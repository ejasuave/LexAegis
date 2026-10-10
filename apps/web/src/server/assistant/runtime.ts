import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Result } from '@lexaegis/protocol';
import {
  createQwenProvider,
  createReviewAgent,
  createUnavailableReviewAgent,
  resolveAdmission,
  resolveBudget,
  type ChatProvider,
  type ReviewAgent,
  type StatusPort,
} from '@lexaegis/agent';
import { getAuthService, requireAccountSession } from '../auth/session';
import { getChainRuntime } from '../chain/runtime';
import { getPool } from '../db/pool';
import { loadServerConfig } from '../env';
import { getFeatureConfiguration } from '../flags';
import { resolveAssistantProvider } from './config';
import { createPostgresRunStore } from './run-store';

/*
 * The process-wide assistant runtime. One agent per process, because the in-flight runs and their
 * abort handles live in it. It is assembled from operator configuration only: a missing key,
 * endpoint or database leaves an agent that answers NOT_CONFIGURED and never a stand-in.
 */

export interface AssistantRuntime {
  readonly agent: ReviewAgent;
  /** The configured application origin, for the POST guard. Null when sign-in is not configured. */
  readonly origin: string | null;
  /** The only source of run ownership: the session cookie, never a request field. */
  readonly session: (request: Request) => Promise<Result<{ readonly address: string }>>;
  readonly briefingEnabled: boolean;
  /** Present only for a configured provider; used to report verification, never returned to clients. */
  readonly provider: ChatProvider | null;
}

const KEY = Symbol.for('lexaegis.assistant.runtime');
type Holder = { [KEY]?: AssistantRuntime };
let override: AssistantRuntime | undefined;

/** Test seam: route tests install a runtime built on a scripted provider. Never used in production paths. */
export function setAssistantRuntimeForTests(runtime: AssistantRuntime | undefined): void {
  override = runtime;
}

const toNumber = (value: string | undefined): number | undefined =>
  value === undefined ? undefined : Number(value);

/** Server-side status readings. "ready" means the chain client is configured, not a live receipt read. */
const status: StatusPort = {
  liveChain: () => {
    const chain = getChainRuntime().state;
    return Promise.resolve(chain === 'invalid' ? 'unknown' : chain);
  },
};

function build(): AssistantRuntime {
  const base = {
    origin: getAuthService().origin,
    session: requireAccountSession,
    briefingEnabled: getFeatureConfiguration().flags.matterBriefing,
  };
  const unavailable = { ...base, agent: createUnavailableReviewAgent(), provider: null };
  const loaded = loadServerConfig(process.env);
  if (!loaded.ok) return unavailable;
  const resolved = resolveAssistantProvider(loaded.config);
  const pool = getPool();
  // No database means no atomic admission or quota: the assistant is unavailable, not unmetered.
  if (resolved.state !== 'ready' || pool === null) return unavailable;
  const provider = createQwenProvider(resolved.provider);
  const { assistant } = loaded.config;
  return {
    ...base,
    provider,
    agent: createReviewAgent({
      provider,
      store: createPostgresRunStore(pool),
      status,
      budget: resolveBudget({
        runSeconds: toNumber(assistant.runSeconds),
        providerAttempts: toNumber(assistant.maxProviderAttempts),
        toolExecutions: toNumber(assistant.maxToolCalls),
      }),
      admission: resolveAdmission({
        activeGlobal: toNumber(assistant.activeRunsGlobal),
        dailyPerOwner: toNumber(assistant.dailyRunsPerAccount),
        dailyGlobal: toNumber(assistant.dailyRunsGlobal),
      }),
      flags: { briefingEnabled: base.briefingEnabled },
      notices:
        provider.descriptor.id === 'scripted-test'
          ? [
              'This is a scripted test provider. No model is called and nothing leaves this machine.',
            ]
          : ['Retention and training settings of the provider are not known to this application.'],
      now: () => new Date(),
      newId: () => randomUUID(),
    }),
  };
}

export function getAssistantRuntime(): AssistantRuntime {
  if (override !== undefined) return override;
  const holder = globalThis as Holder;
  holder[KEY] ??= build();
  return holder[KEY];
}

/** True only when the capability checks passed for the exact configured endpoint, model and mode. */
export async function assistantVerified(): Promise<boolean> {
  try {
    return (await getAssistantRuntime().agent.availability()).state === 'verified';
  } catch {
    return false;
  }
}
