import 'server-only';
import { ASSISTANT_LIMITS, type AssistantEvent } from '@lexaegis/agent/contracts';

/*
 * Server-sent events over a fetch-consumed POST response. Frames are produced only when the
 * client reads (pull-based), so a slow client applies backpressure instead of growing a buffer.
 * Heartbeats are comments: they keep the connection open and are never progress.
 */

const encoder = new TextEncoder();
export const SSE_HEARTBEAT_MS = 15_000;

/** One event as one frame. The sequence number doubles as the SSE id. */
export function encodeEvent(event: AssistantEvent): Uint8Array | null {
  const frame = encoder.encode(
    `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  );
  // A frame over the bound is never sent in part: the client then sees a gap and discards the run.
  return frame.byteLength > ASSISTANT_LIMITS.eventFrameBytes ? null : frame;
}

export function eventStreamResponse(
  events: AsyncIterable<AssistantEvent>,
  options: {
    readonly requestId: string;
    /** Called when the client goes away: the run is cancelled, never continued. */
    readonly onDisconnect: () => void;
    readonly heartbeatMs?: number;
  },
): Response {
  const iterator = events[Symbol.asyncIterator]();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let finished = false;
  const end = () => {
    finished = true;
    clearInterval(heartbeat);
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        heartbeat = setInterval(() => {
          // Only when the client is keeping up; a comment never queues behind unread events.
          if (!finished && (controller.desiredSize ?? 0) > 0)
            controller.enqueue(encoder.encode(': hb\n\n'));
        }, options.heartbeatMs ?? SSE_HEARTBEAT_MS);
      },
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done === true) {
            end();
            controller.close();
            return;
          }
          const frame = encodeEvent(next.value);
          if (frame !== null) controller.enqueue(frame);
        } catch {
          end();
          controller.error(new Error('stream failed'));
        }
      },
      cancel() {
        end();
        options.onDisconnect();
      },
    },
    { highWaterMark: 1 },
  );
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
      'x-request-id': options.requestId,
    },
  });
}
