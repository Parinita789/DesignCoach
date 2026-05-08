import { EvaluationsRepository } from './evaluations.repository';
import { EvaluationAuditPayload, PhaseEvaluationResult } from '../types/evaluation.types';

describe('EvaluationsRepository', () => {
  let repo: EvaluationsRepository;
  const phaseEvaluation = {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
  };
  const evaluationAudit = {
    create: jest.fn(),
    findUnique: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new EvaluationsRepository({ phaseEvaluation, evaluationAudit } as never);
  });

  const sampleResult: PhaseEvaluationResult = {
    phase: 'plan',
    score: 4.25,
    signalResults: { sig_a: { result: 'hit', evidence: 'because reasons' } },
    feedbackText: 'good plan',
    topActionableItems: ['add capacity numbers'],
    gapTopics: [
      {
        name: 'capacity_estimation',
        coverage: 'missed' as const,
        whyExpected: '10K RPS NFR but plan.md has no back-of-envelope numbers',
      },
    ],
    audit: {
      prompt: '<rendered prompt>',
      rawResponse: '{"score": 4.25}',
      modelUsed: 'claude-opus-4-7',
      tokensIn: 1200,
      tokensOut: 200,
      cacheReadTokens: 800,
      cacheCreationTokens: 0,
      latencyMs: 4321,
      llmScore: 4.0,
    },
  };

  describe('createPhaseEvaluation', () => {
    it('inserts a row scoped to (sessionId, phase) without audit fields', async () => {
      phaseEvaluation.create.mockResolvedValue({ id: 'eid-1' });

      await repo.createPhaseEvaluation('sid-1', 'plan', sampleResult);

      expect(phaseEvaluation.create).toHaveBeenCalledWith({
        data: {
          sessionId: 'sid-1',
          phase: 'plan',
          score: 4.25,
          signalResults: sampleResult.signalResults,
          feedbackText: 'good plan',
          topActionableItems: sampleResult.topActionableItems,
          gapTopics: sampleResult.gapTopics,
        },
      });
    });
  });

  describe('createEvaluationAudit', () => {
    it('inserts a 1:1 audit row keyed by phaseEvaluationId', async () => {
      evaluationAudit.create.mockResolvedValue({ id: 'aid-1' });
      const audit: EvaluationAuditPayload = sampleResult.audit;

      const result = await repo.createEvaluationAudit('eid-1', audit);

      expect(evaluationAudit.create).toHaveBeenCalledWith({
        data: {
          phaseEvaluationId: 'eid-1',
          prompt: audit.prompt,
          rawResponse: audit.rawResponse,
          modelUsed: audit.modelUsed,
          tokensIn: audit.tokensIn,
          tokensOut: audit.tokensOut,
          cacheReadTokens: audit.cacheReadTokens,
          cacheCreationTokens: audit.cacheCreationTokens,
          latencyMs: audit.latencyMs,
          llmScore: audit.llmScore,
        },
      });
      expect(result).toEqual({ id: 'aid-1' });
    });
  });

  describe('findAuditByEvaluation', () => {
    it('looks up the audit row by the unique phaseEvaluationId', async () => {
      evaluationAudit.findUnique.mockResolvedValue({ id: 'aid-1' });
      await repo.findAuditByEvaluation('eid-1');
      expect(evaluationAudit.findUnique).toHaveBeenCalledWith({
        where: { phaseEvaluationId: 'eid-1' },
      });
    });

    it('returns null when no audit exists for the evaluation', async () => {
      evaluationAudit.findUnique.mockResolvedValue(null);
      expect(await repo.findAuditByEvaluation('missing')).toBeNull();
    });
  });

  describe('findBySession / findById', () => {
    it('lists evaluations for a session, newest first, with audit.modelUsed flattened', async () => {
      phaseEvaluation.findMany.mockResolvedValue([
        { id: 'eid-1', score: 4, audit: { modelUsed: 'claude-opus-4-7' } },
        { id: 'eid-2', score: 3, audit: null },
      ]);
      const out = await repo.findBySession('sid-1');
      expect(phaseEvaluation.findMany).toHaveBeenCalledWith({
        where: { sessionId: 'sid-1' },
        orderBy: { evaluatedAt: 'desc' },
        include: { audit: { select: { modelUsed: true } } },
      });
      expect(out).toEqual([
        { id: 'eid-1', score: 4, modelUsed: 'claude-opus-4-7' },
        { id: 'eid-2', score: 3, modelUsed: null },
      ]);
    });

    it('looks up a single evaluation by id, flattening audit.modelUsed', async () => {
      phaseEvaluation.findUnique.mockResolvedValue({
        id: 'eid-1',
        audit: { modelUsed: 'claude-haiku-4-5' },
      });
      const out = await repo.findById('eid-1');
      expect(phaseEvaluation.findUnique).toHaveBeenCalledWith({
        where: { id: 'eid-1' },
        include: { audit: { select: { modelUsed: true } } },
      });
      expect(out).toEqual({ id: 'eid-1', modelUsed: 'claude-haiku-4-5' });
    });

    it('returns null from findById when the row does not exist', async () => {
      phaseEvaluation.findUnique.mockResolvedValue(null);
      expect(await repo.findById('missing')).toBeNull();
    });
  });
});
