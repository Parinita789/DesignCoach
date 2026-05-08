import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PhaseEvaluation } from '@prisma/client';
import { Phase } from '../../phase-tagger/types/phase.types';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SnapshotsService } from '../../snapshots/services/snapshots.service';
import { AIInteractionsRepository } from '../../hints/repositories/ai-interactions.repository';
import { PlanAgent } from '../agents/plan.agent';
import { BuildAgent } from '../agents/build.agent';
import { BasePhaseAgent } from '../agents/base-phase.agent';
import { PhaseEvalInput } from '../types/evaluation.types';
import { EvaluationsRepository } from '../repositories/evaluations.repository';
import { MentorService } from '../../mentor/services/mentor.service';
import { SignalMentorService } from '../../signal-mentor/services/signal-mentor.service';
import { BuildContextService } from './build-context.service';
import { BackgroundTaskTracker } from '../../../common/background-task-tracker.service';

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);

  constructor(
    @Inject(forwardRef(() => SessionsService))
    private readonly sessionsService: SessionsService,
    private readonly snapshotsService: SnapshotsService,
    private readonly aiInteractionsRepo: AIInteractionsRepository,
    private readonly planAgent: PlanAgent,
    private readonly buildAgent: BuildAgent,
    private readonly evalsRepo: EvaluationsRepository,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => MentorService))
    private readonly mentorService: MentorService,
    @Inject(forwardRef(() => SignalMentorService))
    private readonly signalMentorService: SignalMentorService,
    private readonly buildContextSvc: BuildContextService,
    private readonly tasks: BackgroundTaskTracker,
  ) {}

  async run(
    sessionId: string,
    phases: Phase[] = ['plan'],
    options?: { model?: string },
  ): Promise<PhaseEvaluation[]> {
    const session = await this.sessionsService.getWithQuestion(sessionId);
    const [allSnapshots, hints] = await Promise.all([
      this.snapshotsService.list(sessionId),
      this.aiInteractionsRepo.findBySession(sessionId),
    ]);
    const latestSnapshot = allSnapshots[0];

    const rubricVersion =
      session.question.rubricVersion ??
      this.config.get<string>('RUBRIC_VERSION') ??
      'v2.0';

    const planMd =
      (latestSnapshot?.artifacts as { planMd?: string | null } | null)?.planMd ?? null;

    const input: PhaseEvalInput = {
      session: {
        id: session.id,
        prompt: session.question.prompt,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
      },
      planMd,
      snapshots: allSnapshots.map((s) => ({
        takenAt: s.takenAt,
        elapsedMinutes: s.elapsedMinutes,
        planMdSize:
          ((s.artifacts as { planMd?: string | null } | null)?.planMd ?? '').length,
      })),
      hints: hints.map((h) => ({
        occurredAt: h.occurredAt,
        elapsedMinutes: h.elapsedMinutes,
        prompt: h.prompt,
        response: h.response,
      })),
      rubricVersion,
      kind: session.question.kind ?? null,
      seniority: session.seniority ?? null,
      model: options?.model,
    };

    const out: PhaseEvaluation[] = [];
    for (const phase of phases) {
      const agent = this.agentFor(phase);
      if (!agent) {
        throw new Error(`${phase} agent not implemented`);
      }
      const phaseInput =
        phase === 'build'
          ? { ...input, buildContext: await this.buildContextSvc.load(sessionId, session) }
          : input;
      this.logger.log(`Running ${phase} agent for session ${sessionId}`);
      const result = await agent.evaluate(phaseInput);
      const persisted = await this.evalsRepo.createPhaseEvaluation(sessionId, phase, result);
      await this.evalsRepo.createEvaluationAudit(persisted.id, result.audit);
      out.push(persisted);

      this.tasks.track(
        this.mentorService.generate(persisted.id, options?.model),
        `mentor.generate(${persisted.id})`,
      );
      this.tasks.track(
        this.signalMentorService.generate(persisted.id, options?.model),
        `signalMentor.generate(${persisted.id})`,
      );
    }
    return out;
  }

  private agentFor(phase: Phase): BasePhaseAgent | null {
    if (phase === 'plan') return this.planAgent;
    if (phase === 'build') return this.buildAgent;
    return null;
  }

}
