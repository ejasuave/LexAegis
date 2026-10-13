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
  transactionReading,
} from './hud.selectors';
export type * from './hud.types';
export { EFFECTS_PREFERENCES, isEffectsPreference, resolveEffects } from './hud.effects';
export type { EffectsEnvironment, EffectsMode, EffectsPreference } from './hud.effects';
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
