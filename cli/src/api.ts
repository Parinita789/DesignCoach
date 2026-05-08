import axios, { AxiosInstance } from 'axios';
import { BufferedEvent } from './buffer';
import { BufferedAITurn } from './aiBuffer';

export interface ApiClientOptions {
  server: string;
  token: string;
}

export interface FlushResponse {
  accepted: number;
}

export interface FinishResponse {
  ok: boolean;
}

export class MentorApiClient {
  private http: AxiosInstance;

  constructor(private readonly opts: ApiClientOptions) {
    this.http = axios.create({
      baseURL: opts.server.replace(/\/$/, ''),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.token}`,
      },
      timeout: 30_000,
    });
  }

  async sendEvents(events: BufferedEvent[]): Promise<FlushResponse> {
    const payload = {
      events: events.map((e) => ({
        filePath: e.filePath,
        action: e.action,
        content: e.content,
        contentDiff: e.contentDiff,
        occurredAt: e.occurredAt,
      })),
    };
    const r = await this.http.post<FlushResponse>('/api/build/events', payload);
    return r.data;
  }

  async finishBuild(): Promise<FinishResponse> {
    const r = await this.http.post<FinishResponse>('/api/build/finish', {});
    return r.data;
  }

  async sendAiInteractions(turns: BufferedAITurn[]): Promise<FlushResponse> {
    const payload = {
      interactions: turns.map((t) => ({
        tool: t.tool,
        externalSessionId: t.externalSessionId,
        turnIndex: t.turnIndex,
        role: t.role,
        text: t.text,
        toolName: t.toolName,
        toolInputSummary: t.toolInputSummary,
        toolResultSummary: t.toolResultSummary,
        occurredAt: t.occurredAt,
      })),
    };
    const r = await this.http.post<FlushResponse>('/api/build/ai-interactions', payload);
    return r.data;
  }
}

// Exponential backoff for transient flush failures. 1s, 4s, 16s, then give up.
export const DEFAULT_BACKOFF_MS: readonly number[] = [1000, 4000, 16000];

// Some axios failures (ECONNREFUSED on Node 25, request aborts) leave
// `err.message` empty but populate `err.code` and/or `err.response.status`.
// Pick the first non-empty descriptor so the user sees something useful.
export function describeError(err: unknown): string {
  if (!err) return 'unknown error';
  const e = err as {
    message?: string;
    code?: string;
    response?: { status?: number; statusText?: string };
    cause?: { message?: string; code?: string };
  };
  if (e.message && e.message.trim()) return e.message;
  if (e.code) return e.code;
  if (e.response?.status) {
    return `HTTP ${e.response.status}${e.response.statusText ? ` ${e.response.statusText}` : ''}`;
  }
  if (e.cause?.message) return e.cause.message;
  if (e.cause?.code) return e.cause.code;
  const s = String(err);
  return s === '[object Object]' ? 'unknown error' : s;
}

export async function sendWithBackoff(
  client: MentorApiClient,
  events: BufferedEvent[],
  backoffs: readonly number[] = DEFAULT_BACKOFF_MS,
): Promise<{ ok: boolean; accepted: number; error?: string }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      const out = await client.sendEvents(events);
      return { ok: true, accepted: out.accepted };
    } catch (err) {
      lastErr = err;
      if (attempt < backoffs.length) {
        await new Promise((r) => setTimeout(r, backoffs[attempt]));
      }
    }
  }
  return { ok: false, accepted: 0, error: describeError(lastErr) };
}

// Drains all unsent events from the buffer in chunks. A single huge POST
// would hit body-size limits + timeout; a chunked drain still rolls back
// gracefully when the backend is unreachable (we stop on the first
// failed batch and leave the rest unsent for next time).
export async function drainBuffer(
  client: MentorApiClient,
  buffer: { unsent: (limit?: number) => BufferedEvent[]; markSent: (ids: number[]) => void },
  chunkSize: number,
  backoffs?: readonly number[],
): Promise<{ flushed: number; remaining: number; error?: string }> {
  let flushed = 0;
  while (true) {
    const batch = buffer.unsent(chunkSize);
    if (batch.length === 0) break;
    const out = await sendWithBackoff(client, batch, backoffs);
    if (!out.ok) {
      return { flushed, remaining: buffer.unsent(Number.MAX_SAFE_INTEGER).length, error: out.error };
    }
    buffer.markSent(batch.map((e) => e.id));
    flushed += out.accepted;
  }
  return { flushed, remaining: 0 };
}

// Same shape as drainBuffer but for the AI-turn buffer; lives here so
// the watch + finish + status modules don't have to know which client
// method to call.
export async function sendAiWithBackoff(
  client: MentorApiClient,
  turns: BufferedAITurn[],
  backoffs: readonly number[] = DEFAULT_BACKOFF_MS,
): Promise<{ ok: boolean; accepted: number; error?: string }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      const out = await client.sendAiInteractions(turns);
      return { ok: true, accepted: out.accepted };
    } catch (err) {
      lastErr = err;
      if (attempt < backoffs.length) {
        await new Promise((r) => setTimeout(r, backoffs[attempt]));
      }
    }
  }
  return { ok: false, accepted: 0, error: describeError(lastErr) };
}

export async function drainAiBuffer(
  client: MentorApiClient,
  buffer: {
    unsent: (limit?: number) => BufferedAITurn[];
    markSent: (ids: number[]) => void;
  },
  chunkSize: number,
  backoffs?: readonly number[],
): Promise<{ flushed: number; remaining: number; error?: string }> {
  let flushed = 0;
  while (true) {
    const batch = buffer.unsent(chunkSize);
    if (batch.length === 0) break;
    const out = await sendAiWithBackoff(client, batch, backoffs);
    if (!out.ok) {
      return {
        flushed,
        remaining: buffer.unsent(Number.MAX_SAFE_INTEGER).length,
        error: out.error,
      };
    }
    buffer.markSent(batch.map((e) => e.id));
    flushed += out.accepted;
  }
  return { flushed, remaining: 0 };
}
