# LexAegis — UI/UX Blueprint

Version: 1.0  
Audience: Claude Code  
Primary application: `apps/web`  
Design direction: **Obsidian Neural Workbench**

## 1. Product mandate and design authority

Build an immersive legal workbench, not a dashboard decorated with a particle background. The full-screen canvas is the visual environment; selectable HTML text and accessible controls are the working interface.

The chosen layout is an **asymmetric, evidence-first, three-zone workbench**: matter context on the left, a dominant working stage in the centre, and findings or action details on the right. A flush telemetry ceiling and a persistent command dock complete the composition.

The experience must feel precise, calm and responsive. Futurism comes from light, spatial depth and live state—not clutter, fake telemetry or unreadable microtext.

### Authority and boundaries

- This blueprint replaces the previous lightweight-orb rendering direction with a state-driven HTML5 Canvas nucleus and filament field.
- Preserve the approved LexAegis architecture, protocol, encryption boundaries, consent rules and review workflow. This is a UI specification, not permission to redesign cryptography, contracts or signing.
- Extend existing components and controllers before creating replacements. Inspect the repository, installed dependencies and local instructions before choosing final file paths.
- Preserve the independent verifier and read-only embed. Do not force the immersive workbench into those products.
- The legal workflow remains employment settlement agreement review in England and Wales. Do not invent legal rules or market this as autonomous legal approval.
- When requirements compete, use this priority: truthful state and security; accessibility and document readability; task completion; visual effects.

### Reference-video interpretation

Retain the reference's luminous central hub, branching fine lines, dark negative space and peripheral instrumentation. Do not copy its branding, social-video chrome, dense floating micro-labels or uncontrolled brightness. The reference establishes visual atmosphere, not functional evidence or a reusable interface asset.

### Non-negotiable exclusions

No card-in-a-grid dashboard, opaque panel mosaic, perpetual loading theatre, fabricated risk score, random transaction feed, simulated tool completion, auto-signing, ambient audio, screen shake, scanline filter or pointer-following particle toy.

## 2. Screen architecture

### 2.1 Desktop composition

Design first at 1440 × 900 CSS pixels. Use CSS Grid for layout; avoiding a dashboard grid does not prohibit CSS Grid as a layout primitive.

| Region | Desktop allocation | Responsibility |
|---|---|---|
| System ceiling | Full width; 40 px minimum height | Matter/version, network, Mera session, vault, transaction and indexing states |
| Left matter rail | 240 px preferred; 208–256 px range | Matters, documents, versions, evidence checklist and saved context |
| Central working stage | Remaining width; approximately 776 px at the reference size | State Nucleus in Command mode; document and source-linked work in Review mode |
| Right attention rail | 336 px preferred; 304–384 px range | Financial discrepancy, selected finding, explanation, calculation or action preview |
| Bottom command dock | Full width; 64 px minimum height | Command launcher, editable prompt, task status and Stop |

Use 20 px outer horizontal gutters and 24 px inter-region gaps at the reference size. These measurements allocate 240 + 776 + 336 + 48 + 40 = 1440 px. Adapt through the breakpoints below rather than compressing the document indefinitely.

The ceiling and dock occupy real layout rows. They must not cover document content, focus outlines or scrollbars. Use `minmax(0, 1fr)`, `min-width: 0` and `min-height: 0` where required for predictable scrolling.

The application fills the available browser viewport with `100dvh`, with a `100vh` fallback. Do not require the browser Fullscreen API or hide browser navigation.

### 2.2 Two working modes, one continuous workspace

**Command mode**

- Centre the nucleus in the unobstructed central stage, near 44% of its height.
- Reserve the central approximately 55% of the stage for the nucleus and surrounding negative space.
- Place one plain-language status sentence below it, followed by a compact list of actual task steps and a scrollable conversation/result transcript.
- Present results as typographic sections with source links and hairline separators, never as floating card tiles.
- Before a matter is selected, show “Open a matter to begin.” Do not render synthetic activity.

**Review mode**

- Give the central stage to the document; keep its reading column around 68–78 characters wide where space allows.
- Move the nucleus into a compact 32 px status position in the stage toolbar. The remaining filament field becomes peripheral and subdued.
- Keep the selected finding and its source/calculation in the right rail. The assistant stays available through the dock and an expandable transcript.
- Preserve document version, selected clause, scroll position, current finding and unsent command draft when switching modes.
- Opening a source citation enters Review mode and focuses the cited passage. Do not switch modes merely because an animation changes state.

Default to Review mode when reopening a matter with an active document. Use Command mode for an empty workspace or an explicit user choice.

### 2.3 Responsive behavior

| Available width | Layout rule |
|---|---|
| 1440 px and above | Three zones; let outer rails grow only to their maximums. Expand central negative space, not text line length. |
| 1200–1439 px | Three zones; left rail 208 px, right rail 304 px, 16 px gaps and outer gutters. |
| 768–1199 px | Document plus a 304 px inspector when the document retains at least 440 px. Move matter navigation into a labelled drawer; otherwise show one work surface at a time. |
| Below 768 px | One work surface with labelled Matter, Document, Findings and Activity tabs. The command launcher and active-run Stop remain visible. |
| Zoomed or exceptionally narrow | Reflow into a single reading column. Permit page scrolling and growing chrome; never shrink text to preserve the HUD silhouette. |

On small screens, the nucleus becomes compact whenever document or finding content is open. Do not shrink a desktop HUD into an illegible thumbnail.

Respect safe-area insets and the on-screen keyboard. The command input and Send/Stop controls must remain visible without trapping the user in a fixed-height panel. Breakpoints respond to available CSS width, including browser zoom.

### 2.4 Layer stack

| Layer | Content | Interaction |
|---|---|---|
| 0 | Black-to-charcoal base | None |
| 1 | Full-viewport neural canvas and nucleus | `aria-hidden="true"`; `pointer-events: none` |
| 2 | Shared contrast mask and restrained confirmation wash | Decorative; never intercept input |
| 10 | Semantic workspace, transparent rails and document | Normal HTML interaction |
| 20 | Ceiling, dock and contextual controls | Normal HTML interaction |
| 40 | Command palette or modal drawer | Managed modal focus and background inertness |
| 60 | Exact-action approval dialog | Exclusive focus; no competing command palette |

Use one intentional stacking context. Do not solve layering bugs with escalating arbitrary z-index values. Nothing luminous may paint above readable text.

## 3. Visual system

### 3.1 Design tokens

```css
:root {
  color-scheme: dark;

  --lj-bg: #000000;
  --lj-bg-soft: #0d1117;
  --lj-text: #e6edf3;
  --lj-text-secondary: #aab6c4;
  --lj-text-muted: #8b98a9;

  --lj-cobalt: #3b82f6;
  --lj-cyan: #67e8f9;
  --lj-violet-field: #6d28d9;
  --lj-violet-text: #c4b5fd;
  --lj-amber: #fbbf24;
  --lj-error: #fb7185;
  --lj-positive: #6ee7b7;

  --lj-divider: rgb(170 182 196 / 18%);
  --lj-control-edge: #64748b;
  --lj-focus: #67e8f9;
  --lj-panel-fill: transparent;
  --lj-font-mono: "IBM Plex Mono", "SFMono-Regular", Consolas,
    "Liberation Mono", monospace;

  --lj-space-1: 4px;
  --lj-space-2: 8px;
  --lj-space-3: 12px;
  --lj-space-4: 16px;
  --lj-space-5: 24px;
  --lj-space-6: 32px;
  --lj-control-radius: 4px;
  --lj-motion-fast: 120ms;
  --lj-motion-standard: 180ms;
}
```

Use cobalt and deep violet primarily for decorative geometry. Use the lighter cyan, violet-text and amber tokens for meaningful text. Reserve error pink/red for actual failures; a financial discrepancy is an attention state, not automatically a system failure.

The low-contrast divider token is decorative only. Use the stronger control-edge/focus tokens wherever an outline is necessary to identify a control or its state.

### 3.2 Transparent surfaces and reliable contrast

- Panels have transparent fills, no enclosing card shadows and no decorative rounded containers.
- Establish grouping through headings, whitespace, alignment, short rules and occasional corner marks.
- Keep essential text backgrounds visually bounded at or darker than `#0D1117`, using a shared art-layer exclusion mask. Bright filaments, nucleus bloom and confirmation effects must be excluded from those reading zones.
- Calculate exclusion zones from registered content regions, expanded by 16–24 px. Update them after layout changes; do not query every element every animation frame.
- The mask belongs to the background scene, not to individual opaque cards. Feather its outer edges while keeping the reading area reliably dark.
- Disable bloom under approval dialogs, command input, financial amounts and selected source passages.
- If transparent treatment cannot maintain contrast, dim or disable the canvas. Readability is the acceptance criterion.
- Native document pages may retain their original appearance. Do not invert PDFs or alter source-document formatting to make them match the HUD.

### 3.3 Typography and detail

| Role | Size / line height | Treatment |
|---|---|---|
| Ceiling metadata | 13 / 20 px | Muted labels; readable values |
| Rail labels and controls | 14 / 22 px | Regular or medium weight |
| Document and explanations | 16–18 / 26–30 px | Regular weight; comfortable measure |
| Section heading | 18 / 26 px | Medium weight; sentence case |
| Selected financial discrepancy | 28 / 34 px | Tabular numerals; currency and meaning visible |
| Command input | 16 / 24 px | Monospace; no glowing text shadow |

Use rem-based implementation values and respect user font scaling. Self-host an appropriately licensed font if it is not already available; retain the system fallback and avoid third-party font requests from a confidential workspace.

Use `font-variant-numeric: tabular-nums`. Disable programming ligatures in addresses, hashes and numerical comparisons. Apply no blur, glow or transform scaling to text. Do not use all-caps body copy or sub-12 px “technical” text.

Icons are simple outlined SVGs with consistent strokes. Every meaningful status has a text label; icons and colors are supplementary.

## 4. Neural canvas and State Nucleus

### 4.1 Composition

Implement a single visible Canvas 2D surface beneath the DOM. Avoid a WebGL/3D dependency for this effect.

- Render approximately 320 filaments in the default desktop quality tier, with branching geometry distributed toward viewport edges.
- Use 0.6–1.0 CSS-pixel strokes. Preserve stable geometry between frames; animate small offsets along precomputed curves instead of regenerating a random web.
- Build an 8–12 px bright cyan-white core inside a restrained 112–160 px halo in Command mode. Keep most of the screen genuinely dark.
- Do not attach a label to every filament. Semantic labels belong to actual DOM content in the rails.
- Restrict glow to the nucleus and a small particle pool. Pre-render glow sprites; avoid per-filament full-screen blur.
- Use geometry seeded independently of evidence content. Never seed visible patterns from private document hashes or secret values.
- Decorative idle drift is permitted, but it must never be presented as evidence of ongoing computation or traffic.

### 4.2 State-to-visual contract

| Application state | Geometry and color | Motion | Required text |
|---|---|---|---|
| IDLE | Cobalt/cyan branches; low bloom | Very slow drift; no inward execution streams | Ready, or the actual empty-state instruction |
| QUEUED / AWAITING USER | Dim static field; clear status icon | No simulated work | Queued, or the specific required action |
| RUNNING | Deep-violet field; pale-violet particle accents | Inward particles only for currently executing tools | Actual operation and completed/total steps when the total is known |
| DISCREPANCY / ALERT | Affected branches become jagged amber and terminate at real finding anchors | Freeze affected geometry; optional slow intensity variation | Finding title, amount or missing item, and source/action link |
| STOPPING | Subdued violet; no newly emitted particles | Existing particles fade without implying completion | Stopping; then Cancelled only after acknowledgement |
| FAILED | Static field; error marker on the failed operation | No celebration or continuing execution streams | What failed and the available recovery action |
| STALE / OFFLINE / UNKNOWN | Muted neutral field and labelled connection state | Halt execution streams when activity cannot be verified | Last known state with freshness information |
| RECEIPT CONFIRMED | One restrained cyan confirmation effect | One-shot only; see Section 5 | Receipt confirmed on the configured network |

### 4.3 Concurrent state and precedence

Do not implement the entire application as one color enum. Keep activity, attention, account session, vault, transaction and indexing state independent.

1. Accessibility preferences and hidden-page suspension govern all effects.
2. Vault lock clears sensitive content and anchors immediately; it does not erase public transaction history.
3. Blocking attention freezes the relevant geometry and dims unrelated branches. The DOM must still state whether an agent task is actually running.
4. Nonblocking findings remain amber while unrelated running-tool streams may remain violet.
5. A confirmed-receipt effect never hides an error, changes a finding disposition or resets the activity state.

Geometry freezing is a visual treatment, not cancellation. Particle density is an activity cue, not a percentage complete, token count, payment amount or claim about internal model reasoning.

### 4.4 Finding anchors

Register only currently visible finding rows and source markers as canvas anchors. Resolve their positions relative to the canvas using layout measurements and observers.

Draw at most three highlighted finding bundles simultaneously: the selected finding first, then the highest-priority visible unresolved findings. Keep all findings available in the DOM list.

Terminate a branch at the row's marker or margin, never across the words. If a finding is off-screen or in a closed drawer, point to its labelled Findings control and show the true unresolved count. Do not invent coordinates or severity.

Use stable jagged geometry for alerts. Any optional intensity variation must be slow, subtle and removable; no strobing, shaking or rapid on/off blinking.

## 5. Receipt-confirmation effect: truthful timing

The visual requirement named “BLOCK MINTED” is implemented as **RECEIPT CONFIRMED**. A confirmed application receipt is not a claim that LexAegis minted a blockchain block.

### Trigger contract

The transaction controller—not the canvas, an AI message or the indexer—may emit the confirmation signal only after it has verified:

1. The expected configured chain and registry.
2. Successful transaction execution, not merely a transaction hash or block inclusion claim.
3. The expected receipt event and action identity, bound to the intended commitment and reviewer account.
4. The canonicality/finality policy already defined by the project's chain adapter.

Do not invent a confirmation count, trust an arbitrary RPC endpoint or equate Envio indexing with confirmation.

### Timing and deduplication

- Schedule the effect on the next available rendered frame after the validated confirmation signal reaches the client.
- Do not claim synchronization to the exact millisecond of remote chain consensus. Network delivery, validation and display refresh introduce unavoidable delay.
- Record client signal-received and first-effect-frame timestamps only in privacy-safe diagnostic instrumentation. Keep chain time and client time explicitly distinct.
- Deduplicate using the existing stable chain-event identity, incorporating chain, registry, transaction and log/event identity as appropriate.
- Initial page load, history replay, reconnect, React remount and duplicate delivery must not replay old celebrations.
- Update real transaction state even if the matter changes or the agent is cancelled. Show no fullscreen effect for a different matter, a hidden tab or historical hydration.
- If confirmation is subsequently invalidated, show a persistent correction and re-verify state. Do not silently retain a success claim.

### Effect envelope and accessibility

Use one low-luminance cyan wash behind the DOM: approximately 180 ms rise and 420 ms fade, with a starting maximum opacity of 0.06. Prefer a stronger localized nucleus/perimeter wave over increasing full-screen brightness.

This is a bounded design target, not proof of photosensitivity compliance. Test the actual rendered result. No white-out, abrupt high-luminance flash or repeated flash train is permitted. Keep reading-zone masks active throughout.

Coalesce simultaneous confirmations into one visual envelope while recording each real event in the activity history. Limit celebration envelopes to one within any two-second window; do not queue a later burst.

With reduced motion, disabled effects or a hidden page, update the persistent confirmation label and announce it once without a flash. Confirmation never depends on the animation finishing.

## 6. Telemetry ceiling and peripheral information

### 6.1 Ceiling

Anchor a borderless, zero-outer-padding strip to the top of the application viewport. “Flush” describes the chrome, not text touching a display cutout: allow safe-area accommodation and 12 px internal horizontal breathing room for content and focus indicators.

Show these independently:

| Reading | Authoritative source | Required behavior |
|---|---|---|
| Matter / version | Selected workspace state | Preserve context during every operation |
| Network | Configured chain adapter | Clearly identify testnet; never imply mainnet or production assurance |
| Envio indexing | Actual indexer observations | Indexed block, lag when known, and last-updated time; label stale/unavailable explicitly |
| Mera session | Account/session controller | Authenticated, expired, unsupported or unavailable; actual expiry when available |
| Public account | Verified public reviewer address | Shortened display with deliberate full-value reveal/copy |
| Vault | Encryption/storage controller | Locked, unlocked, saving, saved or error; no universal “secure” badge |
| Transaction | Transaction controller | Awaiting approval, awaiting signature, broadcast, pending, confirmed or failed |

“Passkey connection hash” must mean a safe public account identifier or clearly labelled nonsecret display fingerprint. Never display credential IDs, PRF outputs, signing-session tokens, raw signatures, unwrapped keys or authentication challenges.

Do not imply that a passkey is a continuously connected wallet socket. Session authorization, vault availability and transaction state are separate facts.

Refresh values only from real observations. A local clock or “last updated” age may tick honestly; block numbers and lock flags may not tick theatrically. If chain-head and indexed-head observations are incomparable or unavailable, show lag as unknown rather than zero.

On constrained widths, retain matter, session/vault warnings and active operation state. Move secondary details into a labelled System status disclosure. Never use a moving marquee or continuously announce block updates to screen readers.

### 6.2 Left rail: matter and evidence

Use a vertically ordered outline: selected matter, document/version list, evidence checklist, then saved context.

Missing evidence is an unresolved requirement, not proof that an event did not occur. Each item exposes its source/rule reference, current state and next action. Do not let a decorative checkbox imply verified evidence.

Selecting a document or version is explicit. Switching context cancels or detaches runs through existing controllers and clears obsolete highlights; it must not silently mix results between matters.

### 6.3 Right rail: attention and explanation

Prioritize one selected finding. Show its category, plain-language meaning, relevant amount, source passage, deterministic calculation and available human disposition.

For a payment discrepancy, use the existing integer-minor-unit calculator and currency formatter. Label the value as an arithmetic gap or discrepancy—not automatically money owed, a legal breach or a predicted outcome.

Distinguish an agent suggestion, extracted fact, human-confirmed fact and human decision. Never truncate a critical amount or action label. Long identifiers can shorten visually only when their full value remains deliberately accessible.

Additional findings are compact rows, not summary cards. The right rail changes to a package/action preview only after the user requests that action.

## 7. Keyboard-first command system

### 7.1 One command model, two entry surfaces

- **Global palette:** hidden until `Ctrl+K` or `Cmd+K`; horizontally centred near the upper-middle of the viewport; maximum width 720 px and height 70dvh, with its own result scrolling.
- **Bottom dock:** always contains a visible Commands launcher, current task status and an active-run Stop action. The editable console expands upward when needed.
- Both use the same command registry and volatile draft state. Do not create separate chat histories or conflicting dispatch paths.
- Use a thin cyan focus rule and restrained glow around the active console edge. Keep input text sharp and unglowing.
- Open/close with opacity and at most 8 px vertical movement over 120–180 ms. Reduced-motion mode uses an immediate transition.

Opening the palette must not wait for a network call, model response or animation completion before focusing the input.

### 7.2 Keyboard and focus contract

| Input | Behavior |
|---|---|
| Ctrl/Cmd + K | Toggle the palette within the active application |
| Up / Down | Move through command suggestions without submitting |
| Enter in palette | Select an explicit command; transfer natural-language text to the editable dock when execution needs review |
| Enter in dock | Send the explicit draft through the normal consent/validation path |
| Shift + Enter | Insert a newline in the dock |
| Escape | Close the current dismissible overlay and restore focus; never approve, sign or imply task cancellation |
| Tab / Shift + Tab | Follow the semantic focus order; remain within a modal when one is open |
| Visible Stop or `/stop` | Request cancellation directly, without an LLM round-trip |

Ignore composition events and repeated shortcut keydown events. Register one scoped shortcut listener and remove it on unmount. Prevent browser defaults only when actually handling the intended chord.

Do not open the palette over the exact-action approval dialog. Preserve the approval focus boundary; expose an explicit close/back control instead.

When a modal is open during a run, expose Stop within that modal as well. A background button made inert is not an accessible Stop control.

Implement the palette using the established modal-dialog and combobox/listbox interaction patterns. Use labelled controls, an announced active option, focus containment, background inertness and focus restoration. Avoid nested dialogs and unsupported ARIA combinations. [R8] [R9]

### 7.3 Command registry

| Command | Handler responsibility | Boundary |
|---|---|---|
| `/explain` | Explain the selected clause using source-linked analysis | Require a selected source and applicable analysis consent |
| `/check-payments` | Run the approved extraction/calculation workflow | Code calculates; no model arithmetic presented as verified |
| `/status` | Read actual workspace/runtime/receipt status | No model call required |
| `/stop` | Invoke the existing cancellation controller | No approval dialog or model call; never claim to reverse broadcast transactions |
| `/missing-evidence` | Show or refresh the scoped evidence checks | Preserve unknown versus missing distinctions |
| `/summarise` | Summarise the selected authorized context | Follow plaintext-disclosure and Send requirements |
| `/prepare-review` | Prepare the review package | Preparation is not approval or signing |

Retain existing supported commands. Do not silently invent new capabilities or replace the approved handlers with UI-only simulations.

Natural-language commands resolve to allowlisted application intents, not shell commands, arbitrary browser actions or model-generated executable code. Treat pasted text, document contents and model output as untrusted data.

Never send sensitive command drafts to an external service on every keystroke. Apply consent and explicit Send before selected plaintext leaves the browser. An unknown command shows a useful suggestion; it does not fall through to unrestricted execution.

## 8. Review, approval and recovery flows

### 8.1 Evidence-first workflow

Support the existing sequence without collapsing its stages:

1. Select a matter and source version.
2. Preview the analysis disclosure and explicitly send the selected context.
3. Observe actual bounded task/tool progress and source-linked findings.
4. Review facts, calculations, unresolved items and proposed dispositions.
5. Freeze an immutable package and complete encrypted save/read-back.
6. Open the exact-action approval preview.
7. Explicitly approve the bound action and complete the separate signing/fee/Send requirements.
8. Show broadcast, pending, verified confirmation and indexing as distinct states.

The interface must never treat saved, prepared, approved, signed, broadcast, confirmed, indexed or currently active as synonyms.

### 8.2 Approval focus state

Use a dedicated central action preview with a strongly dimmed shared canvas and transparent content surface. Stop decorative motion during the ceremony.

Show the frozen package/version, intended action, reviewer account, configured network/registry, relevant receipt references, fee information and exactly what becomes public. Bind the confirmation control to the immutable action being displayed.

Changing the underlying package invalidates the displayed approval. Changing conversational context cannot silently change an already approved package.

No command, model response, voice utterance, elapsed timer or active passkey session substitutes for this ceremony. Preparing a package never signs it.

Use action-specific labels such as “Approve this review package” or “Revoke this receipt,” not “Continue” where the consequence is material.

### 8.3 Honest result language

- “Receipt confirmed” means the specified on-chain action met the configured verification policy.
- “File integrity verified” is separate from receipt lifecycle and signer-policy checks.
- “Indexed” describes the history service, not current authoritative registry state.
- “Active,” “revoked,” “superseded,” “not found” and “unknown” retain their protocol meanings.
- A receipt demonstrates an account's approval of particular bytes. It does not establish legal correctness, professional qualification or execution of the settlement agreement.

### 8.4 Required non-happy paths

Provide explicit states for unsupported passkey capability, expired session, locked vault, save/read-back failure, missing evidence, cancelled run, tool failure, exhausted analysis budget, indexer lag, offline RPC, rejected signing, reverted transaction and confirmation invalidation.

Retain safe recoverable work. Do not automatically retry signing, broadcasting or other consequential actions. A reconnect must not silently restart an analysis run or resend plaintext.

On lock, remove plaintext, extracted snippets, drafts and private finding anchors from visible state according to the existing vault policy. Do not claim that locking retracts data already sent to the backend or model provider.

## 9. Accessibility and safety acceptance rules

Target WCAG 2.2 AA across the working UI, with additional reduced-motion and no-flash safeguards. Do not claim conformance merely because token pairs pass a calculator.

- Meet at least 4.5:1 contrast for normal text and 3:1 for large text. Essential control/state graphics must meet 3:1 against adjacent colors. Test real composited backgrounds, including the brightest permitted scene. [R1] [R10]
- All functional information and controls must exist in semantic DOM. The decorative canvas must be removable without loss of capability.
- Use visible, unglowing focus outlines. Focused controls must not disappear behind the ceiling, dock, drawers or on-screen keyboard. [R3]
- Use at least 24 × 24 CSS-pixel pointer targets where the applicable criterion requires them; prefer 44 × 44 px for touch controls and Stop. Do not confuse a small icon with its larger hit area. [R2]
- Provide a persistent Effects control: System, Reduced and Off. Respect `prefers-reduced-motion` before the first animated frame; a site preference may further reduce effects, not silently override the OS request. [R6]
- Reduced mode uses static geometry and immediate state changes; Off removes the decorative canvas. Neither removes status information.
- Provide a way to pause/hide ongoing decorative motion. Do not require users to open a command palette to make the screen comfortable. [R5]
- No rapid flashing or high-intensity full-screen luminance changes. Validate the rendered confirmation and alert treatments against flash-safety criteria; reduced motion alone is not a flash-safety test. [R4]
- Use polite live announcements for meaningful task transitions. Reserve assertive alerts for urgent actionable failures; never announce every particle, block tick or streamed token.
- Respect forced-colors mode, text-spacing overrides, 200% text scaling and 400% browser zoom. Disable decorative graphics where they interfere.
- Supply keyboard-accessible citations and document navigation. Preserve text selection, copy, browser find and standard editing shortcuts.
- Voice remains an optional, default-off enhancement under the existing capability/privacy rules. The text workflow must be complete without it.

## 10. Runtime architecture and performance budget

### 10.1 Data flow

Existing controllers produce validated domain events. A pure HUD selector produces a small view model. DOM components render semantic state; a separate canvas renderer consumes only visual state and measured anchor positions.

The renderer must not fetch RPC/indexer data, inspect documents, own authentication, issue agent commands or infer transaction success. Timers may interpolate visuals or calculate freshness; they may not advance business state.

Keep runtime activity, findings, Mera session, vault state, transaction state, indexing state and effect preferences as distinct fields. Avoid ambiguous booleans such as `isSecure`, `isVerified` or `isSuccess` without a named scope.

Validate matter, source version, run identity and event ordering through the existing runtime contract. Ignore cancelled/superseded analysis results. A real broadcast transaction remains independently tracked even after agent cancellation or a matter switch.

DOM and canvas must derive from the same accepted snapshot so colors cannot contradict labels. On event-stream gaps or stale heartbeats, preserve last-known facts with a freshness warning instead of pretending that work completed.

### 10.2 Rendering lifecycle

- Use `requestAnimationFrame` with elapsed-time integration, not frame-count-dependent velocity. Browser rendering is frame-based; it cannot promise a remote-event millisecond. [R7]
- Clamp elapsed time on resume; do not simulate a large backlog of missed frames.
- Keep animation data outside React render state. Re-render React on accepted semantic changes, not per particle.
- Pause the render loop when the page is hidden. Reduced, Off and static states must not retain a continuously running animation loop.
- Use one visible canvas, precomputed curves, pooled particles and cached glow sprites. Batch draw operations by style.
- Resize from actual layout dimensions. Handle viewport, zoom and DPR changes without leaking observers or reallocating continuously.
- Cap effective backing scale with `min(devicePixelRatio, 1.5, sqrt(4_000_000 / (cssWidth * cssHeight)))`. Skip rendering for zero dimensions; allow a scale below 1 on very large screens.
- Keep total backing-store pixels at or below four million by default. Reuse buffers and impose bounds on particles, anchors and retained event data.
- Use seeded static geometry during initial rendering; do not create hydration differences with uncontrolled randomness.
- If Canvas 2D initialization fails, show the same complete DOM workbench with a static CSS/SVG status marker. Failure of decoration cannot block review or signing.
- Do not introduce a worker or OffscreenCanvas unless profiling demonstrates a need and a working fallback is retained.

### 10.3 Quality tiers and targets

| Tier | Filaments | Maximum active particles | Render cap |
|---|---:|---:|---|
| Standard desktop | 320 | 64 | 20 fps idle; up to 60 fps active |
| Balanced | 160 | 32 | 15 fps idle; 30 fps active |
| Compact / low-power | 80 | 16 | Static idle; up to 24 fps active |
| Reduced | Static simplified field | 0 | Redraw only after relevant changes |
| Off / failed canvas | 0 | 0 | No canvas animation |

These are ceilings, not guaranteed frame rates or required activity. Adapt downward after sustained frame-budget misses; avoid oscillating tiers. Reduce glow, particle count, filament count and backing resolution before compromising input responsiveness.

Measure on a recorded mid-range integrated-GPU desktop and a representative mobile device:

- Palette keydown to focused input: p95 at or below 100 ms under the tested workload.
- Canvas work per drawn frame: p95 at or below 4 ms desktop and 2 ms compact mode; reduce quality if exceeded.
- No animation-attributable long task above 50 ms in the representative review/run trace.
- Stop dispatches on the next available application turn; the UI distinguishes dispatch from server acknowledgement.
- No renderer callbacks while hidden or Effects is Off; no growing listener/observer count after repeated mode changes.

These are implementation acceptance targets, not claims that the application has already achieved them. Record hardware, browser, viewport, DPR, trace and effect tier with results.

## 11. Component ownership and implementation order

Preferred new feature root: `apps/web/src/features/hud/`. Adapt to the repository's actual conventions and document the mapping. Do not duplicate already-owned business logic.

| Module | Responsibility |
|---|---|
| `HudShell.tsx` | Semantic region layout, responsive modes and shared context preservation |
| `hud.tokens.css` | Design tokens, typography, spacing and reduced/forced-color overrides |
| `hud.selectors.ts` | Pure mapping from existing domain state to truthful HUD view models |
| `hud.effects.ts` | Validated confirmation consumption, deduplication and effect policy |
| `NeuralCanvas.tsx` | Canvas lifecycle only; no business/network authority |
| `neural.renderer.ts` | Geometry, nucleus, pooled particles, quality tiers and drawing |
| `useHudAnchors.ts` | Registered region masks and visible finding coordinates |
| `SystemCeiling.tsx` | Independent live telemetry readings and freshness |
| `MatterRail.tsx` / `AttentionRail.tsx` | Adapt existing matter/evidence/finding components |
| `CommandDock.tsx` / `CommandPalette.tsx` | Shared registry, draft, keyboard and focus behavior |
| Existing review/approval controllers | Remain owners of disclosure, freeze, save, approval and signing |
| `__tests__/` and existing E2E suite | Selector, event, accessibility, lifecycle and visual regression tests |

Execute these stages sequentially. Complete and validate each stage before adding dependent polish.

### Stage 1 — Inspect and map

Read repository instructions and identify the existing shell, command handlers, review controller, account/vault state, transaction adapter and event schema. Record the precise file mapping. Preserve existing tests, protocol vectors and unrelated changes.

### Stage 2 — Build the semantic workbench

Implement tokens, ceiling, rails, central stage and dock with static state labels. Complete desktop, narrow and zoomed layouts. Confirm the entire keyboard workflow before adding animation.

### Stage 3 — Connect truthful state

Implement pure selectors and event freshness/identity handling. Reuse existing deterministic calculations and domain controllers. Cover unknown, stale, concurrent and cancelled states with unit tests.

### Stage 4 — Implement commands and focus

Connect the palette and dock to the same registry and consent path. Implement direct Stop, draft preservation, modal focus containment and restoration. Verify no command can approve or sign.

### Stage 5 — Add the canvas

Implement the nucleus, filaments, quiet-zone masks, real finding anchors and quality tiers. Start with static scenes; enable motion only after contrast and lifecycle tests pass.

### Stage 6 — Integrate receipt effects

Consume only the verified transaction-controller signal. Add live-event deduplication, replay suppression, safe effect coalescing, reduced-motion behavior and confirmation-correction handling.

### Stage 7 — Finish review and failure states

Integrate the document-focused mode, precise approval ceremony, account expiry, vault lock, budget failures, offline behavior and recoverable errors. Confirm that visual changes do not alter authorization.

### Stage 8 — Validate and hand off

Run relevant type checks, linting, unit/integration tests and E2E tests using the repository's actual scripts. Capture synthetic-data screenshots and performance traces. Report implemented files, measured results and remaining blockers; never claim an untested criterion passed.

## 12. Definition of done

### Visual and layout

- [ ] The background is one continuous neural environment, not a collection of opaque cards.
- [ ] Command mode has a clear central nucleus and calm peripheral information.
- [ ] Review mode gives document text priority and preserves the selected clause.
- [ ] Text remains sharp and readable in idle, running, alert and confirmation scenes.
- [ ] The ceiling is flush and borderless; its content and focus outlines are not clipped.
- [ ] Critical amounts, signing actions and Stop remain available at every supported width.

### Truth and authorization

- [ ] No hardcoded activity, random metrics, fictitious completion percentage or default success state appears in production UI.
- [ ] Running particles begin and stop according to accepted tool activity, not arbitrary timers.
- [ ] Alert branches terminate at genuine visible findings or their labelled navigation control.
- [ ] Duplicate, out-of-order and obsolete run events cannot corrupt the current matter.
- [ ] Simultaneous running and attention states remain understandable without color alone.
- [ ] Envio lag, Mera expiry, vault lock and transaction status remain separate readings.
- [ ] Signing rejection, transaction reversion, pending state and indexer updates never trigger confirmation celebration.
- [ ] One validated live confirmation produces at most one eligible effect; refresh/reconnect/remount do not replay it.
- [ ] Consent, encrypted save/read-back, exact approval and signing boundaries remain intact.
- [ ] No passkey secret, plaintext evidence or private document hash is exposed by telemetry or diagnostics.

### Interaction and accessibility

- [ ] A keyboard-only user can open a matter, inspect a citation, run a command, stop a run and complete the explicit review ceremony.
- [ ] Palette focus opens promptly, stays in the modal and returns to the correct control on close.
- [ ] Stop is reachable while drawers or the palette are open and cannot be mistaken for transaction reversal.
- [ ] Reduced motion, Effects Off and forced colors preserve every essential capability.
- [ ] At 320 CSS-pixel width, 200% text size and 400% zoom, the working interface reflows without clipped actions or page-wide horizontal scrolling; source-document viewing may retain its necessary internal navigation.
- [ ] Screen-reader announcements describe meaningful state changes without telemetry chatter.
- [ ] Contrast, pointer targets, focus visibility and actual flash behavior have been checked beyond automated scanning.

### Resilience and performance

- [ ] Canvas failure leaves a complete usable application.
- [ ] Hidden tabs and disabled effects stop unnecessary rendering without stopping authoritative transaction tracking.
- [ ] Repeated resize, mode switching and unmount/remount do not leak listeners, buffers or animation loops.
- [ ] Quality adaptation meets the measured budgets without degrading document interaction.
- [ ] Synthetic fixtures cover idle, running, concurrent alert, stopping, offline, locked, pending, failed, confirmed and corrected-confirmation states.
- [ ] Build and test results distinguish passed, failed and not run. Screenshots alone are not proof of functional correctness.

## 13. Implementation references

Project authority: `LexAegis Refined Project Brief v3 (v3.0)`, the additive `LexAegis prompt chapters 14-19` specifications, and the repository's existing approved domain contracts. This blueprint changes visual presentation only where explicitly stated.

Primary technical references, consulted 7 October 2026:

- [R1 — W3C: Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
- [R2 — W3C: Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
- [R3 — W3C: Focus Not Obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html)
- [R4 — W3C: Three Flashes or Below Threshold](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html)
- [R5 — W3C: Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html)
- [R6 — MDN: prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion)
- [R7 — MDN: requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)
- [R8 — W3C ARIA APG: Modal Dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
- [R9 — W3C ARIA APG: Combobox](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)
- [R10 — W3C: Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)
