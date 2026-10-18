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
import {
  PhaseEvalInput,
  PhaseEvaluationResult,
  PlanResultsPayload,
  SignalResult,
} from '../types/evaluation.types';
import { EvaluationsRepository } from '../repositories/evaluations.repository';
import { BuildContextService } from './build-context.service';
import { BackgroundTaskTracker } from '../../../common/background-task-tracker.service';
import {
  BuildEvalRequestedEvent,
  EvaluationCompletedEvent,
  PlanEvalDetailsCompletedEvent,
} from '../../../common/events/evaluation-events';
import { computeFingerprint } from '../helpers/compute-fingerprint';
import { AGENTS_CONFIG } from '../../../config/llm-tunables.config';
import { EvaluationQueueService } from '../../evaluation-queue/services/evaluation-queue.service';

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
    private readonly _tasks: BackgroundTaskTracker,
    private readonly queue: EvaluationQueueService,
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
      userId: session.userId,
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
      const phaseInput =
        phase === 'build'
          ? { ...input, buildContext: await this.buildContextSvc.load(sessionId, session) }
          : input;

      // Content-based cache check. Same shape across phases — same
      // inputs (plan.md + model + build artifacts) means same row.
      // Cache hits skip the LLM call but still repair downstream queue
      // fan-out. This matters when the original worker persisted the
      // evaluation and then crashed before enqueueing follow-up jobs.
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
        await this.enqueueCachedDownstream(cached, sessionId, options?.model);
        out.push(cached);
        continue;
      }

      if (phase === 'plan') {
        out.push(await this.runPlanPhase(sessionId, phaseInput, fingerprint, options?.model));
      } else if (phase === 'build') {
        out.push(await this.runBuildPhase(sessionId, phaseInput, fingerprint, options?.model));
      } else {
        throw new Error(`${phase} agent not implemented`);
      }
    }
    return out;
  }

  // Plan: Call A persists a row with score-only + empty detail fields.
  // Call B fires in the background via BackgroundTaskTracker and
  // patches the row when it completes. The HTTP caller gets the
  // row from Call A at ~5-15s and the frontend polls for Call B.
  private async runPlanPhase(
    sessionId: string,
    input: PhaseEvalInput,
    fingerprint: string,
    overrideModel: string | undefined,
  ): Promise<PhaseEvaluation> {
    this.logger.log(`Running plan Call A for session ${sessionId}`);
    const results = await this.planAgent.evaluateResults(input);

    const persisted = await this.persistPlanCallA(sessionId, results, fingerprint);

    this.eventEmitter.emit(
      EvaluationCompletedEvent.eventName,
      new EvaluationCompletedEvent(persisted.id, sessionId, 'plan', overrideModel),
    );
    await this.queue.enqueueSignalMentor({
      evaluationId: persisted.id,
      sessionId,
      ...(overrideModel ? { model: overrideModel } : {}),
    });
    await this.queue.enqueuePlanDetails({
      evaluationId: persisted.id,
      sessionId,
      ...(overrideModel ? { model: overrideModel } : {}),
    });

    return persisted;
  }

  private async persistPlanCallA(
    sessionId: string,
    results: PlanResultsPayload,
    fingerprint: string,
  ): Promise<PhaseEvaluation> {
    // Seed the row with score + verdicts; detail fields are empty
    // string / empty array; details_completed_at = null (Prisma default).
    const seed: PhaseEvaluationResult = {
      phase: 'plan',
      score: results.score,
      signalResults: results.signalResults,
      feedbackText: '',
      topActionableItems: [],
      gapTopics: [],
      audit: results.audit,
    };
    try {
      const persisted = await this.evalsRepo.createPhaseEvaluation(
        sessionId,
        'plan',
        seed,
        fingerprint,
      );
      await this.evalsRepo.createEvaluationAudit(persisted.id, results.audit);
      return persisted;
    } catch (err) {
      if (!isUniqueConstraintViolation(err)) throw err;
      const winner = await this.evalsRepo.findByFingerprint(sessionId, 'plan', fingerprint);
      if (!winner) throw err;
      this.logger.warn(
        `Concurrent race on plan eval for session ${sessionId} — ` +
          `duplicate Call A paid, returning winner's row ${winner.id}.`,
      );
      return winner;
    }
  }

  async runPlanDetailsForEvaluation(evaluationId: string, model?: string): Promise<void> {
    const evalRow = await this.evalsRepo.findById(evaluationId);
    if (!evalRow) throw new Error(`Evaluation ${evaluationId} not found`);
    const session = await this.sessionReadService.getWithQuestion(evalRow.sessionId);
    const [allSnapshots, hints] = await Promise.all([
      this.snapshotsService.list(evalRow.sessionId),
      this.aiInteractionsRepo.findBySession(evalRow.sessionId),
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
      userId: session.userId,
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
      model,
    };
    await this.evaluateDetailsAndPersist(
      evaluationId,
      evalRow.sessionId,
      input,
      evalRow.signalResults as unknown as Record<string, SignalResult>,
      model,
    );
  }

  private async evaluateDetailsAndPersist(
    evaluationId: string,
    sessionId: string,
    input: PhaseEvalInput,
    priorSignalResults: Record<string, SignalResult>,
    model: string | undefined,
  ): Promise<void> {
    const existing = await this.evalsRepo.findById(evaluationId);
    if (existing?.detailsCompletedAt) {
      await this.queue.enqueueMentor({
        evaluationId,
        sessionId,
        ...(model ? { model } : {}),
      });
      this.eventEmitter.emit(
        PlanEvalDetailsCompletedEvent.eventName,
        new PlanEvalDetailsCompletedEvent(evaluationId, sessionId, true),
      );
      return;
    }

    let details: Awaited<ReturnType<PlanAgent['evaluateDetails']>>;
    try {
      details = await this.planAgent.evaluateDetails(input, priorSignalResults);
      await this.evalsRepo.patchDetails(evaluationId, {
        signalResults: details.signalResults,
        score: details.score,
        feedbackText: details.feedbackText,
        topActionableItems: details.topActionableItems,
        gapTopics: details.gapTopics,
        detailsAudit: details.audit,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Plan Call B failed for eval ${evaluationId}: ${message}. ` +
          `Marking detailsError on the row.`,
      );
      try {
        await this.evalsRepo.markDetailsError(evaluationId, truncateError(message));
      } catch (writeErr) {
        // If we can't even write the error column, log and move on —
        // the row is still queryable; the frontend will poll until it
        // gives up by its own UI timeout.
        this.logger.error(
          `Plan Call B: also failed to write detailsError for eval ${evaluationId}: ` +
            (writeErr instanceof Error ? writeErr.message : String(writeErr)),
        );
      }
      throw err;
    }

    await this.queue.enqueueMentor({
      evaluationId,
      sessionId,
      ...(model ? { model } : {}),
    });
    this.eventEmitter.emit(
      PlanEvalDetailsCompletedEvent.eventName,
      new PlanEvalDetailsCompletedEvent(evaluationId, sessionId, true),
    );
    this.logger.log(
      `Plan Call B persisted for eval ${evaluationId} ` +
        `(${details.downgradedSignalIds.length} signal(s) downgraded)`,
    );
  }

  // Build keeps the single-call shape — same behavior as before. The
  // two-call refactor is plan-only for this PR; build follows in a
  // separate one once the pattern is validated.
  private async runBuildPhase(
    sessionId: string,
    input: PhaseEvalInput,
    fingerprint: string,
    overrideModel: string | undefined,
  ): Promise<PhaseEvaluation> {
    this.logger.log(`Running build agent for session ${sessionId}`);
    const result = await this.buildAgent.evaluate(input);

    try {
      const persisted = await this.evalsRepo.createPhaseEvaluation(
        sessionId,
        'build',
        result,
        fingerprint,
      );
      await this.evalsRepo.createEvaluationAudit(persisted.id, result.audit);
      this.eventEmitter.emit(
        EvaluationCompletedEvent.eventName,
        new EvaluationCompletedEvent(persisted.id, sessionId, 'build', overrideModel),
      );
      await this.queue.enqueueSignalMentor({
        evaluationId: persisted.id,
        sessionId,
        ...(overrideModel ? { model: overrideModel } : {}),
      });
      await this.queue.enqueueMentor({
        evaluationId: persisted.id,
        sessionId,
        ...(overrideModel ? { model: overrideModel } : {}),
      });
      return persisted;
    } catch (err) {
      if (!isUniqueConstraintViolation(err)) throw err;
      const winner = await this.evalsRepo.findByFingerprint(sessionId, 'build', fingerprint);
      if (!winner) throw err;
      this.logger.warn(
        `Concurrent race on build eval for session ${sessionId} — ` +
          `duplicate LLM call paid, returning winner's row ${winner.id}.`,
      );
      this.eventEmitter.emit(
        EvaluationCompletedEvent.eventName,
        new EvaluationCompletedEvent(winner.id, sessionId, 'build', overrideModel),
      );
      await this.enqueueCachedDownstream(winner, sessionId, overrideModel);
      return winner;
    }
  }

  private async enqueueCachedDownstream(
    cached: PhaseEvaluation,
    sessionId: string,
    model: string | undefined,
  ): Promise<void> {
    const payload = {
      evaluationId: cached.id,
      sessionId,
      ...(model ? { model } : {}),
    };

    if (cached.phase === 'plan') {
      await this.queue.enqueueSignalMentor(payload);
      // A row with detailsError is still missing its details, so retry
      // Call B; enqueuePlanDetails no-ops if an attempt is still pending.
      if (!cached.detailsCompletedAt) {
        await this.queue.enqueuePlanDetails(payload);
      } else {
        await this.queue.enqueueMentor(payload);
      }
      return;
    }

    if (cached.phase === 'build') {
      await this.queue.enqueueSignalMentor(payload);
      await this.queue.enqueueMentor(payload);
    }
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
    this.enqueueBuildEval(event.sessionId).catch((err) => {
      this.logger.error(
        `Failed to enqueue build eval for session ${event.sessionId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    });
  }

  private async enqueueBuildEval(sessionId: string): Promise<void> {
    const session = await this.sessionReadService.getWithQuestion(sessionId);
    const latestSnapshot = await this.snapshotsService.latest(sessionId);
    const planMd =
      (latestSnapshot?.artifacts as { planMd?: string | null } | null)?.planMd ?? null;
    const resolvedModel = this.fingerprintModelFor('build', undefined);
    const buildContext = await this.buildContextSvc.load(sessionId, session);
    const fingerprint = computeFingerprint('build', {
      planMd,
      model: resolvedModel,
      buildContext,
    });
    await this.queue.enqueueBuildEvaluation({
      sessionId,
      resolvedModel,
      fingerprint,
    });
  }
}

// Cap detailsError text at a reasonable size so a multi-KB LLM error
// message doesn't bloat every API response that includes the row.
function truncateError(msg: string): string {
  const MAX = 500;
  return msg.length > MAX ? `${msg.slice(0, MAX)}…(truncated)` : msg;
}
