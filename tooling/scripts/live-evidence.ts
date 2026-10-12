/**
 * pnpm validate:live <command>
 *
 * The bounded, manual-assisted harness for what an automated local run CANNOT establish: real passkey
 * recovery on hardware a person controls, existing live testnet references, and (only on explicit
 * opt-in) a paid Qwen run. It never drives a passkey ceremony, never funds, deploys or sends, never
 * infers success from missing interaction, and keeps four kinds of observation apart: local/scripted
 * (not here), live read, human-observed device, paid-model.
 *
 *   status                      (default) what is verified, unverified, blocked or not run, and who acts next. No network.
 *   device                      the checklist for a person on a real device. Prints only.
 *   device-record --address 0x.. --browser .. --os .. --authenticator-class .. --rp-id ..
 *                 --create yes|no|not-available --unlock .. --save-readback .. --recover-after-origin-clear ..
 *                 --origin-only-cleared yes --passkey-kept yes
 *                 [--second-device yes|no|not-available --second-device-commitment-match ..]
 *                 [--ceremonies-create N --ceremonies-unlock N --ceremonies-recover N]
 *                 [--seconds-create S --seconds-unlock S --seconds-recover S]
 *                 [--seconds-source-to-answer S --seconds-sign S --seconds-broadcast S --seconds-confirmed S]
 *                 [--voice-dictation yes|no|unavailable --voice-read-aloud yes|no|unavailable]
 *                 [--write]
 *                               validates what the person observed and records it (with --write).
 *                               Every step flag is required: a missing one is an error, never "yes".
 *   read                        bounded READ-ONLY live checks of the existing registry reference through
 *                               the public Monad RPC, Alchemy (when configured) and the Envio history
 *                               index (when configured). One pass, no loops, no load. [--env-file .env] [--write]
 *   record-qwen                 records the latest passing LIVE qwen:smoke evidence file as a `qwen-run` result of class
 *                               live_provider (what Gate C1 reads). Calls nothing; refuses a file that is not a genuine run.
 *   qwen --spend-tokens         runs `pnpm qwen:smoke` (a synthetic fixture, the ordinary per-run budget).
 *                               Without the flag nothing is called and the case stays not_run.
 *
 * Exit codes: 0 done; 1 a check failed or a recorded step was not shown; 2 usage; 3 blocked or opt-in missing.
 * Limits: a script cannot prove sponsor-side retention, practitioner validation, external adoption or
 * legal accuracy; "not-available" is recorded as unverified, never as a pass.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readState, recordEvidence } from '../src/evidence-writer';
import { redact } from '../src/redact';
import { LIVE_CLASSES, type EvidenceResult } from '../src/state';
import { ROOT, gitRevision, stamp } from './lib';

const argv = process.argv.slice(2);
const command = argv[0] !== undefined && !argv[0].startsWith('--') ? argv[0] : 'status';
const rest = command === argv[0] ? argv.slice(1) : argv;
const value = (name: string): string | undefined => {
  const index = rest.indexOf(`--${name}`);
  return index === -1 ? undefined : rest[index + 1];
};
const has = (name: string): boolean => rest.includes(`--${name}`);
const today = (): string => new Date().toISOString().slice(0, 10);
const stampId = (): string => new Date().toISOString().replace(/\D/g, '').slice(0, 14);

// ---- status ---------------------------------------------------------------------------------------------

interface Row {
  readonly capability: string;
  readonly subjects: readonly string[];
  readonly next: string;
  /** A fact that must hold for a pass to count (for example a second device). */
  readonly requires?: (facts: Readonly<Record<string, string | boolean>>) => boolean;
}

const ROWS: readonly Row[] = [
  {
    capability: 'Mera create and recover on a real device (same credential and rpId)',
    subjects: ['mera-real-device-check'],
    next: 'a person: pnpm validate:live device, then device-record --write',
  },
  {
    capability:
      'Encrypted vault saved, read back and recovered after clearing the origin (real device)',
    subjects: ['device-recovery-observation', 'vault-real-device-check'],
    next: 'a person: pnpm validate:live device, then device-record --write',
  },
  {
    capability: 'Same credential recovered on a genuinely separate device',
    subjects: ['device-recovery-observation', 'mera-real-device-check'],
    next: 'a person with a second device: device-record --second-device yes ...',
    requires: (facts) => facts.secondDeviceRecovery === 'yes' || facts.secondDevice === 'yes',
  },
  {
    capability:
      'Registry reference verified read-only against the live chain (Alchemy, public RPC)',
    subjects: ['deployment-verification', 'live-read-observation'],
    next: 'pnpm validate:live read --env-file .env --write (read-only)',
  },
  {
    capability: 'Envio history index read, with lag stated separately',
    subjects: ['live-read-observation'],
    next: 'pnpm validate:live read --env-file .env --write (needs ENVIO_GRAPHQL_URL)',
    requires: (facts) => facts.envioReady === true,
  },
  {
    capability: 'Genuine Qwen run (paid model)',
    subjects: ['qwen-run'],
    next: 'pnpm validate:live qwen --spend-tokens (explicit opt-in)',
  },
  {
    capability: 'New testnet lifecycle (sign, broadcast, confirmed observation)',
    subjects: ['registry-transaction', 'mera-signature'],
    next: 'a person: pnpm smoke:testnet --operator-start (no automatic funding)',
  },
  {
    capability: 'Local dictation and read-aloud on a real device',
    subjects: ['device-recovery-observation'],
    next: 'a person: device-record --voice-dictation yes|no|unavailable ...',
    requires: (facts) => facts.voiceDictation === 'yes' && facts.voiceReadAloud === 'yes',
  },
];

function latest(results: readonly EvidenceResult[], subject: string): EvidenceResult | undefined {
  return results
    .filter((result) => result.subject === subject)
    .sort((a, b) => a.checkedAt.localeCompare(b.checkedAt))
    .at(-1);
}

/**
 * The paid-model run is recorded by `pnpm qwen:smoke` in its own evidence file, not in build-state. It
 * counts only when a LIVE file shows a passing run with a verified capability and every assertion ok.
 */
function qwenEvidence(): { state: string; detail: string } {
  const directory = join(ROOT, 'docs', 'evidence');
  const files = readdirSync(directory).filter((name) =>
    /^chapter09-qwen-smoke-\d{4}-\d{2}-\d{2}\.json$/.test(name),
  );
  const parsed = files
    .map((name) => {
      try {
        return {
          name,
          doc: JSON.parse(readFileSync(join(directory, name), 'utf8')) as {
            evidenceKind?: string;
            outcome?: string;
            executedAt?: string;
            capability?: { verified?: boolean };
            assertions?: { ok?: boolean }[];
          },
        };
      } catch {
        return null;
      }
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => (a.doc.executedAt ?? '').localeCompare(b.doc.executedAt ?? ''));
  const last = parsed.at(-1);
  if (last === undefined) return { state: 'not_run', detail: 'no record' };
  const { doc, name } = last;
  const ok =
    doc.evidenceKind === 'live' &&
    doc.outcome === 'pass' &&
    doc.capability?.verified === true &&
    (doc.assertions?.length ?? 0) > 0 &&
    doc.assertions?.every((a) => a.ok === true) === true;
  if (ok)
    return {
      state: 'verified',
      detail: `live provider run ${doc.executedAt?.slice(0, 10) ?? ''} (docs/evidence/${name}); one synthetic fixture, not production reliability`,
    };
  return {
    state: doc.outcome === 'blocked' ? 'blocked' : 'unverified',
    detail: `${doc.outcome ?? 'unknown'} ${doc.executedAt?.slice(0, 10) ?? ''} (docs/evidence/${name})`,
  };
}

function statusTable(): {
  rows: { capability: string; state: string; detail: string; next: string }[];
} {
  const state = readState(ROOT);
  const results = Array.isArray(state.results) ? (state.results as EvidenceResult[]) : [];
  const rows = ROWS.map((row) => {
    if (row.subjects.includes('qwen-run')) {
      const qwen = qwenEvidence();
      return {
        capability: row.capability,
        state: qwen.state,
        detail: qwen.detail,
        next: qwen.state === 'verified' ? '-' : row.next,
      };
    }
    const seen = row.subjects
      .map((subject) => latest(results, subject))
      .filter((result): result is EvidenceResult => result !== undefined);
    const verified = seen.find(
      (result) =>
        result.outcome === 'pass' &&
        LIVE_CLASSES.has(result.evidenceClass) &&
        (row.requires === undefined || row.requires(result.facts ?? {})),
    );
    if (verified !== undefined)
      return {
        capability: row.capability,
        state: 'verified',
        detail: `${verified.evidenceClass} ${verified.checkedAt.slice(0, 10)} (${verified.subject}${verified.reasonCodes.includes('OPERATOR_REPORTED') ? ', operator reported' : ''})`,
        next: '-',
      };
    const any = seen.at(-1);
    if (any === undefined)
      return { capability: row.capability, state: 'not_run', detail: 'no record', next: row.next };
    // A record that does not show this step is "unverified", not a concealed failure.
    const shown =
      any.outcome === 'pass'
        ? 'a pass that does not show this step'
        : `${any.outcome} ${any.checkedAt.slice(0, 10)}`;
    return {
      capability: row.capability,
      state: any.outcome === 'blocked' ? 'blocked' : 'unverified',
      detail: `${any.subject}: ${shown}`,
      next: row.next,
    };
  });
  return { rows };
}

if (command === 'status') {
  const { rows } = statusTable();
  for (const row of rows)
    console.log(
      `${row.state.padEnd(10)} ${row.capability}\n           ${row.detail}\n           next: ${row.next}`,
    );
  console.log(
    '\nverified = a passing real_device or live_testnet record that shows the step. Local, scripted and virtual-authenticator evidence never counts here.',
  );
  process.exit(0);
}

// ---- device checklist ------------------------------------------------------------------------------------

if (command === 'device') {
  console.log(`Real-device recovery check (you act; nothing here drives a passkey)

Use a dedicated synthetic account and a synthetic document only.

 1. Open the application on its real origin on a supported browser and OS. Note browser, OS, the
    authenticator CLASS (platform, synced passkey, phone/hybrid, security key), and the rpId.
 2. Create the Mera account. Count the authenticator prompts you saw and time them.
 3. Unlock the vault explicitly. Save a synthetic matter. Read it back.
 4. Clear ONLY this origin's site data (not the passkey, not other sites). Confirm to yourself that you did.
 5. Reopen, sign in with the same credential, recover the vault. The reviewer address and the decrypted
    bytes/commitment must be the same ones you saw before.
 6. If you have a second supported device with the same synced credential: repeat step 5 there.
 7. Time, separately: question to answer, recovery, signing, broadcast, confirmed observation.
 8. Optional: try local dictation and read-aloud. If a control is absent, record "unavailable".

Then record only what you saw, with --write. A step you did not do is "not-available", which is
recorded as unverified. Never paste a credential ID, key or recovery value.`);
  process.exit(0);
}

// ---- device-record ---------------------------------------------------------------------------------------

const TRI = ['yes', 'no', 'not-available'] as const;
const VOICE = ['yes', 'no', 'unavailable'] as const;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function tri(name: string, allowed: readonly string[] = TRI): string {
  const given = value(name);
  if (given === undefined)
    fail(`missing --${name} (${allowed.join('|')}): a step you did not report is not assumed`);
  if (!allowed.includes(given)) fail(`--${name} must be one of ${allowed.join('|')}`);
  return given;
}

/** Credential IDs, keys and recovery values look like long opaque tokens. Refuse them everywhere. */
function plain(name: string, text: string | undefined, required = true): string {
  if (text === undefined || text === '') {
    if (required) fail(`missing --${name}`);
    return '';
  }
  if (text.length > 80 || /[A-Za-z0-9_+/=-]{40,}/.test(text) || /^0x[0-9a-fA-F]{40,}$/.test(text))
    fail(
      `--${name} looks like a credential, key or identifier: record only a short descriptive label`,
    );
  return text;
}

const number = (name: string): string => {
  const given = value(name);
  if (given === undefined) return 'not-measured';
  if (!/^\d{1,6}(\.\d{1,3})?$/.test(given))
    fail(`--${name} must be a number of seconds or a count`);
  return given;
};

if (command === 'device-record') {
  const address =
    value('address') ??
    fail('missing --address (the lowercase 0x address the Account panel shows)');
  if (!/^0x[0-9a-f]{40}$/.test(address)) fail('--address must be a lowercase 0x address');
  const steps = {
    create: tri('create'),
    unlock: tri('unlock'),
    saveReadback: tri('save-readback'),
    recoverAfterOriginClear: tri('recover-after-origin-clear'),
  };
  const clearedOnlyOrigin = tri('origin-only-cleared');
  const passkeyKept = tri('passkey-kept');
  const second = tri('second-device');
  const secondMatch = second === 'yes' ? tri('second-device-commitment-match') : 'not-available';
  const facts: Record<string, string | boolean> = {
    address,
    browser: plain('browser', value('browser')),
    os: plain('os', value('os')),
    authenticatorClass: plain('authenticator-class', value('authenticator-class')),
    rpId: plain('rp-id', value('rp-id')),
    ...steps,
    originOnlyCleared: clearedOnlyOrigin,
    passkeyKept,
    secondDevice: second,
    secondDeviceCommitmentMatch: secondMatch,
    ceremoniesCreate: number('ceremonies-create'),
    ceremoniesUnlock: number('ceremonies-unlock'),
    ceremoniesRecover: number('ceremonies-recover'),
    secondsCreate: number('seconds-create'),
    secondsUnlock: number('seconds-unlock'),
    secondsRecover: number('seconds-recover'),
    secondsSourceToAnswer: number('seconds-source-to-answer'),
    secondsSign: number('seconds-sign'),
    secondsBroadcast: number('seconds-broadcast'),
    secondsConfirmed: number('seconds-confirmed'),
    voiceDictation: tri('voice-dictation', VOICE),
    voiceReadAloud: tri('voice-read-aloud', VOICE),
    textFallbackTested: true,
  };
  // The clearing must have touched only this origin and kept the passkey, or the step proves nothing.
  const clearValid = clearedOnlyOrigin === 'yes' && passkeyKept === 'yes';
  const core = [steps.create, steps.unlock, steps.saveReadback, steps.recoverAfterOriginClear];
  const reasons: string[] = ['OPERATOR_REPORTED'];
  if (!clearValid) reasons.push('ORIGIN_CLEAR_NOT_CONFIRMED');
  if (core.includes('no')) reasons.push('STEP_REPORTED_FAILED');
  if (core.includes('not-available')) reasons.push('STEP_NOT_SHOWN');
  if (second !== 'yes') reasons.push('SECOND_DEVICE_NOT_SHOWN');
  if (second === 'yes' && secondMatch !== 'yes')
    reasons.push('SECOND_DEVICE_COMMITMENT_NOT_MATCHED');
  if (facts.voiceDictation !== 'yes' || facts.voiceReadAloud !== 'yes')
    reasons.push('VOICE_DEVICE_EVIDENCE_UNAVAILABLE');
  const failed =
    core.includes('no') || second === 'no' || (second === 'yes' && secondMatch === 'no');
  const allShown = core.every((step) => step === 'yes') && clearValid;
  const outcome = failed ? 'fail' : allShown ? 'pass' : 'unknown';

  console.log(`outcome: ${outcome}`);
  console.log(`reasons: ${reasons.join(', ')}`);
  console.log(
    'unverified, not failed: a step marked not-available stays unverified and is never hidden by a fresh passkey.',
  );
  if (!has('write')) {
    console.log('dry run: add --write to record this observation');
    process.exit(outcome === 'fail' ? 1 : 0);
  }
  await recordEvidence({
    root: ROOT,
    results: [
      stamp({
        id: `device-recovery-${stampId()}`,
        subject: 'device-recovery-observation',
        command: 'manual: pnpm validate:live device-record (a person on real hardware)',
        evidenceClass: 'real_device',
        outcome,
        reasonCodes: reasons.map((r) => r.replaceAll('-', '_')),
        facts,
      }),
    ],
  });
  console.log('recorded as real_device evidence (operator reported; not independently proven)');
  process.exit(outcome === 'fail' ? 1 : 0);
}

// ---- read ------------------------------------------------------------------------------------------------

interface LiveReadResult {
  readonly provider: 'alchemy' | 'public-rpc' | 'envio';
  readonly status: 'match' | 'mismatch' | 'invalid' | 'unavailable' | 'not_configured' | 'readable';
  readonly durationMs: number;
  readonly detail: Record<string, string | boolean>;
}

function loadEnvFile(): void {
  const path = value('env-file');
  if (path === undefined) return;
  const full = join(ROOT, path);
  if (!existsSync(full)) fail(`--env-file ${path} not found`);
  process.loadEnvFile(full); // values are never printed
}

function verifyDeployment(provider: 'alchemy' | 'public-rpc'): LiveReadResult {
  const started = Date.now();
  if (provider === 'alchemy' && (process.env.ALCHEMY_MONAD_RPC_URL ?? '') === '')
    return {
      provider,
      status: 'not_configured',
      durationMs: 0,
      detail: { reason: 'ALCHEMY_MONAD_RPC_URL not set' },
    };
  const run = spawnSync(
    'pnpm',
    ['verify:deployment', ...(provider === 'public-rpc' ? ['--public-rpc'] : []), '--json'],
    { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 90_000 },
  );
  const durationMs = Date.now() - started;
  const text = run.stdout;
  const parsed = (() => {
    try {
      // The evidence document wraps the report under `report`.
      const document = JSON.parse(text.slice(text.indexOf('{'))) as {
        report?: {
          outcome?: string;
          checkpoint?: { blockNumber: string; finalizedBlock: string; rechecked: boolean } | null;
          record?: { registryAddress: string; deploymentBlock: string; chainId: string } | null;
        };
      };
      return document.report ?? null;
    } catch {
      return null;
    }
  })();
  const status =
    parsed?.outcome === 'match' || parsed?.outcome === 'mismatch' || parsed?.outcome === 'invalid'
      ? parsed.outcome
      : 'unavailable';
  return {
    provider,
    status,
    durationMs,
    detail: {
      ...(parsed?.record
        ? {
            registryAddress: parsed.record.registryAddress,
            deploymentBlock: parsed.record.deploymentBlock,
            chainId: parsed.record.chainId,
          }
        : {}),
      ...(parsed?.checkpoint
        ? {
            checkpointBlock: parsed.checkpoint.blockNumber,
            finalizedBlock: parsed.checkpoint.finalizedBlock,
            rechecked: parsed.checkpoint.rechecked,
          }
        : {}),
    },
  };
}

async function post(url: string, body: unknown, ms: number): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  return response.json();
}

async function readEnvio(publicHead: bigint | null): Promise<LiveReadResult> {
  const url = process.env.ENVIO_GRAPHQL_URL ?? '';
  if (url === '')
    return {
      provider: 'envio',
      status: 'not_configured',
      durationMs: 0,
      detail: { reason: 'ENVIO_GRAPHQL_URL not set' },
    };
  const started = Date.now();
  try {
    const reply = (await post(
      url,
      {
        query:
          'query HistoryMeta { _meta { chainId startBlock progressBlock sourceBlock isReady eventsProcessed } }',
      },
      10_000,
    )) as { data?: { _meta?: unknown } };
    const raw = reply.data?._meta;
    const meta = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | null | undefined;
    if (meta === undefined || meta === null) throw new Error('no _meta');
    const progress = BigInt(String(meta.progressBlock));
    const source = BigInt(String(meta.sourceBlock));
    return {
      provider: 'envio',
      status: 'readable',
      durationMs: Date.now() - started,
      detail: {
        envioReadable: true,
        envioReady: meta.isReady === true,
        isReady: meta.isReady === true,
        progressBlock: progress.toString(),
        sourceBlock: source.toString(),
        // Lag is stated twice and never merged: against the index's own source, and against the public chain head.
        sourceLagBlocks: (source > progress ? source - progress : 0n).toString(),
        publicHeadLagBlocks:
          publicHead === null
            ? 'unknown'
            : (publicHead > progress ? publicHead - progress : 0n).toString(),
      },
    };
  } catch (error) {
    return {
      provider: 'envio',
      status: 'unavailable',
      durationMs: Date.now() - started,
      detail: { reason: redact(error instanceof Error ? error.message : 'error').slice(0, 80) },
    };
  }
}

if (command === 'read') {
  loadEnvFile();
  console.log(
    'Read-only checks of the existing registry reference. No key, no signature, no transaction.',
  );
  const results: LiveReadResult[] = [verifyDeployment('public-rpc'), verifyDeployment('alchemy')];
  const head = await (async (): Promise<bigint | null> => {
    try {
      const reply = (await post(
        'https://testnet-rpc.monad.xyz/',
        { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
        8_000,
      )) as { result?: string };
      return reply.result === undefined ? null : BigInt(reply.result);
    } catch {
      return null;
    }
  })();
  results.push(await readEnvio(head));
  for (const item of results)
    console.log(
      `${item.provider.padEnd(11)} ${item.status.padEnd(14)} ${String(item.durationMs)} ms  ${Object.entries(
        item.detail,
      )
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(' ')}`,
    );
  const reached = results.filter((r) => r.status !== 'not_configured');
  const bad = reached.some((r) => r.status === 'mismatch' || r.status === 'invalid');
  const unavailable = reached.some((r) => r.status === 'unavailable');
  console.log(
    'deployment, reference and checkpoint are different facts: a match proves the code at that checkpoint, not the head.',
  );
  if (has('write')) {
    const revision = gitRevision();
    const directory = join(ROOT, 'docs', 'evidence', 'chapter12');
    mkdirSync(directory, { recursive: true });
    const file = join(directory, `live-read-${today()}.json`);
    const doc = {
      schema: 'lexaegis.live-read-observation.v1',
      class: 'live_read',
      observedAt: new Date().toISOString(),
      commit: revision.commit,
      dirtyWorktree: revision.dirtyWorktree,
      note: 'Read-only. Endpoints are named by provider, never by URL. A match is code identity at the stated checkpoint, not live state.',
      results,
    };
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    const envio = results.find((r) => r.provider === 'envio');
    await recordEvidence({
      root: ROOT,
      results: [
        stamp({
          id: `live-read-${stampId()}`,
          subject: 'live-read-observation',
          command: 'pnpm validate:live read',
          evidenceClass: 'live_testnet',
          outcome: bad ? 'fail' : unavailable || reached.length === 0 ? 'unknown' : 'pass',
          reasonCodes: [
            'READ_ONLY',
            ...(unavailable ? ['PROVIDER_UNAVAILABLE'] : []),
            ...results
              .filter((r) => r.status === 'not_configured')
              .map((r) => `${r.provider.toUpperCase().replaceAll('-', '_')}_NOT_CONFIGURED`),
          ],
          evidenceRefs: [{ type: 'path', value: relative(ROOT, file) }],
          facts: {
            chainId: '10143',
            envioReadable: envio?.status === 'readable',
            envioReady: envio?.detail.envioReady === true,
            providers: results
              .filter((r) => r.status !== 'not_configured')
              .map((r) => `${r.provider}:${r.status}`)
              .join(','),
          },
        }),
      ],
    });
    console.log(`recorded: ${relative(ROOT, file)}`);
  }
  process.exit(bad ? 1 : unavailable || reached.length === 0 ? 3 : 0);
}

// ---- record-qwen ------------------------------------------------------------------------------------------

interface QwenSmokeDoc {
  evidenceKind?: string;
  outcome?: string;
  executedAt?: string;
  provider?: { id?: string; region?: string; requestedModel?: string };
  capability?: { verified?: boolean; returnedModel?: string | null };
  run?: { terminalEvent?: string; agentConfig?: { provider?: { requestIds?: string[] } } };
  assertions?: { id?: string; ok?: boolean; detail?: string }[];
}

/** Facts a genuine-run requirement reads, derived ONLY from what the smoke wrote. Returns why not, or the facts. */
function providerFacts(
  doc: QwenSmokeDoc,
): { facts: Record<string, string | boolean> } | { why: string } {
  if (doc.evidenceKind !== 'live') return { why: 'the file is not marked as a live run' };
  if (doc.outcome !== 'pass') return { why: `the run outcome is ${doc.outcome ?? 'missing'}` };
  if (doc.provider?.id !== 'qwen') return { why: 'the provider is not qwen' };
  if (doc.capability?.verified !== true) return { why: 'the capability check is not verified' };
  const returnedModel = doc.capability.returnedModel ?? '';
  if (returnedModel === '') return { why: 'the provider returned no model name' };
  if (doc.run?.terminalEvent !== 'run_completed') return { why: 'the run did not complete' };
  const assertions = doc.assertions ?? [];
  if (assertions.length === 0 || !assertions.every((a) => a.ok === true))
    return { why: 'not every assertion passed' };
  const requestIds = doc.run.agentConfig?.provider?.requestIds ?? [];
  const tools =
    assertions.find((a) => a.id === 'model_requested_two_read_only_tools')?.detail ?? '';
  const toolRequests = (tools.match(/T\d+:[a-z_]+:succeeded/g) ?? []).length;
  const cited = assertions.find((a) => a.id === 'answer_cites_resolvable_sources')?.detail ?? '';
  const citedBlocks = Number(/^(\d+) validated block/.exec(cited)?.[1] ?? '0');
  return {
    facts: {
      provenance: 'live-provider',
      replayed: false,
      scriptedProvider: false,
      provider: 'qwen',
      region: doc.provider.region ?? '',
      returnedModel,
      capabilityVerified: true,
      assertionsPassed: true,
      requestIds: String(requestIds.length),
      toolRequests: String(toolRequests),
      citedBlocks: String(citedBlocks),
      inputKind: 'synthetic_fixture',
    },
  };
}

if (command === 'record-qwen') {
  const directory = join(ROOT, 'docs', 'evidence');
  const files = readdirSync(directory)
    .filter((name) => /^chapter09-qwen-smoke-\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort();
  const name = files.at(-1);
  if (name === undefined) fail('no chapter09-qwen-smoke evidence file');
  const doc = JSON.parse(readFileSync(join(directory, name), 'utf8')) as QwenSmokeDoc;
  const derived = providerFacts(doc);
  if ('why' in derived) {
    console.error(`not recorded: ${derived.why}`);
    process.exit(1);
  }
  const executedAt = doc.executedAt ?? '';
  const id = `qwen-run-${executedAt.replace(/\D/g, '').slice(0, 14)}`;
  const existing = readState(ROOT).results;
  if (Array.isArray(existing) && (existing as EvidenceResult[]).some((r) => r.id === id)) {
    console.log(`already recorded: ${id}`);
    process.exit(0);
  }
  await recordEvidence({
    root: ROOT,
    results: [
      {
        ...stamp({
          id,
          subject: 'qwen-run',
          command: 'pnpm qwen:smoke (recorded by pnpm validate:live record-qwen)',
          evidenceClass: 'live_provider',
          outcome: 'pass',
          reasonCodes: ['LIVE_PROVIDER_RUN', 'SYNTHETIC_FIXTURE_INPUT', 'ONE_RUN_ONE_FIXTURE'],
          evidenceRefs: [{ type: 'path', value: `docs/evidence/${name}` }],
          facts: derived.facts,
        }),
        checkedAt: new Date().toISOString(),
      },
    ],
  });
  console.log(
    `recorded ${id} as live_provider evidence from docs/evidence/${name} (no provider call made)`,
  );
  process.exit(0);
}

// ---- qwen (explicit opt-in) ------------------------------------------------------------------------------

if (command === 'qwen') {
  if (!has('spend-tokens')) {
    console.log(
      'not_run LIVE_OPT_IN_REQUIRED: this calls the configured paid model on a synthetic fixture. Add --spend-tokens to run it. Nothing was called.',
    );
    process.exit(3);
  }
  loadEnvFile();
  console.log(
    'Running pnpm qwen:smoke (synthetic fixture, ordinary per-run budget). It records its own evidence.',
  );
  const run = spawnSync('pnpm', ['qwen:smoke'], {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
    timeout: 15 * 60_000,
  });
  process.exit(run.status === 0 ? 0 : run.status === null ? 3 : 1);
}

console.error(`unknown command ${command}; see the header of tooling/scripts/live-evidence.ts`);
process.exit(2);
