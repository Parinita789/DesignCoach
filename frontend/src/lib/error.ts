// Friendly error message extraction for axios + generic error shapes.
// Prefers the backend's NestJS-formatted body (response.data.message),
// then the standard Error.message, then network-level fields.
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
