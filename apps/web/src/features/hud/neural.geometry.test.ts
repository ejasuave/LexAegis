import { describe, expect, it } from 'vitest';
import {
  FIELD_POINTS,
  QualityGovernor,
  TIERS,
  backingScale,
  buildField,
  fieldReach,
  initialTier,
  jagged,
  routeAlert,
  segmentCrossesRect,
  seeded,
} from './neural.geometry';
import { isEffectsPreference, resolveEffects } from './hud.effects';

describe('field geometry', () => {
  it('is identical on every build and has the tier filament counts', () => {
    const a = buildField(320);
    const b = buildField(320);
    expect(a.count).toBe(320);
    expect(Array.from(a.xs.slice(0, 40))).toEqual(Array.from(b.xs.slice(0, 40)));
    expect(buildField(160).count).toBe(160);
    expect(buildField(80).count).toBe(80);
  });

  it('keeps every point finite and inside a bounded reach', () => {
    const f = buildField(320);
    for (let i = 0; i < f.xs.length; i++) {
      expect(Number.isFinite(f.xs[i])).toBe(true);
      expect(Math.hypot(f.xs[i] ?? 0, f.ys[i] ?? 0)).toBeLessThan(2.2);
    }
    expect(f.start[f.count]).toBe(f.count * FIELD_POINTS);
  });

  it('uses a seeded generator whose output depends only on the seed', () => {
    const r1 = seeded(1);
    const r2 = seeded(1);
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
    expect(seeded(2)()).not.toBe(seeded(1)());
  });

  it('measures reach to the farthest corner', () => {
    expect(fieldReach({ x: 0, y: 0 }, 300, 400)).toBe(500);
  });
});

describe('backing store scale', () => {
  it('caps at 1.5 and at four million backing pixels, and may drop below 1', () => {
    expect(backingScale(3, 800, 600)).toBe(1.5);
    expect(backingScale(1, 1440, 900)).toBe(1);
    const huge = backingScale(2, 5120, 2880);
    expect(huge).toBeLessThan(1);
    expect(5120 * huge * 2880 * huge).toBeLessThanOrEqual(4_000_000 + 1);
  });
  it('skips zero dimensions and rejects a bad ratio', () => {
    expect(backingScale(2, 0, 100)).toBe(0);
    expect(backingScale(Number.NaN, 1000, 1000)).toBe(1);
  });
});

describe('quality tiers', () => {
  it('starts compact on small screens and balanced on weak hardware', () => {
    expect(initialTier({ cssWidth: 390, hardwareConcurrency: 8, deviceMemoryGb: 8 })).toBe(
      'compact',
    );
    expect(initialTier({ cssWidth: 1440, hardwareConcurrency: 2, deviceMemoryGb: null })).toBe(
      'balanced',
    );
    expect(initialTier({ cssWidth: 1440, hardwareConcurrency: 8, deviceMemoryGb: 8 })).toBe(
      'standard',
    );
  });

  it('steps down only after two consecutive missed windows, and never back up', () => {
    const g = new QualityGovernor('standard', 10);
    const feed = (ms: number) => {
      let stepped: string | null = null;
      for (let i = 0; i < 10; i++) stepped = g.record(ms) ?? stepped;
      return stepped;
    };
    expect(feed(9)).toBeNull();
    expect(g.tier).toBe('standard');
    expect(feed(9)).toBe('balanced');
    expect(feed(1)).toBeNull();
    expect(g.tier).toBe('balanced');
    feed(9);
    expect(feed(9)).toBe('compact');
    feed(20);
    expect(feed(20)).toBeNull();
    expect(g.tier).toBe('compact');
  });

  it('a single slow window does not step down, and a fast one resets the count', () => {
    const g = new QualityGovernor('standard', 5);
    for (let i = 0; i < 5; i++) g.record(9);
    for (let i = 0; i < 5; i++) g.record(1);
    for (let i = 0; i < 5; i++) g.record(9);
    expect(g.tier).toBe('standard');
  });

  it('has the blueprint ceilings', () => {
    expect(TIERS.standard).toMatchObject({
      filaments: 320,
      maxParticles: 64,
      idleFps: 20,
      activeFps: 60,
    });
    expect(TIERS.balanced).toMatchObject({
      filaments: 160,
      maxParticles: 32,
      idleFps: 15,
      activeFps: 30,
    });
    expect(TIERS.compact).toMatchObject({
      filaments: 80,
      maxParticles: 16,
      idleFps: 0,
      activeFps: 24,
    });
  });
});

describe('alert routing', () => {
  const region = { x: 100, y: 100, w: 200, h: 200 };
  const quiet = [region];
  it('detects a segment through a region', () => {
    expect(segmentCrossesRect({ x: 0, y: 200 }, { x: 400, y: 200 }, region)).toBe(true);
    expect(segmentCrossesRect({ x: 0, y: 50 }, { x: 400, y: 50 }, region)).toBe(false);
  });
  it('goes straight when clear, around via the channel when blocked, and nowhere when boxed in', () => {
    const from = { x: 50, y: 50 };
    expect(routeAlert(from, { x: 350, y: 50 }, quiet, null)).toHaveLength(2);
    const to = { x: 350, y: 350 };
    const blocked = [{ x: 150, y: 150, w: 100, h: 100 }];
    expect(routeAlert(from, to, blocked, null)).toBeNull();
    const around = routeAlert(from, to, blocked, 320);
    expect(around).toHaveLength(4);
    expect(routeAlert(from, to, [{ x: 0, y: 0, w: 400, h: 400 }], 320)).toBeNull();
  });
  it('makes stable jagged shapes that end exactly on the marker', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 140, y: 0 },
    ];
    const a = jagged(path, 0);
    const b = jagged(path, 0);
    expect(a).toEqual(b);
    expect(jagged(path, 1)).not.toEqual(a);
    expect(a[a.length - 1]).toEqual({ x: 140, y: 0 });
  });
});

describe('effects policy', () => {
  const base = {
    preference: 'system',
    osReducedMotion: false,
    forcedColors: false,
    canvasFailed: false,
  } as const;
  it('honours the operating system request and lets the site only reduce further', () => {
    expect(resolveEffects(base)).toBe('full');
    expect(resolveEffects({ ...base, osReducedMotion: true })).toBe('reduced');
    expect(resolveEffects({ ...base, preference: 'reduced' })).toBe('reduced');
    expect(resolveEffects({ ...base, preference: 'off' })).toBe('off');
    expect(resolveEffects({ ...base, preference: 'system', osReducedMotion: true })).not.toBe(
      'full',
    );
  });
  it('removes the canvas for forced colours or a failed canvas', () => {
    expect(resolveEffects({ ...base, forcedColors: true })).toBe('off');
    expect(resolveEffects({ ...base, canvasFailed: true })).toBe('off');
  });
  it('validates stored preferences', () => {
    expect(isEffectsPreference('reduced')).toBe(true);
    expect(isEffectsPreference('full')).toBe(false);
    expect(isEffectsPreference(null)).toBe(false);
  });
});
