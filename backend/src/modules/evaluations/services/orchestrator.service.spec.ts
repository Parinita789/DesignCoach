import { OrchestratorService } from './orchestrator.service';
import {
  PhaseEvaluationResult,
  PlanDetailsPayload,
  PlanResultsPayload,
  SignalResult,
} from '../types/evaluation.types';

const SID = '00000000-0000-0000-0000-000000000001';

function makeSession(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SID,
    startedAt: new Date('2026-05-07T09:00:00Z'),
    endedAt: new Date('2026-05-07T10:00:00Z'),
    seniority: 'mid',
    buildStartedAt: new Date('2026-05-07T09:20:00Z'),
    buildEndedAt: new Date('2026-05-07T09:55:00Z'),
    question: {
      prompt: 'Design X.',
      rubricVersion: 'v2.0',
      mode: 'build',
    },
    ...overrides,
  };
}

function makeBuildResult(): PhaseEvaluationResult {
  return {
    phase: 'build',
    score: 4,
    signalResults: {},
    feedbackText: 'fb',
    topActionableItems: [],
    gapTopics: [],
    audit: {
      prompt: 'p',
      rawResponse: 'r',
      modelUsed: 'm',
      tokensIn: 1,
      tokensOut: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      latencyMs: 1,
    },
  };
}

function makePlanResults(): PlanResultsPayload {
  const signalResults: Record<string, SignalResult> = {
    sig_a: { result: 'hit', evidence: '' },
    sig_b: { result: 'miss', evidence: '' },
  };
  return {
    score: 4,
    signalResults,
    audit: {
      prompt: 'p-A',
      rawResponse: '{"signals":{...}}',
      modelUsed: 'm',
      tokensIn: 1,
      tokensOut: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      latencyMs: 1,
      llmScore: 4,
    },
  };
}

function makePlanDetails(downgraded: string[] = []): PlanDetailsPayload {
  return {
    signalResults: {
      sig_a: { result: 'hit', evidence: 'quote', reasoning: 'because' },
      sig_b: { result: 'miss', evidence: 'n/a', reasoning: 'absent' },
    },
    score: downgraded.length > 0 ? 3 : 4,
    downgradedSignalIds: downgraded,
    feedbackText: 'detailed feedback',
    topActionableItems: ['action 1'],
    gapTopics: [],
    audit: {
      prompt: 'p-B',
      rawResponse: '{"signals":{...}}',
      modelUsed: 'm',
      tokensIn: 2,
      tokensOut: 1500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      latencyMs: 30000,
      llmScore: downgraded.length > 0 ? 3 : 4,
    },
  };
}

function makeOrchestrator(deps: {
  session?: ReturnType<typeof makeSession>;
  events?: Array<unknown>;
  aiTurns?: Array<unknown>;
  planResults?: PlanResultsPayload;
  planDetails?: PlanDetailsPayload;
  planDetailsError?: Error;
  buildResult?: PhaseEvaluationResult;
}) {
  const sessionsService = {
    getWithQuestion: jest.fn().mockResolvedValue(deps.session ?? makeSession()),
  };
  const snapshotsService = {
    list: jest.fn().mockResolvedValue([]),
    latest: jest.fn().mockResolvedValue({ artifacts: { planMd: '# Plan' } }),
  };
  const aiInteractionsRepo = { findBySession: jest.fn().mockResolvedValue([]) };
  const planAgent = {
    evaluateResults: jest.fn().mockResolvedValue(deps.planResults ?? makePlanResults()),
    evaluateDetails: deps.planDetailsError
      ? jest.fn().mockRejectedValue(deps.planDetailsError)
      : jest.fn().mockResolvedValue(deps.planDetails ?? makePlanDetails()),
  };
  const buildAgent = {
    evaluate: jest.fn().mockResolvedValue(deps.buildResult ?? makeBuildResult()),
  };
  const evalsRepo = {
    createPhaseEvaluation: jest
      .fn()
      .mockImplementation(async (_sid, phase, _result, fingerprint) => ({
        id: `eid-${phase}`,
        sessionId: SID,
        phase,
        inputFingerprint: fingerprint ?? null,
      })),
    createEvaluationAudit: jest.fn().mockResolvedValue(undefined),
    findByFingerprint: jest.fn().mockResolvedValue(null),
    findById: jest.fn().mockResolvedValue({
      id: 'eid-plan',
      sessionId: SID,
      phase: 'plan',
      score: 4,
      signalResults: deps.planResults?.signalResults ?? makePlanResults().signalResults,
      feedbackText: '',
      topActionableItems: [],
      gapTopics: [],
    }),
    patchDetails: jest.fn().mockResolvedValue(undefined),
    markDetailsError: jest.fn().mockResolvedValue(undefined),
  };
  const config = { get: jest.fn() };
  const tasks = {
    track: jest.fn((p: Promise<unknown>) => p.catch(() => undefined)),
  };
  const queue = {
    enqueueSignalMentor: jest.fn().mockResolvedValue('signal-mentor-job'),
    enqueuePlanDetails: jest.fn().mockResolvedValue('plan-details-job'),
    enqueueMentor: jest.fn().mockResolvedValue('mentor-job'),
    enqueueBuildEvaluation: jest.fn().mockResolvedValue('build-job'),
  };
  const eventEmitter = { emit: jest.fn() };
  const buildContextSvc = {
    load: jest.fn().mockImplementation(async (_sid, session) => {
      const events = (deps.events ?? []) as Array<{
        filePath: string;
        action: 'created' | 'modified' | 'deleted';
        content: string | null;
        contentDiff: string | null;
        occurredAt: Date;
      }>;
      const tree = events
        .filter((e) => e.action !== 'deleted')
        .map((e) => ({
          path: e.filePath,
          size: (e.content ?? '').length,
          sha1: 'abc',
        }));
      return {
        startedAt: session.buildStartedAt,
        endedAt: session.buildEndedAt,
        events: events.map((e) => ({
          filePath: e.filePath,
          action: e.action,
          contentDiff: e.contentDiff,
          occurredAt: e.occurredAt,
        })),
        finalTree: tree,
        keyFileSnippets: events.map((e) => ({ path: e.filePath, content: e.content ?? '' })),
        allFileContents: events.map((e) => ({ path: e.filePath, content: e.content ?? '' })),
        aiTurns: (deps.aiTurns ?? []).map((t: Record<string, unknown>) => ({
          ...t,
          occurredAt: t.occurredAt instanceof Date ? t.occurredAt : new Date(String(t.occurredAt)),
        })),
      };
    }),
  };

  const svc = new OrchestratorService(
    sessionsService as never,
    snapshotsService as never,
    aiInteractionsRepo as never,
    planAgent as never,
    buildAgent as never,
    evalsRepo as never,
    config as never,
    buildContextSvc as never,
    tasks as never,
    queue as never,
    eventEmitter as never,
  );

  return {
    svc,
    planAgent,
    buildAgent,
    queue,
    eventEmitter,
    buildContextSvc,
    tasks,
    evalsRepo,
  };
}

describe('OrchestratorService.run dispatch', () => {
  it('routes phase="plan" to PlanAgent.evaluateResults (Call A) and skips BuildAgent', async () => {
    const t = makeOrchestrator({});
    await t.svc.run(SID, ['plan']);
    expect(t.planAgent.evaluateResults).toHaveBeenCalledTimes(1);
    expect(t.buildAgent.evaluate).not.toHaveBeenCalled();
  });

  it('routes phase="build" to BuildAgent and skips PlanAgent', async () => {
    const t = makeOrchestrator({});
    await t.svc.run(SID, ['build']);
    expect(t.buildAgent.evaluate).toHaveBeenCalledTimes(1);
    expect(t.planAgent.evaluateResults).not.toHaveBeenCalled();
  });

  it('throws on unimplemented phases', async () => {
    const t = makeOrchestrator({});
    await expect(t.svc.run(SID, ['validate'])).rejects.toThrow(/validate agent not implemented/);
  });

  it('enqueues build mentor artifacts after the build path persists', async () => {
    const t = makeOrchestrator({});
    await t.svc.run(SID, ['build'], { model: 'm-override' });
    expect(t.queue.enqueueSignalMentor).toHaveBeenCalledWith(
      expect.objectContaining({
        evaluationId: 'eid-build',
        sessionId: SID,
        model: 'm-override',
      }),
    );
    expect(t.queue.enqueueMentor).toHaveBeenCalledWith(
      expect.objectContaining({
        evaluationId: 'eid-build',
        sessionId: SID,
        model: 'm-override',
      }),
    );
  });

  it('emits EvaluationCompletedEvent for feedback invalidation after build persists', async () => {
    const t = makeOrchestrator({});
    await t.svc.run(SID, ['build']);
    expect(t.eventEmitter.emit).toHaveBeenCalledWith(
      'evaluation.completed',
      expect.objectContaining({ evaluationId: 'eid-build', sessionId: SID, phase: 'build' }),
    );
  });

  it('enqueues plan details and signal mentor after Call A persists', async () => {
    const t = makeOrchestrator({});
    await t.svc.run(SID, ['plan'], { model: 'm-override' });
    expect(t.queue.enqueueSignalMentor).toHaveBeenCalledWith(
      expect.objectContaining({
        evaluationId: 'eid-plan',
        sessionId: SID,
        model: 'm-override',
      }),
    );
    expect(t.queue.enqueuePlanDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        evaluationId: 'eid-plan',
        sessionId: SID,
        model: 'm-override',
      }),
    );
  });

  it('emits EvaluationCompletedEvent for feedback invalidation after Call A persists', async () => {
    const t = makeOrchestrator({});
    await t.svc.run(SID, ['plan']);
    expect(t.eventEmitter.emit).toHaveBeenCalledWith(
      'evaluation.completed',
      expect.objectContaining({ evaluationId: 'eid-plan', sessionId: SID, phase: 'plan' }),
    );
  });
});

describe('OrchestratorService two-call plan path', () => {
  it('persists Call A row immediately with score + empty detail fields, then schedules Call B', async () => {
    const t = makeOrchestrator({});
    const [persisted] = await t.svc.run(SID, ['plan']);

    expect(persisted.id).toBe('eid-plan');
    expect(t.planAgent.evaluateResults).toHaveBeenCalledTimes(1);
    expect(t.evalsRepo.createPhaseEvaluation).toHaveBeenCalledTimes(1);

    const [, , seed] = t.evalsRepo.createPhaseEvaluation.mock.calls[0];
    expect(seed.score).toBe(4);
    expect(seed.signalResults.sig_a.result).toBe('hit');
    expect(seed.feedbackText).toBe('');
    expect(seed.topActionableItems).toEqual([]);
    expect(seed.gapTopics).toEqual([]);

    expect(t.queue.enqueuePlanDetails).toHaveBeenCalledWith(
      expect.objectContaining({ evaluationId: 'eid-plan', sessionId: SID }),
    );
  });

  it('Call B patches the row with full details + score + audit', async () => {
    const t = makeOrchestrator({});
    await t.svc.run(SID, ['plan']);
    await t.svc.runPlanDetailsForEvaluation('eid-plan');

    expect(t.planAgent.evaluateDetails).toHaveBeenCalledTimes(1);
    expect(t.evalsRepo.patchDetails).toHaveBeenCalledTimes(1);

    const [id, patch] = t.evalsRepo.patchDetails.mock.calls[0];
    expect(id).toBe('eid-plan');
    expect(patch.feedbackText).toBe('detailed feedback');
    expect(patch.topActionableItems).toEqual(['action 1']);
    expect(patch.score).toBe(4);
  });

  it('enqueues mentor after Call B persists', async () => {
    const t = makeOrchestrator({});
    await t.svc.run(SID, ['plan']);
    await t.svc.runPlanDetailsForEvaluation('eid-plan');

    expect(t.queue.enqueueMentor).toHaveBeenCalledWith(
      expect.objectContaining({ evaluationId: 'eid-plan', sessionId: SID }),
    );
    expect(t.eventEmitter.emit).toHaveBeenCalledWith(
      'plan-eval.details-completed',
      expect.objectContaining({ evaluationId: 'eid-plan', sessionId: SID, succeeded: true }),
    );
  });

  it('Call B failure: marks detailsError, does not enqueue mentor, and rethrows for BullMQ', async () => {
    const t = makeOrchestrator({
      planDetailsError: new Error('LLM timeout exceeded 90s'),
    });
    await t.svc.run(SID, ['plan']);
    await expect(t.svc.runPlanDetailsForEvaluation('eid-plan')).rejects.toThrow(
      /LLM timeout/,
    );

    expect(t.evalsRepo.markDetailsError).toHaveBeenCalledTimes(1);
    const [id, message] = t.evalsRepo.markDetailsError.mock.calls[0];
    expect(id).toBe('eid-plan');
    expect(message).toMatch(/LLM timeout/);

    expect(t.evalsRepo.patchDetails).not.toHaveBeenCalled();
    expect(t.queue.enqueueMentor).not.toHaveBeenCalled();
  });

  it('passes Call A signal results as priorSignalResults to Call B', async () => {
    const t = makeOrchestrator({});
    await t.svc.run(SID, ['plan']);
    await t.svc.runPlanDetailsForEvaluation('eid-plan');

    const [, priorResults] = t.planAgent.evaluateDetails.mock.calls[0];
    expect(priorResults.sig_a.result).toBe('hit');
    expect(priorResults.sig_b.result).toBe('miss');
  });

  it('caps detailsError message length so a long LLM error does not bloat the row', async () => {
    const t = makeOrchestrator({
      planDetailsError: new Error('X'.repeat(2000)),
    });
    await t.svc.run(SID, ['plan']);
    await expect(t.svc.runPlanDetailsForEvaluation('eid-plan')).rejects.toThrow();

    const [, message] = t.evalsRepo.markDetailsError.mock.calls[0];
    expect(message.length).toBeLessThanOrEqual(520);
    expect(message).toMatch(/truncated/);
  });
});

describe('OrchestratorService.run buildContext population', () => {
  it('passes a buildContext with finalTree, keyFileSnippets, and aiTurns to BuildAgent', async () => {
    const events = [
      {
        filePath: 'a.ts',
        action: 'created',
        content: 'export const a = 1;',
        contentDiff: null,
        occurredAt: new Date('2026-05-07T09:25:00Z'),
      },
    ];
    const aiTurns = [
      {
        externalSessionId: 'cc-1',
        turnIndex: 0,
        role: 'user',
        text: 'help me with auth',
        toolName: null,
        toolInputSummary: null,
        toolResultSummary: null,
        occurredAt: new Date('2026-05-07T09:30:00Z'),
      },
    ];
    const t = makeOrchestrator({ events, aiTurns });
    await t.svc.run(SID, ['build']);

    const callArg = t.buildAgent.evaluate.mock.calls[0][0];
    expect(callArg.buildContext).toBeDefined();
    expect(callArg.buildContext.finalTree).toEqual([
      expect.objectContaining({ path: 'a.ts' }),
    ]);
    expect(callArg.buildContext.keyFileSnippets).toEqual([
      expect.objectContaining({ path: 'a.ts', content: 'export const a = 1;' }),
    ]);
    expect(callArg.buildContext.allFileContents).toEqual([
      { path: 'a.ts', content: 'export const a = 1;' },
    ]);
    expect(callArg.buildContext.aiTurns).toHaveLength(1);
    expect(callArg.buildContext.startedAt).toBeInstanceOf(Date);
    expect(callArg.buildContext.endedAt).toBeInstanceOf(Date);
  });

  it('plan-phase calls do not load build artifacts (no DB calls to build repos)', async () => {
    const t = makeOrchestrator({});
    await t.svc.run(SID, ['plan']);
    expect(t.buildContextSvc.load).not.toHaveBeenCalled();
  });
});

describe('OrchestratorService.run content-based caching', () => {
  it('persists a fingerprint on the new eval row', async () => {
    const t = makeOrchestrator({});
    await t.svc.run(SID, ['plan']);
    expect(t.evalsRepo.createPhaseEvaluation).toHaveBeenCalledTimes(1);
    const [_sid, _phase, _result, fingerprint] = t.evalsRepo.createPhaseEvaluation.mock.calls[0];
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the cached row when a prior eval with the same fingerprint exists', async () => {
    const t = makeOrchestrator({});
    const cachedRow = {
      id: 'cached-eid',
      sessionId: SID,
      phase: 'plan',
      inputFingerprint: 'cached-fp',
      score: 4.2,
      detailsCompletedAt: new Date('2026-05-07T10:10:00Z'),
      detailsError: null,
    };
    t.evalsRepo.findByFingerprint.mockResolvedValueOnce(cachedRow);

    const result = await t.svc.run(SID, ['plan']);

    expect(result).toEqual([cachedRow]);
    expect(t.planAgent.evaluateResults).not.toHaveBeenCalled();
    expect(t.evalsRepo.createPhaseEvaluation).not.toHaveBeenCalled();
    expect(t.tasks.track).not.toHaveBeenCalled();
    expect(t.queue.enqueueSignalMentor).toHaveBeenCalledWith(
      expect.objectContaining({ evaluationId: 'cached-eid', sessionId: SID }),
    );
    expect(t.queue.enqueuePlanDetails).not.toHaveBeenCalled();
  });

  it('re-enqueues Call B for a cached row whose details previously failed', async () => {
    const t = makeOrchestrator({});
    t.evalsRepo.findByFingerprint.mockResolvedValueOnce({
      id: 'cached-eid',
      sessionId: SID,
      phase: 'plan',
      inputFingerprint: 'cached-fp',
      score: 3,
      detailsCompletedAt: null,
      detailsError: 'LLM call exceeded 90000ms',
    });

    await t.svc.run(SID, ['plan']);

    expect(t.planAgent.evaluateResults).not.toHaveBeenCalled();
    expect(t.queue.enqueuePlanDetails).toHaveBeenCalledWith(
      expect.objectContaining({ evaluationId: 'cached-eid', sessionId: SID }),
    );
    expect(t.queue.enqueueMentor).not.toHaveBeenCalled();
  });

  it('runs Call A normally on cache miss (findByFingerprint returns null)', async () => {
    const t = makeOrchestrator({});
    await t.svc.run(SID, ['plan']);
    expect(t.evalsRepo.findByFingerprint).toHaveBeenCalledTimes(1);
    expect(t.planAgent.evaluateResults).toHaveBeenCalledTimes(1);
    expect(t.evalsRepo.createPhaseEvaluation).toHaveBeenCalledTimes(1);
  });

  it('looks up the fingerprint scoped to (sessionId, phase, fingerprint)', async () => {
    const t = makeOrchestrator({});
    await t.svc.run(SID, ['build']);
    const [sessionId, phase, fingerprint] = t.evalsRepo.findByFingerprint.mock.calls[0];
    expect(sessionId).toBe(SID);
    expect(phase).toBe('build');
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the winner row on P2002 concurrent-race conflict at Call A insert', async () => {
    const t = makeOrchestrator({});
    const winnerRow = {
      id: 'winner-eid',
      phase: 'plan',
      inputFingerprint: 'shared-fp',
      score: 4.0,
    };
    t.evalsRepo.findByFingerprint
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winnerRow);
    t.evalsRepo.createPhaseEvaluation.mockRejectedValueOnce({
      code: 'P2002',
      message: 'Unique constraint failed on (session_id, phase, input_fingerprint)',
    });

    const result = await t.svc.run(SID, ['plan']);

    expect(result).toEqual([winnerRow]);
    expect(t.evalsRepo.createEvaluationAudit).not.toHaveBeenCalled();
  });

  it('propagates non-P2002 DB errors (does not swallow real failures)', async () => {
    const t = makeOrchestrator({});
    t.evalsRepo.createPhaseEvaluation.mockRejectedValueOnce(
      new Error('connection reset by peer'),
    );
    await expect(t.svc.run(SID, ['plan'])).rejects.toThrow(/connection reset/);
  });

  it('rethrows the original P2002 if no winner row exists after the conflict (unexpected state)', async () => {
    const t = makeOrchestrator({});
    t.evalsRepo.findByFingerprint
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    t.evalsRepo.createPhaseEvaluation.mockRejectedValueOnce({
      code: 'P2002',
      message: 'Unique constraint failed',
    });

    await expect(t.svc.run(SID, ['plan'])).rejects.toMatchObject({ code: 'P2002' });
  });
});
