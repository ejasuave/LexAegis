/**
 * Type-checks the documentation examples against the public entry points: every `@example` block in
 * the SDK sources and every tagged ```ts fence in Markdown. It writes nothing outside a temporary
 * directory under the package, and removes it afterwards.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface Snippet {
  /** Where it came from, for the failure message. */
  readonly origin: string;
  readonly code: string;
}

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** Public SDK sources: no tests, no generated ABI, no test helpers. */
export function sdkSourceFiles(sourceDirectory: string): string[] {
  return [...walk(sourceDirectory)].filter(
    (file) =>
      file.endsWith('.ts') &&
      !file.endsWith('.test.ts') &&
      !file.includes(`/generated/`) &&
      !file.endsWith('test-helpers.ts'),
  );
}

/** Every ```ts fence inside an `@example` tag of a TSDoc comment. */
export function tsdocExamples(file: string, root: string): Snippet[] {
  const text = readFileSync(file, 'utf8');
  const out: Snippet[] = [];
  for (const comment of text.matchAll(/\/\*\*([\s\S]*?)\*\//g)) {
    const body = (comment[1] ?? '')
      .split('\n')
      .map((line) => line.replace(/^\s*\* ?/, ''))
      .join('\n');
    if (!body.includes('@example')) continue;
    let index = 0;
    for (const fence of body.matchAll(/```ts\n([\s\S]*?)```/g)) {
      index += 1;
      out.push({
        origin: `${relative(root, file)} example ${String(index)}`,
        code: fence[1] ?? '',
      });
    }
  }
  return out;
}

/** ```ts fences of a Markdown file whose info string is exactly "ts" (others are not checked). */
export function markdownFences(file: string, root: string): Snippet[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/^```ts\n([\s\S]*?)^```/gm)].map((match, index) => ({
    origin: `${relative(root, file)} fence ${String(index + 1)}`,
    code: match[1] ?? '',
  }));
}

/** Compiles the snippets as ES modules against the package's own entry points. */
export function typecheckSnippets(
  snippets: readonly Snippet[],
  directory: string,
): { origin: string; message: string }[] {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        extends: '../tsconfig.json',
        compilerOptions: { noEmit: true, types: ['node'], noUnusedLocals: false },
        include: ['*.ts'],
      }),
    );
    snippets.forEach((snippet, index) => {
      writeFileSync(join(directory, `snippet-${String(index).padStart(3, '0')}.ts`), snippet.code);
    });
    const run = spawnSync('pnpm', ['exec', 'tsc', '--noEmit', '-p', directory], {
      encoding: 'utf8',
    });
    if (run.status === 0) return [];
    const failures: { origin: string; message: string }[] = [];
    for (const line of run.stdout.split('\n')) {
      const match = /snippet-(\d{3})\.ts\((\d+),\d+\): (error .*)/.exec(line);
      if (match === null) continue;
      const snippet = snippets[Number(match[1])];
      failures.push({
        origin: snippet?.origin ?? 'unknown',
        message: `line ${match[2] ?? '?'}: ${match[3] ?? ''}`,
      });
    }
    return failures.length > 0
      ? failures
      : [{ origin: 'tsc', message: run.stdout.split('\n').slice(0, 4).join(' | ') }];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
