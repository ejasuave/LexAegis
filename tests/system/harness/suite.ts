import type { Browser, BrowserContext, Page } from 'playwright';
import { addVirtualAuthenticator, launch } from './browser';
import { recordResult } from './recorder';
import type { EvidenceClass } from './manifest';
import {
  deployRegistry,
  startMiner,
  writeLocalDeploymentRecord,
  type DeployedRegistry,
} from './chain';
import {
  isBlocked,
  startSystemChain,
  startSystemServices,
  startWebApp,
  type Blocked,
  type SystemChain,
  type SystemServices,
  type WebApp,
} from './services';
import { startFaultProxy, type FaultProxy } from './fault-proxy';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * A spec's shared environment: isolated services, the production web build and a browser. If any piece
 * is missing, every case the spec owns gets a typed `blocked` result and its tests skip.
 */

export interface Suite {
  readonly services: SystemServices;
  readonly app: WebApp;
  readonly browser: Browser;
  /** Present when the suite was started with `localChain`: a loopback Anvil with the real registry. */
  readonly chain: SystemChain | null;
  readonly registry: DeployedRegistry | null;
  /** Present with `faultProxy`: the application's only route to the node, with injectable faults. */
  readonly proxy: FaultProxy | null;
  /** The server environment the application was started with (non-secret, synthetic). */
  readonly appEnv: Readonly<Record<string, string>>;
  /** A new context with a CDP virtual authenticator (PRF on by default). Simulated and labelled. */
  newSession(options?: {
    readonly prf?: boolean;
    readonly clock?: boolean;
    readonly authenticator?: boolean;
  }): Promise<{
    context: BrowserContext;
    page: Page;
    cdp: Awaited<ReturnType<typeof addVirtualAuthenticator>> | null;
  }>;
  stop(): Promise<void>;
}

export interface SuiteOptions {
  readonly name: string;
  readonly cases: readonly string[];
  readonly evidenceClass?: EvidenceClass;
  /** Run a loopback Anvil with the unchanged registry and point the application at it (test seam). */
  readonly localChain?: boolean;
  /** Put a fault-injecting loopback proxy between the application and the local node. */
  readonly faultProxy?: boolean;
  /** Extra server configuration, merged over the defaults. */
  readonly env?: (services: SystemServices) => Record<string, string>;
}

export async function startSuite(options: SuiteOptions): Promise<Suite | Blocked> {
  const started = new Date();
  const block = (blocked: Blocked): Blocked => {
    for (const id of options.cases)
      recordResult({
        caseId: id,
        status: 'blocked',
        evidenceClass: options.evidenceClass ?? 'browser_scripted',
        startedAt: started,
        configuration: { reason: blocked.reason },
        issueCodes: [blocked.code],
      });
    return blocked;
  };
  const services = await startSystemServices();
  if (isBlocked(services)) return block(services);
  let chain: SystemChain | null = null;
  let registry: DeployedRegistry | null = null;
  let proxy: FaultProxy | null = null;
  let stopMiner: (() => void) | null = null;
  let scratch = '';
  let chainEnv: Record<string, string> = {};
  if (options.localChain === true) {
    const started2 = await startSystemChain(10143, { allowPublicChainId: true });
    if (isBlocked(started2)) {
      await services.stop();
      return block(started2);
    }
    chain = started2;
    registry = await deployRegistry(chain);
    scratch = mkdtempSync(join(tmpdir(), 'system-suite-'));
    const recordFile = join(scratch, 'local-deployment.json');
    writeLocalDeploymentRecord(recordFile, chain, registry);
    stopMiner = startMiner(chain);
    if (options.faultProxy === true) proxy = await startFaultProxy(chain.local.rpcUrl);
    chainEnv = {
      LEXAEGIS_TEST_CHAIN: 'local-anvil',
      LEXAEGIS_TEST_CHAIN_DEPLOYMENT: recordFile,
      ALCHEMY_MONAD_RPC_URL: proxy?.url ?? chain.local.rpcUrl,
    };
  }
  const appEnv: Record<string, string> = {
    NEXT_PUBLIC_CHAIN_ID: '10143',
    NEXT_PUBLIC_REGISTRY_ADDRESS: registry?.address ?? `0x${'ab'.repeat(20)}`,
    DATABASE_URL: services.postgres.url,
    S3_ENDPOINT: services.s3.endpoint,
    S3_BUCKET: services.s3.bucket,
    S3_REGION: services.s3.region,
    S3_ACCESS_KEY_ID: services.s3.accessKeyId,
    S3_SECRET_ACCESS_KEY: services.s3.secretAccessKey,
    FEATURE_VOICE: 'false',
    FEATURE_AGENT_IDENTITY: 'false',
    FEATURE_REPUTATION_FEEDBACK: 'false',
    LEXAEGIS_TEST_MODE: 'scripted-assistant',
    ASSISTANT_TEST_PROVIDER_URL: services.provider.baseUrl,
    QWEN_API_KEY: '',
    QWEN_BASE_URL: '',
    QWEN_OUTPUT_MODE: '',
    ...chainEnv,
    ...options.env?.(services),
  };
  const app = await startWebApp({ name: options.name, env: appEnv });
  if (isBlocked(app)) {
    stopMiner?.();
    await proxy?.stop();
    await chain?.stop();
    await services.stop();
    return block(app);
  }
  const browser = await launch();
  return {
    services,
    app,
    browser,
    chain,
    registry,
    proxy,
    appEnv,
    async newSession(sessionOptions = {}) {
      const context = await browser.newContext({
        reducedMotion: 'reduce',
        viewport: { width: 1440, height: 900 },
        permissions: ['clipboard-read', 'clipboard-write'],
        acceptDownloads: true,
      });
      const page = await context.newPage();
      if (sessionOptions.clock === true) await page.clock.install();
      const cdp =
        sessionOptions.authenticator === false
          ? null
          : await addVirtualAuthenticatorWith(context, page, sessionOptions.prf !== false);
      return { context, page, cdp };
    },
    async stop() {
      stopMiner?.();
      await proxy?.stop();
      await browser.close();
      await app.stop();
      await chain?.stop();
      await services.stop();
      if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
    },
  };
}

async function addVirtualAuthenticatorWith(context: BrowserContext, page: Page, prf: boolean) {
  if (prf) return addVirtualAuthenticator(context, page);
  await page.addInitScript('window.__name = (target) => target;');
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: false,
    } as never,
  });
  return { cdp, authenticatorId };
}
