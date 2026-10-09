export const AUTH_BODY_LIMIT = 16 * 1024;
export const REQUEST_HEADER = 'x-lexaegis-request';

export type GuardFailure = 'ORIGIN' | 'CONTENT_TYPE' | 'HEADER' | 'TOO_LARGE' | 'MALFORMED';
export type GuardedBody =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly reason: GuardFailure };

/** True only when the Origin header is present and exactly the configured origin. */
export function originMatches(request: Request, origin: string): boolean {
  return request.headers.get('origin') === origin;
}

export async function readLimited(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(declared) || declared > limit) return null;
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export type GuardedBytes =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: GuardFailure };

/**
 * Guards a state-changing request: exact configured Origin, application/json and the
 * X-LexAegis-Request: 1 header (which a cross-site form cannot send), then a streaming-counted
 * body limit. The origin comes from configuration, never from Host or forwarding headers.
 */
export async function readGuardedBytes(
  request: Request,
  origin: string,
  limit: number,
): Promise<GuardedBytes> {
  if (!originMatches(request, origin)) return { ok: false, reason: 'ORIGIN' };
  const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') return { ok: false, reason: 'CONTENT_TYPE' };
  if (request.headers.get(REQUEST_HEADER) !== '1') return { ok: false, reason: 'HEADER' };
  const bytes = await readLimited(request, limit);
  return bytes === null ? { ok: false, reason: 'TOO_LARGE' } : { ok: true, bytes };
}

/** Control JSON: the 16 KiB authentication-sized limit. */
export async function readGuardedJson(request: Request, origin: string): Promise<GuardedBody> {
  const guarded = await readGuardedBytes(request, origin, AUTH_BODY_LIMIT);
  if (!guarded.ok) return guarded;
  try {
    const body: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(guarded.bytes),
    );
    return { ok: true, body };
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
}
