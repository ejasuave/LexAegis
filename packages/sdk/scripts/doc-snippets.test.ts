import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { markdownFences, sdkSourceFiles, tsdocExamples, typecheckSnippets } from './doc-snippets';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(packageDir, 'src');
const temp = join(packageDir, '.doc-snippets-test');

/** Exported but not part of the documented public surface. */
const INTERNAL = new Set(['succeed', 'failWith', 'freezeResult']);

describe('SDK documentation examples', () => {
  const files = sdkSourceFiles(sourceDir);

  it('every public function carries a TSDoc @example', () => {
    const missing: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/^export (?:async )?function (\w+)/gm)) {
        const name = match[1] ?? '';
        if (INTERNAL.has(name)) continue;
        const before = text.slice(0, match.index);
        const start = before.lastIndexOf('/**');
        const end = before.indexOf('*/', start);
        const doc = start !== -1 && before.slice(end + 2).trim() === '' ? before.slice(start) : '';
        if (!doc.includes('@example')) missing.push(`${file.replace(packageDir, '')}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every example type-checks against the public entry points', { timeout: 180_000 }, () => {
    const snippets = files.flatMap((file) => tsdocExamples(file, packageDir));
    expect(snippets.length).toBeGreaterThan(40);
    expect(typecheckSnippets(snippets, temp)).toEqual([]);
  });

  it(
    'every TypeScript fence in the README type-checks against the public entry points',
    { timeout: 180_000 },
    () => {
      const fences = markdownFences(join(packageDir, 'README.md'), packageDir);
      expect(fences.length).toBeGreaterThanOrEqual(2);
      expect(typecheckSnippets(fences, temp)).toEqual([]);
    },
  );

  it('a wrong example is reported with its origin (negative control)', { timeout: 120_000 }, () => {
    const failures = typecheckSnippets(
      [
        {
          origin: 'bad example',
          code: "import { noSuchExport } from '@lexaegis/sdk';\nconsole.log(noSuchExport);\n",
        },
        {
          origin: 'good example',
          code: "import { parseReviewExport } from '@lexaegis/sdk';\nconsole.log(parseReviewExport);\n",
        },
      ],
      temp,
    );
    expect(failures.map((failure) => failure.origin)).toEqual(['bad example']);
  });
});
