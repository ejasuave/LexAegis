import { SMOKE_STEPS } from './smoke-steps';

export interface GuardResult {
  readonly id: string;
  readonly ok: boolean;
  readonly reason: string;
}

type Env = Readonly<Record<string, string | undefined>>;

const truthy = (value: string | undefined) =>
  value !== undefined && value !== '' && value !== '0' && value !== 'false';
const SIMULATION_MARKERS = [
  'LEXAEGIS_REPLAY_PROVIDER',
  'LEXAEGIS_VIRTUAL_AUTHENTICATOR',
  'LEXAEGIS_TEST_SIGNER',
] as const;

/**
 * Read-only preflight for the manual live harness. Pure: it reads only the environment it is
 * given, makes no request and cannot start anything.
 */
export function preflightTestnet(env: Env, argv: readonly string[]): GuardResult[] {
  const results: GuardResult[] = [];
  const check = (id: string, ok: boolean, reason: string) =>
    results.push({ id, ok, reason: ok ? 'ok' : reason });

  check('not-ci', !truthy(env.CI) && !truthy(env.GITHUB_ACTIONS), 'refusing to run in CI');
  check(
    'operator-start',
    argv.includes('--operator-start'),
    'requires an explicit --operator-start',
  );

  const chain = env.NEXT_PUBLIC_CHAIN_ID;
  check('not-mainnet', chain !== '143' && env.SMOKE_CHAIN_ID !== '143', 'mainnet is refused');
  check(
    'chain-10143',
    chain === '10143' && env.SMOKE_CHAIN_ID === '10143',
    'chain must be Monad testnet 10143',
  );
  check(
    'registry-configured',
    /^0x[0-9a-fA-F]{40}$/.test(env.NEXT_PUBLIC_REGISTRY_ADDRESS ?? '') &&
      !/^0x0{40}$/.test(env.NEXT_PUBLIC_REGISTRY_ADDRESS ?? ''),
    'a deployed registry address is not configured',
  );

  const approved = new Set(
    (env.SMOKE_APPROVED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  );
  for (const [id, name] of [
    ['app-origin', 'SMOKE_APP_ORIGIN'],
    ['verifier-origin', 'SMOKE_VERIFIER_ORIGIN'],
  ] as const) {
    const origin = env[name] ?? '';
    check(
      id,
      origin.startsWith('https://') && approved.has(origin),
      `${name} must be an approved https origin`,
    );
  }
  check(
    'synthetic-account',
    /^synthetic-[a-z0-9-]{3,40}$/.test(env.SMOKE_ACCOUNT_LABEL ?? ''),
    'SMOKE_ACCOUNT_LABEL must name a synthetic demonstration account',
  );
  check(
    'no-simulation',
    SIMULATION_MARKERS.every((name) => !truthy(env[name])),
    'replay providers, virtual authenticators and test signers are refused',
  );
  return results;
}

export function guardsPass(results: readonly GuardResult[]): boolean {
  return results.every((result) => result.ok);
}

/** Resume ledger: completed steps and the transaction identifiers they produced. */
export interface Ledger {
  readonly runId: string;
  readonly completed: Readonly<Record<string, { readonly transactionHash?: string }>>;
}

/** Steps still to do. A completed step is never repeated, so a rerun cannot duplicate a write. */
export function remainingSteps(ledger: Ledger): string[] {
  return SMOKE_STEPS.map((step) => step.id).filter((id) => !(id in ledger.completed));
}
