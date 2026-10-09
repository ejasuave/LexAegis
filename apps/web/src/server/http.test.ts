import { describe, expect, it } from 'vitest';
import { GET as health } from '@/app/api/health/route';
import { GET as readiness } from '@/app/api/readiness/route';
import { readinessReportSchema } from '@/lib/readiness-schema';
import { createLogger } from './logger';
import { errorResponse, handleRoute, notImplementedResponse } from './http';
import { createApplicationError } from '@lexaegis/protocol';

const GET_REQUEST = new Request('http://localhost/api');

describe('health and readiness routes', () => {
  it('liveness returns 200 even though every integration is unavailable', async () => {
    const response = await health(GET_REQUEST);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ status: 'ok' });
  });

  it('readiness returns 503 with truthful unavailable states and a request ID', async () => {
    const response = await readiness(GET_REQUEST);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = readinessReportSchema.parse(await response.json());
    expect(body.status).toBe('unavailable');
    // Nothing is configured in the test environment, so nothing is configured or verified.
    expect(
      body.capabilities.every(
        (item) => item.state === 'unimplemented' || item.state === 'unconfigured',
      ),
    ).toBe(true);
    expect(response.headers.get('x-request-id')).toBe(body.requestId);
  });

  it('does not echo environment secrets in either response', async () => {
    const previous = process.env.QWEN_API_KEY;
    process.env.QWEN_API_KEY = 'route-secret-0123456789';
    try {
      for (const route of [health, readiness]) {
        const text = await (await route(GET_REQUEST)).text();
        expect(text).not.toContain('route-secret-0123456789');
      }
    } finally {
      if (previous === undefined) delete process.env.QWEN_API_KEY;
      else process.env.QWEN_API_KEY = previous;
    }
  });
});

describe('error mapping', () => {
  it('maps an unfinished operation to 501 NOT_IMPLEMENTED, never a success', async () => {
    const response = notImplementedResponse('Document analysis', 'req_9');
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'NOT_IMPLEMENTED' } });
  });

  it('turns thrown exceptions into a fixed INTERNAL error without leaking the message', async () => {
    const route = handleRoute(() => {
      throw new Error('contains legal text: Settlement of £24,000');
    });
    const response = await route(GET_REQUEST);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain('INTERNAL');
    expect(text).not.toContain('Settlement');
    expect(text).not.toContain('£24,000');
  });

  it('maps error codes to HTTP statuses', () => {
    expect(errorResponse(createApplicationError('UNAVAILABLE', 'x', 'r1')).status).toBe(503);
    expect(errorResponse(createApplicationError('INVALID_INPUT', 'x', 'r2')).status).toBe(400);
  });
});

describe('logger', () => {
  it('writes only allowlisted fields', () => {
    const lines: string[] = [];
    const log = createLogger((line) => lines.push(line));
    log.error({
      event: 'test',
      requestId: 'req_1',
      code: 'INTERNAL',
      status: 500,
      // Excess properties are a compile error; this cast simulates a careless caller at runtime.
      ...({ body: 'legal text', authorization: 'Bearer abc' } as object),
    });
    const parsed = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['code', 'event', 'level', 'requestId', 'status']);
    expect(lines[0]).not.toContain('legal text');
    expect(lines[0]).not.toContain('Bearer');
  });
});
