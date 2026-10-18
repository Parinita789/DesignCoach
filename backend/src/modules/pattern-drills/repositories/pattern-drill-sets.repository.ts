import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class PatternDrillSetsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findOutstanding(userId: string) {
    return this.prisma.patternDrillSet.findFirst({
      where: { userId, submittedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  create(data: {
    userId: string;
    coveredPatterns: Prisma.InputJsonValue;
    items: Prisma.InputJsonValue;
  }) {
    return this.prisma.patternDrillSet.create({ data });
  }

  findByIdForUser(id: string, userId: string) {
    return this.prisma.patternDrillSet.findFirst({ where: { id, userId } });
  }

  listByUser(userId: string) {
    return this.prisma.patternDrillSet.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Feeds the history-driven pattern picker: only gradedResult is needed
  // (per-item {pattern, correct}), not the full row, to tally how many
  // times each pattern has actually been attempted.
  findGradedResultsByUser(userId: string) {
    return this.prisma.patternDrillSet.findMany({
      where: { userId, submittedAt: { not: null } },
      select: { gradedResult: true },
    });
  }

  markSubmitted(
    id: string,
    data: { submission: Prisma.InputJsonValue; gradedResult: Prisma.InputJsonValue },
  ) {
    return this.prisma.patternDrillSet.update({
      where: { id },
      data: {
        submission: data.submission,
        gradedResult: data.gradedResult,
        submittedAt: new Date(),
      },
    });
  }

  delete(id: string) {
    return this.prisma.patternDrillSet.delete({ where: { id } });
  }

  updateManualStatus(id: string, manualStatus: Prisma.InputJsonValue) {
    return this.prisma.patternDrillSet.update({ where: { id }, data: { manualStatus } });
  }
}
