/*
 * Component styles, inside the shadow root. Public CSS custom properties (all optional):
 *   --por-font, --por-text, --por-muted, --por-background, --por-border, --por-radius, --por-focus,
 *   --por-active, --por-warning, --por-danger, --por-neutral
 * No external font, image or stylesheet is requested.
 */
export const STYLES = `
:host { display: block; max-width: 100%; }
:host([hidden]) { display: none; }
.root {
  box-sizing: border-box; min-width: 0; max-width: 100%;
  font: 0.875rem/1.45 var(--por-font, system-ui, sans-serif);
  color: var(--por-text, #1b1f24); background: var(--por-background, #ffffff);
  border: 1px solid var(--por-border, #8a949e); border-radius: var(--por-radius, 6px);
  padding: 0.75rem;
}
.title { margin: 0 0 0.5rem; font-weight: 600; }
.line { display: grid; grid-template-columns: auto 1fr; gap: 0.25rem 0.5rem; align-items: start; margin: 0 0 0.5rem; min-width: 0; }
.line svg { width: 1.25rem; height: 1.25rem; flex: none; margin-top: 0.1rem; }
.label { font-weight: 600; }
.value { font-weight: 600; }
.detail { display: block; color: var(--por-muted, #4a5560); font-size: 0.8125rem; overflow-wrap: anywhere; }
.text { min-width: 0; overflow-wrap: anywhere; }
.s-active { color: var(--por-active, #0b6b3a); }
.s-revoked, .s-mismatch { color: var(--por-danger, #a4262c); }
.s-superseded, .s-incomplete, .s-unsupported, .s-config { color: var(--por-warning, #7a4e00); }
.s-unknown, .s-not_found, .s-checking, .s-unavailable, .s-not-checked { color: var(--por-neutral, #3b4651); }
.s-match { color: var(--por-active, #0b6b3a); }
dl.ref { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 0.125rem 0.5rem; margin: 0.5rem 0; font-size: 0.75rem; }
dl.ref dt { color: var(--por-muted, #4a5560); }
dl.ref dd { margin: 0; font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.5rem; }
button {
  font: inherit; color: inherit; background: transparent; cursor: pointer;
  border: 1px solid var(--por-border, #8a949e); border-radius: var(--por-radius, 6px);
  padding: 0.375rem 0.75rem; min-height: 2.25rem; transition: background-color 120ms;
}
button:hover { background: rgba(127, 127, 127, 0.15); }
button:focus-visible { outline: 3px solid var(--por-focus, #0b57d0); outline-offset: 2px; }
button[disabled] { cursor: default; opacity: 0.6; }
.note { margin: 0.5rem 0 0; color: var(--por-muted, #4a5560); font-size: 0.75rem; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
@media (forced-colors: active) { .root, button { border-color: CanvasText; } }
`;
