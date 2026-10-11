/**
 * pnpm packages:build: compiles @lexaegis/protocol and @lexaegis/sdk to ESM JavaScript plus
 * declarations in each package's git-ignored dist directory. The sources use bundler-style
 * extensionless imports, so emitted relative specifiers are rewritten to explicit file paths and
 * the output runs under Node's ESM resolution. Imports no workspace package.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ROOT } from './lib';

export const BUILT_PACKAGES = ['protocol', 'sdk'] as const;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** Rewrites `./x` and `../x/y` to `./x.js` or `./x/index.js` using the emitted files. */
export function rewriteSpecifiers(text: string, file: string, extension: '.js' | '.d.ts'): string {
  const rewrite = (specifier: string): string => {
    if (!specifier.startsWith('.')) return specifier;
    const base = resolve(dirname(file), specifier);
    if (existsSync(`${base}${extension}`)) return `${specifier}.js`;
    if (existsSync(join(base, `index${extension}`)))
      return `${specifier.replace(/\/$/, '')}/index.js`;
    throw new Error(`cannot resolve ${specifier} from ${file}`);
  };
  return text.replace(
    /((?:from|import)\s*\(?\s*)(['"])(\.{1,2}\/[^'"]*)\2/g,
    (_match, lead: string, quote: string, specifier: string) =>
      `${lead}${quote}${rewrite(specifier)}${quote}`,
  );
}

export function buildPackage(name: (typeof BUILT_PACKAGES)[number]): void {
  const dir = join(ROOT, 'packages', name);
  rmSync(join(dir, 'dist'), { recursive: true, force: true });
  execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json'], {
    cwd: dir,
    stdio: 'inherit',
  });
  for (const file of files(join(dir, 'dist'))) {
    if (file.endsWith('.d.ts'))
      writeFileSync(file, rewriteSpecifiers(readFileSync(file, 'utf8'), file, '.d.ts'));
    else if (file.endsWith('.js'))
      writeFileSync(file, rewriteSpecifiers(readFileSync(file, 'utf8'), file, '.js'));
  }
}

if (process.argv[1]?.endsWith('build-packages.ts')) {
  for (const name of BUILT_PACKAGES) {
    buildPackage(name);
    console.log(`built packages/${name}/dist`);
  }
}
