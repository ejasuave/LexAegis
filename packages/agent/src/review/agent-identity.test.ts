import { describe, expect, it } from 'vitest';
import {
  agentConfigAnySchema,
  agentConfigSchema,
  agentIdentityRefSchema,
  producibleAgentIdentitySchema,
} from '../contracts';
import { agentConfigArtifactBytes, localAgentConfig, withAgentIdentity } from './agent-artifacts';

const reference = {
  standard: 'erc-8004',
  chainId: '10143',
  identityRegistry: '0x8004a818bfb912233c491871b3d84c89a494bd9e',
  agentId: '0',
  cardUri: 'https://lexaegis.example.test/.well-known/agent-card.json',
} as const;
const base = localAgentConfig({
  viewId: '11111111-1111-4111-8111-111111111111',
  intent: 'status',
  startedAt: '2026-10-11T10:00:00.000Z',
  finishedAt: '2026-10-11T10:00:01.000Z',
  toolExecutions: 1,
});

describe('optional agentIdentity in the agent-configuration artifact', () => {
  it('v1 artifacts and their exact bytes are unchanged and still parse', async () => {
    const first = await agentConfigArtifactBytes(base);
    expect(base.schema).toBe('lexaegis.agent-config.v1');
    expect(agentConfigAnySchema.parse(JSON.parse(new TextDecoder().decode(first.bytes)))).toEqual(
      base,
    );
    expect(new TextDecoder().decode(first.bytes)).not.toContain('agentIdentity');
    expect((await agentConfigArtifactBytes(base)).sha256).toBe(first.sha256);
  });

  it('a new reference serialises losslessly, including agentId zero and a 2^256-1 identifier', async () => {
    for (const agentId of [
      '0',
      '1',
      '340282366920938463463374607431768211456',
      (2n ** 256n - 1n).toString(),
    ]) {
      const config = withAgentIdentity(base, { ...reference, agentId });
      const { bytes } = await agentConfigArtifactBytes(config);
      const decoded = agentConfigAnySchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
      expect(decoded.schema === 'lexaegis.agent-config.v2' && decoded.agentIdentity?.agentId).toBe(
        agentId,
      );
    }
  });

  it('adding or changing the identity changes the artifact digest (it is committed with the artifact)', async () => {
    const plain = await agentConfigArtifactBytes(base);
    const one = await agentConfigArtifactBytes(withAgentIdentity(base, reference));
    const other = await agentConfigArtifactBytes(
      withAgentIdentity(base, { ...reference, agentId: '1' }),
    );
    const uri = await agentConfigArtifactBytes(
      withAgentIdentity(base, {
        ...reference,
        cardUri: 'https://lexaegis.example.test/other.json',
      }),
    );
    expect(new Set([plain.sha256, one.sha256, other.sha256, uri.sha256]).size).toBe(4);
  });

  it('rejects malformed references and keeps v1 closed', () => {
    const bad: Record<string, unknown>[] = [
      { ...reference, standard: 'erc-721' },
      { ...reference, chainId: '0' },
      { ...reference, identityRegistry: `0x${'00'.repeat(20)}` },
      { ...reference, identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e' },
      { ...reference, agentId: 7 },
      { ...reference, agentId: '007' },
      { ...reference, agentId: (2n ** 256n).toString() },
      { ...reference, cardUri: 'http://lexaegis.example.test/card.json' },
      {
        ...reference,
        cardUri: ['https://user', 'pw'].join(':') + '@lexaegis.example.test/card.json',
      },
      { ...reference, cardUri: 'https://lexaegis.example.test/card.json?matter=1' },
      { ...reference, cardUri: 'https://lexaegis.example.test/card.json#x' },
      { ...reference, cardUri: 'ipfs://bafy' },
      { ...reference, cardUri: `https://lexaegis.example.test/${'a'.repeat(600)}` },
      { ...reference, extra: 'x' },
    ];
    for (const value of bad)
      expect(
        agentIdentityRefSchema.safeParse(value).success,
        JSON.stringify(value).slice(0, 80),
      ).toBe(false);
    expect(agentConfigSchema.safeParse({ ...base, agentIdentity: reference }).success).toBe(false);
    expect(
      agentConfigAnySchema.safeParse({ ...base, schema: 'lexaegis.agent-config.v3' }).success,
    ).toBe(false);
  });

  it('a producer refuses a reference for another network', async () => {
    const mainnet = { ...reference, chainId: '143' };
    expect(agentIdentityRefSchema.safeParse(mainnet).success).toBe(true); // readable if it exists...
    expect(producibleAgentIdentitySchema.safeParse(mainnet).success).toBe(false); // ...never produced
    expect(() => withAgentIdentity(base, mainnet)).toThrow();
    await expect(
      agentConfigArtifactBytes({
        ...agentConfigAnySchema.parse(withAgentIdentity(base, reference)),
        agentIdentity: mainnet,
      } as never),
    ).rejects.toThrow();
  });

  it('a reference cannot be added to an existing frozen artifact: its bytes and digest stay what they were', async () => {
    const frozen = await agentConfigArtifactBytes(base);
    withAgentIdentity(base, reference);
    expect((await agentConfigArtifactBytes(base)).sha256).toBe(frozen.sha256);
  });
});
