import * as bcrypt from 'bcryptjs';
import { BuildTokenService } from './build-token.service';

describe('BuildTokenService', () => {
  function makePrisma() {
    return {
      session: {
        update: jest.fn(),
        findUnique: jest.fn(),
      },
    };
  }

  describe('mintForSession', () => {
    it('writes a bcrypt hash + buildStartedAt and returns the plaintext token', async () => {
      const prisma = makePrisma();
      prisma.session.update.mockResolvedValue({});
      const svc = new BuildTokenService(prisma as never);

      const out = await svc.mintForSession('sid-1');

      expect(out.sessionId).toBe('sid-1');
      expect(out.expiresInMinutes).toBe(60);
      expect(out.buildStartedAt).toBeInstanceOf(Date);
      // Token shape: <sessionId>.<hex>
      const [sid, secret] = out.token.split('.');
      expect(sid).toBe('sid-1');
      expect(secret).toMatch(/^[0-9a-f]{64}$/);

      const call = prisma.session.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'sid-1' });
      expect(call.data.buildEndedAt).toBeNull();
      expect(call.data.buildStartedAt).toBeInstanceOf(Date);
      expect(call.data.buildTokenHash).toMatch(/^\$2[ab]\$/);
      // Persisted hash matches the secret half (not the full token).
      expect(await bcrypt.compare(secret, call.data.buildTokenHash)).toBe(true);
      expect(await bcrypt.compare(out.token, call.data.buildTokenHash)).toBe(false);
    });
  });

  describe('verify', () => {
    function withSession(row: Record<string, unknown> | null) {
      const prisma = makePrisma();
      prisma.session.findUnique.mockResolvedValue(row);
      return { prisma, svc: new BuildTokenService(prisma as never) };
    }

    it('rejects undefined / empty / bare strings', async () => {
      const { svc } = withSession(null);
      expect(await svc.verify(undefined)).toBeNull();
      expect(await svc.verify('')).toBeNull();
      expect(await svc.verify('no-dot')).toBeNull();
      expect(await svc.verify('.no-id')).toBeNull();
      expect(await svc.verify('no-secret.')).toBeNull();
    });

    it('rejects when the id half is not a UUID (no DB call)', async () => {
      const { svc, prisma } = withSession(null);
      expect(await svc.verify('junk.notreal')).toBeNull();
      expect(prisma.session.findUnique).not.toHaveBeenCalled();
    });

    it('rejects when the session does not exist', async () => {
      const { svc } = withSession(null);
      const out = await svc.verify('00000000-0000-0000-0000-000000000000.deadbeef');
      expect(out).toBeNull();
    });

    it('rejects when buildTokenHash is null (start-build never called)', async () => {
      const { svc } = withSession({
        id: 'sid',
        buildTokenHash: null,
        buildStartedAt: new Date(),
        buildEndedAt: null,
        status: 'completed',
      });
      const out = await svc.verify('11111111-2222-3333-4444-555555555555.deadbeef');
      expect(out).toBeNull();
    });

    it('rejects when the session is abandoned', async () => {
      const hash = await bcrypt.hash('secret', 4);
      const { svc } = withSession({
        id: 'sid',
        buildTokenHash: hash,
        buildStartedAt: new Date(),
        buildEndedAt: null,
        status: 'abandoned',
      });
      expect(await svc.verify('11111111-2222-3333-4444-555555555555.secret')).toBeNull();
    });

    it('rejects when buildEndedAt is set (already finished)', async () => {
      const hash = await bcrypt.hash('secret', 4);
      const { svc } = withSession({
        id: 'sid',
        buildTokenHash: hash,
        buildStartedAt: new Date(),
        buildEndedAt: new Date(),
        status: 'completed',
      });
      expect(await svc.verify('11111111-2222-3333-4444-555555555555.secret')).toBeNull();
    });

    it('rejects when the token is older than 60 minutes', async () => {
      const hash = await bcrypt.hash('secret', 4);
      const { svc } = withSession({
        id: 'sid',
        buildTokenHash: hash,
        buildStartedAt: new Date(Date.now() - 61 * 60_000),
        buildEndedAt: null,
        status: 'completed',
      });
      expect(await svc.verify('11111111-2222-3333-4444-555555555555.secret')).toBeNull();
    });

    it('rejects when the secret half does not match the stored hash', async () => {
      const hash = await bcrypt.hash('right-secret', 4);
      const { svc } = withSession({
        id: '11111111-2222-3333-4444-555555555555',
        buildTokenHash: hash,
        buildStartedAt: new Date(),
        buildEndedAt: null,
        status: 'completed',
      });
      expect(await svc.verify('11111111-2222-3333-4444-555555555555.wrong')).toBeNull();
    });

    it('returns the sessionId on a fresh, matching token', async () => {
      const hash = await bcrypt.hash('right-secret', 4);
      const { svc } = withSession({
        id: '11111111-2222-3333-4444-555555555555',
        buildTokenHash: hash,
        buildStartedAt: new Date(),
        buildEndedAt: null,
        status: 'completed',
      });
      expect(await svc.verify('11111111-2222-3333-4444-555555555555.right-secret')).toEqual({
        sessionId: '11111111-2222-3333-4444-555555555555',
      });
    });
  });
});
