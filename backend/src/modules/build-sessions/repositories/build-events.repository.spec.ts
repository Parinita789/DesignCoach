import { BuildEventsRepository } from './build-events.repository';
import { IncomingBuildEvent } from '../types/build-event.types';

describe('BuildEventsRepository', () => {
  function makePrisma() {
    return {
      buildEvent: { createMany: jest.fn(), count: jest.fn() },
      session: { update: jest.fn(), findUnique: jest.fn() },
      $transaction: jest.fn(),
    };
  }

  const events: IncomingBuildEvent[] = [
    { filePath: 'a.ts', action: 'created', content: 'x', occurredAt: '2026-05-07T00:00:00.000Z' },
    { filePath: 'a.ts', action: 'modified', contentDiff: '+y', occurredAt: '2026-05-07T00:00:01.000Z' },
  ];

  it('inserts rows + bumps buildEventCount by the actual inserted count in one transaction', async () => {
    const prisma = makePrisma();
    const tx = {
      buildEvent: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
      session: { update: jest.fn().mockResolvedValue({ id: 'sid' }) },
    };
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));
    const repo = new BuildEventsRepository(prisma as never);

    const accepted = await repo.insertBatch('sid', events);

    expect(accepted).toBe(2);
    expect(tx.buildEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          sessionId: 'sid',
          filePath: 'a.ts',
          action: 'created',
          content: 'x',
          contentDiff: null,
          occurredAt: new Date('2026-05-07T00:00:00.000Z'),
        }),
        expect.objectContaining({
          filePath: 'a.ts',
          action: 'modified',
          content: null,
          contentDiff: '+y',
        }),
      ],
    });
    expect(tx.session.update).toHaveBeenCalledWith({
      where: { id: 'sid' },
      data: { buildEventCount: { increment: 2 } },
    });
  });

  it('skips the counter update when no rows were actually inserted', async () => {
    const prisma = makePrisma();
    const tx = {
      buildEvent: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
      session: { update: jest.fn() },
    };
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));
    const repo = new BuildEventsRepository(prisma as never);

    const accepted = await repo.insertBatch('sid', events);

    expect(accepted).toBe(0);
    expect(tx.session.update).not.toHaveBeenCalled();
  });

  it('short-circuits on an empty batch (no DB calls)', async () => {
    const prisma = makePrisma();
    const repo = new BuildEventsRepository(prisma as never);
    const accepted = await repo.insertBatch('sid', []);
    expect(accepted).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  describe('reconcileCount', () => {
    it('overwrites the cached counter when it disagrees with the canonical count', async () => {
      const prisma = makePrisma();
      prisma.session.findUnique.mockResolvedValue({ buildEventCount: 5 });
      prisma.buildEvent.count.mockResolvedValue(7);
      const repo = new BuildEventsRepository(prisma as never);

      const result = await repo.reconcileCount('sid');

      expect(result).toEqual({ before: 5, after: 7 });
      expect(prisma.session.update).toHaveBeenCalledWith({
        where: { id: 'sid' },
        data: { buildEventCount: 7 },
      });
    });

    it('does not write when the cached counter already matches', async () => {
      const prisma = makePrisma();
      prisma.session.findUnique.mockResolvedValue({ buildEventCount: 7 });
      prisma.buildEvent.count.mockResolvedValue(7);
      const repo = new BuildEventsRepository(prisma as never);

      const result = await repo.reconcileCount('sid');

      expect(result).toEqual({ before: 7, after: 7 });
      expect(prisma.session.update).not.toHaveBeenCalled();
    });
  });
});
