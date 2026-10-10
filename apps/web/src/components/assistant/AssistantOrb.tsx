import type { AssistantRunState } from '@lexaegis/agent/contracts';

/** Run states, plus the two idle readings: no usable assistant, or ready with nothing running. */
export type OrbState = AssistantRunState | 'unavailable' | 'ready';

const LABELS: Record<OrbState, string> = {
  unavailable: 'Assistant unavailable',
  ready: 'Ready',
  queued: 'Queued',
  running: 'Working',
  awaiting_input: 'Needs your input',
  stopping: 'Stopping',
  completed: 'Run finished',
  cancelled: 'Cancelled',
  failed: 'Run failed',
  interrupted: 'Interrupted: outcome unknown',
};

const ACTIVE: ReadonlySet<OrbState> = new Set(['running', 'stopping']);

const COLORS: Record<OrbState, string> = {
  unavailable: 'var(--lj-text-muted)',
  ready: 'var(--lj-cyan)',
  queued: 'var(--lj-text-muted)',
  running: 'var(--lj-violet-text)',
  awaiting_input: 'var(--lj-amber)',
  stopping: 'var(--lj-violet-text)',
  completed: 'var(--lj-cyan)',
  cancelled: 'var(--lj-text-muted)',
  failed: 'var(--lj-error)',
  interrupted: 'var(--lj-amber)',
};

export function orbLabel(state: OrbState): string {
  return LABELS[state];
}

/**
 * Lightweight CSS/SVG orb. The visible text label is the source of truth; the graphic is
 * decorative and animates only for genuinely active states (and never with reduced motion).
 */
export function AssistantOrb({
  state,
  size = 'expanded',
}: {
  state: OrbState;
  size?: 'expanded' | 'compact';
}) {
  const px = size === 'expanded' ? 160 : 32;
  const color = COLORS[state];
  return (
    <div
      className="lj-orb inline-flex items-center gap-3"
      data-active={ACTIVE.has(state)}
      data-state={state}
    >
      <svg width={px} height={px} viewBox="0 0 160 160" aria-hidden="true" focusable="false">
        <circle
          className="lj-orb-ring"
          cx="80"
          cy="80"
          r="74"
          fill="none"
          stroke={color}
          strokeOpacity="0.35"
        />
        <circle
          className="lj-orb-ring"
          cx="80"
          cy="80"
          r="56"
          fill="none"
          stroke={color}
          strokeOpacity="0.5"
        />
        <circle cx="80" cy="80" r="34" fill="none" stroke="var(--lj-cobalt)" strokeOpacity="0.7" />
        <circle
          cx="80"
          cy="80"
          r="10"
          fill="var(--lj-cyan)"
          fillOpacity={state === 'unavailable' ? 0.35 : 0.95}
        />
      </svg>
      {size === 'compact' ? (
        <span className="text-sm text-lj-secondary">{LABELS[state]}</span>
      ) : null}
    </div>
  );
}
