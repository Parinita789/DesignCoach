import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { PhaseEvaluation } from '@prisma/client';
import { Phase } from '../../phase-tagger/types/phase.types';
import { SessionReadService } from '../../session-read/services/session-read.service';
import { SnapshotsService } from '../../snapshots/services/snapshots.service';
import { AIInteractionsRepository } from '../../hints/repositories/ai-interactions.repository';
import { PlanAgent } from '../agents/plan.agent';
import { BuildAgent } from '../agents/build.agent';
import { BasePhaseAgent } from '../agents/base-phase.agent';
import { PhaseEvalInput } from '../types/evaluation.types';
import { EvaluationsRepository } from '../repositories/evaluations.repository';
import { BuildContextService } from './build-context.service';
import { BackgroundTaskTracker } from '../../../common/background-task-tracker.service';
import {
  BuildEvalRequestedEvent,
  EvaluationCompletedEvent,
} from '../../../common/events/evaluation-events';
import { computeFingerprint } from '../helpers/compute-fingerprint';
import { AGENTS_CONFIG } from '../../../config/llm-tunables.config';

// Prisma surfaces unique-constraint violations as `PrismaClientKnownRequestError`
// with `code: 'P2002'`. We avoid `instanceof Prisma.PrismaClientKnownRequestError`
// so this stays trivially mockable from tests — checking the `code` property
// is sufficient and matches Prisma's stable contract.
function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'P2002'
  );
}

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);

  constructor(
    private readonly sessionReadService: SessionReadService,
    private readonly snapshotsService: SnapshotsService,
    private readonly aiInteractionsRepo: AIInteractionsRepository,
    private readonly planAgent: PlanAgent,
    private readonly buildAgent: BuildAgent,
    private readonly evalsRepo: EvaluationsRepository,
    private readonly config: ConfigService,
    private readonly buildContextSvc: BuildContextService,
    private readonly tasks: BackgroundTaskTracker,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async run(
    sessionId: string,
    phases: Phase[] = ['plan'],
    options?: { model?: string },
  ): Promise<PhaseEvaluation[]> {
    const session = await this.sessionReadService.getWithQuestion(sessionId);
    const [allSnapshots, hints] = await Promise.all([
      this.snapshotsService.list(sessionId),
      this.aiInteractionsRepo.findBySession(sessionId),
    ]);
    const latestSnapshot = allSnapshots[0];

    const rubricVersion =
      session.question.rubricVersion ??
      this.config.get<string>('RUBRIC_VERSION') ??
      'v3.0';

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

      // Content-based cache check: if a prior eval already exists for
      // this session+phase with identical material inputs (plan.md,
      // model, build artifacts for build phase), return it instead of
      // paying for a fresh LLM run. Mentor + signal-mentor are NOT
      // re-fired — they already ran (or are running) for the cached
      // row; firing again would just duplicate that work. Users who
      // want to regenerate downstream artifacts use the dedicated
      // POST /mentor/:id endpoint.
      const fingerprintModel = this.fingerprintModelFor(phase, options?.model);
      const fingerprint = computeFingerprint(phase, {
        planMd: phaseInput.planMd,
        model: fingerprintModel,
        buildContext: phaseInput.buildContext,
      });
      const cached = await this.evalsRepo.findByFingerprint(sessionId, phase, fingerprint);
      if (cached) {
        this.logger.log(
          `Cache hit for ${phase} eval on session ${sessionId} ` +
            `(fingerprint=${fingerprint.slice(0, 12)}…) — skipping LLM run`,
        );
        out.push(cached);
        continue;
      }

      this.logger.log(`Running ${phase} agent for session ${sessionId}`);
      const result = await agent.evaluate(phaseInput);

      let persisted: PhaseEvaluation;
      try {
        persisted = await this.evalsRepo.createPhaseEvaluation(
          sessionId,
          phase,
          result,
          fingerprint,
        );
        await this.evalsRepo.createEvaluationAudit(persisted.id, result.audit);
        this.eventEmitter.emit(
          EvaluationCompletedEvent.eventName,
          new EvaluationCompletedEvent(persisted.id, sessionId, phase, options?.model),
        );
      } catch (err) {
        // Lost a concurrent race against another orchestrator run with
        // identical inputs — the unique partial index on
        // (session_id, phase, input_fingerprint) rejected this INSERT
        // because the other side already wrote the row. The LLM call
        // we just made is wasted (a follow-up idempotency-key layer
        // will short-circuit before the LLM call), but DB integrity is
        // preserved. Return the winner's row to the caller so the
        // user sees a consistent result.
        if (!isUniqueConstraintViolation(err)) throw err;
        const winner = await this.evalsRepo.findByFingerprint(sessionId, phase, fingerprint);
        if (!winner) {
          // P2002 thrown but no row found by the same fingerprint —
          // unexpected; surface the original error.
          throw err;
        }
        this.logger.warn(
          `Concurrent race on ${phase} eval for session ${sessionId} — ` +
            `duplicate LLM call paid, returning winner's row ${winner.id}.`,
        );
        persisted = winner;
      }

      out.push(persisted);
    }
    return out;
  }

  // Resolve the model that will actually be used for this phase — same
  // precedence as the agents themselves (per-call override → agent
  // default). The fingerprint must include the resolved model so
  // switching to Sonnet via a per-call override correctly invalidates
  // the cache.
  private fingerprintModelFor(phase: Phase, overrideModel: string | undefined): string {
    if (overrideModel) return overrideModel;
    if (phase === 'plan') return AGENTS_CONFIG.planAgent.defaultModel;
    if (phase === 'build') return AGENTS_CONFIG.buildAgent.defaultModel;
    return AGENTS_CONFIG.planAgent.defaultModel;
  }

  @OnEvent(BuildEvalRequestedEvent.eventName)
  handleBuildEvalRequested(event: BuildEvalRequestedEvent): void {
    this.tasks.track(
      this.run(event.sessionId, ['build']),
      `buildAgent.run(${event.sessionId})`,
    );
  }

  private agentFor(phase: Phase): BasePhaseAgent | null {
    if (phase === 'plan') return this.planAgent;
    if (phase === 'build') return this.buildAgent;
    return null;
  }
}
