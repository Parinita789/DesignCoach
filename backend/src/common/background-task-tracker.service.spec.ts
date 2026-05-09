import {
  BackgroundTaskTimeoutError,
  BackgroundTaskTracker,
  ShutdownInProgressError,
} from './background-task-tracker.service';

describe('BackgroundTaskTracker', () => {
  let tracker: BackgroundTaskTracker;

  beforeEach(() => {
    tracker = new BackgroundTaskTracker();
  });

  it('registers a promise and decrements size when it settles', async () => {
    let resolve: () => void = () => undefined;
    const p = new Promise<void>((r) => {
      resolve = r;
    });
    const tracked = tracker.track(p, 'test-task');
    expect(tracker.size()).toBe(1);
    resolve();
    await tracked;
    expect(tracker.size()).toBe(0);
  });

  it('catches rejections so unhandled errors do not propagate', async () => {
    const p = Promise.reject(new Error('boom'));
    const tracked = tracker.track(p, 'failing-task');
    await expect(tracked).resolves.toBeUndefined();
  });

  it('beforeApplicationShutdown awaits in-flight tasks before resolving', async () => {
    let resolveTask: () => void = () => undefined;
    const slow = new Promise<void>((r) => {
      resolveTask = r;
    });
    tracker.track(slow, 'slow-task');
    expect(tracker.size()).toBe(1);

    const drainPromise = tracker.beforeApplicationShutdown('SIGTERM');
    let drained = false;
    drainPromise.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    resolveTask();
    await drainPromise;
    expect(drained).toBe(true);
    expect(tracker.size()).toBe(0);
  });

  it('throws ShutdownInProgressError when track is called after shutdown begins', async () => {
    await tracker.beforeApplicationShutdown('SIGINT');
    const p = Promise.resolve('value');
    expect(() => tracker.track(p, 'late-task')).toThrow(ShutdownInProgressError);
    expect(tracker.size()).toBe(0);
    // The promise still resolves on its own; the test is about the
    // tracker refusing to accept new work, not about cancelling work
    // the caller already kicked off.
    await expect(p).resolves.toBe('value');
  });

  describe('per-task timeout', () => {
    it('rejects a task that exceeds its timeoutMs and increments timedOut counter', async () => {
      const hung = new Promise<void>(() => {
        /* never resolves */
      });
      const tracked = tracker.track(hung, 'hung-task', { timeoutMs: 30 });
      await tracked;
      const stats = tracker.getStats();
      expect(stats.totalTimedOut).toBe(1);
      expect(stats.totalFailed).toBe(0);
      expect(stats.recentFailures).toHaveLength(1);
      expect(stats.recentFailures[0].timedOut).toBe(true);
      expect(stats.recentFailures[0].errorName).toBe('BackgroundTaskTimeoutError');
    });

    it('honors the env-configured default when no per-call timeout is supplied', async () => {
      const config = {
        get: jest.fn((k: string) => (k === 'BACKGROUND_TASK_TIMEOUT_MS' ? '20' : undefined)),
      };
      const t = new BackgroundTaskTracker(config as never);
      const hung = new Promise<void>(() => {});
      await t.track(hung, 'env-timeout-task');
      expect(t.getStats().totalTimedOut).toBe(1);
    });

    it('a fast task settles before the timeout fires (no spurious timeout)', async () => {
      const tracked = tracker.track(Promise.resolve(), 'fast-task', { timeoutMs: 5_000 });
      await tracked;
      const stats = tracker.getStats();
      expect(stats.totalCompleted).toBe(1);
      expect(stats.totalTimedOut).toBe(0);
    });
  });

  describe('getStats', () => {
    it('reports tracked / completed / failed counters and a failure ring buffer', async () => {
      await tracker.track(Promise.resolve(), 'ok-1');
      await tracker.track(Promise.resolve(), 'ok-2');
      await tracker.track(Promise.reject(new Error('oops')), 'bad-1');
      await tracker.track(Promise.reject('string-error'), 'bad-2');

      const stats = tracker.getStats();
      expect(stats.totalTracked).toBe(4);
      expect(stats.totalCompleted).toBe(2);
      expect(stats.totalFailed).toBe(2);
      expect(stats.totalTimedOut).toBe(0);
      expect(stats.recentFailures).toHaveLength(2);
      expect(stats.recentFailures[0].label).toBe('bad-1');
      expect(stats.recentFailures[0].errorName).toBe('Error');
      expect(stats.recentFailures[0].message).toBe('oops');
      expect(stats.recentFailures[1].errorName).toBe('string');
      expect(stats.recentFailures[1].message).toBe('string-error');
    });
  });

  describe('drain', () => {
    it('reports a rejection count when some tasks fail during drain instead of falsely "all clean"', async () => {
      const warnSpy = jest
        .spyOn((tracker as unknown as { logger: { warn: (msg: string) => void } }).logger, 'warn')
        .mockImplementation(() => undefined);
      let resolveOk: () => void = () => undefined;
      let rejectBad: (err: Error) => void = () => undefined;
      tracker.track(
        new Promise<void>((r) => {
          resolveOk = r;
        }),
        'will-succeed',
      );
      // Wrap the rejection so the unhandled-rejection guard inside
      // track absorbs it during the drain window.
      tracker.track(
        new Promise<void>((_, rej) => {
          rejectBad = rej;
        }),
        'will-fail',
      );

      const drainP = tracker.beforeApplicationShutdown('SIGTERM');
      resolveOk();
      rejectBad(new Error('drain-time failure'));
      await drainP;

      // The "drained cleanly" log must NOT have been emitted; a warn
      // line should mention how many tasks failed during the drain
      // window (counters are how we know — wrapper promises always
      // resolve so allSettled can't see rejections).
      const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(warnCalls.some((m) => /1 failed during the drain window/.test(m))).toBe(true);
    });
  });
});
