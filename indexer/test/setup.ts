import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// createTestIndexer locates config.yaml from the working directory. The root vitest run starts
// in the repository root, so move into the indexer package first (requires the forks pool).
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
