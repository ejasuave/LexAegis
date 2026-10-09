import 'server-only';
import { randomUUID } from 'node:crypto';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { ChainPolicy } from '@lexaegis/sdk/registry';
import { createPostgresAuthStore } from '../auth/store';
import { getPool } from '../db/pool';
import { loadServerConfig } from '../env';
import { getChainClient, type ServerChainClient } from './alchemy-client';
import { resolveDeployment, resolveSettings, type ChainSettings } from './config';
import { createPostgresChainStore, type ChainStore } from './operation-store';
import type { OperationDeps } from './operations';

export type ChainRuntime =
  | { readonly state: 'not_configured' | 'not_deployed' | 'invalid' }
  | {
      readonly state: 'ready';
      readonly client: ServerChainClient;
      readonly policy: ChainPolicy;
      readonly store: ChainStore | null;
      readonly settings: ChainSettings;
      readonly funder: PrivateKeyAccount | null;
      readonly allow:
        ((bucket: string, windowStart: Date, limit: number) => Promise<boolean>) | null;
      readonly operationDeps: OperationDeps | null;
      readonly now: () => Date;
    };

let override: ChainRuntime | undefined;
/** Test seam: route tests install a runtime built on fixtures. Never used in production code paths. */
export function setChainRuntimeForTests(runtime: ChainRuntime | undefined): void {
  override = runtime;
}

function loadFunder(key: string | undefined): PrivateKeyAccount | null {
  if (key === undefined || !/^0x[0-9a-fA-F]{64}$/.test(key)) return null;
  try {
    return privateKeyToAccount(key as `0x${string}`);
  } catch {
    return null;
  }
}

/** Assembled per call from configuration; missing pieces yield typed non-ready states. */
export function getChainRuntime(): ChainRuntime {
  if (override !== undefined) return override;
  const loaded = loadServerConfig(process.env);
  if (!loaded.ok) return { state: 'invalid' };
  const client = getChainClient();
  if (client === null) return { state: 'not_configured' };
  const deployment = resolveDeployment();
  if (deployment.state !== 'ready') {
    return { state: deployment.state === 'not_deployed' ? 'not_deployed' : 'invalid' };
  }
  const pool = getPool();
  const store = pool === null ? null : createPostgresChainStore(pool);
  const auth = pool === null ? null : createPostgresAuthStore(pool);
  const settings = resolveSettings(loaded.config);
  const now = () => new Date();
  return {
    state: 'ready',
    client,
    policy: deployment.policy,
    store,
    settings,
    funder: loadFunder(loaded.config.funding.testnetFunderPrivateKey),
    allow:
      auth === null ? null : (bucket, windowStart, limit) => auth.allow(bucket, windowStart, limit),
    operationDeps:
      store === null
        ? null
        : {
            client,
            policy: deployment.policy,
            store,
            now,
            randomId: () => randomUUID(),
            registryMaxFeeWei: settings.registryMaxFeeWei,
          },
    now,
  };
}
