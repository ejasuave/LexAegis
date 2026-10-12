/**
 * pnpm submission:package: copies only the intended public assets and form copy into
 * submission/upload/ with a hash manifest and a STATUS.txt listing every unresolved item.
 * It never includes secrets, auth state, internal evidence or recordings that do not exist.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ROOT } from './lib';

const FILES = [
  'submission/project.json',
  'submission/judge-guide.md',
  'submission/qwen-article.md',
  'submission/sponsor-evidence.json',
  'submission/technical-demo.md',
  'submission/pitch.md',
  'submission/assets/logo.png',
];
const out = join(ROOT, 'submission/upload');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const manifest: Record<string, string> = {};
for (const path of FILES) {
  copyFileSync(join(ROOT, path), join(out, basename(path)));
  manifest[basename(path)] = createHash('sha256')
    .update(readFileSync(join(ROOT, path)))
    .digest('hex');
}
writeFileSync(join(out, 'MANIFEST.sha256.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(
  join(out, 'STATUS.txt'),
  'NOT READY FOR SUBMISSION. Run `pnpm submission:validate` for the current unresolved items.\n' +
    'Known: no hosted application or verifier, repository private, videos not recorded, article unpublished, team facts and portal fields not supplied.\n',
);
console.log(`packaged ${String(FILES.length)} files into submission/upload`);
