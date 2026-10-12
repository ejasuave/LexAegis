/**
 * Post-build step: gives the emitted declarations explicit relative specifiers so they resolve under
 * Node-style module resolution as well as bundler resolution (the same rewrite `pnpm packages:build`
 * applies to the other packages). Runs on dist/types only.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const types = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'types');

for (const name of readdirSync(types).filter((entry) => entry.endsWith('.d.ts'))) {
  const file = join(types, name);
  const text = readFileSync(file, 'utf8').replace(
    /((?:from|import)\s*\(?\s*)(['"])(\.{1,2}\/[^'"]*)\2/g,
    (_match, lead: string, quote: string, specifier: string) => {
      if (/\.(?:js|json)$/.test(specifier)) return `${lead}${quote}${specifier}${quote}`;
      if (!existsSync(`${resolve(types, specifier)}.d.ts`))
        throw new Error(`cannot resolve ${specifier} from ${file}`);
      return `${lead}${quote}${specifier}.js${quote}`;
    },
  );
  writeFileSync(file, text);
}
