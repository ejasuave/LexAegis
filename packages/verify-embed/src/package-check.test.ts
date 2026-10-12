import { describe, expect, it, vi } from 'vitest';
import { resolveHostConfig } from './config';
import { snapshotInputs } from './inputs';
import { checkPackage, downloadBounded, verifyPackageBytes } from './package-check';
import { ATTRIBUTES, HOST } from './test-helpers';

const resolved = resolveHostConfig(HOST);
if (!resolved.ok) throw new Error('fixture');
const snapshot = snapshotInputs(
  { ...ATTRIBUTES, packageUrl: 'https://packages.example.invalid/a.json' },
  resolved.config,
);
if (!snapshot.ok) throw new Error('fixture');
const input = snapshot.input;
const URL_OK = 'https://packages.example.invalid/a.json';

const streamOf = (chunks: Uint8Array[]): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  );

describe('bounded download', () => {
  it('requests with credentials omitted, no redirects, no referrer and no cache', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(streamOf([new Uint8Array([1, 2])])));
    const result = await downloadBounded(URL_OK, { fetch: fetchSpy });
    expect(result).toEqual({ ok: true, bytes: new Uint8Array([1, 2]) });
    expect(fetchSpy).toHaveBeenCalledWith(
      URL_OK,
      expect.objectContaining({
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      }),
    );
  });

  it('counts bytes as they are read, not what Content-Length claims', async () => {
    const response = streamOf([new Uint8Array(6), new Uint8Array(6)]);
    const result = await downloadBounded(URL_OK, {
      fetch: () => Promise.resolve(response),
      maxBytes: 10,
    });
    expect(result).toEqual({ ok: false, reason: 'TOO_LARGE' });
  });

  it('refuses a declared oversize without reading', async () => {
    const response = new Response('x', { headers: { 'content-length': '999' } });
    expect(
      await downloadBounded(URL_OK, { fetch: () => Promise.resolve(response), maxBytes: 10 }),
    ).toEqual({ ok: false, reason: 'TOO_LARGE' });
  });

  it('maps HTTP errors, network errors and aborts to typed failures', async () => {
    expect(
      await downloadBounded(URL_OK, {
        fetch: () => Promise.resolve(new Response('', { status: 500 })),
      }),
    ).toEqual({ ok: false, reason: 'HTTP_STATUS' });
    expect(
      await downloadBounded(URL_OK, { fetch: () => Promise.reject(new TypeError('network')) }),
    ).toEqual({ ok: false, reason: 'FETCH_FAILED' });
    const controller = new AbortController();
    controller.abort();
    expect(
      await downloadBounded(URL_OK, {
        fetch: () => Promise.reject(new DOMException('aborted', 'AbortError')),
        signal: controller.signal,
      }),
    ).toEqual({ ok: false, reason: 'ABORTED' });
  });

  it('times out a stalled download', async () => {
    const result = await downloadBounded(URL_OK, {
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')));
        }),
    });
    expect(result).toEqual({ ok: false, reason: 'TIMEOUT' });
  });
});

describe('package verification outcomes', () => {
  const text = (value: string) => new TextEncoder().encode(value);

  it('names an encrypted backup as unsupported, never as a match', async () => {
    expect(
      await verifyPackageBytes(text('{"schema":"lexaegis.encrypted-review-export.v1"}'), input),
    ).toMatchObject({ kind: 'unsupported' });
  });

  it('treats malformed bytes as unavailable evidence', async () => {
    expect(await verifyPackageBytes(text('not json'), input)).toMatchObject({
      kind: 'unavailable',
    });
  });

  it('never fetches an origin the host did not approve', async () => {
    const fetchSpy = vi.fn();
    const rejected = { ...input, packageUrl: 'https://evil.example.invalid/a.json' };
    expect(await checkPackage(rejected, resolved.config, { fetch: fetchSpy })).toEqual({
      kind: 'unavailable',
      reason: 'ORIGIN_NOT_ALLOWED',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
