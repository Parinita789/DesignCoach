import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class SnapshotsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: {
    sessionId: string;
    elapsedMinutes: number;
    inferredPhase: string | null;
    artifacts: Prisma.InputJsonValue;
  }) {
    return this.prisma.snapshot.create({ data });
  }

  findBySession(sessionId: string, opts: { take?: number; skip?: number } = {}) {
    return this.prisma.snapshot.findMany({
      where: { sessionId },
      orderBy: { takenAt: 'desc' },
      take: opts.take,
      skip: opts.skip,
    });
  }

  findLatest(sessionId: string) {
    return this.prisma.snapshot.findFirst({
      where: { sessionId },
      orderBy: { takenAt: 'desc' },
    });
  }

  latestJsonlOffset(_sessionId: string): Promise<number> {
    throw new Error('Not implemented');
  }
}
