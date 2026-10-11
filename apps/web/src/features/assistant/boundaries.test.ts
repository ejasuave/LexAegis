import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * The model proposes; code decides. Nothing on the assistant side may reach a human-approval,
 * decision, package, signing, transaction or voice controller. This scans the assistant's own
 * source, so a future import of one fails here before it can ship.
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const FORBIDDEN =
  /\b(ApprovalController|DecisionController|PackageController|TransactionController|VoiceController|ReadAloudController|bindReviewGate|takeAuthorisation|readVerifiedDecisionLog|reviewSigning|createReviewGateLatch)\b|features\/(review\/(approval|decisions|package)|transactions|voice)\b|features\/account\/(review-signing|registry-transaction-signing|session-controller)/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

describe('assistant boundary', () => {
  const files = [
    ...sources(join(root, 'features', 'assistant')),
    ...sources(join(root, 'components', 'assistant')),
  ].filter((file) => !file.endsWith('ReadAloud.tsx'));

  it('has source to check', () => {
    expect(files.length).toBeGreaterThan(8);
  });

  it('never imports or names an approval, decision, package, signing, transaction or voice controller', () => {
    const offenders = files.filter((file) => FORBIDDEN.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => file.slice(root.length))).toEqual([]);
  });

  it('the run card only renders a read-aloud control, which cannot act on anything', () => {
    const card = readFileSync(join(root, 'components', 'assistant', 'RunCard.tsx'), 'utf8');
    expect(card).toContain('ReadAloudButton');
    expect(card).not.toMatch(/useApproval|useTransaction|usePackage|useDecisions/);
  });
});
