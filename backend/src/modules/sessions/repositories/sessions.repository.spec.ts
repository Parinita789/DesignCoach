import { SessionsRepository } from './sessions.repository';
import { SessionStatus } from '@prisma/client';

describe('SessionsRepository', () => {
  let repo: SessionsRepository;
  const session = {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new SessionsRepository({ session } as never);
  });

  describe('create', () => {
    it('inserts a session row keyed by questionId', async () => {
      session.create.mockResolvedValue({ id: 'sid-1' });
      const result = await repo.create({ questionId: 'qid-1' });

      expect(session.create).toHaveBeenCalledWith({
        data: { questionId: 'qid-1', seniority: null },
      });
      expect(result).toEqual({ id: 'sid-1' });
    });
  });

  describe('findById', () => {
    it('queries by unique id', async () => {
      session.findUnique.mockResolvedValue({ id: 'sid-1' });
      await repo.findById('sid-1');

      expect(session.findUnique).toHaveBeenCalledWith({ where: { id: 'sid-1' } });
    });

    it('returns null when not found', async () => {
      session.findUnique.mockResolvedValue(null);
      expect(await repo.findById('missing')).toBeNull();
    });
  });

  describe('findByIdWithQuestion', () => {
    it('includes the parent question', async () => {
      session.findUnique.mockResolvedValue({ id: 'sid-1', question: { prompt: 'X' } });
      await repo.findByIdWithQuestion('sid-1');

      expect(session.findUnique).toHaveBeenCalledWith({
        where: { id: 'sid-1' },
        include: { question: true },
      });
    });
  });

  describe('findAll', () => {
    it('orders by startedAt desc', async () => {
      session.findMany.mockResolvedValue([]);
      await repo.findAll();

      expect(session.findMany).toHaveBeenCalledWith({ orderBy: { startedAt: 'desc' } });
    });
  });

  describe('markEnded', () => {
    it('updates status and stamps endedAt', async () => {
      session.update.mockResolvedValue({ id: 'sid-1' });
      const before = Date.now();
      await repo.markEnded('sid-1', SessionStatus.completed);
      const after = Date.now();

      expect(session.update).toHaveBeenCalledTimes(1);
      const call = session.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'sid-1' });
      expect(call.data.status).toBe(SessionStatus.completed);
      expect(call.data.endedAt).toBeInstanceOf(Date);
      expect(call.data.endedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(call.data.endedAt.getTime()).toBeLessThanOrEqual(after);
    });

    it('passes the abandoned status through', async () => {
      session.update.mockResolvedValue({ id: 'sid-1' });
      await repo.markEnded('sid-1', SessionStatus.abandoned);
      expect(session.update.mock.calls[0][0].data.status).toBe(SessionStatus.abandoned);
    });
  });

  describe('buildTokenHash redaction (security)', () => {
    const dbRow = {
      id: 'sid-1',
      questionId: 'qid-1',
      buildTokenHash: '$2b$10$secret-hash-must-not-leak',
      buildStartedAt: new Date('2026-05-07T00:00:00Z'),
      buildEndedAt: null,
      buildEventCount: 3,
      status: 'completed',
    };

    it('strips buildTokenHash from findById', async () => {
      session.findUnique.mockResolvedValue(dbRow);
      const out = await repo.findById('sid-1');
      expect(out).not.toBeNull();
      expect((out as Record<string, unknown>).buildTokenHash).toBeUndefined();
      expect(out!.buildEventCount).toBe(3);
    });

    it('strips buildTokenHash from findByIdWithQuestion', async () => {
      session.findUnique.mockResolvedValue({ ...dbRow, question: { prompt: 'X' } });
      const out = await repo.findByIdWithQuestion('sid-1');
      expect((out as Record<string, unknown>).buildTokenHash).toBeUndefined();
      expect(out!.buildStartedAt).toEqual(new Date('2026-05-07T00:00:00Z'));
    });

    it('strips buildTokenHash from each row of findAll', async () => {
      session.findMany.mockResolvedValue([dbRow, { ...dbRow, id: 'sid-2' }]);
      const rows = await repo.findAll();
      for (const r of rows) {
        expect((r as Record<string, unknown>).buildTokenHash).toBeUndefined();
      }
      expect(rows.length).toBe(2);
    });

    it('strips buildTokenHash from markEnded result', async () => {
      session.update.mockResolvedValue(dbRow);
      const out = await repo.markEnded('sid-1', SessionStatus.completed);
      expect((out as Record<string, unknown>).buildTokenHash).toBeUndefined();
    });

    it('returns null unchanged from findById when row is missing', async () => {
      session.findUnique.mockResolvedValue(null);
      expect(await repo.findById('missing')).toBeNull();
    });
  });
});
