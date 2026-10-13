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
  initialTier,
  inflate,
  jagged,
  routeAlert,
  seeded,
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
    case 'unavailable':
      // No assistant to run (signed out or not configured) is not a fault: the field idles, a little dimmer.
      return {
        lines: [line(COBALT, 0.65), line(CYAN, 0.5)],
        net: line(COBALT, 0.42),
        node: line(CYAN, 0.75),
        halo: CYAN,
        particle: CYAN,
        alpha: 0.85,
        bloom: 0.5,
        animated: true,
        energy: 0,
      };
    case 'stale':
    case 'offline':
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
const ENERGY_RISE_TAU = 0.2;
const ENERGY_FALL_TAU = 0.4;
/** Thinking pulses once every 1.75 s: well under three a second. */
const PULSE_SECONDS = 1.75;
const RIM_SECONDS = 10;
const LOBE_RGB = ['129 140 248', '250 204 21', '251 113 60', '74 222 128'] as const;
const TENDRIL_RGB = '190 215 255';
const MASK_MARGIN = 24;
const MASK_FEATHER = 14;
const FRAME_CLAMP_MS = 100;

interface Geometry {
  readonly origin: Point;
  readonly mode: NucleusMode;
  readonly empty: boolean;
  /** One unit of tendril length, in CSS pixels. */
  readonly unit: number;
  /** Nucleus sphere radius. */
  readonly sphere: number;
  /** Half-extent of the mesh. */
  readonly mesh: number;
}

export class NeuralRenderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;
  readonly #governor: QualityGovernor;
  readonly #rand = seeded(0x2f1d);
  #field: Field;
  #network: Network;
  #energy = 0;
  readonly #scratchX = new Float32Array(512);
  readonly #scratchY = new Float32Array(512);
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
  #fade: HTMLCanvasElement | null = null;
  #fadeKey = '';
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
    this.#field = buildField(this.#filamentCount(), undefined, this.#tendrilCount());
    this.#network = buildNetwork(this.#nodeCount());
  }

  #tendrilCount(): number {
    return this.#mode === 'reduced' ? TIERS.compact.tendrils : TIERS[this.#tier].tendrils;
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
    this.#field = buildField(this.#filamentCount(), undefined, this.#tendrilCount());
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
    // Ambient beads run at the idle rate; only real activity, a confirmation or an easing cue ask for more.
    return this.#scene.toolsRunning || this.#washLive() || this.#energySettling()
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
      this.#field = buildField(this.#filamentCount(), undefined, this.#tendrilCount());
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

    const empty = s.workspace === 'empty';
    const stage = s.stage;
    const stageW = stage?.w ?? this.#cssW * 0.6;
    const stageH = stage?.h ?? this.#cssH * 0.7;
    const mode: NucleusMode = s.nucleus?.mode ?? 'none';
    // With nothing open the nucleus sits at the exact centre of the stage.
    const origin: Point =
      empty && mode === 'hero' && stage !== null
        ? { x: stage.x + stage.w / 2, y: stage.y + stage.h / 2 }
        : (s.nucleus ?? { x: this.#cssW * 0.5, y: this.#cssH * 0.44 });
    const full = this.#mode === 'full' && !s.ceremony;
    const motion = animating && full && palette.animated;
    const target = this.#energyTarget();
    this.#energy = motion
      ? easeToward(
          this.#energy,
          target,
          dt,
          target > this.#energy ? ENERGY_RISE_TAU : ENERGY_FALL_TAU,
        )
      : target;
    const energy = this.#energy;
    // The canvas owns the stage only with no matter open. With one open the orb shrinks to an
    // ambient presence and the reading-zone masks keep every word on a dark floor.
    const emphasis = s.ceremony
      ? 0.18
      : mode === 'hero'
        ? empty
          ? 1
          : 0.6
        : mode === 'compact'
          ? 0.5
          : 0.4;
    const geometry: Geometry = {
      origin,
      mode,
      empty,
      // Tendrils reach about half the stage width; thinking lengthens them by 1.6x.
      unit: 0.5 * stageW * (1 + 0.6 * energy),
      sphere:
        mode === 'hero'
          ? stageH * (empty ? 0.19 + 0.05 * energy : 0.07 + 0.02 * energy)
          : mode === 'compact'
            ? 13 + 2 * energy
            : 0,
      mesh:
        mode === 'hero'
          ? empty
            ? Math.min(stageW * 0.33, stageH * 0.5)
            : Math.min(stageW * 0.13, 100)
          : mode === 'compact'
            ? 26
            : 0,
    };

    const alpha = emphasis * palette.alpha;
    this.#drawMesh(ctx, geometry, palette, alpha, t, motion);
    this.#drawTendrils(ctx, geometry, t, palette, alpha, motion, energy);
    if (mode !== 'none') this.#drawNucleus(ctx, geometry, palette, s, energy, t, motion);
    if (full) {
      this.#stepParticles(dt, palette.animated || s.toolsRunning, energy);
      this.#drawParticles(ctx, geometry, palette, energy);
    } else {
      this.#pn = 0;
    }
    // With nothing open the art owns the stage, but fades out toward its edges instead of ending on a hard rectangle.
    if (empty && stage !== null && mode === 'hero') this.#fadeToStage(ctx, stage);
    this.#drawWash(ctx, origin, mode, t * 1000);
    this.#applyMask(ctx);
    this.#drawAlerts(ctx, origin, s, t, motion);
  }

  /**
   * Tendrils: 24 to 40 smooth cubic curves in near-white blue with a soft glow, swaying
   * continuously. Fine branch filaments add texture. Thinking lengthens and brightens them.
   */
  #drawTendrils(
    ctx: CanvasRenderingContext2D,
    g: Geometry,
    t: number,
    palette: Palette,
    alpha: number,
    motion: boolean,
    energy: number,
  ): void {
    const f = this.#field;
    const muted = palette.halo === NEUTRAL;
    const rgb = muted ? NEUTRAL : palette.halo === VIOLET_TEXT ? VIOLET_TEXT : TENDRIL_RGB;
    const innerGap =
      (g.mode === 'hero' ? g.sphere * 1.05 : g.mode === 'compact' ? g.sphere * 1.3 : 24) / g.unit;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = 'lighter';
    const xs: number[] = [];
    const ys: number[] = [];
    const trace = (i: number): void => {
      const begin = f.start[i] ?? 0;
      const px = f.perpX[i] ?? 0;
      const py = f.perpY[i] ?? 0;
      const ph = f.phase[i] ?? 0;
      xs.length = 0;
      ys.length = 0;
      for (let k = 0; k < FIELD_POINTS; k++) {
        const ux = f.xs[begin + k] ?? 0;
        const uy = f.ys[begin + k] ?? 0;
        if (Math.hypot(ux, uy) < innerGap) continue;
        // Two slow waves that never repeat in step: continuous sway, strongest at the tip.
        const along = k / (FIELD_POINTS - 1);
        const d = motion
          ? (Math.sin(t * 0.55 + ph + along * 2.1) * 0.035 +
              Math.sin(t * 0.23 + ph * 1.7 - along) * 0.03) *
            along
          : 0;
        xs.push(g.origin.x + (ux + px * d) * g.unit);
        ys.push(g.origin.y + (uy + py * d) * g.unit);
      }
      const n = xs.length;
      if (n < 2) return;
      ctx.moveTo(xs[0] ?? 0, ys[0] ?? 0);
      // Catmull-Rom through the points, written as cubic Beziers: smooth, never a spike.
      for (let k = 0; k < n - 1; k++) {
        const p0x = xs[Math.max(0, k - 1)] ?? 0;
        const p0y = ys[Math.max(0, k - 1)] ?? 0;
        const p1x = xs[k] ?? 0;
        const p1y = ys[k] ?? 0;
        const p2x = xs[k + 1] ?? 0;
        const p2y = ys[k + 1] ?? 0;
        const p3x = xs[Math.min(n - 1, k + 2)] ?? 0;
        const p3y = ys[Math.min(n - 1, k + 2)] ?? 0;
        ctx.bezierCurveTo(
          p1x + (p2x - p0x) / 6,
          p1y + (p2y - p0y) / 6,
          p2x - (p3x - p1x) / 6,
          p2y - (p3y - p1y) / 6,
          p2x,
          p2y,
        );
      }
    };
    // Fine branch filaments first, faint.
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.strokeStyle = line(rgb, 0.25 + 0.45 * energy);
    ctx.lineWidth = 0.9 + 0.5 * energy;
    for (let i = 0; i < f.count; i++) if ((f.depth[i] ?? 0) === 1) trace(i);
    ctx.stroke();
    // The tendrils: 2 to 3 px, #cfe6ff, softly glowing.
    ctx.beginPath();
    ctx.strokeStyle = line(rgb, 0.6 + 0.4 * energy);
    ctx.lineWidth = 2 + 1 * energy;
    ctx.shadowColor = muted ? `rgb(${NEUTRAL} / 0.6)` : 'rgb(150 190 255 / 0.9)';
    ctx.shadowBlur = 8 * this.#scale;
    for (const stem of f.stems) trace(stem);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  /** The mesh: dense linked nodes in four colour lobes with a violet mass at the core, jittering constantly. */
  #drawMesh(
    ctx: CanvasRenderingContext2D,
    g: Geometry,
    palette: Palette,
    alpha: number,
    t: number,
    motion: boolean,
  ): void {
    if (g.mesh === 0) return;
    const n = this.#network;
    const xs = this.#scratchX;
    const ys = this.#scratchY;
    const muted = palette.halo === NEUTRAL;
    ctx.globalCompositeOperation = 'lighter';
    if (!muted && g.mode === 'hero') {
      // A strong violet mass around the core, behind the nodes.
      const mass = ctx.createRadialGradient(
        g.origin.x,
        g.origin.y,
        0,
        g.origin.x,
        g.origin.y,
        g.mesh * 0.8,
      );
      mass.addColorStop(0, 'rgb(124 80 235 / 0.4)');
      mass.addColorStop(0.55, 'rgb(90 70 220 / 0.18)');
      mass.addColorStop(1, 'rgb(90 70 220 / 0)');
      ctx.globalAlpha = alpha;
      ctx.fillStyle = mass;
      ctx.beginPath();
      ctx.arc(g.origin.x, g.origin.y, g.mesh * 0.8, 0, Math.PI * 2);
      ctx.fill();
    }
    // Wider than tall, as in the reference; jitter is positional only, never a brightness change.
    for (let i = 0; i < n.count; i++) {
      const p = n.phase[i] ?? 0;
      const jx = motion ? (Math.sin(t * 2.3 + p * 3) + Math.sin(t * 3.7 + p * 5)) * 1.1 : 0;
      const jy = motion ? (Math.sin(t * 2.9 + p * 4) + Math.sin(t * 3.1 + p * 2)) * 1.1 : 0;
      xs[i] = g.origin.x + (n.xs[i] ?? 0) * g.mesh * 1.2 + jx;
      ys[i] = g.origin.y + (n.ys[i] ?? 0) * g.mesh * 0.85 + jy;
    }
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 0.6;
    for (let lobe = 0; lobe < 4; lobe++) {
      const rgb = muted ? NEUTRAL : (LOBE_RGB[lobe] ?? LOBE_RGB[0]);
      ctx.strokeStyle = line(rgb, 0.34);
      ctx.beginPath();
      for (let e = 0; e < n.edges; e++) {
        const a = n.edgeFrom[e] ?? 0;
        if ((n.lobe[a] ?? 0) !== lobe) continue;
        const b = n.edgeTo[e] ?? 0;
        ctx.moveTo(xs[a] ?? 0, ys[a] ?? 0);
        ctx.lineTo(xs[b] ?? 0, ys[b] ?? 0);
      }
      ctx.stroke();
      ctx.fillStyle = line(rgb, 0.9);
      ctx.beginPath();
      for (let i = 0; i < n.count; i++) {
        if ((n.lobe[i] ?? 0) !== lobe) continue;
        const size = i % 4 === 0 ? 3 : 2;
        ctx.rect((xs[i] ?? 0) - size / 2, (ys[i] ?? 0) - size / 2, size, size);
      }
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
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

  /**
   * The nucleus: a large soft glow, a translucent blue-violet sphere (brighter in the middle)
   * with fine scanlines, a thick white-cyan rim arc that turns once every ten seconds and a faint
   * full ring. Thinking whitens the rim and adds a wider additive bloom, pulsing every 1.75 s.
   */
  #drawNucleus(
    ctx: CanvasRenderingContext2D,
    g: Geometry,
    palette: Palette,
    scene: SceneState,
    energy: number,
    t: number,
    motion: boolean,
  ): void {
    const { x, y } = g.origin;
    const muted = palette.halo === NEUTRAL;
    const pulse = motion ? 1 + 0.08 * energy * Math.sin((t * Math.PI * 2) / PULSE_SECONDS) : 1;
    const r = g.sphere * pulse;
    const dim = scene.ceremony ? 0.25 : 1;
    ctx.globalAlpha = dim;
    // One large soft glow behind everything else.
    ctx.globalCompositeOperation = 'lighter';
    const halo = ctx.createRadialGradient(x, y, r * 0.4, x, y, r * 2.6);
    halo.addColorStop(
      0,
      muted ? 'rgb(100 116 139 / 0.2)' : `rgb(90 90 240 / ${String(0.3 + 0.2 * energy)})`,
    );
    halo.addColorStop(0.5, muted ? 'rgb(100 116 139 / 0.08)' : 'rgb(70 90 230 / 0.12)');
    halo.addColorStop(1, 'rgb(70 90 230 / 0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, r * 2.6, 0, Math.PI * 2);
    ctx.fill();
    // Body: brighter blue-violet in the middle (about 0.5 alpha), clearer toward the rim.
    const body = ctx.createRadialGradient(x, y, 0, x, y, r);
    const lift = 0.5 + 0.5 * energy;
    body.addColorStop(
      0,
      muted ? 'rgb(120 136 160 / 0.3)' : `rgb(140 120 255 / ${String(0.5 * lift + 0.15)})`,
    );
    body.addColorStop(
      0.6,
      muted ? 'rgb(100 116 139 / 0.2)' : `rgb(80 100 235 / ${String(0.28 * lift + 0.08)})`,
    );
    body.addColorStop(
      1,
      muted ? 'rgb(148 163 184 / 0.28)' : `rgb(110 160 255 / ${String(0.3 * lift + 0.08)})`,
    );
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    if (r > 20) {
      // Fine scanlines, clipped to the sphere.
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.beginPath();
      for (let ly = y - r; ly < y + r; ly += 3) {
        ctx.moveTo(x - r, ly);
        ctx.lineTo(x + r, ly);
      }
      ctx.strokeStyle = 'rgb(160 200 255 / 0.1)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
    // The faint full ring, then the thick glowing rim arc.
    const angle =
      motion || this.#mode !== 'full' ? ((t % RIM_SECONDS) / RIM_SECONDS) * Math.PI * 2 : 0;
    const span = 1.4 + 1.3 * energy;
    ctx.lineCap = 'round';
    ctx.strokeStyle = muted
      ? 'rgb(170 182 196 / 0.4)'
      : `rgb(${CYAN} / ${String(0.22 + 0.2 * energy)})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = muted ? 'rgb(190 200 212)' : energy > 0.5 ? 'rgb(255 255 255)' : CORE_WHITE;
    ctx.lineWidth = 4 + 2 * energy;
    ctx.shadowColor = muted ? 'rgb(190 200 212 / 0.6)' : `rgb(${CYAN} / 0.95)`;
    ctx.shadowBlur = (12 + 8 * energy) * this.#scale;
    ctx.beginPath();
    ctx.arc(x, y, r, angle, angle + span);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    if (!muted) {
      // Bloom, additive, about 1.5 radii; wider and brighter while thinking.
      const bloomR = r * 1.5;
      const bloom = ctx.createRadialGradient(x, y, r * 0.3, x, y, bloomR);
      bloom.addColorStop(0, `rgb(235 250 255 / ${String(0.3 + 0.55 * energy)})`);
      bloom.addColorStop(0.45, `rgb(${CYAN} / ${String(0.15 + 0.25 * energy)})`);
      bloom.addColorStop(1, `rgb(${CYAN} / 0)`);
      ctx.fillStyle = bloom;
      ctx.beginPath();
      ctx.arc(x, y, bloomR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    if (scene.activity === 'failed') {
      ctx.strokeStyle = 'rgb(251 113 133)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r + 8, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /** Beads on the tendrils, travelling both ways; faster, brighter and denser while thinking. */
  #stepParticles(dt: number, spawn: boolean, energy: number): void {
    const cap = TIERS[this.#tier].maxParticles;
    const speed = 0.22 + 0.4 * energy;
    for (let i = this.#pn - 1; i >= 0; i--) {
      this.#pt[i] = (this.#pt[i] ?? 0) + (this.#pd[i] ?? 1) * dt * speed;
      this.#pa[i] = Math.min((this.#pa[i] ?? 0) + dt * 3, spawn ? 1 : (this.#pa[i] ?? 0));
      if (!spawn) this.#pa[i] = Math.max(0, (this.#pa[i] ?? 0) - dt * 2.4);
      const p = this.#pt[i] ?? 0;
      if (p <= 0 || p >= 1 || (this.#pa[i] ?? 0) <= 0) this.#remove(i);
    }
    if (!spawn) return;
    this.#spawnDebt += dt * (cap / 2.4) * (0.4 + 0.9 * energy);
    const stems = this.#field.stems;
    const live = Math.round(cap * (0.4 + 0.6 * energy));
    while (this.#spawnDebt >= 1 && this.#pn < Math.min(cap, live)) {
      this.#spawnDebt -= 1;
      const stem = stems[Math.floor(this.#rand() * stems.length)] ?? 0;
      const outward = this.#pn % 2 === 0;
      this.#pf[this.#pn] = stem;
      this.#pd[this.#pn] = outward ? 1 : -1;
      this.#pt[this.#pn] = outward ? 0.02 : 0.98;
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
    g: Geometry,
    palette: Palette,
    energy: number,
  ): void {
    if (this.#pn === 0) return;
    const f = this.#field;
    const muted = palette.halo === NEUTRAL;
    const dot = this.#sprite(`bead:${String(muted)}`, 6, (c, r) => {
      // A bright white core of about 3.5 px with a small blue halo.
      const gradient = c.createRadialGradient(r, r, 0, r, r, r);
      gradient.addColorStop(0, muted ? 'rgb(210 220 232 / 1)' : 'rgb(255 255 255 / 1)');
      gradient.addColorStop(0.28, muted ? 'rgb(190 200 212 / 0.9)' : 'rgb(235 245 255 / 0.9)');
      gradient.addColorStop(0.4, muted ? 'rgb(150 165 185 / 0.3)' : 'rgb(150 200 255 / 0.35)');
      gradient.addColorStop(1, 'rgb(150 200 255 / 0)');
      c.fillStyle = gradient;
      c.fillRect(0, 0, r * 2, r * 2);
    });
    const size = 11 + 3 * energy;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.#pn; i++) {
      const stem = this.#pf[i] ?? 0;
      const u = Math.max(0, Math.min(1, this.#pt[i] ?? 0)) * (FIELD_POINTS - 1);
      const k = Math.min(FIELD_POINTS - 2, Math.floor(u));
      const frac = u - k;
      const begin = f.start[stem] ?? 0;
      const ux = (f.xs[begin + k] ?? 0) * (1 - frac) + (f.xs[begin + k + 1] ?? 0) * frac;
      const uy = (f.ys[begin + k] ?? 0) * (1 - frac) + (f.ys[begin + k + 1] ?? 0) * frac;
      ctx.globalAlpha = (this.#pa[i] ?? 0) * (0.65 + 0.3 * energy);
      ctx.drawImage(
        dot,
        g.origin.x + ux * g.unit - size / 2,
        g.origin.y + uy * g.unit - size / 2,
        size,
        size,
      );
    }
    ctx.globalCompositeOperation = 'source-over';
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

  /** Multiplies the art by a soft-edged copy of the stage rectangle (cached until the stage moves). */
  #fadeToStage(ctx: CanvasRenderingContext2D, stage: Rect): void {
    const key = `${String(stage.x)},${String(stage.y)},${String(stage.w)},${String(stage.h)},${String(this.#scale)}`;
    if (this.#fade === null || this.#fadeKey !== key) {
      const fade = this.#fade ?? document.createElement('canvas');
      fade.width = this.#canvas.width;
      fade.height = this.#canvas.height;
      const g = fade.getContext('2d');
      this.#fade = fade;
      this.#fadeKey = key;
      if (g === null) return;
      const feather = Math.min(70, stage.w * 0.1, stage.h * 0.15);
      g.setTransform(this.#scale, 0, 0, this.#scale, 0, 0);
      g.clearRect(0, 0, this.#cssW, this.#cssH);
      g.fillStyle = '#fff';
      g.shadowColor = '#fff';
      g.shadowBlur = feather * this.#scale;
      g.fillRect(
        stage.x + feather,
        stage.y + feather,
        stage.w - 2 * feather,
        stage.h - 2 * feather,
      );
    }
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(this.#fade, 0, 0, this.#cssW, this.#cssH);
    ctx.globalCompositeOperation = 'source-over';
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
