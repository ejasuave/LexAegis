import { describe, expect, it, vi } from 'vitest';
import { AgentIdentityController } from './controller';
import { describeView, toView, type IdentityPayload } from './describe';

const REGISTRY = '0x8004a818bfb912233c491871b3d84c89a494bd9e';
const hash = `0x${'7'.repeat(64)}`;
const resolution = (over: Record<string, unknown> = {}) => ({
  schema: 'lexaegis.agent-identity-resolution.v1',
  status: 'registered',
  reason: 'REGISTERED',
  generation: 0,
  observedAt: '2026-10-11T12:00:00.000Z',
  reference: {
    standard: 'erc-8004',
    chainId: '10143',
    identityRegistry: REGISTRY,
    agentId: '7',
    cardUri: 'https://app.example.test/api/agent-card',
  },
  checkpoint: { chainId: '10143', blockNumber: '97', blockHash: hash },
  registry: { codeKeccak256: hash, implementation: null, version: '2.0.0' },
  agent: {
    owner: `0x${'22'.repeat(20)}`,
    uri: {
      captured: 'https://app.example.test/api/agent-card',
      current: 'https://app.example.test/api/agent-card',
      changed: false,
      transport: 'https',
    },
  },
  ...over,
});
const payload = (over: Record<string, unknown> = {}) =>
  ({ configured: true, resolution: resolution(over) }) as IdentityPayload;

describe('identity line wording', () => {
  it('registered carries agent, registry, network and checkpoint, and claims no verification', () => {
    const view = toView(payload());
    expect(view).toMatchObject({
      kind: 'registered',
      agentId: '7',
      blockNumber: '97',
      cardLink: 'https://app.example.test/api/agent-card',
    });
    const text = describeView(view);
    expect(text.headline).toBe('Registered: agent 7');
    expect(text.detail).toContain('Monad testnet');
    expect(text.detail).toContain('not a verification');
    expect(`${text.headline} ${text.detail}`).not.toMatch(
      /verified assistant|licensed|legally reliable|qualified\b(?! )/i,
    );
  });
  it('no configured registration and a proven nonexistent agent are Not registered, with distinct reasons', () => {
    expect(toView({ configured: false, reason: 'NO_REGISTRATION_CONFIGURED' })).toEqual({
      kind: 'not_registered',
      reason: 'NO_REGISTRATION_CONFIGURED',
    });
    expect(toView(payload({ status: 'notFound', reason: 'AGENT_NOT_FOUND', agent: null }))).toEqual(
      { kind: 'not_registered', reason: 'AGENT_NOT_FOUND' },
    );
    expect(describeView({ kind: 'not_registered', reason: 'AGENT_NOT_FOUND' }).headline).toBe(
      'Not registered',
    );
  });
  it('a demonstrably missing dependency is unavailable; RPC trouble is unknown, never "absent"', () => {
    for (const reason of ['REGISTRY_CODE_MISSING', 'ABI_UNSUPPORTED', 'NETWORK_NOT_CONFIGURED']) {
      const view = toView(
        payload({ status: 'unavailable', reason, agent: null, checkpoint: null }),
      );
      expect(view.kind).toBe('unavailable');
      expect(describeView(view).headline).toBe('Agent identity unavailable on this network');
    }
    for (const reason of ['RPC_UNAVAILABLE', 'BUDGET_EXHAUSTED', 'BLOCK_CHANGED', 'ABORTED']) {
      const view = toView(
        payload({ status: 'unavailable', reason, agent: null, checkpoint: null }),
      );
      expect(view.kind).toBe('unknown');
      expect(describeView(view).headline).toBe('Unable to check agent identity');
      expect(describeView(view).detail).toContain('does not mean the agent is unregistered');
    }
  });
  it('a changed URI is shown, and a non-https or credentialed URI never becomes a link', () => {
    const changed = toView(
      payload({
        agent: {
          owner: `0x${'22'.repeat(20)}`,
          uri: { captured: 'x', current: 'ipfs://bafy', changed: true, transport: 'unsupported' },
        },
      }),
    );
    expect(changed).toMatchObject({ kind: 'registered', cardLink: null, uriChanged: true });
    expect(describeView(changed).detail).toContain('differs');
  });
});

describe('AgentIdentityController', () => {
  const ok = () => Promise.resolve({ configured: false, reason: 'NO_REGISTRATION_CONFIGURED' });
  it('makes no request and stays off when the feature is off', async () => {
    const fetchSpy = vi.fn(ok);
    const controller = new AgentIdentityController({ enabled: false, fetch: fetchSpy });
    await controller.inspect();
    controller.invalidate();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe('off');
  });
  it('reads only on an explicit inspection: checking first, then the answer, with no polling', async () => {
    const fetchSpy = vi.fn(ok);
    const controller = new AgentIdentityController({ enabled: true, fetch: fetchSpy });
    expect(controller.getSnapshot().phase).toBe('idle');
    expect(fetchSpy).not.toHaveBeenCalled();
    const phases: string[] = [];
    controller.subscribe(() => phases.push(controller.getSnapshot().phase));
    await controller.inspect();
    expect(phases).toEqual(['checking', 'done']);
    expect(controller.getSnapshot().view).toEqual({
      kind: 'not_registered',
      reason: 'NO_REGISTRATION_CONFIGURED',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it('discards a stale answer after invalidation (lock, matter change, unmount) and never reuses a success', async () => {
    let release: (value: unknown) => void = () => undefined;
    const slow = new AgentIdentityController({
      enabled: true,
      fetch: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const pending = slow.inspect();
    expect(slow.getSnapshot().phase).toBe('checking');
    slow.invalidate();
    release(payload());
    await pending;
    expect(slow.getSnapshot()).toMatchObject({ phase: 'idle', view: null });
    const done = new AgentIdentityController({
      enabled: true,
      fetch: () => Promise.resolve(payload()),
    });
    await done.inspect();
    expect(done.getSnapshot().view?.kind).toBe('registered');
    done.invalidate();
    expect(done.getSnapshot().view).toBeNull(); // the earlier success is not current evidence
  });
  it('a failing, aborted or malformed read is unknown, not unregistered', async () => {
    for (const fetchFn of [
      () => Promise.reject(new Error('x')),
      () => Promise.resolve({ nonsense: true }),
    ]) {
      const controller = new AgentIdentityController({ enabled: true, fetch: fetchFn });
      await controller.inspect();
      expect(controller.getSnapshot().view?.kind).toBe('unknown');
    }
  });
});
