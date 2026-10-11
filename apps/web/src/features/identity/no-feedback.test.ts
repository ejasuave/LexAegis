import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FEATURE_READINESS } from '@/server/flags';

/*
 * The reputation-feedback stretch task was not elected, so nothing may write ERC-8004 feedback.
 * This guards the shipped runtime sources (web app, verifier, SDK, CLI) against a stray write path.
 */
const repo = fileURLToPath(new URL('../../../../..', import.meta.url));
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

describe('reputation feedback is cut, not stubbed', () => {
  it('the flag has no implementation, so no environment can enable it', () => {
    expect(FEATURE_READINESS.reputationFeedback).toEqual({ implemented: false, verified: false });
  });
  it('no runtime source can submit feedback, register, or call a write method of the registries', () => {
    const roots = [
      'apps/web/src',
      'apps/verifier/src',
      'packages/sdk/src/agent-identity',
      'packages/cli/src',
    ];
    for (const root of roots) {
      for (const file of sources(join(repo, root))) {
        const text = readFileSync(file, 'utf8');
        for (const forbidden of [
          /giveFeedback/,
          /feedbackURI/,
          /ERC8004_OPERATOR_KEY/,
          /\bsetAgentURI\b/,
          /functionName:\s*'register'/,
          /eth_sendRawTransaction|eth_sendTransaction|eth_sign/,
        ]) {
          expect(
            forbidden.test(text),
            `${file.slice(repo.length)} matches ${String(forbidden)}`,
          ).toBe(false);
        }
      }
    }
  });
});
