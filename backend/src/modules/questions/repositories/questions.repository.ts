import { Injectable } from '@nestjs/common';
import { QuestionKind as PrismaQuestionKind } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class QuestionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: { prompt: string; rubricVersion: string; kind: PrismaQuestionKind }) {
    return this.prisma.question.create({ data });
  }

  async findAll(opts: { take?: number; skip?: number } = {}) {
    const rows = await this.prisma.question.findMany({
      orderBy: { createdAt: 'desc' },
      take: opts.take,
      skip: opts.skip,
      include: {
        sessions: {
          include: {
            phaseEvaluations: {
              orderBy: { evaluatedAt: 'desc' },
              include: { audit: { select: { modelUsed: true } } },
            },
          },
          orderBy: { startedAt: 'asc' },
        },
      },
    });
    return rows.map(flattenQuestion);
  }

  async deleteByIdCascading(id: string): Promise<string[]> {
    const sessions = await this.prisma.session.findMany({
      where: { questionId: id },
      select: { id: true },
    });
    const sessionIds = sessions.map((s) => s.id);
    await this.prisma.$transaction([
      this.prisma.session.deleteMany({ where: { questionId: id } }),
      this.prisma.question.delete({ where: { id } }),
    ]);
    return sessionIds;
  }

  async findById(id: string) {
    const row = await this.prisma.question.findUnique({
      where: { id },
      include: {
        sessions: {
          include: {
            phaseEvaluations: {
              orderBy: { evaluatedAt: 'desc' },
              include: { audit: { select: { modelUsed: true } } },
            },
          },
          orderBy: { startedAt: 'asc' },
        },
      },
    });
    return row ? flattenQuestion(row) : null;
  }
}

function flattenQuestion<
  T extends {
    sessions: Array<{
      phaseEvaluations: Array<{ audit: { modelUsed: string } | null } & Record<string, unknown>>;
    }>;
  },
>(question: T): T {
  return {
    ...question,
    sessions: question.sessions.map((s) => ({
      ...s,
      phaseEvaluations: s.phaseEvaluations.map(({ audit, ...rest }) => ({
        ...rest,
        modelUsed: audit?.modelUsed ?? null,
      })),
    })),
  } as T;
}
