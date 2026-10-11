import { z } from 'zod';

/*
 * What may leave the machine for explorer source verification: the registry's public Solidity
 * sources, the pinned OpenZeppelin sources they import, and the compiler settings. Nothing else.
 */

export const OUTGOING_SOURCE_PREFIXES = ['src/', 'node_modules/@openzeppelin/contracts/'] as const;
/** Standard-JSON settings keys the pinned Foundry writes. Any other key stops the submission. */
export const OUTGOING_SETTING_KEYS = [
  'remappings',
  'optimizer',
  'metadata',
  'outputSelection',
  'evmVersion',
  'viaIR',
  'viaSSACFG',
  'experimental',
  'libraries',
] as const;

const standardInputSchema = z.strictObject({
  language: z.literal('Solidity'),
  sources: z.record(z.string(), z.strictObject({ content: z.string() })),
  settings: z.record(z.string(), z.unknown()),
});
export type StandardInput = z.infer<typeof standardInputSchema>;

export interface OutgoingCheck {
  readonly ok: boolean;
  readonly issues: string[];
  readonly sources: { path: string; bytes: number }[];
  readonly settings: Record<string, unknown>;
}

/** Validates the exact payload preview against the allowlist. */
export function checkOutgoing(rawStandardInput: string): OutgoingCheck {
  const issues: string[] = [];
  let parsed: StandardInput;
  try {
    parsed = standardInputSchema.parse(JSON.parse(rawStandardInput));
  } catch {
    return { ok: false, issues: ['PAYLOAD_UNREADABLE'], sources: [], settings: {} };
  }
  const sources = Object.entries(parsed.sources).map(([path, { content }]) => ({
    path,
    bytes: new TextEncoder().encode(content).length,
  }));
  for (const { path } of sources) {
    const allowed =
      OUTGOING_SOURCE_PREFIXES.some((prefix) => path.startsWith(prefix)) &&
      path.endsWith('.sol') &&
      !path.includes('..') &&
      !/(^|\/)\.[^/]/.test(path);
    if (!allowed) issues.push(`SOURCE_NOT_ALLOWED ${path}`);
  }
  if (!sources.some(({ path }) => path === 'src/ProofOfReviewRegistry.sol'))
    issues.push('REGISTRY_SOURCE_MISSING');
  for (const key of Object.keys(parsed.settings)) {
    if (!(OUTGOING_SETTING_KEYS as readonly string[]).includes(key))
      issues.push(`SETTING_NOT_ALLOWED ${key}`);
  }
  return { ok: issues.length === 0, issues, sources, settings: parsed.settings };
}

/** Sourcify's status answer for one contract (API v2). `null` means it holds no verification. */
export const sourcifyStatusSchema = z.looseObject({
  match: z.string().nullable(),
  creationMatch: z.string().nullable(),
  runtimeMatch: z.string().nullable(),
  chainId: z.string(),
  address: z.string(),
  verifiedAt: z.string().optional(),
});
export type SourcifyStatus = z.infer<typeof sourcifyStatusSchema>;

export type ExplorerOutcome = 'verified' | 'not_verified' | 'pending' | 'unavailable';

/** "Submitted" or "accepted" is not verified: only a non-null match from the service is. */
export function explorerOutcome(
  status: SourcifyStatus | null,
  expected: { chainId: string; address: string },
): ExplorerOutcome {
  if (status === null) return 'unavailable';
  if (
    status.chainId !== expected.chainId ||
    status.address.toLowerCase() !== expected.address.toLowerCase()
  ) {
    return 'unavailable';
  }
  return status.match === null ? 'not_verified' : 'verified';
}
