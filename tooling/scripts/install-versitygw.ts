/**
 * Installs the pinned VersityGW release into the git-ignored .tools directory, accepting the
 * archive only if its SHA-256 equals the value committed in tooling/toolchain.json.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ROOT } from './lib';

const platforms = ['linux_x86_64', 'linux_arm64', 'darwin_x86_64', 'darwin_arm64'] as const;
const schema = z.strictObject({
  versitygw: z.strictObject({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    purpose: z.string(),
    archiveSha256: z.strictObject(
      Object.fromEntries(platforms.map((p) => [p, z.string().regex(/^[0-9a-f]{64}$/)])) as Record<
        (typeof platforms)[number],
        z.ZodString
      >,
    ),
  }),
});
const { versitygw } = schema.parse(
  JSON.parse(readFileSync(join(ROOT, 'tooling', 'toolchain.json'), 'utf8')),
);

export const versitygwBinary = join(
  ROOT,
  '.tools',
  'versitygw',
  `v${versitygw.version}`,
  'versitygw',
);

function platform(): (typeof platforms)[number] {
  const os =
    process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'arm64' : null;
  const key = `${String(os)}_${String(arch)}`;
  const found = platforms.find((p) => p === key);
  if (found === undefined) throw new Error(`No pinned VersityGW archive for ${key}.`);
  return found;
}

if (existsSync(versitygwBinary)) {
  console.log(`VersityGW ${versitygw.version} is already installed`);
} else {
  const key = platform();
  const os = key.startsWith('darwin') ? 'Darwin' : 'Linux';
  const arch = key.endsWith('arm64') ? 'arm64' : 'x86_64';
  const name = `versitygw_v${versitygw.version}_${os}_${arch}`;
  const url = `https://github.com/versity/versitygw/releases/download/v${versitygw.version}/${name}.tar.gz`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed with HTTP ${String(response.status)}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(archive).digest('hex');
  if (digest !== versitygw.archiveSha256[key]) {
    throw new Error(`Checksum mismatch for ${name}: got ${digest}. Nothing was installed.`);
  }
  const target = join(ROOT, '.tools', 'versitygw', `v${versitygw.version}`);
  const staging = `${target}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const archivePath = join(staging, 'archive.tar.gz');
  writeFileSync(archivePath, archive);
  execFileSync('tar', ['-xzf', archivePath, '-C', staging, '--strip-components=1']);
  rmSync(archivePath);
  chmodSync(join(staging, 'versitygw'), 0o755);
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  console.log(`Installed VersityGW ${versitygw.version} (${key}) in ${target}`);
}
