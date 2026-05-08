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
import { BuildContext, PhaseEvalInput } from '../types/evaluation.types';
import { EvaluationsRepository } from '../repositories/evaluations.repository';
import { MentorService } from '../../mentor/services/mentor.service';
import { SignalMentorService } from '../../signal-mentor/services/signal-mentor.service';
import { BuildEventsRepository } from '../../build-sessions/repositories/build-events.repository';
import { BuildAIInteractionsRepository } from '../../build-sessions/repositories/build-ai-interactions.repository';
import { reconstructBuildTree } from '../helpers/reconstruct-build-tree';
import { selectBuildContext } from '../helpers/select-build-context';

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
    private readonly buildEventsRepo: BuildEventsRepository,
    private readonly buildAiRepo: BuildAIInteractionsRepository,
  ) {}

  async run(
    sessionId: string,
    phases: Phase[] = ['plan'],
    options?: { model?: string },
  ): Promise<PhaseEvaluation[]> {
    const session = await this.sessionsService.getWithQuestion(sessionId);
    const allSnapshots = await this.snapshotsService.list(sessionId);
    const latestSnapshot = await this.snapshotsService.latest(sessionId);
    const hints = await this.aiInteractionsRepo.findBySession(sessionId);

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
      mode: session.question.mode ?? null,
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
        phase === 'build' ? { ...input, buildContext: await this.loadBuildContext(sessionId, session) } : input;
      this.logger.log(`Running ${phase} agent for session ${sessionId}`);
      const result = await agent.evaluate(phaseInput);
      const persisted = await this.evalsRepo.createPhaseEvaluation(sessionId, phase, result);
      // Audit FK requires persisted.id, so insert order is fixed.
      await this.evalsRepo.createEvaluationAudit(persisted.id, result.audit);
      out.push(persisted);

      // Fire-and-forget mentor generation. Doesn't block the eval HTTP
      // response — the orchestrator returns once the eval row + audit
      // are persisted. The mentor LLM call runs in the background;
      // success persists a mentor_artifacts row + writes prompt+response
      // to disk. Failures are swallowed by MentorService and only
      // surface in the logs. The frontend lazy-loads the artifact when
      // the user opens the section, by which time the call has usually
      // finished (10-30s typical).
      this.mentorService.generate(persisted.id, options?.model).catch((err) => {
        this.logger.warn(
          `Background mentor.generate(${persisted.id}) crashed: ${(err as Error).message}`,
        );
      });
      this.signalMentorService.generate(persisted.id, options?.model).catch((err) => {
        this.logger.warn(
          `Background signalMentor.generate(${persisted.id}) crashed: ${(err as Error).message}`,
        );
      });
    }
    return out;
  }

  private agentFor(phase: Phase): BasePhaseAgent | null {
    if (phase === 'plan') return this.planAgent;
    if (phase === 'build') return this.buildAgent;
    return null;
  }

  // Pulls captured build artifacts from the dedicated tables, reconstructs
  // the final-state tree, and trims to a prompt-shaped slice. Empty
  // sessions return a buildContext with empty arrays so the agent can
  // still emit cannot_evaluate verdicts cleanly.
  private async loadBuildContext(
    sessionId: string,
    session: { buildStartedAt?: Date | null; buildEndedAt?: Date | null },
  ): Promise<BuildContext> {
    const [eventRows, aiRows] = await Promise.all([
      this.buildEventsRepo.findAllForSession(sessionId),
      this.buildAiRepo.findAllForSession(sessionId),
    ]);

    const reconstructed = reconstructBuildTree(eventRows);
    if (reconstructed.brokenPatchPaths.length > 0) {
      this.logger.warn(
        `Build tree reconstruction had ${reconstructed.brokenPatchPaths.length} broken patch path(s) ` +
          `for session ${sessionId}: ${reconstructed.brokenPatchPaths.join(', ')}`,
      );
    }

    const slimEvents = eventRows.map((e) => ({
      filePath: e.filePath,
      action: e.action as 'created' | 'modified' | 'deleted',
      contentDiff: e.contentDiff,
      occurredAt: e.occurredAt,
    }));

    const { keyFileSnippets, aiTurnsForPrompt } = selectBuildContext({
      events: slimEvents,
      aiTurns: aiRows,
      contents: reconstructed.contents,
    });

    return {
      startedAt: session.buildStartedAt ?? null,
      endedAt: session.buildEndedAt ?? null,
      events: slimEvents,
      finalTree: reconstructed.tree,
      keyFileSnippets,
      aiTurns: aiTurnsForPrompt,
    };
  }
}
