/** Runs a pinned Foundry tool from the contracts directory: `tsx scripts/foundry.ts forge build`. */
import { spawnSync } from 'node:child_process';
import {
  contractsDir,
  isFoundryTool,
  resolveFoundryTool,
  ToolchainError,
  FOUNDRY_TOOLS,
} from './lib/toolchain';

const [tool, ...args] = process.argv.slice(2);
if (!isFoundryTool(tool)) {
  console.error(`usage: foundry.ts <${FOUNDRY_TOOLS.join('|')}> [arguments]`);
  process.exit(2);
}

try {
  const result = spawnSync(resolveFoundryTool(tool), args, { cwd: contractsDir, stdio: 'inherit' });
  process.exit(result.status ?? 1);
} catch (error) {
  if (!(error instanceof ToolchainError)) throw error;
  console.error(error.message);
  process.exit(1);
}
