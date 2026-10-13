import type { ActivityState } from './hud.types';
import { WASH_FADE_MS, WASH_RISE_MS, washOpacity, type EffectsMode } from './hud.effects';
import {
  FIELD_POINTS,
  QualityGovernor,
  TIERS,
  backingScale,
  buildField,
  buildNetwork,
  easeToward,
  fieldReach,
  initialTier,
  inflate,
  jagged,
  routeAlert,
  seeded,
  visiblePoints,
  type Field,
  type Network,
  type Point,
  type Rect,
  type TierName,
} from './neural.geometry';

/*
 * Canvas 2D drawing only. It receives a visual scene and measured positions; it never fetches,
 * reads documents, owns authentication, issues commands or infers success. Timers integrate
 * visuals and nothing else.
 */

export type NucleusMode = 'hero' | 'compact' | 'none';

export interface AlertTarget {
  readonly severity: 'alert' | 'failure' | 'input';
  /** A real, visible finding marker; or the labelled Findings control when the row is off-screen. */
  readonly marker: Point;
}

export interface SceneState {
  readonly activity: ActivityState;
  /** True only while a tool is executing in a run whose activity can still be verified. */
  readonly toolsRunning: boolean;
  /** The exact-action approval is open: dim the art and stop all motion. */
  readonly ceremony: boolean;
  readonly nucleus: { readonly x: number; readonly y: number; readonly mode: NucleusMode } | null;
  /** Registered reading regions, in CSS pixels, before the safety margin is added. */
  readonly regions: readonly Rect[];
  readonly channelX: number | null;
  readonly alerts: readonly AlertTarget[];
  /** No matter is open: the canvas may fill the central stage. */
  readonly workspace: 'empty' | 'matter';
  /** The central working stage, in CSS pixels, for sizing the cluster. */
  readonly stage: Rect | null;
  /** One verified confirmation to show once. The id is the stable event identity. */
  readonly wash: { readonly id: string; readonly receivedAtMs: number } | null;
}

export const EMPTY_SCENE: SceneState = {
  activity: 'idle',
  toolsRunning: false,
  ceremony: false,
  nucleus: null,
  regions: [],
  channelX: null,
  alerts: [],
  workspace: 'empty',
  stage: null,
  wash: null,
};

export interface RendererStats {
  readonly framesDrawn: number;
  readonly loopRunning: boolean;
  readonly tier: TierName;
  readonly filaments: number;
  readonly liveParticles: number;
  readonly mode: EffectsMode;
  readonly backingPixels: number;
  /** p95 of the most recent window of canvas work, in milliseconds; null before one exists. */
  readonly lastP95Ms: number | null;
  /** Client-side timing of the last confirmation effect, in performance.now() milliseconds. */
  readonly wash: { readonly receivedAtMs: number; readonly firstFrameAtMs: number } | null;
}

interface Palette {
  /** Tendril colours, stems and branches, at idle strength. */
  readonly lines: readonly [string, string];
  /** The cluster's linking lines and its nodes. */
  readonly net: string;
  readonly node: string;
  readonly halo: string;
  readonly particle: string;
  readonly alpha: number;
  readonly bloom: number;
  readonly animated: boolean;
  /** Activity cue 0..1: brighter, longer tendrils and a larger core. Never progress. */
  readonly energy: number;
}

const COBALT = '59 130 246';
const CYAN = '103 232 249';
const VIOLET = '109 40 217';
const VIOLET_TEXT = '196 181 253';
const NEUTRAL = '100 116 139';
const AMBER = '251 191 36';
/** The one near-white: only ever the small, bounded core. */
const CORE_WHITE = 'rgb(236 252 255)';

function line(rgb: string, a: number): string {
  return `rgb(${rgb} / ${String(a)})`;
}

/** One state-to-visual table. The words for each state live in the DOM, never here. */
function paletteFor(activity: ActivityState): Palette {
  switch (activity) {
    case 'running':
      return {
        lines: [line(CYAN, 0.6), line(VIOLET_TEXT, 0.5)],
        net: line(VIOLET_TEXT, 0.42),
        node: line(CYAN, 0.85),
        halo: CYAN,
        particle: CYAN,
        alpha: 1,
        bloom: 0.8,
        animated: true,
        energy: 1,
      };
    case 'stopping':
      return {
        lines: [line(VIOLET, 0.55), line(VIOLET_TEXT, 0.3)],
        net: line(VIOLET_TEXT, 0.26),
        node: line(VIOLET_TEXT, 0.6),
        halo: VIOLET_TEXT,
        particle: VIOLET_TEXT,
        alpha: 0.85,
        bloom: 0.5,
        animated: false,
        energy: 0.15,
      };
    case 'queued':
    case 'awaiting_user':
      return {
        lines: [line(COBALT, 0.4), line(CYAN, 0.28)],
        net: line(COBALT, 0.26),
        node: line(CYAN, 0.5),
        halo: CYAN,
        particle: CYAN,
        alpha: 0.9,
        bloom: 0.45,
        animated: false,
        energy: 0,
      };
    case 'failed':
    case 'interrupted':
    case 'cancelled':
      return {
        lines: [line(NEUTRAL, 0.6), line(NEUTRAL, 0.44)],
        net: line(NEUTRAL, 0.4),
        node: line(NEUTRAL, 0.75),
        halo: NEUTRAL,
        particle: NEUTRAL,
        alpha: 0.95,
        bloom: 0.3,
        animated: false,
        energy: 0,
      };
    case 'stale':
    case 'offline':
    case 'unavailable':
      return {
        lines: [line(NEUTRAL, 0.6), line(NEUTRAL, 0.44)],
        net: line(NEUTRAL, 0.4),
        node: line(NEUTRAL, 0.75),
        halo: NEUTRAL,
        particle: NEUTRAL,
        alpha: 0.95,
        bloom: 0.3,
        animated: false,
        energy: 0,
      };
    case 'idle':
    case 'completed':
      return {
        lines: [line(COBALT, 0.65), line(CYAN, 0.5)],
        net: line(COBALT, 0.42),
        node: line(CYAN, 0.75),
        halo: CYAN,
        particle: CYAN,
        alpha: 1,
        bloom: 0.6,
        animated: true,
        energy: 0,
      };
  }
}

const HALO_HERO = 72;
const HALO_COMPACT = 17;
const CORE_HERO = 5;
const CORE_COMPACT = 2.5;
/** The core never grows past these, so near-white stays a small bounded disc. */
const CORE_HERO_MAX = 11;
const CORE_COMPACT_MAX = 4;
/** One slow breath, in seconds: no flicker, no pulse faster than this. */
const BREATH_SECONDS = 6;
const ENERGY_TAU_SECONDS = 1.4;
const MASK_MARGIN = 24;
const MASK_FEATHER = 14;
const FRAME_CLAMP_MS = 100;

export class NeuralRenderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;
  readonly #governor: QualityGovernor;
  readonly #rand = seeded(0x2f1d);
  #field: Field;
  #network: Network;
  #energy = 0;
  readonly #scratchX = new Float32Array(160);
  readonly #scratchY = new Float32Array(160);
  #tier: TierName;
  #mode: EffectsMode;
  #scene: SceneState = EMPTY_SCENE;
  #visible = true;
  #cssW = 0;
  #cssH = 0;
  #scale = 0;
  #dirty = true;
  #maskDirty = true;
  #mask: HTMLCanvasElement | null = null;
  #sprites = new Map<string, HTMLCanvasElement>();
  #raf = 0;
  #loop = false;
  #lastDraw = 0;
  #lastFrame = 0;
  #frames = 0;
  #lastP95: number | null = null;
  #work: number[] = [];
  #washId: string | null = null;
  #washStart = 0;
  #washTiming: { receivedAtMs: number; firstFrameAtMs: number } | null = null;

  // Particle pool: structure of arrays, fixed size, reused.
  readonly #pf = new Int16Array(64);
  readonly #pt = new Float32Array(64);
  readonly #pa = new Float32Array(64);
  readonly #pd = new Int8Array(64);
  #pn = 0;
  #spawnDebt = 0;

  constructor(canvas: HTMLCanvasElement, init: { mode: EffectsMode; tier?: TierName }) {
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('Canvas 2D is unavailable');
    this.#canvas = canvas;
    this.#ctx = ctx;
    this.#mode = init.mode;
    this.#tier =
      init.tier ??
      initialTier({
        cssWidth: typeof window === 'undefined' ? 1440 : window.innerWidth,
        hardwareConcurrency:
          typeof navigator === 'undefined' ? null : navigator.hardwareConcurrency,
        deviceMemoryGb:
          typeof navigator === 'undefined'
            ? null
            : ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null),
      });
    this.#governor = new QualityGovernor(this.#tier);
    this.#field = buildField(this.#filamentCount());
    this.#network = buildNetwork(this.#nodeCount());
  }

  #nodeCount(): number {
    return this.#mode === 'reduced' ? TIERS.compact.nodes : TIERS[this.#tier].nodes;
  }

  #filamentCount(): number {
    // Reduced mode is a static, simplified field.
    return this.#mode === 'reduced' ? TIERS.compact.filaments : TIERS[this.#tier].filaments;
  }

  stats(): RendererStats {
    return {
      framesDrawn: this.#frames,
      loopRunning: this.#loop,
      tier: this.#tier,
      filaments: this.#field.count,
      liveParticles: this.#pn,
      mode: this.#mode,
      backingPixels: this.#canvas.width * this.#canvas.height,
      lastP95Ms: this.#lastP95,
      wash: this.#washTiming,
    };
  }

  setMode(mode: EffectsMode): void {
    if (mode === this.#mode) return;
    this.#mode = mode;
    this.#field = buildField(this.#filamentCount());
    this.#network = buildNetwork(this.#nodeCount());
    this.#pn = 0;
    this.#dirty = true;
    this.#schedule();
  }

  setVisible(visible: boolean): void {
    if (visible === this.#visible) return;
    this.#visible = visible;
    // Resume without simulating the frames that were missed.
    this.#lastFrame = 0;
    this.#schedule();
  }

  setScene(scene: SceneState): void {
    const regionsChanged = !sameRects(this.#scene.regions, scene.regions);
    this.#scene = scene;
    if (regionsChanged) this.#maskDirty = true;
    this.#dirty = true;
    this.#schedule();
  }

  /** Sizes the backing store from actual layout dimensions; reallocates only on a real change. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const scale = backingScale(dpr, cssWidth, cssHeight);
    if (scale === 0) {
      this.#cssW = 0;
      this.#cssH = 0;
      return;
    }
    const w = Math.max(1, Math.round(cssWidth * scale));
    const h = Math.max(1, Math.round(cssHeight * scale));
    const same = w === this.#canvas.width && h === this.#canvas.height && scale === this.#scale;
    this.#cssW = cssWidth;
    this.#cssH = cssHeight;
    if (!same) {
      this.#canvas.width = w;
      this.#canvas.height = h;
      this.#scale = scale;
      this.#mask = null;
      this.#sprites.clear();
      this.#maskDirty = true;
    }
    this.#dirty = true;
    this.#schedule();
  }

  dispose(): void {
    if (this.#raf !== 0) cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    this.#loop = false;
    this.#visible = false;
    this.#mask = null;
    this.#sprites.clear();
  }

  // ---- Scheduling ----------------------------------------------------------------------------

  #animating(): boolean {
    const s = this.#scene;
    return (
      this.#mode === 'full' &&
      !s.ceremony &&
      (paletteFor(s.activity).animated ||
        s.toolsRunning ||
        this.#pn > 0 ||
        this.#washLive() ||
        this.#energySettling())
    );
  }

  /** The activity cue eases in and out over a second or two, so it needs frames while it moves. */
  #energyTarget(): number {
    const s = this.#scene;
    if (s.ceremony) return 0;
    const base = paletteFor(s.activity).energy;
    // Full strength only while a tool really executes; between tools a run is only mildly raised.
    return s.activity === 'running' ? (s.toolsRunning ? base : base * 0.35) : base;
  }

  #energySettling(): boolean {
    return Math.abs(this.#energy - this.#energyTarget()) > 0.002;
  }

  #washLive(): boolean {
    return this.#washStart > 0 && performance.now() < this.#washStart + WASH_RISE_MS + WASH_FADE_MS;
  }

  #fps(): number {
    const tier = TIERS[this.#tier];
    return this.#scene.toolsRunning || this.#pn > 0 || this.#washLive() || this.#energySettling()
      ? tier.activeFps
      : tier.idleFps;
  }

  #schedule(): void {
    if (this.#raf !== 0 || !this.#visible || this.#mode === 'off') return;
    if (this.#cssW === 0) return;
    const wantsLoop = this.#animating() && this.#fps() > 0;
    if (!wantsLoop && !this.#dirty) {
      this.#loop = false;
      return;
    }
    this.#raf = requestAnimationFrame(this.#tick);
  }

  readonly #tick = (now: number): void => {
    this.#raf = 0;
    if (!this.#visible || this.#mode === 'off' || this.#cssW === 0) {
      this.#loop = false;
      return;
    }
    const animating = this.#animating() && this.#fps() > 0;
    const minGap = animating ? 1000 / this.#fps() : 0;
    if (animating && !this.#dirty && now - this.#lastDraw < minGap - 1) {
      this.#loop = true;
      this.#raf = requestAnimationFrame(this.#tick);
      return;
    }
    this.#startWash(now);
    const dt = this.#lastFrame === 0 ? 0 : Math.min(now - this.#lastFrame, FRAME_CLAMP_MS) / 1000;
    this.#lastFrame = now;
    this.#lastDraw = now;
    const started = performance.now();
    this.#draw(now / 1000, dt, animating);
    const work = performance.now() - started;
    this.#frames++;
    this.#dirty = false;
    if (animating) this.#adapt(work);
    this.#loop = this.#animating() && this.#fps() > 0;
    if (this.#loop) this.#raf = requestAnimationFrame(this.#tick);
    else this.#lastFrame = 0;
  };

  /** Starts the one-shot effect on the first rendered frame after the signal arrived. */
  #startWash(now: number): void {
    const wash = this.#scene.wash;
    if (wash === null) {
      // A withdrawn confirmation ends the effect at once.
      this.#washStart = 0;
      return;
    }
    if (wash.id === this.#washId) return;
    this.#washId = wash.id;
    if (this.#mode !== 'full' || this.#scene.ceremony || !this.#visible) return;
    this.#washStart = now;
    // Both in the performance.now() timeline, so the interval is a real client-side delay.
    this.#washTiming = { receivedAtMs: wash.receivedAtMs, firstFrameAtMs: performance.now() };
  }

  #adapt(work: number): void {
    this.#work.push(work);
    if (this.#work.length >= 90) {
      const sorted = [...this.#work].sort((a, b) => a - b);
      this.#lastP95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? null;
      this.#work.length = 0;
    }
    const stepped = this.#governor.record(work);
    if (stepped !== null) {
      this.#tier = stepped;
      this.#field = buildField(this.#filamentCount());
      this.#network = buildNetwork(this.#nodeCount());
      this.#pn = Math.min(this.#pn, TIERS[stepped].maxParticles);
      this.#dirty = true;
    }
  }

  // ---- Drawing -------------------------------------------------------------------------------

  #draw(t: number, dt: number, animating: boolean): void {
    const ctx = this.#ctx;
    const s = this.#scene;
    const palette = paletteFor(s.activity);
    const scale = this.#scale;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, this.#cssW, this.#cssH);

    const origin: Point = s.nucleus ?? { x: this.#cssW * 0.5, y: this.#cssH * 0.44 };
    const mode: NucleusMode = s.nucleus?.mode ?? 'none';
    const reach = fieldReach(origin, this.#cssW, this.#cssH);
    const full = this.#mode === 'full' && !s.ceremony;
    const motion = animating && full;
    const target = this.#energyTarget();
    // Eased while animating; a still scene (reduced) shows the settled look straight away.
    this.#energy = motion ? easeToward(this.#energy, target, dt, ENERGY_TAU_SECONDS) : target;
    const energy = this.#energy;
    const empty = s.workspace === 'empty';
    // The canvas fills the stage only with no matter open. With a matter open the tendrils stay in
    // the margins and the cluster shrinks; in Review the nucleus is a small status knot.
    const emphasis = s.ceremony
      ? 0.18
      : mode === 'hero'
        ? empty
          ? 1
          : 0.65
        : mode === 'compact'
          ? 0.5
          : 0.4;
    const breath = motion ? 1 + 0.06 * Math.sin((t * Math.PI * 2) / BREATH_SECONDS) : 1;

    this.#drawField(ctx, origin, reach, t, palette, emphasis * palette.alpha, motion, mode, energy);
    this.#drawCluster(ctx, origin, mode, palette, emphasis * palette.alpha, t, motion, empty);
    if (mode !== 'none') this.#drawNucleus(ctx, origin, mode, palette, s, energy, breath);
    if (full) {
      this.#stepParticles(dt, s.toolsRunning && s.activity === 'running');
      this.#drawParticles(ctx, origin, reach, palette, energy);
    } else {
      this.#pn = 0;
    }
    this.#drawWash(ctx, origin, mode, t * 1000);
    this.#applyMask(ctx);
    this.#drawAlerts(ctx, origin, s, t, motion);
  }

  /** Tendrils: long thin curves smoothed through their midpoints. Energy lengthens and brightens them. */
  #drawField(
    ctx: CanvasRenderingContext2D,
    origin: Point,
    reach: number,
    t: number,
    palette: Palette,
    alpha: number,
    motion: boolean,
    mode: NucleusMode,
    energy: number,
  ): void {
    const f = this.#field;
    const innerGap = (mode === 'hero' ? HALO_HERO : mode === 'compact' ? HALO_COMPACT : 24) / reach;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const trace = (i: number, fraction: number): void => {
      const begin = f.start[i] ?? 0;
      const sway = motion ? Math.sin(t * 0.12 + (f.phase[i] ?? 0)) * 0.006 : 0;
      const px = f.perpX[i] ?? 0;
      const py = f.perpY[i] ?? 0;
      const { whole, rest } = visiblePoints(FIELD_POINTS, fraction);
      const xs: number[] = [];
      const ys: number[] = [];
      for (let k = 0; k <= whole + 1 && k < FIELD_POINTS; k++) {
        let ux = f.xs[begin + k] ?? 0;
        let uy = f.ys[begin + k] ?? 0;
        if (k === whole + 1) {
          // The partial last segment, so a tendril can lengthen smoothly.
          ux = (f.xs[begin + whole] ?? 0) + (ux - (f.xs[begin + whole] ?? 0)) * rest;
          uy = (f.ys[begin + whole] ?? 0) + (uy - (f.ys[begin + whole] ?? 0)) * rest;
        }
        // Points inside the halo are skipped, so the core keeps a dark ring around it.
        if (Math.hypot(ux, uy) < innerGap) continue;
        const d = sway * (k / (FIELD_POINTS - 1));
        xs.push(origin.x + (ux + px * d) * reach);
        ys.push(origin.y + (uy + py * d) * reach);
      }
      const n = xs.length;
      if (n < 2) return;
      ctx.moveTo(xs[0] ?? 0, ys[0] ?? 0);
      for (let k = 1; k < n - 1; k++) {
        const mx = ((xs[k] ?? 0) + (xs[k + 1] ?? 0)) / 2;
        const my = ((ys[k] ?? 0) + (ys[k + 1] ?? 0)) / 2;
        ctx.quadraticCurveTo(xs[k] ?? 0, ys[k] ?? 0, mx, my);
      }
      ctx.lineTo(xs[n - 1] ?? 0, ys[n - 1] ?? 0);
    };
    const stemFraction = 0.72 + 0.28 * energy;
    const branchFraction = 0.55 + 0.45 * energy;
    ctx.globalAlpha = alpha;
    for (let batch = 0; batch < 4; batch++) {
      ctx.beginPath();
      ctx.strokeStyle = palette.lines[batch & 1] ?? palette.lines[0];
      ctx.lineWidth = batch < 2 ? 0.9 : 0.6;
      for (let i = 0; i < f.count; i++) {
        const kind = f.depth[i] ?? 0;
        if ((kind << 1) + (i & 1) !== batch) continue;
        trace(i, kind === 0 ? stemFraction : branchFraction);
      }
      ctx.stroke();
    }
    if (energy > 0.02) {
      // The brighter pass: stems only, white-cyan, fading in with the activity cue.
      ctx.beginPath();
      ctx.strokeStyle = line('214 244 255', 0.8 * energy);
      ctx.lineWidth = 1.3;
      ctx.globalAlpha = alpha;
      for (const stem of f.stems) trace(stem, stemFraction);
      ctx.stroke();
    }
    // Beads along the stems: small static nodes that make the tendrils read as a network.
    this.#drawBeads(ctx, origin, reach, t, palette, alpha, motion, stemFraction, innerGap);
    ctx.globalAlpha = 1;
  }

  #drawBeads(
    ctx: CanvasRenderingContext2D,
    origin: Point,
    reach: number,
    t: number,
    palette: Palette,
    alpha: number,
    motion: boolean,
    fraction: number,
    innerGap: number,
  ): void {
    const f = this.#field;
    ctx.globalAlpha = alpha * 0.9;
    ctx.fillStyle = palette.node;
    ctx.beginPath();
    for (const stem of f.stems) {
      const begin = f.start[stem] ?? 0;
      const sway = motion ? Math.sin(t * 0.12 + (f.phase[stem] ?? 0)) * 0.006 : 0;
      for (const at of [0.34, 0.58, 0.82]) {
        if (at > fraction) continue;
        const u = at * (FIELD_POINTS - 1);
        const k = Math.min(FIELD_POINTS - 2, Math.floor(u));
        const frac = u - k;
        const ux = (f.xs[begin + k] ?? 0) * (1 - frac) + (f.xs[begin + k + 1] ?? 0) * frac;
        const uy = (f.ys[begin + k] ?? 0) * (1 - frac) + (f.ys[begin + k + 1] ?? 0) * frac;
        if (Math.hypot(ux, uy) < innerGap) continue;
        const d = sway * at;
        const x = origin.x + (ux + (f.perpX[stem] ?? 0) * d) * reach;
        const y = origin.y + (uy + (f.perpY[stem] ?? 0) * d) * reach;
        ctx.moveTo(x + 1.4, y);
        ctx.arc(x, y, 1.4, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  }

  /**
   * The linked cluster around the nucleus. Sized to the stage when no matter is open, a small
   * knot beside the document otherwise, absent when there is no nucleus on the page.
   */
  #drawCluster(
    ctx: CanvasRenderingContext2D,
    origin: Point,
    mode: NucleusMode,
    palette: Palette,
    alpha: number,
    t: number,
    motion: boolean,
    empty: boolean,
  ): void {
    if (mode === 'none') return;
    const stage = this.#scene.stage;
    const stageW = stage?.w ?? this.#cssW * 0.6;
    const stageH = stage?.h ?? this.#cssH * 0.7;
    const radius =
      mode === 'hero'
        ? empty
          ? Math.min(stageW * 0.3, stageH * 0.36)
          : Math.min(stageW * 0.14, 110)
        : 26;
    const n = this.#network;
    const xs = this.#scratchX;
    const ys = this.#scratchY;
    for (let i = 0; i < n.count; i++) {
      const drift = motion ? Math.sin(t * 0.2 + (n.phase[i] ?? 0)) * 0.012 : 0;
      xs[i] = origin.x + ((n.xs[i] ?? 0) + drift) * radius;
      ys[i] = origin.y + ((n.ys[i] ?? 0) - drift) * radius;
    }
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = palette.net;
    ctx.beginPath();
    for (let e = 0; e < n.edges; e++) {
      const a = n.edgeFrom[e] ?? 0;
      const b = n.edgeTo[e] ?? 0;
      ctx.moveTo(xs[a] ?? 0, ys[a] ?? 0);
      ctx.lineTo(xs[b] ?? 0, ys[b] ?? 0);
    }
    ctx.stroke();
    ctx.fillStyle = palette.node;
    ctx.beginPath();
    for (let i = 0; i < n.count; i++) {
      const size = i % 5 === 0 ? 3 : 2;
      ctx.rect((xs[i] ?? 0) - size / 2, (ys[i] ?? 0) - size / 2, size, size);
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  #sprite(
    key: string,
    size: number,
    draw: (c: CanvasRenderingContext2D, r: number) => void,
  ): HTMLCanvasElement {
    const cached = this.#sprites.get(key);
    if (cached !== undefined) return cached;
    const px = Math.max(2, Math.round(size * 2 * this.#scale));
    const c = document.createElement('canvas');
    c.width = px;
    c.height = px;
    const g = c.getContext('2d');
    if (g !== null) draw(g, px / 2);
    this.#sprites.set(key, c);
    return c;
  }

  #drawNucleus(
    ctx: CanvasRenderingContext2D,
    origin: Point,
    mode: NucleusMode,
    palette: Palette,
    scene: SceneState,
    energy: number,
    breath: number,
  ): void {
    const hero = mode === 'hero';
    const halo = (hero ? HALO_HERO : HALO_COMPACT) * (1 + 0.45 * energy) * breath;
    const core = Math.min(
      hero ? CORE_HERO_MAX : CORE_COMPACT_MAX,
      (hero ? CORE_HERO + 6 * energy : CORE_COMPACT + 1.5 * energy) * breath,
    );
    const rgb = palette.halo === CYAN ? CYAN : palette.halo === NEUTRAL ? NEUTRAL : VIOLET_TEXT;
    const glow = this.#sprite(
      `halo:${rgb}:${String(hero)}`,
      hero ? HALO_HERO * 1.5 : HALO_COMPACT * 1.5,
      (g, r) => {
        const gradient = g.createRadialGradient(r, r, 0, r, r, r);
        gradient.addColorStop(0, `rgb(${rgb} / 0.6)`);
        gradient.addColorStop(0.25, `rgb(${rgb} / 0.22)`);
        gradient.addColorStop(1, `rgb(${rgb} / 0)`);
        g.fillStyle = gradient;
        g.fillRect(0, 0, r * 2, r * 2);
      },
    );
    ctx.globalAlpha = scene.ceremony ? 0.1 : Math.min(1, palette.bloom + 0.25 * energy);
    ctx.drawImage(glow, origin.x - halo, origin.y - halo, halo * 2, halo * 2);
    ctx.globalAlpha = scene.ceremony ? 0.3 : 1;
    ctx.beginPath();
    ctx.arc(origin.x, origin.y, core, 0, Math.PI * 2);
    ctx.fillStyle = palette.halo === NEUTRAL ? 'rgb(170 182 196)' : CORE_WHITE;
    ctx.fill();
    ctx.globalAlpha = 1;
    if (scene.activity === 'failed') {
      // A failed run is a static field with a marker; the words say what failed.
      ctx.strokeStyle = 'rgb(251 113 133)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(origin.x, origin.y, core + (hero ? 9 : 5), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /** Particles run along the stems, half inward and half outward, only while a tool executes. */
  #stepParticles(dt: number, spawn: boolean): void {
    const cap = TIERS[this.#tier].maxParticles;
    const reachFraction = 0.72 + 0.28 * this.#energy;
    for (let i = this.#pn - 1; i >= 0; i--) {
      this.#pt[i] = (this.#pt[i] ?? 0) + (this.#pd[i] ?? 1) * dt * 0.5;
      // Particles stop and fade when emission stops; they never imply completion.
      this.#pa[i] = Math.min((this.#pa[i] ?? 0) + dt * 3, spawn ? 1 : (this.#pa[i] ?? 0));
      if (!spawn) this.#pa[i] = Math.max(0, (this.#pa[i] ?? 0) - dt * 2.4);
      const p = this.#pt[i] ?? 0;
      if (p <= 0 || p >= reachFraction || (this.#pa[i] ?? 0) <= 0) this.#remove(i);
    }
    if (!spawn) return;
    this.#spawnDebt += dt * (cap / 1.8);
    const stems = this.#field.stems;
    while (this.#spawnDebt >= 1 && this.#pn < cap) {
      this.#spawnDebt -= 1;
      const stem = stems[Math.floor(this.#rand() * stems.length)] ?? 0;
      const outward = this.#pn % 2 === 0;
      this.#pf[this.#pn] = stem;
      this.#pd[this.#pn] = outward ? 1 : -1;
      this.#pt[this.#pn] = outward ? 0.02 : reachFraction - 0.02;
      this.#pa[this.#pn] = 0;
      this.#pn++;
    }
    this.#spawnDebt = Math.min(this.#spawnDebt, 2);
  }

  #remove(i: number): void {
    const last = this.#pn - 1;
    this.#pf[i] = this.#pf[last] ?? 0;
    this.#pt[i] = this.#pt[last] ?? 0;
    this.#pa[i] = this.#pa[last] ?? 0;
    this.#pd[i] = this.#pd[last] ?? 1;
    this.#pn = last;
  }

  #drawParticles(
    ctx: CanvasRenderingContext2D,
    origin: Point,
    reach: number,
    palette: Palette,
    energy: number,
  ): void {
    if (this.#pn === 0) return;
    const f = this.#field;
    const rgb =
      palette.particle === NEUTRAL ? NEUTRAL : palette.particle === CYAN ? CYAN : VIOLET_TEXT;
    const dot = this.#sprite(`dot:${rgb}`, 6, (g, r) => {
      const gradient = g.createRadialGradient(r, r, 0, r, r, r);
      gradient.addColorStop(0, `rgb(${rgb} / 0.95)`);
      gradient.addColorStop(0.35, `rgb(${rgb} / 0.4)`);
      gradient.addColorStop(1, `rgb(${rgb} / 0)`);
      g.fillStyle = gradient;
      g.fillRect(0, 0, r * 2, r * 2);
    });
    for (let i = 0; i < this.#pn; i++) {
      const stem = this.#pf[i] ?? 0;
      const u = Math.max(0, Math.min(1, this.#pt[i] ?? 0)) * (FIELD_POINTS - 1);
      const k = Math.min(FIELD_POINTS - 2, Math.floor(u));
      const frac = u - k;
      const begin = f.start[stem] ?? 0;
      const ux = (f.xs[begin + k] ?? 0) * (1 - frac) + (f.xs[begin + k + 1] ?? 0) * frac;
      const uy = (f.ys[begin + k] ?? 0) * (1 - frac) + (f.ys[begin + k + 1] ?? 0) * frac;
      ctx.globalAlpha = (this.#pa[i] ?? 0) * (0.7 + 0.25 * energy);
      ctx.drawImage(dot, origin.x + ux * reach - 6, origin.y + uy * reach - 6, 12, 12);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * One low-luminance cyan wash and a wave leaving the nucleus. Both are painted before the
   * reading-zone mask, so text backgrounds stay dark throughout, and neither exceeds the envelope.
   */
  #drawWash(ctx: CanvasRenderingContext2D, origin: Point, mode: NucleusMode, nowMs: number): void {
    if (!this.#washLive() || this.#scene.ceremony) return;
    const elapsed = nowMs - this.#washStart;
    const opacity = washOpacity(elapsed);
    if (opacity > 0) {
      ctx.globalAlpha = opacity;
      ctx.fillStyle = `rgb(${CYAN})`;
      ctx.fillRect(0, 0, this.#cssW, this.#cssH);
    }
    if (mode !== 'none') {
      const total = WASH_RISE_MS + WASH_FADE_MS;
      const p = Math.min(1, Math.max(0, elapsed / total));
      ctx.globalAlpha = 0.3 * (1 - p);
      ctx.strokeStyle = `rgb(${CYAN})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(
        origin.x,
        origin.y,
        (mode === 'hero' ? HALO_HERO : HALO_COMPACT) * (1 + 2.2 * p),
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ---- Quiet zones ---------------------------------------------------------------------------

  /** Paints the shared contrast mask over the art: reading regions are solid dark with a soft edge. */
  #applyMask(ctx: CanvasRenderingContext2D): void {
    if (this.#scene.regions.length === 0) return;
    if (this.#mask === null || this.#maskDirty) this.#buildMask();
    if (this.#mask !== null) ctx.drawImage(this.#mask, 0, 0, this.#cssW, this.#cssH);
  }

  #buildMask(): void {
    const mask = this.#mask ?? document.createElement('canvas');
    mask.width = this.#canvas.width;
    mask.height = this.#canvas.height;
    const g = mask.getContext('2d');
    this.#mask = mask;
    this.#maskDirty = false;
    if (g === null) return;
    g.setTransform(this.#scale, 0, 0, this.#scale, 0, 0);
    g.clearRect(0, 0, this.#cssW, this.#cssH);
    g.fillStyle = '#000';
    g.shadowColor = '#000';
    g.shadowBlur = MASK_FEATHER * this.#scale;
    for (const region of this.#scene.regions) {
      const r = inflate(region, MASK_MARGIN);
      g.fillRect(r.x, r.y, r.w, r.h);
    }
  }

  // ---- Alerts --------------------------------------------------------------------------------

  #drawAlerts(
    ctx: CanvasRenderingContext2D,
    origin: Point,
    s: SceneState,
    t: number,
    motion: boolean,
  ): void {
    if (s.alerts.length === 0 || s.nucleus === null) return;
    // Raw registered regions: a marker sits just outside its own region, inside the safety margin.
    const reading = s.regions;
    // A slow, shallow intensity change; frozen when motion is off.
    const pulse = motion ? 0.82 + 0.18 * Math.sin(t * 0.9) : 0.9;
    s.alerts.slice(0, 3).forEach((target, slot) => {
      const path = routeAlert(origin, target.marker, reading, s.channelX);
      if (path === null) return;
      const shape = jagged(path, slot);
      ctx.beginPath();
      shape.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.strokeStyle = target.severity === 'failure' ? 'rgb(251 113 133)' : `rgb(${AMBER})`;
      ctx.globalAlpha = (s.ceremony ? 0.25 : 0.85) * pulse;
      ctx.lineWidth = 1;
      ctx.lineJoin = 'miter';
      ctx.stroke();
      // The branch ends in a small marker beside the row, never across its words.
      const m = target.marker;
      ctx.beginPath();
      ctx.moveTo(m.x, m.y - 4);
      ctx.lineTo(m.x + 4, m.y + 3);
      ctx.lineTo(m.x - 4, m.y + 3);
      ctx.closePath();
      ctx.fillStyle = target.severity === 'failure' ? 'rgb(251 113 133)' : `rgb(${AMBER})`;
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }
}

function sameRects(a: readonly Rect[], b: readonly Rect[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((r, i) => {
    const o = b[i];
    return o !== undefined && r.x === o.x && r.y === o.y && r.w === o.w && r.h === o.h;
  });
}
