import { Prisma } from '@prisma/client';
import { LlmSpendRepository } from './llm-spend.repository';
import type { PrismaService } from '../../../database/prisma.service';

function makeRepo() {
  const prisma = {
    llmSpend: {
      create: jest.fn(),
      aggregate: jest.fn(),
    },
  } as unknown as PrismaService;
  return { repo: new LlmSpendRepository(prisma), prisma };
}

const baseParams = {
  userId: 'uid-1',
  provider: 'anthropic',
  model: 'claude-opus-4-7',
  tokensIn: 100,
  tokensOut: 200,
  cacheReadTokens: 50,
  cacheCreationTokens: 25,
  estimatedCostUsd: 1.234567,
  route: 'plan.evaluate',
};

describe('LlmSpendRepository.insert', () => {
  it('maps every input field to the Prisma create shape', async () => {
    const { repo, prisma } = makeRepo();
    (prisma.llmSpend.create as jest.Mock).mockResolvedValue({});
    await repo.insert(baseParams);
    const call = (prisma.llmSpend.create as jest.Mock).mock.calls[0][0];
    expect(call.data).toMatchObject({
      userId: 'uid-1',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      tokensIn: 100,
      tokensOut: 200,
      cacheReadTokens: 50,
      cacheCreationTokens: 25,
      route: 'plan.evaluate',
    });
  });

  it('wraps the numeric cost in Prisma.Decimal (so 1.234567 survives the round-trip)', async () => {
    const { repo, prisma } = makeRepo();
    (prisma.llmSpend.create as jest.Mock).mockResolvedValue({});
    await repo.insert(baseParams);
    const passed = (prisma.llmSpend.create as jest.Mock).mock.calls[0][0].data.estimatedCostUsd;
    expect(passed).toBeInstanceOf(Prisma.Decimal);
    expect(passed.toString()).toBe('1.234567');
  });

  it('accepts $0 (subscription providers like claude_cli always pass 0)', async () => {
    const { repo, prisma } = makeRepo();
    (prisma.llmSpend.create as jest.Mock).mockResolvedValue({});
    await repo.insert({ ...baseParams, estimatedCostUsd: 0 });
    const passed = (prisma.llmSpend.create as jest.Mock).mock.calls[0][0].data.estimatedCostUsd;
    expect(passed.toString()).toBe('0');
  });
});

describe('LlmSpendRepository.sumSinceTodayUtcMidnight', () => {
  it('filters by userId + occurredAt >= todayUtcMidnight (the hot cap-check path)', async () => {
    const { repo, prisma } = makeRepo();
    (prisma.llmSpend.aggregate as jest.Mock).mockResolvedValue({
      _sum: { estimatedCostUsd: new Prisma.Decimal('0') },
    });
    await repo.sumSinceTodayUtcMidnight('uid-1');
    const call = (prisma.llmSpend.aggregate as jest.Mock).mock.calls[0][0];
    expect(call.where.userId).toBe('uid-1');
    expect(call.where.occurredAt.gte).toBeInstanceOf(Date);
    // Strictly at UTC midnight — no hour/minute drift.
    const lower = call.where.occurredAt.gte as Date;
    expect(lower.getUTCHours()).toBe(0);
    expect(lower.getUTCMinutes()).toBe(0);
    expect(lower.getUTCSeconds()).toBe(0);
    expect(lower.getUTCMilliseconds()).toBe(0);
  });

  it('asks Prisma to SUM the estimatedCostUsd column', async () => {
    const { repo, prisma } = makeRepo();
    (prisma.llmSpend.aggregate as jest.Mock).mockResolvedValue({
      _sum: { estimatedCostUsd: new Prisma.Decimal('2.50') },
    });
    await repo.sumSinceTodayUtcMidnight('uid-1');
    const call = (prisma.llmSpend.aggregate as jest.Mock).mock.calls[0][0];
    expect(call._sum).toEqual({ estimatedCostUsd: true });
  });

  it('returns a JS number unwrapped from Prisma.Decimal', async () => {
    const { repo, prisma } = makeRepo();
    (prisma.llmSpend.aggregate as jest.Mock).mockResolvedValue({
      _sum: { estimatedCostUsd: new Prisma.Decimal('4.20') },
    });
    await expect(repo.sumSinceTodayUtcMidnight('uid-1')).resolves.toBe(4.2);
  });

  it('returns 0 when the user has no rows (Prisma returns _sum.estimatedCostUsd = null)', async () => {
    const { repo, prisma } = makeRepo();
    (prisma.llmSpend.aggregate as jest.Mock).mockResolvedValue({
      _sum: { estimatedCostUsd: null },
    });
    await expect(repo.sumSinceTodayUtcMidnight('uid-1')).resolves.toBe(0);
  });
});
