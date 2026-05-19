import { OrchestratorService } from './orchestrator.service';
import { PhaseEvaluationResult } from '../types/evaluation.types';

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

function makeResult(phase: 'plan' | 'build'): PhaseEvaluationResult {
  return {
    phase,
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

function makeOrchestrator(deps: {
  session?: ReturnType<typeof makeSession>;
  events?: Array<unknown>;
  aiTurns?: Array<unknown>;
  planResult?: PhaseEvaluationResult;
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
  const planAgent = { evaluate: jest.fn().mockResolvedValue(deps.planResult ?? makeResult('plan')) };
  const buildAgent = { evaluate: jest.fn().mockResolvedValue(deps.buildResult ?? makeResult('build')) };
  const evalsRepo = {
    createPhaseEvaluation: jest
      .fn()
      .mockImplementation(async (_sid, phase, _result, fingerprint) => ({
        id: `eid-${phase}`,
        phase,
        inputFingerprint: fingerprint ?? null,
      })),
    createEvaluationAudit: jest.fn().mockResolvedValue(undefined),
    findByFingerprint: jest.fn().mockResolvedValue(null),
  };
  const config = { get: jest.fn() };
  const eventEmitter = { emit: jest.fn() };
  const buildEventsRepo = { findAllForSession: jest.fn().mockResolvedValue(deps.events ?? []) };
  const buildAiRepo = { findAllForSession: jest.fn().mockResolvedValue(deps.aiTurns ?? []) };
  const tasks = {
    track: jest.fn((p: Promise<unknown>) => p.catch(() => undefined)),
  };
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
    eventEmitter as never,
  );

  return {
    svc,
    planAgent,
    buildAgent,
    eventEmitter,
    buildEventsRepo,
    buildAiRepo,
    buildContextSvc,
    tasks,
    evalsRepo,
  };
}

describe('OrchestratorService.run dispatch', () => {
  it('routes phase="plan" to PlanAgent and skips BuildAgent', async () => {
    const t = makeOrchestrator({});
    await t.svc.run(SID, ['plan']);
    expect(t.planAgent.evaluate).toHaveBeenCalledTimes(1);
    expect(t.buildAgent.evaluate).not.toHaveBeenCalled();
  });

  it('routes phase="build" to BuildAgent and skips PlanAgent', async () => {
    const t = makeOrchestrator({});
    await t.svc.run(SID, ['build']);
    expect(t.buildAgent.evaluate).toHaveBeenCalledTimes(1);
    expect(t.planAgent.evaluate).not.toHaveBeenCalled();
  });

  it('throws on unimplemented phases', async () => {
    const t = makeOrchestrator({});
    await expect(t.svc.run(SID, ['validate'])).rejects.toThrow(/validate agent not implemented/);
  });

  it('emits EvaluationCompletedEvent for each persisted phase eval', async () => {
    const t = makeOrchestrator({});
    await t.svc.run(SID, ['build']);
    expect(t.eventEmitter.emit).toHaveBeenCalledTimes(1);
    const [name, payload] = t.eventEmitter.emit.mock.calls[0];
    expect(name).toBe('evaluation.completed');
    expect(payload).toEqual(
      expect.objectContaining({ evaluationId: 'eid-build', sessionId: SID, phase: 'build' }),
    );

    await t.svc.run(SID, ['plan']);
    expect(t.eventEmitter.emit).toHaveBeenCalledTimes(2);
    expect(t.eventEmitter.emit.mock.calls[1][1]).toEqual(
      expect.objectContaining({ evaluationId: 'eid-plan', sessionId: SID, phase: 'plan' }),
    );
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
      phase: 'plan',
      inputFingerprint: 'cached-fp',
      score: 4.2,
    };
    t.evalsRepo.findByFingerprint.mockResolvedValueOnce(cachedRow);

    const result = await t.svc.run(SID, ['plan']);

    expect(result).toEqual([cachedRow]);
    expect(t.planAgent.evaluate).not.toHaveBeenCalled();
    expect(t.evalsRepo.createPhaseEvaluation).not.toHaveBeenCalled();
    expect(t.eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('runs the agent normally on cache miss (findByFingerprint returns null)', async () => {
    const t = makeOrchestrator({});
    // default mock already returns null — this test documents the
    // expected behavior on miss
    await t.svc.run(SID, ['plan']);
    expect(t.evalsRepo.findByFingerprint).toHaveBeenCalledTimes(1);
    expect(t.planAgent.evaluate).toHaveBeenCalledTimes(1);
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

  it('returns the winner row on P2002 concurrent-race conflict and does not emit event', async () => {
    const t = makeOrchestrator({});
    // First findByFingerprint (cache check) returns null → agent runs.
    // createPhaseEvaluation throws P2002 (another orchestrator beat us).
    // Second findByFingerprint (post-conflict) returns the winner.
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
    // Audit was not created on the conflict path (winner already has its audit).
    expect(t.evalsRepo.createEvaluationAudit).not.toHaveBeenCalled();
    // Event was not emitted on the conflict path (winner already emitted).
    expect(t.eventEmitter.emit).not.toHaveBeenCalled();
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
    // Cache miss → agent runs → P2002 thrown → re-query returns null.
    // This is "shouldn't happen" territory; we surface the original error
    // rather than silently invent a row.
    t.evalsRepo.findByFingerprint
      .mockResolvedValueOnce(null)  // initial cache check
      .mockResolvedValueOnce(null); // post-conflict re-query
    t.evalsRepo.createPhaseEvaluation.mockRejectedValueOnce({
      code: 'P2002',
      message: 'Unique constraint failed',
    });

    await expect(t.svc.run(SID, ['plan'])).rejects.toMatchObject({ code: 'P2002' });
  });
});
