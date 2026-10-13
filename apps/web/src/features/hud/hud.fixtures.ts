import type { HudInput, ActiveRunInput, FindingInput } from './hud.types';

/*
 * Synthetic scenes for tests and screenshots. Everything here is invented: no matter, document,
 * address or hash is real. They exist only behind the HUD_FIXTURES server flag and are never
 * reachable in a normal build. A fixture feeds the real selectors, so the pictures under test are
 * exactly what the application would draw for that input.
 */

export const HUD_FIXTURE_NAMES = [
  'idle',
  'queued',
  'awaiting',
  'running',
  'alert',
  'stopping',
  'offline',
  'stale',
  'locked',
  'pending',
  'failed',
  'confirmed',
] as const;

export type HudFixtureName = (typeof HUD_FIXTURE_NAMES)[number];

export function isHudFixtureName(value: string): value is HudFixtureName {
  return (HUD_FIXTURE_NAMES as readonly string[]).includes(value);
}

const ADDRESS = '0x00000000000000000000000000000000000fix01';

const FINDINGS: readonly FindingInput[] = [
  { id: 'fx-finding-1', state: 'attention', resolved: false, visible: false, selected: true },
  { id: 'fx-finding-2', state: 'attention', resolved: false, visible: false, selected: false },
  { id: 'fx-finding-3', state: 'needs_input', resolved: false, visible: false, selected: false },
  {
    id: 'fx-finding-4',
    state: 'technical_failure',
    resolved: false,
    visible: false,
    selected: false,
  },
];

export function fixtureFindingIds(): readonly string[] {
  return FINDINGS.map((f) => f.id);
}

export function buildHudFixture(name: HudFixtureName, nowMs: number): HudInput {
  const run = (patch: Partial<ActiveRunInput> = {}): ActiveRunInput => ({
    state: 'running',
    toolsStarted: 2,
    toolsFinished: 1,
    stepsCompleted: 1,
    stepsTotal: 4,
    operation: 'payment check',
    outOfDate: false,
    failureMessage: null,
    failureCode: null,
    lastEventAtMs: nowMs - 1000,
    ...patch,
  });
  const base: HudInput = {
    ceiling: {
      nowMs,
      matterTitle: 'Synthetic matter',
      selectedVersionIds: ['fixture0001'],
      networkLabel: 'Monad Testnet (10143)',
      chainId: '10143',
      account: {
        availability: 'available',
        ceremony: 'idle',
        address: ADDRESS,
        signing: 'unlocked',
        signingExpiresAtMs: nowMs + 20 * 60_000,
        lastEvent: null,
        backend: 'signed_in',
      },
      vaultLabel: 'Unlocked',
      transaction: { stage: 'idle', mayHaveBroadcast: false },
      indexer: {
        availability: 'available',
        freshness: 'caught_up',
        indexConsistency: 'consistent',
        observedAtMs: nowMs - 6000,
        indexedBlock: '1000000',
        sourceLag: '0',
        confirmedLag: '0',
      },
    },
    assistant: { phase: 'idle', orb: 'ready', availability: 'ready', activeRun: null },
    findings: [],
    vaultUnlocked: true,
    matterSelected: true,
  };
  const running = {
    ...base.assistant,
    phase: 'running' as const,
    orb: 'running' as const,
    activeRun: run(),
  };
  switch (name) {
    case 'idle':
      return base;
    case 'queued':
      return {
        ...base,
        assistant: { ...base.assistant, orb: 'queued', activeRun: run({ state: 'queued' }) },
      };
    case 'awaiting':
      return { ...base, assistant: { ...base.assistant, phase: 'preview' } };
    case 'running':
      return { ...base, assistant: running };
    case 'alert':
      // A nonblocking finding next to a running tool: two independent states at once.
      return { ...base, assistant: running, findings: FINDINGS };
    case 'stopping':
      return { ...base, assistant: { ...running, phase: 'stopping', orb: 'stopping' } };
    case 'offline':
      return {
        ...base,
        assistant: {
          phase: 'idle',
          orb: 'unavailable',
          availability: 'unreachable',
          activeRun: null,
        },
      };
    case 'stale':
      return {
        ...base,
        assistant: { ...running, activeRun: run({ lastEventAtMs: nowMs - 5 * 60_000 }) },
      };
    case 'locked':
      return {
        ...base,
        ceiling: {
          ...base.ceiling,
          vaultLabel: 'Locked',
          account: { ...base.ceiling.account, signing: 'locked' },
        },
        findings: FINDINGS,
        vaultUnlocked: false,
        matterSelected: false,
      };
    case 'pending':
      return {
        ...base,
        ceiling: { ...base.ceiling, transaction: { stage: 'pending', mayHaveBroadcast: true } },
      };
    case 'failed':
      return {
        ...base,
        assistant: {
          phase: 'idle',
          orb: 'failed',
          availability: 'ready',
          activeRun: run({
            state: 'failed',
            failureMessage: 'The payment check could not read the selected schedule.',
          }),
        },
      };
    case 'confirmed':
      return {
        ...base,
        ceiling: { ...base.ceiling, transaction: { stage: 'confirmed', mayHaveBroadcast: true } },
      };
  }
}
