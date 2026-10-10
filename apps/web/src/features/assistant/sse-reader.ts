/*
 * Reads server-sent events from a fetch response body. Frames may be split anywhere across
 * network chunks, including inside a multi-byte character. Comment lines (heartbeats) are
 * dropped: they are not progress. The buffer is bounded; exceeding it ends the stream as an
 * overflow rather than growing without limit.
 */

export const SSE_BUFFER_LIMIT_BYTES = 64 * 1024;

export type SseItem =
  { readonly kind: 'event'; readonly data: string } | { readonly kind: 'overflow' };

/** Splits complete frames off the front of a buffer. Exposed for tests. */
export function takeFrames(buffer: string): { frames: string[]; rest: string } {
  const normalised = buffer.replace(/\r\n/g, '\n');
  const parts = normalised.split('\n\n');
  const rest = parts.pop() ?? '';
  return { frames: parts, rest };
}

/** The data of one frame, or null for a comment-only frame. Multiple data lines join with \n. */
export function frameData(frame: string): string | null {
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return data.length === 0 ? null : data.join('\n');
}

export async function* readSse(
  body: ReadableStream<Uint8Array>,
  limitBytes: number = SSE_BUFFER_LIMIT_BYTES,
): AsyncGenerator<SseItem> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = takeFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        const data = frameData(frame);
        if (data !== null) yield { kind: 'event', data };
      }
      if (buffer.length > limitBytes) {
        yield { kind: 'overflow' };
        return;
      }
    }
    // A trailing frame without its blank line is incomplete and is not delivered.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
