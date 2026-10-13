import type { ActivityState } from './hud.types';
import { WASH_FADE_MS, WASH_RISE_MS, washOpacity, type EffectsMode } from './hud.effects';
import {
  FIELD_POINTS,
  QualityGovernor,
  TIERS,
  backingScale,
  buildField,
  fieldReach,
  initialTier,
  inflate,
  jagged,
  routeAlert,
  seeded,
  type Field,
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
  readonly lines: readonly [string, string];
  readonly halo: string;
  readonly particle: string;
  readonly alpha: number;
  readonly bloom: number;
  readonly animated: boolean;
}

const COBALT = '59 130 246';
const CYAN = '103 232 249';
const VIOLET = '109 40 217';
const VIOLET_TEXT = '196 181 253';
const NEUTRAL = '100 116 139';
const AMBER = '251 191 36';

function line(rgb: string, a: number): string {
  return `rgb(${rgb} / ${String(a)})`;
}

/** One state-to-visual table. The words for each state live in the DOM, never here. */
function paletteFor(activity: ActivityState): Palette {
  switch (activity) {
    case 'running':
      return {
        lines: [line(VIOLET, 0.42), line(VIOLET_TEXT, 0.2)],
        halo: VIOLET_TEXT,
        particle: VIOLET_TEXT,
        alpha: 1,
        bloom: 0.7,
        animated: true,
      };
    case 'stopping':
      return {
        lines: [line(VIOLET, 0.3), line(VIOLET_TEXT, 0.14)],
        halo: VIOLET_TEXT,
        particle: VIOLET_TEXT,
        alpha: 0.7,
        bloom: 0.45,
        animated: false,
      };
    case 'queued':
    case 'awaiting_user':
      return {
        lines: [line(COBALT, 0.2), line(CYAN, 0.12)],
        halo: CYAN,
        particle: CYAN,
        alpha: 0.6,
        bloom: 0.35,
        animated: false,
      };
    case 'failed':
    case 'interrupted':
    case 'cancelled':
      return {
        lines: [line(NEUTRAL, 0.26), line(NEUTRAL, 0.16)],
        halo: NEUTRAL,
        particle: NEUTRAL,
        alpha: 0.6,
        bloom: 0.25,
        animated: false,
      };
    case 'stale':
    case 'offline':
    case 'unavailable':
      return {
        lines: [line(NEUTRAL, 0.22), line(NEUTRAL, 0.14)],
        halo: NEUTRAL,
        particle: NEUTRAL,
        alpha: 0.55,
        bloom: 0.2,
        animated: false,
      };
    case 'idle':
    case 'completed':
      return {
        lines: [line(COBALT, 0.32), line(CYAN, 0.22)],
        halo: CYAN,
        particle: CYAN,
        alpha: 1,
        bloom: 0.55,
        animated: true,
      };
  }
}

const HALO_HERO = 72;
const HALO_COMPACT = 17;
const CORE_HERO = 5;
const CORE_COMPACT = 2.5;
const MASK_MARGIN = 24;
const MASK_FEATHER = 14;
const FRAME_CLAMP_MS = 100;

export class NeuralRenderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;
  readonly #governor: QualityGovernor;
  readonly #rand = seeded(0x2f1d);
  #field: Field;
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
      (paletteFor(s.activity).animated || s.toolsRunning || this.#pn > 0 || this.#washLive())
    );
  }

  #washLive(): boolean {
    return this.#washStart > 0 && performance.now() < this.#washStart + WASH_RISE_MS + WASH_FADE_MS;
  }

  #fps(): number {
    const tier = TIERS[this.#tier];
    return this.#scene.toolsRunning || this.#pn > 0 || this.#washLive()
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
    // Subdued everywhere except the Command-mode nucleus; dimmed hard during the approval.
    const emphasis = s.ceremony ? 0.18 : mode === 'hero' ? 1 : mode === 'compact' ? 0.5 : 0.4;
    const motion = animating && palette.animated && this.#mode === 'full' && !s.ceremony;

    this.#drawField(ctx, origin, reach, t, palette, emphasis * palette.alpha, motion, mode);
    if (mode !== 'none') this.#drawNucleus(ctx, origin, mode, palette, s);
    if (this.#mode === 'full' && !s.ceremony) {
      this.#stepParticles(dt, s.toolsRunning && s.activity === 'running');
      this.#drawParticles(ctx, origin, reach, palette);
    } else {
      this.#pn = 0;
    }
    this.#drawWash(ctx, origin, mode, t * 1000);
    this.#applyMask(ctx);
    this.#drawAlerts(ctx, origin, s, t, motion);
  }

  #drawField(
    ctx: CanvasRenderingContext2D,
    origin: Point,
    reach: number,
    t: number,
    palette: Palette,
    alpha: number,
    motion: boolean,
    mode: NucleusMode,
  ): void {
    const f = this.#field;
    const innerGap = (mode === 'hero' ? HALO_HERO : mode === 'compact' ? HALO_COMPACT : 24) / reach;
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let batch = 0; batch < 4; batch++) {
      ctx.beginPath();
      ctx.strokeStyle = palette.lines[batch & 1] ?? palette.lines[0];
      ctx.lineWidth = batch < 2 ? 0.9 : 0.6;
      for (let i = 0; i < f.count; i++) {
        if (((f.depth[i] ?? 0) << 1) + (i & 1) !== batch) continue;
        const begin = f.start[i] ?? 0;
        const sway = motion ? Math.sin(t * 0.12 + (f.phase[i] ?? 0)) * 0.006 : 0;
        const px = f.perpX[i] ?? 0;
        const py = f.perpY[i] ?? 0;
        let started = false;
        for (let k = 0; k < FIELD_POINTS; k++) {
          const ux = f.xs[begin + k] ?? 0;
          const uy = f.ys[begin + k] ?? 0;
          // Points inside the halo are skipped, so most of the screen around the core stays dark.
          if (Math.hypot(ux, uy) < innerGap) continue;
          const d = sway * (k / (FIELD_POINTS - 1));
          const x = origin.x + (ux + px * d) * reach;
          const y = origin.y + (uy + py * d) * reach;
          if (started) ctx.lineTo(x, y);
          else {
            ctx.moveTo(x, y);
            started = true;
          }
        }
      }
      ctx.stroke();
    }
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
  ): void {
    const halo = mode === 'hero' ? HALO_HERO : HALO_COMPACT;
    const core = mode === 'hero' ? CORE_HERO : CORE_COMPACT;
    const rgb = palette.halo === CYAN ? CYAN : palette.halo === NEUTRAL ? NEUTRAL : VIOLET_TEXT;
    const glow = this.#sprite(`halo:${rgb}:${String(halo)}`, halo, (g, r) => {
      const gradient = g.createRadialGradient(r, r, 0, r, r, r);
      gradient.addColorStop(0, `rgb(${rgb} / 0.55)`);
      gradient.addColorStop(0.25, `rgb(${rgb} / 0.2)`);
      gradient.addColorStop(1, `rgb(${rgb} / 0)`);
      g.fillStyle = gradient;
      g.fillRect(0, 0, r * 2, r * 2);
    });
    ctx.globalAlpha = scene.ceremony ? 0.1 : palette.bloom;
    ctx.drawImage(glow, origin.x - halo, origin.y - halo, halo * 2, halo * 2);
    ctx.globalAlpha = scene.ceremony ? 0.3 : 1;
    ctx.beginPath();
    ctx.arc(origin.x, origin.y, core, 0, Math.PI * 2);
    ctx.fillStyle = palette.halo === NEUTRAL ? 'rgb(170 182 196)' : 'rgb(230 251 255)';
    ctx.fill();
    ctx.globalAlpha = 1;
    if (scene.activity === 'failed') {
      // A failed run is a static field with a marker; the words say what failed.
      ctx.strokeStyle = 'rgb(251 113 133)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(origin.x, origin.y, core + (mode === 'hero' ? 9 : 5), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  #stepParticles(dt: number, spawn: boolean): void {
    const cap = TIERS[this.#tier].maxParticles;
    for (let i = this.#pn - 1; i >= 0; i--) {
      this.#pt[i] = (this.#pt[i] ?? 0) - dt * 0.62;
      // Particles stop and fade when emission stops; they never imply completion.
      this.#pa[i] = Math.min((this.#pa[i] ?? 0) + dt * 3, spawn ? 1 : (this.#pa[i] ?? 0));
      if (!spawn) this.#pa[i] = Math.max(0, (this.#pa[i] ?? 0) - dt * 2.4);
      if ((this.#pt[i] ?? 0) <= 0 || (this.#pa[i] ?? 0) <= 0) this.#remove(i);
    }
    if (!spawn) return;
    this.#spawnDebt += dt * (cap / 1.6);
    while (this.#spawnDebt >= 1 && this.#pn < cap) {
      this.#spawnDebt -= 1;
      // Inward streams run along stems only, ending at the nucleus.
      const stems = this.#field.count / 8;
      const stem = Math.floor(this.#rand() * stems) * 8;
      this.#pf[this.#pn] = stem;
      this.#pt[this.#pn] = 1;
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
    this.#pn = last;
  }

  #drawParticles(
    ctx: CanvasRenderingContext2D,
    origin: Point,
    reach: number,
    palette: Palette,
  ): void {
    if (this.#pn === 0) return;
    const f = this.#field;
    const rgb = palette.particle === NEUTRAL ? NEUTRAL : VIOLET_TEXT;
    const dot = this.#sprite(`dot:${rgb}`, 5, (g, r) => {
      const gradient = g.createRadialGradient(r, r, 0, r, r, r);
      gradient.addColorStop(0, `rgb(${rgb} / 0.95)`);
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
      ctx.globalAlpha = (this.#pa[i] ?? 0) * 0.9;
      ctx.drawImage(dot, origin.x + ux * reach - 5, origin.y + uy * reach - 5, 10, 10);
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
