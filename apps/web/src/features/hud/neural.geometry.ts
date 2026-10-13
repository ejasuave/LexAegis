/*
 * Pure geometry and policy for the neural canvas: seeded filaments, alert routing, backing-store
 * scale and quality adaptation. Nothing here touches the DOM or a canvas, so it can be tested
 * directly. The seed is a constant: geometry never derives from evidence, hashes or secrets.
 */

export const FIELD_SEED = 0x4c58a3;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type TierName = 'standard' | 'balanced' | 'compact';

export interface Tier {
  readonly name: TierName;
  readonly filaments: number;
  readonly maxParticles: number;
  /** Frames per second while nothing is executing. 0 means a static scene. */
  readonly idleFps: number;
  readonly activeFps: number;
  /** p95 canvas work per drawn frame above which quality steps down, in milliseconds. */
  readonly budgetMs: number;
}

export const TIERS: Readonly<Record<TierName, Tier>> = {
  standard: {
    name: 'standard',
    filaments: 320,
    maxParticles: 64,
    idleFps: 20,
    activeFps: 60,
    budgetMs: 4,
  },
  balanced: {
    name: 'balanced',
    filaments: 160,
    maxParticles: 32,
    idleFps: 15,
    activeFps: 30,
    budgetMs: 4,
  },
  compact: {
    name: 'compact',
    filaments: 80,
    maxParticles: 16,
    idleFps: 0,
    activeFps: 24,
    budgetMs: 2,
  },
};

const ORDER: readonly TierName[] = ['standard', 'balanced', 'compact'];

export function nextLowerTier(name: TierName): TierName {
  const index = ORDER.indexOf(name);
  return ORDER[Math.min(index + 1, ORDER.length - 1)] ?? 'compact';
}

/** The tier a device starts on. It only ever steps down from here. */
export function initialTier(input: {
  readonly cssWidth: number;
  readonly hardwareConcurrency: number | null;
  readonly deviceMemoryGb: number | null;
}): TierName {
  if (input.cssWidth < 800) return 'compact';
  if (
    (input.hardwareConcurrency !== null && input.hardwareConcurrency <= 2) ||
    (input.deviceMemoryGb !== null && input.deviceMemoryGb <= 2)
  ) {
    return 'balanced';
  }
  return 'standard';
}

/** min(devicePixelRatio, 1.5, sqrt(4_000_000 / (cssWidth * cssHeight))); may fall below 1. */
export function backingScale(dpr: number, cssWidth: number, cssHeight: number): number {
  if (!(cssWidth > 0) || !(cssHeight > 0)) return 0;
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return Math.min(safeDpr, 1.5, Math.sqrt(4_000_000 / (cssWidth * cssHeight)));
}

/**
 * Steps quality down after sustained frame-budget misses, never up, so tiers cannot oscillate.
 * A window is a fixed count of drawn frames; two consecutive missed windows trigger one step.
 */
export class QualityGovernor {
  readonly #window: number;
  readonly #samples: number[] = [];
  #misses = 0;
  #tier: TierName;

  constructor(start: TierName, windowFrames = 90) {
    this.#tier = start;
    this.#window = windowFrames;
  }

  get tier(): TierName {
    return this.#tier;
  }

  /** Records the canvas work of one drawn frame. Returns the new tier when it stepped down. */
  record(workMs: number): TierName | null {
    this.#samples.push(workMs);
    if (this.#samples.length < this.#window) return null;
    const sorted = [...this.#samples].sort((a, b) => a - b);
    this.#samples.length = 0;
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
    this.#misses = p95 > TIERS[this.#tier].budgetMs ? this.#misses + 1 : 0;
    if (this.#misses < 2) return null;
    this.#misses = 0;
    const lower = nextLowerTier(this.#tier);
    if (lower === this.#tier) return null;
    this.#tier = lower;
    return lower;
  }
}

/** Mulberry32: a small seeded generator, so the field is identical on every load. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Filaments as polylines in unit space (the origin is the nucleus; 1 is the field's reach).
 * Stems radiate with a slight spiral; each carries branches that leave it part-way along.
 */
export interface Field {
  readonly count: number;
  /** Index of each filament's first point in xs/ys, plus a final end index. */
  readonly start: Uint32Array;
  readonly xs: Float32Array;
  readonly ys: Float32Array;
  /** 0 for a stem, 1 for a branch. */
  readonly depth: Uint8Array;
  /** Unit perpendicular of each filament's base direction, for drift. */
  readonly perpX: Float32Array;
  readonly perpY: Float32Array;
  readonly phase: Float32Array;
}

const POINTS_PER_FILAMENT = 10;
const BRANCHES_PER_STEM = 7;

export function buildField(filaments: number, seed = FIELD_SEED): Field {
  const rand = seeded(seed);
  const stems = Math.max(1, Math.floor(filaments / (BRANCHES_PER_STEM + 1)));
  const total = stems * (BRANCHES_PER_STEM + 1);
  const start = new Uint32Array(total + 1);
  const xs = new Float32Array(total * POINTS_PER_FILAMENT);
  const ys = new Float32Array(total * POINTS_PER_FILAMENT);
  const depth = new Uint8Array(total);
  const perpX = new Float32Array(total);
  const perpY = new Float32Array(total);
  const phase = new Float32Array(total);

  let f = 0;
  const lay = (
    originX: number,
    originY: number,
    angle: number,
    length: number,
    curl: number,
    kind: 0 | 1,
  ): number => {
    const index = f++;
    start[index] = index * POINTS_PER_FILAMENT;
    depth[index] = kind;
    perpX[index] = -Math.sin(angle);
    perpY[index] = Math.cos(angle);
    phase[index] = rand() * Math.PI * 2;
    for (let k = 0; k < POINTS_PER_FILAMENT; k++) {
      const t = k / (POINTS_PER_FILAMENT - 1);
      const a = angle + curl * t * t;
      const r = length * t;
      xs[index * POINTS_PER_FILAMENT + k] = originX + Math.cos(a) * r;
      ys[index * POINTS_PER_FILAMENT + k] = originY + Math.sin(a) * r;
    }
    return index;
  };

  for (let s = 0; s < stems; s++) {
    // Even spread with jitter, so no wedge of the field is empty.
    const angle = ((s + rand() * 0.6) / stems) * Math.PI * 2;
    const length = 0.55 + rand() * 0.45;
    const curl = (rand() - 0.5) * 0.9;
    const stem = lay(0, 0, angle, length, curl, 0);
    for (let b = 0; b < BRANCHES_PER_STEM; b++) {
      const at = 2 + Math.floor(rand() * (POINTS_PER_FILAMENT - 4));
      const ox = xs[stem * POINTS_PER_FILAMENT + at] ?? 0;
      const oy = ys[stem * POINTS_PER_FILAMENT + at] ?? 0;
      const side = rand() < 0.5 ? -1 : 1;
      lay(
        ox,
        oy,
        angle + side * (0.25 + rand() * 0.6),
        length * (0.25 + rand() * 0.35),
        side * (0.2 + rand() * 0.5),
        1,
      );
    }
  }
  start[total] = total * POINTS_PER_FILAMENT;
  return { count: total, start, xs, ys, depth, perpX, perpY, phase };
}

export const FIELD_POINTS = POINTS_PER_FILAMENT;

/** Reach of the field: the distance from the origin to the farthest corner. */
export function fieldReach(origin: Point, width: number, height: number): number {
  const dx = Math.max(origin.x, width - origin.x);
  const dy = Math.max(origin.y, height - origin.y);
  return Math.hypot(dx, dy);
}

// ---- Alert routing ---------------------------------------------------------------------------

export function inflate(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, w: rect.w + 2 * by, h: rect.h + 2 * by };
}

function contains(rect: Rect, p: Point): boolean {
  return p.x > rect.x && p.x < rect.x + rect.w && p.y > rect.y && p.y < rect.y + rect.h;
}

/** True when the open segment passes through the rectangle's interior (Liang-Barsky). */
export function segmentCrossesRect(a: Point, b: Point, rect: Rect): boolean {
  if (contains(rect, a) || contains(rect, b)) return true;
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const edges: readonly [number, number][] = [
    [-dx, a.x - rect.x],
    [dx, rect.x + rect.w - a.x],
    [-dy, a.y - rect.y],
    [dy, rect.y + rect.h - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q <= 0) return false;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return t1 - t0 > 1e-6;
}

export function pathCrossesAny(path: readonly Point[], regions: readonly Rect[]): boolean {
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (a === undefined || b === undefined) continue;
    if (regions.some((region) => segmentCrossesRect(a, b, region))) return true;
  }
  return false;
}

/**
 * A path from the nucleus to a marker that never crosses a reading region: straight when clear,
 * otherwise along the gap channel between regions. Null when neither is clear: the DOM labels
 * still carry the finding, and nothing is drawn across words.
 */
export function routeAlert(
  from: Point,
  to: Point,
  regions: readonly Rect[],
  channelX: number | null,
): readonly Point[] | null {
  const straight = [from, to];
  if (!pathCrossesAny(straight, regions)) return straight;
  if (channelX === null) return null;
  const viaChannel = [from, { x: channelX, y: from.y }, { x: channelX, y: to.y }, to];
  return pathCrossesAny(viaChannel, regions) ? null : viaChannel;
}

/** Stable jagged points along a path: the same slot always yields the same shape. */
export function jagged(path: readonly Point[], slot: number, amplitude = 5): readonly Point[] {
  const rand = seeded(FIELD_SEED + 977 * (slot + 1));
  const out: Point[] = [];
  const first = path[0];
  if (first === undefined) return out;
  out.push(first);
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (a === undefined || b === undefined) continue;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(2, Math.round(length / 14));
    const nx = length === 0 ? 0 : -(b.y - a.y) / length;
    const ny = length === 0 ? 0 : (b.x - a.x) / length;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const offset = s === steps ? 0 : (rand() - 0.5) * 2 * amplitude;
      out.push({ x: a.x + (b.x - a.x) * t + nx * offset, y: a.y + (b.y - a.y) * t + ny * offset });
    }
  }
  return out;
}
