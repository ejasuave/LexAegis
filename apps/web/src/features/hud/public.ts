/** The pure HUD view-model surface UI code may import. No controller or secret is reachable from it. */
export { INDEXER_STALE_MS, RUN_EVENT_STALE_MS, ageText, freshnessOf } from './hud.freshness';
export { availableCommands, filterCommands, resolveInput, suggestCommand } from './hud.commands';
export type { CommandEntry, CommandId, Resolution } from './hud.commands';
export { BoundedIdentitySet, RunEventGate } from './hud.events';
export type { EventVerdict, RunContext, RunEventIdentity } from './hud.events';
export {
  indexerReading,
  meraSessionReading,
  selectActivity,
  selectAttention,
  selectCeiling,
  selectHud,
  selectNotices,
  transactionReading,
} from './hud.selectors';
export type { Notice, NoticeExtras } from './hud.selectors';
export { CATEGORY_LABEL, categoryLabel, chooseSelectedFinding, paymentGap } from './hud.finding';
export type { Gap, SelectableFinding, SelectedFinding } from './hud.finding';
export type * from './hud.types';
export {
  EFFECTS_PREFERENCES,
  EnvelopeLimiter,
  RECEIPT_COALESCE_MS,
  ReceiptEffects,
  WASH_FADE_MS,
  WASH_MAX_OPACITY,
  WASH_RISE_MS,
  isEffectsPreference,
  resolveEffects,
  washOpacity,
} from './hud.effects';
export type {
  EffectsEnvironment,
  EffectsMode,
  EffectsPreference,
  ReceiptContext,
  ReceiptLabel,
  ReceiptLogEntry,
  ReceiptOutcome,
  ReceiptSignal,
} from './hud.effects';
export { FIELD_SEED, TIERS, backingScale, initialTier, QualityGovernor } from './neural.geometry';
export type { Point, Rect, Tier, TierName } from './neural.geometry';
export { EMPTY_SCENE, NeuralRenderer } from './neural.renderer';
export type { AlertTarget, NucleusMode, RendererStats, SceneState } from './neural.renderer';
export {
  HUD_FIXTURE_NAMES,
  buildHudFixture,
  fixtureFindingIds,
  isHudFixtureName,
} from './hud.fixtures';
export type { HudFixtureName } from './hud.fixtures';
export {
  LOADING_MIN_VISIBLE_MS,
  LOADING_SHOW_AFTER_MS,
  LOADING_STILL_WORKING_MS,
  LoadingGate,
  POSITIVE_TEXT,
  PositiveEffects,
  detectPositiveEvents,
  selectPendingWork,
} from './hud.feedback';
export type {
  BusyRegion,
  LoadingView,
  PendingInput,
  PendingWork,
  PositiveContext,
  PositiveEvent,
  PositiveKind,
  PositiveLabel,
  PositiveOutcome,
  PositiveSnapshot,
} from './hud.feedback';
