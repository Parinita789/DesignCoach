import { UserOrIpThrottlerGuard } from './user-or-ip-throttler.guard';

// We bypass NestJS DI and exercise the overridden `getTracker` method
// directly — that's where 100% of the custom logic lives. The rest
// of the guard is unchanged from the @nestjs/throttler base class
// which has its own upstream coverage.

class TestableGuard extends UserOrIpThrottlerGuard {
  // expose the protected method for testing
  public testGetTracker(req: unknown) {
    return this.getTracker(req as never);
  }
}

function makeGuard() {
  // The parent ThrottlerGuard constructor needs options + storage +
  // reflector. We pass nothing because we never invoke canActivate;
  // only getTracker is under test, and it reads only from `req`.
  return new TestableGuard(
    undefined as never,
    undefined as never,
    undefined as never,
  );
}

describe('UserOrIpThrottlerGuard.getTracker', () => {
  it('returns user:<id> when an authenticated user is on the request', async () => {
    const guard = makeGuard();
    const req = { user: { id: 'uid-1', email: 'a@b.c' }, ip: '127.0.0.1' };
    await expect(guard.testGetTracker(req)).resolves.toBe('user:uid-1');
  });

  it('returns ip:<addr> when there is no user', async () => {
    const guard = makeGuard();
    const req = { ip: '203.0.113.42' };
    await expect(guard.testGetTracker(req)).resolves.toBe('ip:203.0.113.42');
  });

  it('returns ip:unknown when neither user nor req.ip is present', async () => {
    const guard = makeGuard();
    const req = {};
    await expect(guard.testGetTracker(req)).resolves.toBe('ip:unknown');
  });

  it('prefers user over IP — same client across IPs shares a bucket', async () => {
    const guard = makeGuard();
    const reqA = { user: { id: 'uid-1', email: 'a@b.c' }, ip: '10.0.0.1' };
    const reqB = { user: { id: 'uid-1', email: 'a@b.c' }, ip: '10.0.0.2' };
    await expect(guard.testGetTracker(reqA)).resolves.toBe('user:uid-1');
    await expect(guard.testGetTracker(reqB)).resolves.toBe('user:uid-1');
  });

  it('two different anonymous IPs get separate buckets', async () => {
    const guard = makeGuard();
    const a = await guard.testGetTracker({ ip: '1.1.1.1' });
    const b = await guard.testGetTracker({ ip: '2.2.2.2' });
    expect(a).not.toBe(b);
  });
});
