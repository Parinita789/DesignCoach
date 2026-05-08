import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { BuildEventsRepository } from '../repositories/build-events.repository';
import { BuildAIInteractionsRepository } from '../repositories/build-ai-interactions.repository';
import { BuildTokenService, MintedToken } from './build-token.service';
import { IncomingBuildEvent } from '../types/build-event.types';
import { BuildAIInteractionDto } from '../dto/build-ai-interaction.dto';
import { OrchestratorService } from '../../evaluations/services/orchestrator.service';

@Injectable()
export class BuildSessionsService {
  private readonly logger = new Logger(BuildSessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: BuildTokenService,
    private readonly events: BuildEventsRepository,
    private readonly aiInteractions: BuildAIInteractionsRepository,
    @Inject(forwardRef(() => OrchestratorService))
    private readonly orchestrator: OrchestratorService,
  ) {}

  async startBuildPhase(sessionId: string): Promise<MintedToken> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true, status: true, buildEndedAt: true },
    });
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    if (session.status === 'abandoned') {
      throw new ConflictException(
        `Session ${sessionId} is abandoned; cannot start a build phase`,
      );
    }
    if (session.buildEndedAt) {
      throw new ConflictException(
        `Build phase for session ${sessionId} has already finished`,
      );
    }
    return this.tokens.mintForSession(sessionId);
  }

  insertEvents(sessionId: string, events: IncomingBuildEvent[]) {
    return this.events.insertBatch(sessionId, events);
  }

  insertAiInteractions(sessionId: string, interactions: BuildAIInteractionDto[]) {
    return this.aiInteractions.insertBatch(sessionId, interactions);
  }

  async eventsSummary(sessionId: string) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        buildStartedAt: true,
        buildEndedAt: true,
        buildEventCount: true,
      },
    });
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    const [perFile, aiCounts] = await Promise.all([
      this.events.summaryForSession(sessionId),
      this.aiInteractions.countsForSession(sessionId),
    ]);
    return {
      buildStartedAt: session.buildStartedAt,
      buildEndedAt: session.buildEndedAt,
      eventCount: session.buildEventCount,
      perFile,
      aiInteractionCount: aiCounts.total,
      aiSessionsCount: aiCounts.distinctSessions,
    };
  }

  // Idempotent: a second call after finish returns the same eventCount
  // without shifting buildEndedAt forward. The guard normally rejects a
  // second finish, but keeping the service honest defends against
  // future internal callers (orchestrator, retry handlers).
  async finishBuildPhase(sessionId: string): Promise<{ ok: true; eventCount: number }> {
    const existing = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { buildEndedAt: true, buildEventCount: true },
    });
    if (!existing) throw new NotFoundException(`Session ${sessionId} not found`);
    if (existing.buildEndedAt) {
      return { ok: true, eventCount: existing.buildEventCount };
    }
    const updated = await this.prisma.session.update({
      where: { id: sessionId },
      data: { buildEndedAt: new Date() },
      select: { buildEventCount: true },
    });
    this.logger.log(
      `Build phase finished for session ${sessionId} ` +
        `(${updated.buildEventCount} events captured). ` +
        'Dispatching BuildAgent in the background.',
    );
    // Fire-and-forget. The CLI shouldn't wait on the LLM call; failure
    // surfaces only in logs. The orchestrator handles its own retries
    // and downstream mentor dispatch.
    this.orchestrator.run(sessionId, ['build']).catch((err) => {
      this.logger.warn(
        `Background buildAgent.run(${sessionId}) crashed: ${(err as Error).message}`,
      );
    });
    return { ok: true, eventCount: updated.buildEventCount };
  }
}
