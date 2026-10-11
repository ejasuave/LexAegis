import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { findCanaries, type Canary } from './canary';

/*
 * Production-asset checks: what a visitor's browser can download (client bundles, emitted HTML,
 * reachable source maps, packed browser entry points) and, separately, what the server bundle has
 * baked into it as a literal.
 *
 * A 32-byte hex value in a bundle is not automatically a secret: curve parameters, type hashes,
 * public salts and deployment identifiers are public. Each candidate must be CLASSIFIED against a
 * named public source. One that cannot be classified is reported; nothing is waved through by
 * directory, and not every hash is treated as a leak.
 */

export interface AssetFile {
  readonly name: string;
  readonly text: string;
}

export interface AssetFinding {
  readonly file: string;
  readonly rule:
    | 'SERVER_ENV_NAME'
    | 'SERVER_ONLY_MODULE'
    | 'CANARY_VALUE'
    | 'PRIVATE_FIXTURE'
    | 'KEY_MATERIAL_SHAPE'
    | 'UNCLASSIFIED_KEY_SHAPED';
  /** A name, a canary ID or a short prefix of a public-looking candidate. Never a secret value. */
  readonly detail: string;
}

export function readAssets(
  root: string,
  extensions: readonly string[],
  maxBytes = 30 * 1024 * 1024,
): AssetFile[] {
  const out: AssetFile[] = [];
  const walk = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (
        entry.isFile() &&
        extensions.some((extension) => entry.name.endsWith(extension)) &&
        statSync(path).size <= maxBytes
      ) {
        out.push({
          name: relative(root, path).split(sep).join('/'),
          text: readFileSync(path, 'utf8'),
        });
      }
    }
  };
  walk(root);
  return out;
}

/** 32-byte values written as 64 hex digits, optionally 0x-prefixed, not part of a longer run. */
export function keyShapedCandidates(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?<![0-9a-fA-F])(?:0x)?([0-9a-fA-F]{64})(?![0-9a-fA-F])/g)) {
    found.add((match[1] ?? '').toLowerCase());
  }
  return [...found].sort();
}

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values())
    bits -= (count / value.length) * Math.log2(count / value.length);
  return bits;
}

export interface PublicSource {
  /** Shown in the report, for example "dependency @noble/curves" or "docs/SPEC.md". */
  readonly label: string;
  /** Lowercased text of the source. */
  readonly text: string;
}

/**
 * Says why a candidate is public, or returns null. Order: obviously not key material (digits only,
 * or a low-entropy pattern), then a named public source that contains the same value.
 */
export function classifyCandidate(
  candidate: string,
  sources: readonly PublicSource[],
): string | null {
  if (/^[0-9]+$/.test(candidate)) return 'not_key_material: decimal digits only';
  if (entropy(candidate) < 3) return 'not_key_material: low-entropy pattern';
  for (const source of sources) {
    if (source.text.includes(candidate)) return `public: ${source.label}`;
  }
  return null;
}

/** Private keys and bearer tokens by shape, whatever their value. */
const KEY_MATERIAL = [
  { name: 'PEM private key', pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { name: 'provider API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  {
    name: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  {
    name: 'credential in a URL',
    pattern:
      /[a-z][a-z0-9+.-]*:\/\/[^\s/@:"'`]+:[^\s/@"'`]+@(?!127\.0\.0\.1|localhost)[a-z0-9.-]+/i,
  },
] as const;

export interface BrowserAssetOptions {
  /** Names of server-only environment variables. A browser asset must not even name one. */
  readonly serverEnvNames: readonly string[];
  readonly canaries: readonly Canary[];
  /** Text that exists only in private test fixtures (file names, synthetic party names). */
  readonly privateFixtureMarkers: readonly string[];
  readonly publicSources: readonly PublicSource[];
}

/** Everything a browser can download: stricter than the server scan. */
export function scanBrowserAssets(
  files: readonly AssetFile[],
  options: BrowserAssetOptions,
): { findings: AssetFinding[]; classified: { candidate: string; reason: string }[] } {
  const findings: AssetFinding[] = [];
  const classified = new Map<string, string>();
  for (const file of files) {
    for (const name of options.serverEnvNames) {
      if (new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(file.text)) {
        findings.push({ file: file.name, rule: 'SERVER_ENV_NAME', detail: name });
      }
    }
    if (/["'`]server-only["'`]|(?:^|[\\/"'`])src[\\/]server[\\/]/.test(file.text)) {
      findings.push({
        file: file.name,
        rule: 'SERVER_ONLY_MODULE',
        detail: 'server-only marker or src/server path',
      });
    }
    for (const hit of findCanaries(file.text, options.canaries)) {
      findings.push({
        file: file.name,
        rule: 'CANARY_VALUE',
        detail: `${hit.class} ${hit.id} (${hit.encoding})`,
      });
    }
    const lower = file.text.toLowerCase();
    for (const marker of options.privateFixtureMarkers) {
      if (lower.includes(marker.toLowerCase()))
        findings.push({ file: file.name, rule: 'PRIVATE_FIXTURE', detail: marker });
    }
    for (const { name, pattern } of KEY_MATERIAL) {
      if (pattern.test(file.text))
        findings.push({ file: file.name, rule: 'KEY_MATERIAL_SHAPE', detail: name });
    }
    for (const candidate of keyShapedCandidates(file.text)) {
      const reason = classifyCandidate(candidate, options.publicSources);
      if (reason === null) {
        findings.push({
          file: file.name,
          rule: 'UNCLASSIFIED_KEY_SHAPED',
          detail: `${candidate.slice(0, 8)}… (64 hex digits)`,
        });
      } else {
        classified.set(candidate, reason);
      }
    }
  }
  return {
    findings,
    classified: [...classified].map(([candidate, reason]) => ({
      candidate: `${candidate.slice(0, 8)}…`,
      reason,
    })),
  };
}

/**
 * The server bundle legitimately READS its configuration at run time, so naming an environment
 * variable there is not a leak. A literal secret VALUE compiled into it is.
 */
export function scanServerAssets(
  files: readonly AssetFile[],
  canaries: readonly Canary[],
): AssetFinding[] {
  const findings: AssetFinding[] = [];
  for (const file of files) {
    for (const hit of findCanaries(file.text, canaries)) {
      findings.push({
        file: file.name,
        rule: 'CANARY_VALUE',
        detail: `${hit.class} ${hit.id} (${hit.encoding})`,
      });
    }
    for (const { name, pattern } of KEY_MATERIAL) {
      if (name !== 'credential in a URL' && pattern.test(file.text)) {
        findings.push({ file: file.name, rule: 'KEY_MATERIAL_SHAPE', detail: name });
      }
    }
  }
  return findings;
}
