import { Injectable } from '@nestjs/common';
import { EvaluationJobState, Phase } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { EvaluationJobType } from '../evaluation-queue.constants';

@Injectable()
export class EvaluationJobRepository {
  constructor(private readonly prisma: PrismaService) {}

  upsertQueued(data: {
    id: string;
    jobType: EvaluationJobType;
    sessionId: string;
    phase?: Phase;
    evaluationId?: string;
  }) {
    return this.prisma.evaluationJob.upsert({
      where: { id: data.id },
      create: {
        id: data.id,
        jobType: data.jobType,
        sessionId: data.sessionId,
        phase: data.phase ?? null,
        evaluationId: data.evaluationId ?? null,
        state: EvaluationJobState.queued,
      },
      update: {
        jobType: data.jobType,
        sessionId: data.sessionId,
        phase: data.phase ?? null,
        evaluationId: data.evaluationId ?? null,
        state: EvaluationJobState.queued,
        lastError: null,
        failedAt: null,
        completedAt: null,
        queuedAt: new Date(),
        startedAt: null,
      },
    });
  }

  markRunning(id: string, attempts: number) {
    return this.prisma.evaluationJob.update({
      where: { id },
      data: {
        state: EvaluationJobState.running,
        attempts,
        startedAt: new Date(),
        lastError: null,
      },
    });
  }

  markCompleted(id: string, evaluationId?: string) {
    return this.prisma.evaluationJob.update({
      where: { id },
      data: {
        state: EvaluationJobState.completed,
        evaluationId: evaluationId ?? undefined,
        completedAt: new Date(),
        failedAt: null,
        lastError: null,
      },
    });
  }

  markRetrying(id: string, attempts: number, error: string) {
    return this.prisma.evaluationJob.update({
      where: { id },
      data: {
        state: EvaluationJobState.queued,
        attempts,
        lastError: truncate(error),
      },
    });
  }

  markFailed(id: string, attempts: number, error: string) {
    return this.prisma.evaluationJob.update({
      where: { id },
      data: {
        state: EvaluationJobState.failed,
        attempts,
        lastError: truncate(error),
        failedAt: new Date(),
      },
    });
  }

  findById(id: string) {
    return this.prisma.evaluationJob.findUnique({ where: { id } });
  }

  findLatestForEvaluation(evaluationId: string, jobType?: EvaluationJobType) {
    return this.prisma.evaluationJob.findFirst({
      where: {
        evaluationId,
        ...(jobType ? { jobType } : {}),
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  findForSession(sessionId: string) {
    return this.prisma.evaluationJob.findMany({
      where: { sessionId },
      orderBy: { updatedAt: 'desc' },
    });
  }
}

function truncate(message: string): string {
  return message.length > 1000 ? `${message.slice(0, 1000)}...(truncated)` : message;
}
