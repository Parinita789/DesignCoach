import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { IncomingBuildEvent } from '../types/build-event.types';

@Injectable()
export class BuildEventsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insertBatch(sessionId: string, events: IncomingBuildEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    const rows = events.map((e) => ({
      sessionId,
      filePath: e.filePath,
      action: e.action,
      content: e.content ?? null,
      contentDiff: e.contentDiff ?? null,
      occurredAt: new Date(e.occurredAt),
    }));
    // Interactive transaction so we can read the actual inserted count
    // and increment by that — not by `events.length`. Today the two
    // match because createMany throws on conflict, but once we add an
    // idempotency-key UNIQUE constraint (Gap 16) and switch to
    // skipDuplicates, the input length will overcount the cached
    // counter on retry.
    const created = await this.prisma.$transaction(async (tx) => {
      const result = await tx.buildEvent.createMany({ data: rows });
      if (result.count > 0) {
        await tx.session.update({
          where: { id: sessionId },
          data: { buildEventCount: { increment: result.count } },
        });
      }
      return result;
    });
    return created.count;
  }

  // Audit / repair path: recompute buildEventCount from the canonical
  // events table and overwrite the cached counter if they disagree.
  // Returns both values so callers can log drift. Cheap to call from
  // an ops endpoint or a maintenance script; not invoked on the hot
  // path.
  async reconcileCount(sessionId: string): Promise<{ before: number; after: number }> {
    const [session, actual] = await Promise.all([
      this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { buildEventCount: true },
      }),
      this.prisma.buildEvent.count({ where: { sessionId } }),
    ]);
    const before = session?.buildEventCount ?? 0;
    if (before !== actual) {
      await this.prisma.session.update({
        where: { id: sessionId },
        data: { buildEventCount: actual },
      });
    }
    return { before, after: actual };
  }

  countForSession(sessionId: string) {
    return this.prisma.buildEvent.count({ where: { sessionId } });
  }

  findAllForSession(sessionId: string) {
    return this.prisma.buildEvent.findMany({
      where: { sessionId },
      orderBy: { occurredAt: 'asc' },
      select: {
        filePath: true,
        action: true,
        content: true,
        contentDiff: true,
        occurredAt: true,
      },
    });
  }

  async summaryForSession(sessionId: string) {
    const grouped = await this.prisma.buildEvent.groupBy({
      by: ['filePath'],
      where: { sessionId },
      _count: { _all: true },
      _min: { occurredAt: true },
      _max: { occurredAt: true },
    });
    return grouped
      .map((g) => ({
        filePath: g.filePath,
        eventCount: g._count._all,
        firstAt: g._min.occurredAt,
        lastAt: g._max.occurredAt,
      }))
      .sort((a, b) => {
        const da = a.firstAt?.getTime() ?? 0;
        const db = b.firstAt?.getTime() ?? 0;
        return da - db;
      });
  }
}
