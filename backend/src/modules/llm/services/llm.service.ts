import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatMessage, LlmCallOptions, LlmResponse } from '../types/llm.types';
import { LlmProviderFactory } from '../providers/llm-provider.factory';
import { CostCapService } from '../../cost-cap/services/cost-cap.service';
import { LlmProvider as CostCapProvider } from '../../cost-cap/pricing';

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const MAX_BACKOFF_MS = 10_000;

export class LlmTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmTimeoutError';
  }
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;

  constructor(
    private readonly factory: LlmProviderFactory,
    @Optional() config?: ConfigService,
    @Optional() private readonly costCap?: CostCapService,
  ) {
    this.timeoutMs = readNum(config, 'LLM_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    this.maxAttempts = Math.max(
      1,
      readNum(config, 'LLM_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS),
    );
    this.backoffBaseMs = readNum(config, 'LLM_BACKOFF_BASE_MS', DEFAULT_BACKOFF_BASE_MS);
  }

  // Wraps the underlying provider call with a per-attempt timeout and
  // an exponential-backoff retry on transient failures (timeouts,
  // 5xx, 429, network errors). Non-retryable errors (4xx other than
  // 429, validation errors, etc.) propagate on the first try.
  //
  // When opts.userId + opts.route are both set, the call is gated by
  // the user's daily cost cap (pre) and the resulting spend is
  // recorded (post). Record failures are logged but not rethrown —
  // the LLM response was already paid for, so failing the request now
  // would burn budget without giving the user their answer.
  async call(messages: ChatMessage[], opts: LlmCallOptions = {}): Promise<LlmResponse> {
    const capScope = opts.userId && opts.route ? { userId: opts.userId, route: opts.route } : null;
    if (capScope && this.costCap) {
      await this.costCap.assertWithinCap(capScope.userId);
    }

    const provider = this.factory.get();
    let lastErr: unknown;
    let response: LlmResponse | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        response = await this.withTimeout(provider.call(messages, opts));
        break;
      } catch (err) {
        lastErr = err;
        const retryable = this.isRetryable(err);
        if (!retryable || attempt === this.maxAttempts) {
          throw err;
        }
        const delayMs = this.backoffWithJitter(attempt);
        this.logger.warn(
          `LLM call attempt ${attempt}/${this.maxAttempts} failed ` +
            `(${this.errorSummary(err)}); retrying in ${delayMs}ms.`,
        );
        await sleep(delayMs);
      }
    }
    if (!response) throw lastErr;

    if (capScope && this.costCap) {
      try {
        await this.costCap.record({
          userId: capScope.userId,
          provider: provider.name as CostCapProvider,
          model: response.modelUsed,
          tokens: {
            tokensIn: response.tokensIn,
            tokensOut: response.tokensOut,
            cacheReadTokens: response.cacheReadTokens,
            cacheCreationTokens: response.cacheCreationTokens,
          },
          route: capScope.route,
        });
      } catch (err) {
        this.logger.warn(
          `Failed to record LLM spend for user=${capScope.userId} route=${capScope.route}: ` +
            this.errorSummary(err),
        );
      }
    }
    return response;
  }

  supportsToolUse(): boolean {
    return this.factory.get().supportsToolUse;
  }

  private async withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new LlmTimeoutError(`LLM call exceeded ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );
    });
    try {
      return await Promise.race([p, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // The Anthropic SDK exposes `status` on its error objects; native
  // fetch / Node socket errors surface via `message` matching common
  // codes. Only retry transient classes — never blanket-retry a 400.
  private isRetryable(err: unknown): boolean {
    if (err instanceof LlmTimeoutError) return true;
    if (!err || typeof err !== 'object') return false;
    const status = (err as { status?: number }).status;
    if (status === 429) return true;
    if (typeof status === 'number' && status >= 500 && status < 600) return true;
    const msg = (err as { message?: string }).message ?? '';
    if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i.test(msg)) {
      return true;
    }
    return false;
  }

  private backoffWithJitter(attempt: number): number {
    const exponential = Math.min(
      this.backoffBaseMs * Math.pow(2, attempt - 1),
      MAX_BACKOFF_MS,
    );
    // Decorrelated jitter in [base/2, base]: smooths thundering herd
    // if many sessions retry at once.
    return Math.floor(exponential * (0.5 + Math.random() * 0.5));
  }

  private errorSummary(err: unknown): string {
    if (!(err instanceof Error)) return String(err);
    const status = (err as { status?: number }).status;
    const ctor = err.constructor.name;
    return status ? `${ctor} status=${status}: ${err.message}` : `${ctor}: ${err.message}`;
  }
}

function readNum(config: ConfigService | undefined, key: string, fallback: number): number {
  const raw = config?.get<string>(key) ?? process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
