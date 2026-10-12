import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourceFingerprint } from './fingerprint';

describe('the source fingerprint', () => {
  it('follows source content, and ignores credentials files and generated build output', () => {
    const root = mkdtempSync(join(tmpdir(), 'fingerprint-'));
    try {
      mkdirSync(join(root, 'apps', 'web'), { recursive: true });
      writeFileSync(join(root, 'apps', 'web', 'page.ts'), 'export const a = 1;\n');
      const base = sourceFingerprint(root);
      // A local environment file (credentials) and generated output do not move the digest.
      writeFileSync(join(root, 'apps', 'web', '.env'), 'SECRET=one\n');
      writeFileSync(join(root, 'apps', 'web', '.env.local'), 'SECRET=two\n');
      mkdirSync(join(root, 'apps', 'web', '.next-hud-check'), { recursive: true });
      writeFileSync(join(root, 'apps', 'web', '.next-hud-check', 'chunk.js'), 'built');
      expect(sourceFingerprint(root)).toBe(base);
      // Real source does, and so does an example environment file that is committed.
      writeFileSync(join(root, 'apps', 'web', '.env.example'), 'SECRET=\n');
      const withExample = sourceFingerprint(root);
      expect(withExample).not.toBe(base);
      writeFileSync(join(root, 'apps', 'web', 'page.ts'), 'export const a = 2;\n');
      expect(sourceFingerprint(root)).not.toBe(withExample);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
