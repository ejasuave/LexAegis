import { z } from 'zod';

/*
 * Product feature flags (Chapter 14.2). This module is pure and browser-safe: it only resolves
 * values. The server loads the environment once (server/flags.ts) and passes the validated,
 * effective booleans to the client. Nothing here reads process.env.
 */

export const PRODUCT_FLAGS = [
  'voice',
  'documentComparison',
  'matterBriefing',
  'reputationFeedback',
  'agentIdentity',
  'matterNotes',
] as const;
export type ProductFlag = (typeof PRODUCT_FLAGS)[number];

/** Server-only variable names. Deliberately not NEXT_PUBLIC_*: flags must not be build-time values. */
export const FLAG_ENV: Readonly<Record<ProductFlag, string>> = {
  voice: 'FEATURE_VOICE',
  documentComparison: 'FEATURE_DOCUMENT_COMPARISON',
  matterBriefing: 'FEATURE_MATTER_BRIEFING',
  reputationFeedback: 'FEATURE_REPUTATION_FEEDBACK',
  agentIdentity: 'FEATURE_AGENT_IDENTITY',
  matterNotes: 'FEATURE_MATTER_NOTES',
};

/** Exactly "true" or "false". "0", "no", "False" and the like are rejected, never coerced. */
export const flagValueSchema = z.enum(['true', 'false']);

/**
 * Whether a feature exists and whether current verification evidence matches its present
 * implementation and configuration. Both are facts about the code base, not settings.
 */
export interface FeatureReadiness {
  readonly implemented: boolean;
  readonly verified: boolean;
}

/** Unset flags default to false, except these two, which default to "on when implemented and verified". */
const DEFAULT_WHEN_AVAILABLE: ReadonlySet<ProductFlag> = new Set(['agentIdentity', 'matterNotes']);

export type EffectiveFlags = Readonly<Record<ProductFlag, boolean>>;

export const ALL_FLAGS_OFF: EffectiveFlags = Object.freeze(
  Object.fromEntries(PRODUCT_FLAGS.map((flag) => [flag, false])) as Record<ProductFlag, boolean>,
);

export type FlagResolution =
  | {
      readonly ok: true;
      readonly flags: EffectiveFlags;
      /** Flags explicitly set to true that stay off because the feature is not implemented or verified. */
      readonly unavailable: readonly ProductFlag[];
    }
  | { readonly ok: false; readonly invalidKeys: readonly string[] };

type EnvRecord = Readonly<Record<string, string | undefined>>;

/**
 * An explicit false always disables. An explicit true enables only an implemented and verified
 * feature. When unset, the first four flags are false and the last two follow availability.
 */
export function resolveFlags(
  env: EnvRecord,
  readiness: Readonly<Record<ProductFlag, FeatureReadiness>>,
): FlagResolution {
  const invalidKeys: string[] = [];
  const flags = {} as Record<ProductFlag, boolean>;
  const unavailable: ProductFlag[] = [];

  for (const flag of PRODUCT_FLAGS) {
    const name = FLAG_ENV[flag];
    const raw = env[name];
    const available = readiness[flag].implemented && readiness[flag].verified;
    if (raw === undefined || raw === '') {
      flags[flag] = DEFAULT_WHEN_AVAILABLE.has(flag) && available;
      continue;
    }
    const parsed = flagValueSchema.safeParse(raw);
    if (!parsed.success) {
      invalidKeys.push(name);
      continue;
    }
    const requested = parsed.data === 'true';
    flags[flag] = requested && available;
    if (requested && !available) unavailable.push(flag);
  }
  return invalidKeys.length > 0
    ? { ok: false, invalidKeys }
    : { ok: true, flags: Object.freeze(flags), unavailable };
}

/** Strict schema for the only flag payload a client may receive. */
export const clientFlagsSchema = z.strictObject({
  voice: z.boolean(),
  documentComparison: z.boolean(),
  matterBriefing: z.boolean(),
  reputationFeedback: z.boolean(),
  agentIdentity: z.boolean(),
  matterNotes: z.boolean(),
});

/** Names of enabled flags, in the fixed declaration order. */
export function enabledFlags(flags: EffectiveFlags): ProductFlag[] {
  return PRODUCT_FLAGS.filter((flag) => flags[flag]);
}
