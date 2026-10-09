/**
 * Installs the pinned Foundry release into the git-ignored .tools directory. The archive is
 * accepted only when its SHA-256 equals the value committed in toolchain.json. Nothing outside
 * the repository is modified.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FOUNDRY_TOOLS,
  localToolchainDir,
  readToolchain,
  reportedBuild,
  type FoundryPlatform,
} from './lib/toolchain';

function currentPlatform(): FoundryPlatform {
  const key = `${process.platform}_${process.arch === 'x64' ? 'amd64' : process.arch}`;
  if (
    key === 'linux_amd64' ||
    key === 'linux_arm64' ||
    key === 'darwin_amd64' ||
    key === 'darwin_arm64'
  ) {
    return key;
  }
  throw new Error(`No pinned Foundry archive for ${key}.`);
}

const { foundry } = readToolchain();
const target = localToolchainDir(foundry.version);

function installed(): boolean {
  return FOUNDRY_TOOLS.every((tool) => {
    const build = reportedBuild(join(target, tool));
    return build?.version === foundry.version && build.commit === foundry.commit;
  });
}

if (installed()) {
  console.log(`Foundry ${foundry.version} is already installed in ${target}`);
} else {
  const platform = currentPlatform();
  const name = `foundry_v${foundry.version}_${platform}.tar.gz`;
  const url = `https://github.com/foundry-rs/foundry/releases/download/v${foundry.version}/${name}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(archive).digest('hex');
  if (digest !== foundry.archiveSha256[platform]) {
    throw new Error(`Checksum mismatch for ${name}: got ${digest}. Nothing was installed.`);
  }
  mkdirSync(target, { recursive: true });
  const archivePath = join(target, name);
  writeFileSync(archivePath, archive);
  try {
    execFileSync('tar', ['-xzf', archivePath, '-C', target], { stdio: 'inherit' });
  } finally {
    rmSync(archivePath, { force: true });
  }
  if (!installed()) throw new Error(`Installed binaries do not report Foundry ${foundry.version}.`);
  console.log(`Installed Foundry ${foundry.version} (${platform}) in ${target}`);
}
