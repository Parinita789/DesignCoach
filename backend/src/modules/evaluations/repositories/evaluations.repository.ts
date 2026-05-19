import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { Phase } from '../../phase-tagger/types/phase.types';
import { EvaluationAuditPayload, PhaseEvaluationResult } from '../types/evaluation.types';

@Injectable()
export class EvaluationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  createPhaseEvaluation(
    sessionId: string,
    phase: Phase,
    result: PhaseEvaluationResult,
    inputFingerprint: string | null,
  ) {
    return this.prisma.phaseEvaluation.create({
      data: {
        sessionId,
        phase,
        score: result.score,
        signalResults: result.signalResults as unknown as Prisma.InputJsonValue,
        feedbackText: result.feedbackText,
        topActionableItems: result.topActionableItems as unknown as Prisma.InputJsonValue,
        gapTopics: result.gapTopics as unknown as Prisma.InputJsonValue,
        inputFingerprint,
      },
    });
  }

  // Lookup for content-based caching. Returns the most-recent prior eval
  // with the same inputs (same fingerprint) for this session+phase, or
  // null if none exists. NULL fingerprints (pre-migration rows) are
  // never matched — they don't participate in caching.
  async findByFingerprint(sessionId: string, phase: Phase, inputFingerprint: string) {
    const row = await this.prisma.phaseEvaluation.findFirst({
      where: { sessionId, phase, inputFingerprint },
      orderBy: { evaluatedAt: 'desc' },
    });
    return row;
  }

  createEvaluationAudit(phaseEvaluationId: string, audit: EvaluationAuditPayload) {
    return this.prisma.evaluationAudit.create({
      data: {
        phaseEvaluationId,
        prompt: audit.prompt,
        rawResponse: audit.rawResponse,
        modelUsed: audit.modelUsed,
        tokensIn: audit.tokensIn,
        tokensOut: audit.tokensOut,
        cacheReadTokens: audit.cacheReadTokens,
        cacheCreationTokens: audit.cacheCreationTokens,
        latencyMs: audit.latencyMs ?? null,
        llmScore: audit.llmScore ?? null,
      },
    });
  }

  async findBySession(sessionId: string) {
    const rows = await this.prisma.phaseEvaluation.findMany({
      where: { sessionId },
      orderBy: { evaluatedAt: 'desc' },
      include: { audit: { select: { modelUsed: true } } },
    });
    return rows.map(({ audit, ...rest }) => ({
      ...rest,
      modelUsed: audit?.modelUsed ?? null,
    }));
  }

  async findById(evaluationId: string) {
    const row = await this.prisma.phaseEvaluation.findUnique({
      where: { id: evaluationId },
      include: { audit: { select: { modelUsed: true } } },
    });
    if (!row) return null;
    const { audit, ...rest } = row;
    return { ...rest, modelUsed: audit?.modelUsed ?? null };
  }

  findAuditByEvaluation(phaseEvaluationId: string) {
    return this.prisma.evaluationAudit.findUnique({ where: { phaseEvaluationId } });
  }
}
