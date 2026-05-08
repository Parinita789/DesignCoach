import { BuildAIInteractionsRepository } from './build-ai-interactions.repository';

describe('BuildAIInteractionsRepository', () => {
  function makePrisma() {
    return {
      buildAIInteraction: {
        createMany: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn(),
      },
    };
  }

  const interactions = [
    {
      tool: 'claude-code',
      externalSessionId: 'cc-1',
      turnIndex: 0,
      role: 'user' as const,
      text: 'Implement login',
      occurredAt: '2026-05-07T00:00:00.000Z',
    },
    {
      tool: 'claude-code',
      externalSessionId: 'cc-1',
      turnIndex: 1,
      role: 'assistant' as const,
      text: 'Sure — here is auth.ts',
      occurredAt: '2026-05-07T00:00:01.000Z',
    },
  ];

  it('inserts batch with skipDuplicates honored', async () => {
    const prisma = makePrisma();
    prisma.buildAIInteraction.createMany.mockResolvedValue({ count: 2 });
    const repo = new BuildAIInteractionsRepository(prisma as never);
    const accepted = await repo.insertBatch('sid', interactions);

    expect(accepted).toBe(2);
    const call = prisma.buildAIInteraction.createMany.mock.calls[0][0];
    expect(call.skipDuplicates).toBe(true);
    expect(call.data).toHaveLength(2);
    expect(call.data[0]).toMatchObject({
      sessionId: 'sid',
      tool: 'claude-code',
      externalSessionId: 'cc-1',
      turnIndex: 0,
      role: 'user',
      text: 'Implement login',
      occurredAt: new Date('2026-05-07T00:00:00.000Z'),
    });
  });

  it('returns count below the input length when the unique index drops dupes', async () => {
    const prisma = makePrisma();
    prisma.buildAIInteraction.createMany.mockResolvedValue({ count: 1 });
    const repo = new BuildAIInteractionsRepository(prisma as never);
    const accepted = await repo.insertBatch('sid', interactions);
    expect(accepted).toBe(1);
  });

  it('short-circuits on an empty batch', async () => {
    const prisma = makePrisma();
    const repo = new BuildAIInteractionsRepository(prisma as never);
    const accepted = await repo.insertBatch('sid', []);
    expect(accepted).toBe(0);
    expect(prisma.buildAIInteraction.createMany).not.toHaveBeenCalled();
  });

  it('countsForSession returns total + distinct external sessions', async () => {
    const prisma = makePrisma();
    prisma.buildAIInteraction.count.mockResolvedValue(15);
    prisma.buildAIInteraction.findMany.mockResolvedValue([
      { externalSessionId: 'cc-1' },
      { externalSessionId: 'cc-2' },
      { externalSessionId: 'cc-3' },
    ]);
    const repo = new BuildAIInteractionsRepository(prisma as never);
    const out = await repo.countsForSession('sid');
    expect(out).toEqual({ total: 15, distinctSessions: 3 });
    const findArgs = prisma.buildAIInteraction.findMany.mock.calls[0][0];
    expect(findArgs.distinct).toEqual(['externalSessionId']);
  });
});
