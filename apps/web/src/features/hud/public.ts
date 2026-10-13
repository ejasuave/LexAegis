/** The pure HUD view-model surface UI code may import. No controller or secret is reachable from it. */
export { INDEXER_STALE_MS, RUN_EVENT_STALE_MS, ageText, freshnessOf } from './hud.freshness';
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
