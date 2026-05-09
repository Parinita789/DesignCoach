import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DEFAULT_SHUTDOWN_AWAIT_MS = 30_000;
const DEFAULT_PER_TASK_TIMEOUT_MS = 90_000;
const RECENT_FAILURES_CAPACITY = 50;

/**
 * Thrown synchronously by `track()` when shutdown is in progress.
 * Callers that wish to degrade gracefully (e.g. log "deferred" and
 * proceed without dispatching) should catch this; otherwise it
 * bubbles up through the request and the response surfaces a
 * deterministic error rather than the prior silent-loss behavior.
 */
export class ShutdownInProgressError extends Error {
  constructor(label: string) {
    super(`Cannot track new background task "${label}": shutdown in progress.`);
    this.name = 'ShutdownInProgressError';
  }
}

/**
 * Thrown by the per-task timeout wrapper. Counted separately from
 * "task threw on its own" in `getStats()` so a hung-network signal
 * is distinguishable from a model error.
 */
export class BackgroundTaskTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`Background task "${label}" exceeded ${ms}ms timeout.`);
    this.name = 'BackgroundTaskTimeoutError';
  }
}

export interface TrackOptions {
  /**
   * Hard ceiling on this task's runtime. The wrapper rejects with
   * BackgroundTaskTimeoutError if the inner promise hasn't settled.
   * Defaults to BACKGROUND_TASK_TIMEOUT_MS env / 90s.
   */
  timeoutMs?: number;
}

export interface TaskFailureRecord {
  label: string;
  errorName: string;
  message: string;
  failedAt: Date;
  durationMs: number;
  timedOut: boolean;
}

export interface BackgroundTaskStats {
  inflight: number;
  totalTracked: number;
  totalCompleted: number;
  totalFailed: number;
  totalTimedOut: number;
  recentFailures: TaskFailureRecord[];
}

/**
 * In-process background-task tracker.
 *
 * KNOWN STRUCTURAL LIMITATION (read this before you reach for it):
 *
 *   Tasks tracked here live in process memory only. A SIGKILL, OOM
 *   kill, or unhandled crash drops the in-flight task with no
 *   record — the user's mentor never lands and there is nothing in
 *   the DB to replay from. `BeforeApplicationShutdown` only fires
 *   on graceful SIGTERM / SIGINT; a hard kill bypasses this entire
 *   class. Across a rolling deploy with concurrent in-flight
 *   mentor calls, this is observable as silent data loss.
 *
 *   The right replacement is a transactional outbox + worker:
 *   producer writes an OutboxJob row in the same DB transaction as
 *   the row that triggers it; a worker claims rows with `FOR UPDATE
 *   SKIP LOCKED`, runs an idempotent handler, retries with backoff,
 *   dead-letters on max attempts. See `architectural-followups.md`
 *   Track 1 for the schema, worker shape, and migration sequence.
 *
 *   Until the outbox lands, this tracker is the transitional best
 *   effort. The fixes here tighten it so it fails loudly and
 *   observably rather than silently:
 *     - Per-task timeout so hung tasks don't accumulate.
 *     - Real `instanceof Error` guards (no dishonest casts).
 *     - `getStats()` for instrumentation hooks.
 *     - Recent-failures ring buffer for ops introspection.
 *     - Configurable shutdown-drain timeout (BACKGROUND_TASK_SHUTDOWN_AWAIT_MS).
 *     - `track()` THROWS ShutdownInProgressError instead of letting
 *       a fire-and-forget promise race the process exit untracked
 *       (the prior behavior was the worst of both worlds).
 *     - Drain inspects allSettled results and surfaces rejection
 *       counts (no more "drained cleanly" lying when N failed).
 *     - Single inflight snapshot per drain — no TOCTOU drift
 *       between the count we log, the labels we log, and the
 *       promises we race.
 *
 * Acceptable use today: work whose loss across a hard restart is
 * tolerable (e.g. background metrics ingest, cache warm-up).
 *
 * NOT acceptable for: user-visible work the response promised
 * would happen (mentor, signal-mentor, build-eval re-dispatch).
 * Those should move to the outbox.
 */
@Injectable()
export class BackgroundTaskTracker implements BeforeApplicationShutdown {
  private readonly logger = new Logger(BackgroundTaskTracker.name);
  private readonly inflight = new Map<number, { label: string; promise: Promise<unknown> }>();
  private readonly recentFailures: TaskFailureRecord[] = [];
  private readonly shutdownAwaitMs: number;
  private readonly defaultTimeoutMs: number;
  private nextId = 1;
  private shuttingDown = false;
  private totalTracked = 0;
  private totalCompleted = 0;
  private totalFailed = 0;
  private totalTimedOut = 0;

  constructor(@Optional() config?: ConfigService) {
    this.shutdownAwaitMs = readNum(
      config,
      'BACKGROUND_TASK_SHUTDOWN_AWAIT_MS',
      DEFAULT_SHUTDOWN_AWAIT_MS,
    );
    this.defaultTimeoutMs = readNum(
      config,
      'BACKGROUND_TASK_TIMEOUT_MS',
      DEFAULT_PER_TASK_TIMEOUT_MS,
    );
  }

  /**
   * Register a fire-and-forget promise.
   *
   * Returns a Promise<void> wrapper that always resolves — failures
   * are caught and logged inside, so callers that don't await get
   * no unhandled-rejection. Tests and callers that *want* to wait
   * for completion (e.g. before asserting) can await the return.
   *
   * Throws ShutdownInProgressError synchronously if shutdown has
   * already begun. The previous behavior of silently running an
   * untracked promise was the bug — it created a third class of
   * task ("running but invisible to drain") that was strictly
   * worse than either tracking or refusing.
   */
  track(promise: Promise<unknown>, label: string, options: TrackOptions = {}): Promise<void> {
    if (this.shuttingDown) {
      this.logger.warn(
        `Refusing to track new task "${label}" — shutdown in progress.`,
      );
      throw new ShutdownInProgressError(label);
    }
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const startedAt = performance.now();
    this.totalTracked += 1;

    const timed = this.withTimeout(promise, label, timeoutMs);
    const wrapped = timed
      .then(
        () => {
          this.totalCompleted += 1;
        },
        (err: unknown) => {
          const isTimeout = err instanceof BackgroundTaskTimeoutError;
          if (isTimeout) {
            this.totalTimedOut += 1;
          } else {
            this.totalFailed += 1;
          }
          const message = err instanceof Error ? err.message : String(err);
          const errorName = err instanceof Error ? err.constructor.name : typeof err;
          this.logger.warn(
            `Background task "${label}" ${isTimeout ? 'timed out' : 'failed'}: ${message}`,
          );
          this.recordFailure({
            label,
            errorName,
            message,
            failedAt: new Date(),
            durationMs: Math.round(performance.now() - startedAt),
            timedOut: isTimeout,
          });
        },
      )
      .finally(() => {
        this.inflight.delete(id);
      });
    this.inflight.set(id, { label, promise: wrapped });
    return wrapped;
  }

  size(): number {
    return this.inflight.size;
  }

  /**
   * Snapshot of counters + recent failures. Cheap to call from a
   * health endpoint or scrape into Prometheus / OTel — exposing the
   * counters this tracker already maintained but previously threw
   * away on every task settle.
   */
  getStats(): BackgroundTaskStats {
    return {
      inflight: this.inflight.size,
      totalTracked: this.totalTracked,
      totalCompleted: this.totalCompleted,
      totalFailed: this.totalFailed,
      totalTimedOut: this.totalTimedOut,
      recentFailures: this.recentFailures.slice(),
    };
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.shuttingDown = true;
    // Snapshot once. Without this, a task that completes between
    // the count read and the labels read produces mismatched logs.
    const snapshot = [...this.inflight.values()];
    if (snapshot.length === 0) {
      this.logger.log(
        `Shutdown (${signal ?? 'unknown'}): no in-flight background tasks.`,
      );
      return;
    }
    const labels = snapshot.map((t) => t.label);
    // Snapshot the failure counters too. The wrapper promises always
    // resolve (failures are caught in track()), so Promise.allSettled
    // can't tell us which drained tasks failed — we infer from the
    // counter delta over the drain window instead.
    const failedAtStart = this.totalFailed + this.totalTimedOut;
    this.logger.log(
      `Shutdown (${signal ?? 'unknown'}): awaiting ${snapshot.length} background task(s) ` +
        `(timeout ${this.shutdownAwaitMs / 1000}s). Labels: ${labels.join(', ')}`,
    );
    const promises = snapshot.map((t) => t.promise);
    const drain = Promise.allSettled(promises);
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timeout'), this.shutdownAwaitMs);
    });
    const result = await Promise.race([drain, timeout]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (result === 'timeout') {
      const remaining = [...this.inflight.values()].map((t) => t.label);
      this.logger.warn(
        `Shutdown timeout: ${remaining.length} task(s) still in flight after ` +
          `${this.shutdownAwaitMs / 1000}s — abandoning. ` +
          `These tasks were NOT durably persisted; their work is lost. ` +
          `Labels: ${remaining.join(', ')}`,
      );
      return;
    }
    const failedDuringDrain = this.totalFailed + this.totalTimedOut - failedAtStart;
    if (failedDuringDrain > 0) {
      this.logger.warn(
        `Shutdown: drained ${snapshot.length} task(s); ${failedDuringDrain} failed during ` +
          `the drain window. See prior warnings for per-task error messages.`,
      );
    } else {
      this.logger.log(
        `Shutdown: all ${snapshot.length} background task(s) drained cleanly.`,
      );
    }
  }

  private async withTimeout<T>(
    p: Promise<T>,
    label: string,
    timeoutMs: number,
  ): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new BackgroundTaskTimeoutError(label, timeoutMs)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([p, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private recordFailure(rec: TaskFailureRecord): void {
    this.recentFailures.push(rec);
    if (this.recentFailures.length > RECENT_FAILURES_CAPACITY) {
      this.recentFailures.shift();
    }
  }
}

function readNum(config: ConfigService | undefined, key: string, fallback: number): number {
  const raw = config?.get<string>(key) ?? process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
