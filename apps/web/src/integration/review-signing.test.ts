import { recoverTypedDataAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { toEip712ReviewAction } from '@lexaegis/sdk/registry';
import { succeed } from '@/features/account/errors';
import { productionReviewGate, type PreviewTicket } from '@/features/account/review-signing';
import { ABSOLUTE_LIMIT_MS } from '@/features/account/session-controller';
import { CONFIG, createHarness } from '@/test-support/account-harness';

/* Synthetic fixtures with an explicitly opened test gate. Production keeps the gate shut. */

const ZERO32 = `0x${'00'.repeat(32)}`;
const A = `0x${'a1'.repeat(32)}`;
const B = `0x${'b2'.repeat(32)}`;

async function setup(gate = () => succeed(null)) {
  const h = createHarness({ reviewGate: gate });
  await h.controller.createAndSignIn();
  const reviewer = h.controller.getSnapshot().account?.address ?? '';
  const deadline = () => String(Math.floor(h.clock.now / 1000) + 600);
  const request = (overrides: Record<string, unknown> = {}, commitment = A) => ({
    action: {
      chainId: CONFIG.chainId,
      registryAddress: CONFIG.registryAddress,
      action: {
        reviewer,
        action: 0,
        commitment,
        replacementCommitment: ZERO32,
        nonce: '0',
        deadline: deadline(),
        ...overrides,
      },
    },
    packageReference: {
      schema: 'lexaegis.receipt-ref.v1',
      chainId: CONFIG.chainId,
      registryAddress: CONFIG.registryAddress,
      reviewerAddress: reviewer,
      commitment,
    },
  });
  return { h, reviewer, request };
}

const ticketOf = (
  result: { ok: true; data: PreviewTicket } | { ok: false; code: string },
): PreviewTicket => {
  if (!result.ok) throw new Error(result.code);
  return result.data;
};

describe('production gate', () => {
  it('keeps review signing unavailable until the later evidence and live-state gates exist', async () => {
    const { h, request } = await setup(productionReviewGate);
    expect(h.controller.review.preview(request())).toEqual({ ok: false, code: 'UNAVAILABLE' });
    const forged = { digest: '0x', approved: true } as unknown as PreviewTicket;
    expect(await h.controller.review.confirm(forged, request())).toEqual({
      ok: false,
      code: 'UNAVAILABLE',
    });
  });
});

describe('preview and confirmation', () => {
  it('signs exactly the previewed action with the Mera-backed account', async () => {
    const { h, reviewer, request } = await setup();
    const ticket = ticketOf(h.controller.review.preview(request()));
    expect(Object.isFrozen(ticket)).toBe(true);
    expect(ticket).toMatchObject({
      address: reviewer,
      generation: h.controller.getSnapshot().generation,
    });

    const signed = await h.controller.review.confirm(ticket, request());
    if (!signed.ok) throw new Error(signed.code);
    expect(signed.data.digest).toBe(ticket.digest);
    const eip712 = toEip712ReviewAction(signed.data.typedData);
    if (!eip712.ok) throw new Error('typed data');
    const recovered = await recoverTypedDataAddress({
      ...eip712.data,
      signature: signed.data.signature,
    });
    expect(recovered.toLowerCase()).toBe(reviewer);
    expect(signed.data.typedData.domain).toEqual({
      name: 'LexAegisProofOfReview',
      version: '1',
      chainId: CONFIG.chainId,
      verifyingContract: CONFIG.registryAddress,
    });
    // It is a signature, not a submission or a receipt.
    expect(Object.keys(signed.data).sort()).toEqual([
      'action',
      'digest',
      'generation',
      'signature',
      'typedData',
    ]);
  });

  it('consumes a ticket once', async () => {
    const { h, request } = await setup();
    const ticket = ticketOf(h.controller.review.preview(request()));
    expect((await h.controller.review.confirm(ticket, request())).ok).toBe(true);
    expect(await h.controller.review.confirm(ticket, request())).toEqual({
      ok: false,
      code: 'TICKET_INVALID',
    });
  });

  it('rejects a look-alike ticket, a copy and a caller-supplied approved flag', async () => {
    const { h, request } = await setup();
    const ticket = ticketOf(h.controller.review.preview(request()));
    const copy = { ...ticket };
    const flagged = { ...ticket, approved: true } as PreviewTicket;
    expect(await h.controller.review.confirm(copy, request())).toEqual({
      ok: false,
      code: 'TICKET_INVALID',
    });
    expect(await h.controller.review.confirm(flagged, request())).toEqual({
      ok: false,
      code: 'TICKET_INVALID',
    });
    // The genuine ticket is untouched by those attempts.
    expect((await h.controller.review.confirm(ticket, request())).ok).toBe(true);
  });

  it.each([
    ['commitment (another package)', { commitment: B }, B],
    ['nonce', { nonce: '1' }, A],
    ['deadline', { deadline: '1' }, A],
    ['action code', { action: 1 }, A],
    ['replacement', { action: 2, replacementCommitment: B }, A],
  ])(
    'a changed %s invalidates the preview and burns the ticket',
    async (_label, overrides, commitment) => {
      const { h, request } = await setup();
      const ticket = ticketOf(h.controller.review.preview(request()));
      expect(await h.controller.review.confirm(ticket, request(overrides, commitment))).toEqual({
        ok: false,
        code: 'TICKET_INVALID',
      });
      expect(await h.controller.review.confirm(ticket, request())).toEqual({
        ok: false,
        code: 'TICKET_INVALID',
      });
    },
  );

  it('copies inputs: mutating the request after confirming cannot change what is signed', async () => {
    const { h, request } = await setup();
    const input = request();
    const ticket = ticketOf(h.controller.review.preview(input));
    const pending = h.controller.review.confirm(ticket, input);
    input.action.action.commitment = B;
    const signed = await pending;
    expect(signed.ok && signed.data.action.action.commitment).toBe(A);
  });

  it('dies with lock, cancel, account switch and expiry', async () => {
    const { h, request } = await setup();
    const locked = ticketOf(h.controller.review.preview(request()));
    h.controller.lock();
    expect((await h.controller.review.confirm(locked, request())).ok).toBe(false);

    await h.controller.recoverKnown();
    const expired = ticketOf(h.controller.review.preview(request()));
    h.clock.advance(120_000);
    expect(await h.controller.review.confirm(expired, request())).toEqual({
      ok: false,
      code: 'TICKET_INVALID',
    });

    const switched = ticketOf(h.controller.review.preview(request()));
    await h.controller.createAndSignIn();
    expect((await h.controller.review.confirm(switched, request())).ok).toBe(false);
  });

  it('does not release a signature when the session is locked during signing', async () => {
    const { h, request } = await setup();
    const ticket = ticketOf(h.controller.review.preview(request()));
    const pending = h.controller.review.confirm(ticket, request());
    h.controller.lock();
    const result = await pending;
    expect(result.ok).toBe(false);
  });

  it('refuses to sign after the absolute limit even when no timer fired', async () => {
    const { h, request } = await setup();
    // Stay active (so the idle limit never fires) until 30 seconds before the absolute limit.
    for (let elapsed = 0; elapsed < ABSOLUTE_LIMIT_MS - 30_000; elapsed += 30_000) {
      h.clock.advance(30_000);
      h.controller.noteInteraction();
    }
    const input = request();
    const ticket = ticketOf(h.controller.review.preview(input));
    // The machine slept past the limit; nothing ticked.
    h.clock.advance(31_000);
    const result = await h.controller.review.confirm(ticket, input);
    expect(result).toEqual({ ok: false, code: 'SESSION_EXPIRED' });
    expect(h.controller.getSnapshot().signing.state).toBe('locked');
  });

  it('serializes concurrent confirmations: each ticket yields its own signature', async () => {
    const { h, request } = await setup();
    const first = ticketOf(h.controller.review.preview(request({ nonce: '0' })));
    const second = ticketOf(h.controller.review.preview(request({ nonce: '1' })));
    const [a, b] = await Promise.all([
      h.controller.review.confirm(first, request({ nonce: '0' })),
      h.controller.review.confirm(second, request({ nonce: '1' })),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(a.ok && b.ok && a.data.signature).not.toBe(b.ok && b.data.signature);
    expect(a.ok && a.data.action.action.nonce).toBe('0');
    expect(b.ok && b.data.action.action.nonce).toBe('1');
  });
});

describe('scope', () => {
  it.each([
    [
      'another reviewer',
      (r: ReturnType<Awaited<ReturnType<typeof setup>>['request']>) => ({
        ...r,
        action: { ...r.action, action: { ...r.action.action, reviewer: `0x${'12'.repeat(20)}` } },
      }),
    ],
    [
      'another chain',
      (r: ReturnType<Awaited<ReturnType<typeof setup>>['request']>) => ({
        ...r,
        action: { ...r.action, chainId: '143' },
      }),
    ],
    [
      'another registry',
      (r: ReturnType<Awaited<ReturnType<typeof setup>>['request']>) => ({
        ...r,
        action: { ...r.action, registryAddress: `0x${'cd'.repeat(20)}` },
      }),
    ],
    [
      'a reference for another package',
      (r: ReturnType<Awaited<ReturnType<typeof setup>>['request']>) => ({
        ...r,
        packageReference: { ...r.packageReference, commitment: B },
      }),
    ],
    [
      'an extra field',
      (r: ReturnType<Awaited<ReturnType<typeof setup>>['request']>) => ({
        ...r,
        action: { ...r.action, approved: true },
      }),
    ],
    ['arbitrary text', () => ({ action: 'approve everything', packageReference: 'yes' })],
  ])('refuses %s', async (_label, mutate) => {
    const { h, request } = await setup();
    expect(h.controller.review.preview(mutate(request()))).toEqual({
      ok: false,
      code: 'SCOPE_REJECTED',
    });
  });

  it('enforces a positive, unexpired deadline no further out than 600 seconds', async () => {
    const { h, request } = await setup();
    const now = Math.floor(h.clock.now / 1000);
    for (const deadline of [String(now), String(now - 1), String(now + 601), '1']) {
      expect(h.controller.review.preview(request({ deadline }))).toEqual({
        ok: false,
        code: 'SCOPE_REJECTED',
      });
    }
    expect(h.controller.review.preview(request({ deadline: String(now + 600) })).ok).toBe(true);
  });

  it('is unavailable without a configured registry and refuses when locked', async () => {
    const h = createHarness({
      reviewGate: () => succeed(null),
      config: { ...CONFIG, registryAddress: null },
    });
    await h.controller.createAndSignIn();
    expect(h.controller.review.preview({ action: {}, packageReference: {} })).toEqual({
      ok: false,
      code: 'UNAVAILABLE',
    });
    const { h: locked, request } = await setup();
    locked.controller.lock();
    expect(locked.controller.review.preview(request())).toEqual({
      ok: false,
      code: 'SESSION_LOCKED',
    });
  });
});
