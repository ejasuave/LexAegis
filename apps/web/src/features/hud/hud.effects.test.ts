import { describe, expect, it } from 'vitest';
import { RECEIPT_COALESCE_MS, ReceiptEffects, WASH_MAX_OPACITY, washOpacity } from './hud.effects';

const ctx = (patch: Partial<Parameters<ReceiptEffects['consume']>[1]> = {}) => ({
  nowMs: 10_000,
  source: 'live' as const,
  pageVisible: true,
  mode: 'full' as const,
  sameMatter: true,
  networkLabel: 'Monad Testnet (10143)',
  ...patch,
});
const confirmed = (id: string) => ({ kind: 'confirmed' as const, id });

describe('receipt effects', () => {
  it('plays once for one validated live confirmation, with a persistent label and one announcement', () => {
    const fx = new ReceiptEffects();
    const out = fx.consume(confirmed('a'), ctx());
    expect(out).toMatchObject({ accepted: true, play: true, cancelPlay: false });
    expect(out.label).toEqual({
      kind: 'confirmed',
      id: 'a',
      text: 'Receipt confirmed on Monad Testnet (10143).',
    });
    expect(out.announce).toBe(out.label?.text);
    expect(out.log?.kind).toBe('confirmed');
  });

  it('never replays a duplicate: remount, reconnect or double delivery change nothing', () => {
    const fx = new ReceiptEffects();
    fx.consume(confirmed('a'), ctx());
    const again = fx.consume(confirmed('a'), ctx({ nowMs: 99_000 }));
    expect(again).toMatchObject({
      accepted: false,
      play: false,
      log: null,
      label: null,
      announce: null,
    });
  });

  it('treats hydration and history replay as silent, and stops them playing later', () => {
    const fx = new ReceiptEffects();
    expect(fx.consume(confirmed('old'), ctx({ source: 'hydration' }))).toMatchObject({
      accepted: false,
      play: false,
    });
    expect(fx.consume(confirmed('old'), ctx({ nowMs: 60_000 })).play).toBe(false);
  });

  it('gives a hidden tab, another matter, reduced or off effects the label and announcement but no wash', () => {
    for (const patch of [
      { pageVisible: false },
      { sameMatter: false },
      { mode: 'reduced' as const },
      { mode: 'off' as const },
    ]) {
      const out = new ReceiptEffects().consume(confirmed('x'), ctx(patch));
      expect(out.play).toBe(false);
      expect(out.accepted).toBe(true);
      expect(out.label?.kind).toBe('confirmed');
      expect(out.announce).not.toBeNull();
    }
  });

  it('coalesces simultaneous confirmations into one envelope but logs every real event', () => {
    const fx = new ReceiptEffects();
    const first = fx.consume(confirmed('a'), ctx());
    const second = fx.consume(confirmed('b'), ctx({ nowMs: 10_300 }));
    expect(first.play).toBe(true);
    expect(second).toMatchObject({ accepted: true, play: false });
    expect(second.log?.id).toBe('b');
    const late = fx.consume(confirmed('c'), ctx({ nowMs: 10_000 + RECEIPT_COALESCE_MS }));
    expect(late.play).toBe(true);
  });

  it('a hidden delivery does not use up the envelope window', () => {
    const fx = new ReceiptEffects();
    fx.consume(confirmed('a'), ctx({ pageVisible: false }));
    expect(fx.consume(confirmed('b'), ctx({ nowMs: 10_100 })).play).toBe(true);
  });

  it('withdraws a confirmation with a persistent correction, ends any effect, and never celebrates a re-confirmation', () => {
    const fx = new ReceiptEffects();
    fx.consume(confirmed('a'), ctx());
    const fix = fx.consume({ kind: 'invalidated', id: 'a' }, ctx({ nowMs: 11_000 }));
    expect(fix).toMatchObject({ accepted: true, play: false, cancelPlay: true });
    expect(fix.label?.kind).toBe('correction');
    expect(fix.log?.kind).toBe('invalidated');
    expect(fx.consume({ kind: 'invalidated', id: 'a' }, ctx({ nowMs: 12_000 })).accepted).toBe(
      false,
    );
    expect(fx.consume(confirmed('a'), ctx({ nowMs: 30_000 })).accepted).toBe(false);
  });
});

describe('wash envelope', () => {
  it('rises over 180 ms to at most 0.06 and fades to zero by 600 ms, never above the maximum', () => {
    expect(washOpacity(0)).toBe(0);
    expect(washOpacity(90)).toBeCloseTo(WASH_MAX_OPACITY / 2, 5);
    expect(washOpacity(180)).toBeCloseTo(WASH_MAX_OPACITY, 5);
    expect(washOpacity(390)).toBeCloseTo(WASH_MAX_OPACITY / 2, 5);
    expect(washOpacity(600)).toBe(0);
    for (let t = -50; t < 700; t += 7) expect(washOpacity(t)).toBeLessThanOrEqual(0.06);
  });
});
