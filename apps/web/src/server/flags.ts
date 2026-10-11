import 'server-only';
import { createHash } from 'node:crypto';
import { createApplicationError } from '@lexaegis/protocol';
import {
  ALL_FLAGS_OFF,
  PRODUCT_FLAGS,
  clientFlagsSchema,
  resolveFlags,
  type EffectiveFlags,
  type FeatureReadiness,
  type ProductFlag,
} from '@/config/flags';
import { errorResponse } from './http';
import { logger } from './logger';

/**
 * What exists today. A flag cannot enable a feature whose code is absent or whose verification
 * evidence does not match the current implementation. Chapters flip these with their code and
 * with a passing, current check recorded in docs/build-state.json; no environment variable can.
 */
export const FEATURE_READINESS: Readonly<Record<ProductFlag, FeatureReadiness>> = {
  // Chapter 10: on-device dictation and read-aloud behind typed capability adapters, verified by
  // voice.test.ts and the injected-adapter browser check. Real-device recognition is NOT verified
  // (docs/build-state.json chapter10.voice); capability is re-detected in the browser at runtime.
  voice: { implemented: true, verified: true },
  // Chapter 8: bounded two-version text comparison, verified by pipeline.test.ts, review-flow.test.ts
  // and pnpm test:review:browser (recorded in docs/build-state.json chapter08). Still off unless set.
  documentComparison: { implemented: true, verified: true },
  matterBriefing: { implemented: false, verified: false },
  reputationFeedback: { implemented: false, verified: false },
  // Chapter 16: the read-only identity line, route and card, verified by features/identity and
  // server/agent-identity tests. Reading needs a configured registration; without one the line says
  // "Not registered" and makes no request. Registration itself is an operator action not yet performed.
  agentIdentity: { implemented: true, verified: true },
  matterNotes: { implemented: false, verified: false },
};

export interface FeatureConfiguration {
  readonly flags: EffectiveFlags;
  /** Fingerprint of the effective flags: lets operators confirm every instance runs the same configuration. */
  readonly revision: string;
  /** False when a supplied value was malformed; every flag is then off (fail closed). */
  readonly valid: boolean;
}

export function computeRevision(flags: EffectiveFlags): string {
  const canonical = PRODUCT_FLAGS.map((flag) => `${flag}=${flags[flag] ? 1 : 0}`).join(';');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

type EnvRecord = Readonly<Record<string, string | undefined>>;

export function loadFeatureConfiguration(
  env: EnvRecord,
  readiness: Readonly<Record<ProductFlag, FeatureReadiness>> = FEATURE_READINESS,
): FeatureConfiguration {
  const resolved = resolveFlags(env, readiness);
  if (!resolved.ok) {
    // Fixed event only: neither names nor values are logged.
    logger.error({ event: 'feature_flags.invalid', code: 'INVALID_INPUT' });
    return { flags: ALL_FLAGS_OFF, revision: computeRevision(ALL_FLAGS_OFF), valid: false };
  }
  if (resolved.unavailable.length > 0) {
    logger.warn({ event: 'feature_flags.unavailable', code: 'NOT_IMPLEMENTED' });
  }
  return { flags: resolved.flags, revision: computeRevision(resolved.flags), valid: true };
}

let cached: FeatureConfiguration | undefined;

/**
 * Read once per server process, at first use after startup. Changing a flag requires restarting
 * (or redeploying) every instance; there is deliberately no runtime switch.
 */
export function getFeatureConfiguration(): FeatureConfiguration {
  cached ??= loadFeatureConfiguration(process.env);
  return cached;
}

/** The only flag payload that may reach a client: validated booleans, nothing else. */
export function clientFlags(configuration: FeatureConfiguration = getFeatureConfiguration()) {
  return clientFlagsSchema.parse({ ...configuration.flags });
}

/** Server-side gate for direct requests and structured assistant intents. */
export function rejectIfDisabled(
  flag: ProductFlag,
  requestId: string,
  configuration: FeatureConfiguration = getFeatureConfiguration(),
): Response | null {
  if (configuration.flags[flag]) return null;
  return errorResponse(
    createApplicationError('FORBIDDEN', 'This capability is not enabled.', requestId),
  );
}

/** Test seam only. */
export function resetFeatureConfigurationForTests(): void {
  cached = undefined;
}
