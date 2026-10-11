import 'server-only';
import { loadServerConfig } from '../env';
import { getChainRuntime } from '../chain/runtime';
import { createEnvioClient } from './envio-client';
import { configuredFrom, type Configured, type HistoryDeps } from './status';

export type HistoryRuntime =
  | {
      readonly state: 'not_configured';
      readonly reason: 'INDEX_NOT_CONFIGURED' | 'DEPLOYMENT_UNAVAILABLE';
    }
  | { readonly state: 'ready'; readonly deps: HistoryDeps; readonly configured: Configured };

let override: HistoryRuntime | undefined;
/** Test seam for route tests. Never used by production code paths. */
export function setHistoryRuntimeForTests(runtime: HistoryRuntime | undefined): void {
  override = runtime;
}

/**
 * Assembled per call. The Envio endpoint comes only from server configuration; callers cannot
 * choose a URL. A missing index still yields deps so live verification keeps working.
 */
export function getHistoryRuntime(): HistoryRuntime {
  if (override !== undefined) return override;
  const chain = getChainRuntime();
  if (chain.state !== 'ready') return { state: 'not_configured', reason: 'DEPLOYMENT_UNAVAILABLE' };
  const loaded = loadServerConfig(process.env);
  const envioConfig = loaded.ok ? loaded.config.envio : {};
  const envio =
    envioConfig.graphqlUrl === undefined
      ? null
      : createEnvioClient({
          url: envioConfig.graphqlUrl,
          ...(envioConfig.adminSecret === undefined
            ? {}
            : { adminSecret: envioConfig.adminSecret }),
        });
  if (envio === null && envioConfig.graphqlUrl === undefined) {
    // Still ready for live reads; health reports INDEX_NOT_CONFIGURED.
  }
  return {
    state: 'ready',
    configured: configuredFrom(chain.policy),
    deps: {
      envio,
      chain: { live: chain.client.live, policy: chain.policy },
      now: chain.now,
    },
  };
}
