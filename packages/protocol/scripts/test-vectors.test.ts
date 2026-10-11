import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ASSET_PATH, assetIsCurrent, buildAsset } from './test-vectors';

const committed = readFileSync(ASSET_PATH, 'utf8');

describe('published test-vector drift check', () => {
  it('the committed asset equals its independent sources', () => {
    expect(assetIsCurrent()).toBe(true);
    expect(committed).toBe(buildAsset());
  });

  const edits: readonly [string, (text: string) => string][] = [
    [
      'an edited expected canonical byte',
      (text) => text.replace('"canonicalUtf8Hex": "0x7b', '"canonicalUtf8Hex": "0x7c'),
    ],
    [
      'an edited package digest',
      (text) =>
        text.replace(
          '0x3cb09f7016731ab2f8277ae2f82ff0a482b083f2790ab914c7fb2b2c0e628d0b',
          '0x3cb09f7016731ab2f8277ae2f82ff0a482b083f2790ab914c7fb2b2c0e628d0c',
        ),
    ],
    [
      'an edited commitment',
      (text) =>
        text.replace(
          '0x62a213815169d89c876f46ec4ceeaa40eebe7003fbbec2709ece99fb8e761efa',
          '0x62a213815169d89c876f46ec4ceeaa40eebe7003fbbec2709ece99fb8e761efb',
        ),
    ],
    [
      'an edited expected error code',
      (text) => text.replace('"code": "DUPLICATE_KEY"', '"code": "INVALID_JSON"'),
    ],
    [
      'an edited domain separator',
      (text) => text.replace('lexaegis:review-package:v1', 'lexaegis:review-package:v2'),
    ],
  ];

  it.each(edits)('detects %s in a temporary copy', (_name, edit) => {
    const edited = edit(committed);
    expect(edited).not.toBe(committed);
    const directory = mkdtempSync(join(tmpdir(), 'vectors-'));
    try {
      const copy = join(directory, 'protocol-v1.json');
      writeFileSync(copy, edited);
      // The real read-only check command, pointed at the altered temporary copy.
      const run = spawnSync(
        'pnpm',
        ['exec', 'tsx', 'scripts/export-test-vectors.ts', '--check', '--asset', copy],
        { cwd: join(import.meta.dirname, '..'), encoding: 'utf8' },
      );
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('STALE');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
