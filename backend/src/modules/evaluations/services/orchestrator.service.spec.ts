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
    createPhaseEvaluation: jest.fn().mockImplementation(async (_sid, phase) => ({
      id: `eid-${phase}`,
      phase,
    })),
    createEvaluationAudit: jest.fn().mockResolvedValue(undefined),
  };
  const config = { get: jest.fn() };
  const mentorService = { generate: jest.fn().mockResolvedValue(undefined) };
  const signalMentorService = { generate: jest.fn().mockResolvedValue(undefined) };
  const buildEventsRepo = { findAllForSession: jest.fn().mockResolvedValue(deps.events ?? []) };
  const buildAiRepo = { findAllForSession: jest.fn().mockResolvedValue(deps.aiTurns ?? []) };

  const svc = new OrchestratorService(
    sessionsService as never,
    snapshotsService as never,
    aiInteractionsRepo as never,
    planAgent as never,
    buildAgent as never,
    evalsRepo as never,
    config as never,
    mentorService as never,
    signalMentorService as never,
    buildEventsRepo as never,
    buildAiRepo as never,
  );

  return {
    svc,
    planAgent,
    buildAgent,
    mentorService,
    signalMentorService,
    buildEventsRepo,
    buildAiRepo,
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

  it('only fires mentor + signal-mentor on plan-phase evals', async () => {
    const t = makeOrchestrator({});
    await t.svc.run(SID, ['build']);
    expect(t.mentorService.generate).not.toHaveBeenCalled();
    expect(t.signalMentorService.generate).not.toHaveBeenCalled();

    await t.svc.run(SID, ['plan']);
    expect(t.mentorService.generate).toHaveBeenCalledTimes(1);
    expect(t.signalMentorService.generate).toHaveBeenCalledTimes(1);
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
    expect(t.buildEventsRepo.findAllForSession).not.toHaveBeenCalled();
    expect(t.buildAiRepo.findAllForSession).not.toHaveBeenCalled();
  });
});
