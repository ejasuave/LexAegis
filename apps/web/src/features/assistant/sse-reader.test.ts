import { describe, expect, it } from 'vitest';
import { frameData, readSse, takeFrames, type SseItem } from './sse-reader';

const encoder = new TextEncoder();

function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
}

async function all(stream: ReadableStream<Uint8Array>, limit?: number): Promise<SseItem[]> {
  const out: SseItem[] = [];
  for await (const item of readSse(stream, limit)) out.push(item);
  return out;
}

const frame = (seq: number, data: string) => `id: ${seq}\nevent: x\ndata: ${data}\n\n`;

describe('[aegis-cancellation-races-and-streams] SSE reader', () => {
  it('reassembles frames split at every possible byte boundary', async () => {
    const text = frame(1, '{"a":"£24,000 — ünïcode"}') + ': hb\n\n' + frame(2, '{"b":2}');
    const bytes = encoder.encode(text);
    for (let cut = 1; cut < bytes.length; cut += 1) {
      const items = await all(streamOf([bytes.slice(0, cut), bytes.slice(cut)]));
      expect(items).toEqual([
        { kind: 'event', data: '{"a":"£24,000 — ünïcode"}' },
        { kind: 'event', data: '{"b":2}' },
      ]);
    }
    // One byte at a time.
    const single = await all(streamOf([...bytes].map((byte) => new Uint8Array([byte]))));
    expect(single).toHaveLength(2);
  });

  it('treats heartbeat comments as nothing at all', async () => {
    expect(await all(streamOf([': hb\n\n', ': hb\n\n']))).toEqual([]);
    expect(frameData(': hb')).toBeNull();
    expect(frameData('id: 3\ndata: one\ndata: two')).toBe('one\ntwo');
  });

  it('does not deliver a trailing frame that never completed', async () => {
    expect(await all(streamOf([frame(1, '{"a":1}'), 'id: 2\ndata: {"b"']))).toEqual([
      { kind: 'event', data: '{"a":1}' },
    ]);
    expect(takeFrames('a\n\nb')).toEqual({ frames: ['a'], rest: 'b' });
    expect(takeFrames('a\r\n\r\nb\r\n\r\n')).toEqual({ frames: ['a', 'b'], rest: '' });
  });

  it('stops with an overflow instead of buffering without bound', async () => {
    const items = await all(streamOf([frame(1, '{}'), `data: ${'x'.repeat(5000)}`]), 1024);
    expect(items).toEqual([{ kind: 'event', data: '{}' }, { kind: 'overflow' }]);
  });
});
