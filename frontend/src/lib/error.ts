export function extractApiError(err: unknown): string {
  if (!err) return 'Unknown error';
  const e = err as {
    message?: string;
    code?: string;
    response?: { data?: { message?: unknown }; status?: number; statusText?: string };
  };

  const apiMsg = e.response?.data?.message;
  if (typeof apiMsg === 'string' && apiMsg.trim()) return apiMsg;
  if (Array.isArray(apiMsg) && apiMsg.length > 0) {
    return apiMsg.filter((m) => typeof m === 'string').join('; ');
  }

  if (e.message && e.message.trim()) return e.message;
  if (e.code) return e.code;
  if (e.response?.status) {
    const txt = e.response.statusText ? ` ${e.response.statusText}` : '';
    return `HTTP ${e.response.status}${txt}`;
  }
  const s = String(err);
  return s === '[object Object]' ? 'Unknown error' : s;
}

// ---------------------------------------------------------------------------
// Guardrail-specific error parsing
//
// The backend's GuardrailRejectedError ships a structured body so the
// frontend can render specifically rather than dump the raw message
// string. Body shape (HTTP 400):
//   { statusCode: 400, error: 'Bad Request',
//     code: 'TOO_LONG' | 'TOO_SHORT' | 'EMPTY_AFTER_TRIM' | 'NOT_A_STRING',
//     preset: 'plan' | 'hint' | 'question',
//     observedLength: number, limit: number | null,
//     message: string }
// ---------------------------------------------------------------------------

export type GuardrailRejectionCode =
  | 'NOT_A_STRING'
  | 'TOO_SHORT'
  | 'TOO_LONG'
  | 'EMPTY_AFTER_TRIM';

export type GuardrailPresetName = 'plan' | 'hint' | 'question';

export interface GuardrailRejectionInfo {
  code: GuardrailRejectionCode;
  preset: GuardrailPresetName;
  observedLength: number;
  limit: number | null;
  message: string;
}

const GUARDRAIL_CODES: ReadonlySet<string> = new Set([
  'NOT_A_STRING',
  'TOO_SHORT',
  'TOO_LONG',
  'EMPTY_AFTER_TRIM',
]);

const GUARDRAIL_PRESETS: ReadonlySet<string> = new Set(['plan', 'hint', 'question']);

// Returns the structured rejection info if the error is a guardrail
// 400 response, else null. Null lets callers fall back to
// extractApiError() without special-casing the negative.
export function extractGuardrailError(err: unknown): GuardrailRejectionInfo | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { response?: { data?: unknown; status?: number } };
  if (e.response?.status !== 400) return null;
  const body = e.response.data;
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (
    typeof b.code !== 'string' ||
    !GUARDRAIL_CODES.has(b.code) ||
    typeof b.preset !== 'string' ||
    !GUARDRAIL_PRESETS.has(b.preset) ||
    typeof b.observedLength !== 'number' ||
    !(typeof b.limit === 'number' || b.limit === null) ||
    typeof b.message !== 'string'
  ) {
    return null;
  }
  return {
    code: b.code as GuardrailRejectionCode,
    preset: b.preset as GuardrailPresetName,
    observedLength: b.observedLength,
    limit: b.limit as number | null,
    message: b.message,
  };
}

// Render a frontend-facing message that fronts the numbers. Less
// verbose than the backend's humanMessage; safe to drop into a
// banner. Falls back to the backend `message` for codes we don't
// have specialized copy for.
export function formatGuardrailMessage(g: GuardrailRejectionInfo): string {
  const label = PRESET_LABELS[g.preset];
  switch (g.code) {
    case 'TOO_LONG':
      return `${label} too long: ${g.observedLength.toLocaleString()} / ${(g.limit ?? 0).toLocaleString()} chars.`;
    case 'TOO_SHORT':
      return `${label} too short: ${g.observedLength} / ${g.limit ?? 0} chars minimum.`;
    case 'EMPTY_AFTER_TRIM':
      return `${label} can't be empty.`;
    case 'NOT_A_STRING':
      return `${label} must be text.`;
    default:
      return g.message;
  }
}

const PRESET_LABELS: Record<GuardrailPresetName, string> = {
  plan: 'Plan',
  hint: 'Hint',
  question: 'Question',
};

// ---------------------------------------------------------------------------
// Rate-limit (429) error parsing
//
// The backend's @nestjs/throttler returns HTTP 429 with a Retry-After
// header when a per-user or per-IP limit is exceeded. The body is not
// structured (no `code` field — see gaps.md #8), so we detect by
// status code and read the header. Retry-After is either a positive
// integer (seconds) or an HTTP-date; we support both.
// ---------------------------------------------------------------------------

export interface RateLimitInfo {
  // Best-effort seconds-until-retry. Null when the header is missing
  // or unparseable — caller renders a generic "slow down" message.
  retryAfterSeconds: number | null;
}

export function extractRateLimitError(err: unknown): RateLimitInfo | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as {
    response?: { status?: number; headers?: Record<string, unknown> };
  };
  if (e.response?.status !== 429) return null;

  const headers = e.response.headers ?? {};
  // @nestjs/throttler v6 with multiple named tiers emits per-tier
  // headers (Retry-After-short, Retry-After-medium, Retry-After-long)
  // rather than the standard Retry-After. Any of the tiers could be
  // the one that blocked, so we take the MAX of whatever shows up —
  // that's the soonest the client can definitely retry without
  // hitting a different tier's cap. Standard Retry-After is checked
  // first in case the backend normalization gap (gaps.md #8) lands
  // later and we get a cleaner single header.
  const candidates = [
    headers['retry-after'],
    headers['Retry-After'],
    headers['retry-after-short'],
    headers['Retry-After-short'],
    headers['retry-after-medium'],
    headers['Retry-After-medium'],
    headers['retry-after-long'],
    headers['Retry-After-long'],
  ];

  let max: number | null = null;
  for (const raw of candidates) {
    const parsed = parseRetryAfter(raw as string | number | undefined);
    if (parsed !== null && (max === null || parsed > max)) max = parsed;
  }

  return { retryAfterSeconds: max };
}

function parseRetryAfter(raw: string | number | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  // Delta-seconds variant (e.g. "30" or 30).
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum >= 0) return Math.ceil(asNum);
  // HTTP-date variant (e.g. "Wed, 21 Oct 2026 07:28:00 GMT").
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) {
      const diff = Math.ceil((t - Date.now()) / 1000);
      return diff > 0 ? diff : null;
    }
  }
  return null;
}

export function formatRateLimitMessage(info: RateLimitInfo): string {
  const s = info.retryAfterSeconds;
  if (s === null) return 'Too many requests. Please slow down and try again.';
  if (s <= 1) return 'Too many requests. Try again in a moment.';
  if (s < 60) return `Too many requests. Try again in ${s} seconds.`;
  const minutes = Math.ceil(s / 60);
  return `Too many requests. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

// Convenience: dispatches between guardrail, rate-limit, and generic
// error messages. Order matters — check the most-specific shape
// first (guardrail 400 + structured body) before the less-specific
// 429 status-only check.
export function describeError(err: unknown): string {
  const guardrail = extractGuardrailError(err);
  if (guardrail) return formatGuardrailMessage(guardrail);
  const rateLimit = extractRateLimitError(err);
  if (rateLimit) return formatRateLimitMessage(rateLimit);
  return extractApiError(err);
}
