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
import { EvaluationsRepository } from '../../evaluations/repositories/evaluations.repository';

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
    private readonly evalsRepo: EvaluationsRepository,
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
  // without shifting buildEndedAt forward. If a previous finish set the
  // timestamp but the background orchestrator dispatch crashed (or the
  // process restarted before it ran), no build eval row exists. Treat
  // a no-eval idempotent call as "retry the dispatch" so the eval still
  // eventually lands.
  async finishBuildPhase(sessionId: string): Promise<{ ok: true; eventCount: number }> {
    const existing = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { buildEndedAt: true, buildEventCount: true },
    });
    if (!existing) throw new NotFoundException(`Session ${sessionId} not found`);
    if (existing.buildEndedAt) {
      const evals = await this.evalsRepo.findBySession(sessionId);
      const hasBuildEval = evals.some((e) => e.phase === 'build');
      if (!hasBuildEval) {
        this.logger.warn(
          `Session ${sessionId} buildEndedAt is set but no build eval exists — ` +
            'redispatching orchestrator (likely a prior crash).',
        );
        this.dispatchBuildEval(sessionId);
      }
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
    this.dispatchBuildEval(sessionId);
    return { ok: true, eventCount: updated.buildEventCount };
  }

  // Fire-and-forget. The CLI shouldn't wait on the LLM call; failure
  // surfaces only in logs.
  private dispatchBuildEval(sessionId: string): void {
    this.orchestrator.run(sessionId, ['build']).catch((err) => {
      this.logger.warn(
        `Background buildAgent.run(${sessionId}) crashed: ${(err as Error).message}`,
      );
    });
  }
}
