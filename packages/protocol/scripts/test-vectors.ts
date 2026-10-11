/**
 * Builds the language-neutral Proof of Review test-vector asset (packages/protocol/test-vectors)
 * from its two independent sources. Used by export-test-vectors.ts and its tests.
 *
 * The asset is assembled only from two independently generated files and imports no protocol code:
 *   - fixtures/protocol-v1/vectors.json          the original Chapter 2 goldens (copied verbatim)
 *   - fixtures/protocol-interop-v1/cases.json    supplemental cases with authored expectations
 * Nothing here computes an expected value, so nothing can be regenerated from the function under
 * test. A check that finds a difference fails; it never overwrites the asset.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const ASSET_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'test-vectors',
  'protocol-v1.json',
);
const ORIGINAL = 'fixtures/protocol-v1/vectors.json';
const SUPPLEMENTAL = 'fixtures/protocol-interop-v1/cases.json';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const readText = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

interface Original {
  domains: unknown;
  cases: unknown[];
}
interface Supplemental {
  cases: unknown[];
}

export function buildAsset(): string {
  const originalText = readText(ORIGINAL);
  const supplementalText = readText(SUPPLEMENTAL);
  const original = JSON.parse(originalText) as Original;
  const supplemental = JSON.parse(supplementalText) as Supplemental;
  const asset = {
    $comment:
      'SYNTHETIC, PUBLIC Proof of Review protocol v1 interoperability vectors. Test-only: every address, document, decision and opening nonce is fictional or fixed for reproducibility and none may be used in production. Contains no keys, signatures or provider data. Do not edit by hand: it is exported from the two sources named in `sources`.',
    format: 'lexaegis.protocol-test-vectors/1',
    protocolVersion: '1',
    domains: original.domains,
    sources: {
      [ORIGINAL]: {
        sha256: sha256(originalText),
        role: 'original independently generated goldens',
      },
      [SUPPLEMENTAL]: {
        sha256: sha256(supplementalText),
        role: 'supplemental cases with authored expected outcomes',
      },
    },
    /** The original Chapter 2 cases, byte-for-byte as generated. */
    goldens: original.cases,
    /** Operation cases: positive derivations, canonicalization properties and negative inputs. */
    cases: supplemental.cases,
  };
  return `${JSON.stringify(asset, null, 2)}\n`;
}

/** True when the asset at `path` (default: the committed one) equals the freshly derived one, byte for byte. */
export function assetIsCurrent(path: string = ASSET_PATH): boolean {
  let actual: string;
  try {
    actual = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  return actual === buildAsset();
}
