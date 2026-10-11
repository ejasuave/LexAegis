import { useMemo } from 'react';

/** The public block explorer for the configured network, or null when none is configured. */
const DEFAULT_EXPLORER = 'https://testnet.monadvision.com';

export function usePublicExplorer(base?: string): string | null {
  return useMemo(() => base ?? DEFAULT_EXPLORER, [base]);
}
