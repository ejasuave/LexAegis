import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REQUIRED_TAGS, checkSpec } from './spec-check';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const spec = readFileSync(join(root, 'docs', 'SPEC.md'), 'utf8');

/** Replaces exactly one occurrence, so a test cannot pass by editing nothing. */
function alter(text: string, from: string, to: string): string {
  const first = text.indexOf(from);
  expect(first, `fixture text not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(text.indexOf(from, first + 1), `ambiguous fixture text: ${from}`).toBe(-1);
  return text.replace(from, to);
}

const quick = (markdown: string) => checkSpec(markdown, { root, snippets: false });

describe('SPEC.md drift check', () => {
  it('passes for the committed specification', () => {
    expect(quick(spec)).toEqual([]);
  });

  it('requires every normative tag to exist', () => {
    expect(REQUIRED_TAGS.length).toBeGreaterThan(40);
    const findings = quick(spec.replaceAll('<!-- spec:literal PACKAGE_DOMAIN -->', ''));
    expect(findings.some((f) => f.tag === 'literal:PACKAGE_DOMAIN')).toBe(true);
  });

  const mutations: readonly [string, string, string][] = [
    [
      'an edited package domain string',
      '`lexaegis:review-package:v1` <!--',
      '`lexaegis:review-package:v2` <!--',
    ],
    [
      'an edited commitment domain string',
      '`lexaegis:review-commitment:v1` <!--',
      '`lexaegis:review-commit:v1` <!--',
    ],
    [
      'an edited EIP-712 domain name',
      '`LexAegisProofOfReview` <!--',
      '`LexAegisProofOfReviews` <!--',
    ],
    [
      'an edited EIP-712 type string',
      'bytes32 replacementCommitment,uint256 nonce,uint256 deadline)` <!-- spec:literal EIP712_TYPE_STRING',
      'bytes32 replacement,uint256 nonce,uint256 deadline)` <!-- spec:literal EIP712_TYPE_STRING',
    ],
    [
      'an edited type hash',
      '0x5b20b329d8da43817e3f621738bc7b1fd5fd495f2c79254b820be983b26e63fb',
      '0x5b20b329d8da43817e3f621738bc7b1fd5fd495f2c79254b820be983b26e63fc',
    ],
    [
      'an edited limit',
      '| `maxArtifacts`          | `128`      | artifacts',
      '| `maxArtifacts`          | `256`      | artifacts',
    ],
    [
      'an edited export limit',
      '| `maxEncodedBytes`       | `50331648` |',
      '| `maxEncodedBytes`       | `50331649` |',
    ],
    ['an edited live-budget limit', '| `totalMs`     | `20000` |', '| `totalMs`     | `30000` |'],
    [
      'an edited digest pattern',
      '`^0x[0-9a-f]{64}$` <!-- spec:pattern digest -->',
      '`^0x[0-9a-fA-F]{64}$` <!-- spec:pattern digest -->',
    ],
    ['swapped manifest fields', '| `packageId`  | `uuid`', '| `packageIdentifier`  | `uuid`'],
    [
      'swapped signed-field order',
      '| `nonce`                 | `uint256`     |\n| `deadline`              | `uint256`     |',
      '| `deadline`              | `uint256`     |\n| `nonce`                 | `uint256`     |',
    ],
    [
      'a wrong signed-field type',
      '| `action`                | `uint8`       |',
      '| `action`                | `uint256`     |',
    ],
    ['an edited action code', '| `REVOKE`    | `1`  |', '| `REVOKE`    | `3`  |'],
    ['a removed artifact role', '- `extracted-text`\n', ''],
    ['a changed lifecycle order', '- `Revoked`\n- `Superseded`', '- `Superseded`\n- `Revoked`'],
    ['a removed error code', '- `SCOPE_INCOMPLETE`\n', ''],
    ['an added RPC method', '- `eth_call`\n', '- `eth_call`\n- `eth_sendRawTransaction`\n'],
    ['an unknown source revision', 'source revision `b841626`', 'source revision `0123456`'],
  ];

  it.each(mutations)('detects %s in a temporary copy', (_name, from, to) => {
    const findings = quick(alter(spec, from, to));
    expect(findings.length).toBeGreaterThan(0);
  });

  it('does not rewrite or accept a stale copy by comparing it with itself', () => {
    // The same wrong value in the tag and in prose is still wrong: the source is the reference.
    const stale = alter(
      spec,
      '`lexaegis:review-package:v1` <!--',
      '`lexaegis:review-package:v0` <!--',
    );
    expect(quick(stale).some((f) => f.message.includes('lexaegis:review-package:v1'))).toBe(true);
  });

  it('detects a stale executable snippet', { timeout: 180_000 }, () => {
    expect(checkSpec(spec, { root, snippets: true })).toEqual([]);
    const stale = alter(
      spec,
      "  hex(packageDigest),\n  '0x3cb09f7016731ab2f8277ae2f82ff0a482b083f2790ab914c7fb2b2c0e628d0b',",
      "  hex(packageDigest),\n  '0x3cb09f7016731ab2f8277ae2f82ff0a482b083f2790ab914c7fb2b2c0e628d0c',",
    );
    const findings = checkSpec(stale, { root, snippets: true });
    expect(findings.some((f) => f.tag.startsWith('snippet:reproduce-generic'))).toBe(true);
  });
});
