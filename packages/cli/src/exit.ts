/** Process exit codes. They are command-specific in meaning; `--help` documents the precedence. */
export const EXIT = Object.freeze({
  /** verify: complete matching package and an active receipt. status: an active receipt only. */
  OK: 0,
  /** Invalid command or options, contradictory caller configuration, or an unreadable input path. */
  USAGE: 2,
  /** The supplied package fails full integrity or reference verification. */
  INTEGRITY: 10,
  REVOKED: 11,
  SUPERSEDED: 12,
  NOT_FOUND: 13,
  /** Registry or chain state cannot be trusted or obtained. */
  CHAIN_UNTRUSTED: 20,
  /** Interrupted by SIGINT or SIGTERM. A shell convention, not a verification result. */
  INTERRUPTED: 130,
} as const);
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export const EXIT_MEANING: Readonly<Record<ExitCode, string>> = Object.freeze({
  0: 'active',
  2: 'usage',
  10: 'integrity_failed',
  11: 'revoked',
  12: 'superseded',
  13: 'not_found',
  20: 'chain_untrusted',
  130: 'interrupted',
});

/** Stable codes the CLI itself adds. SDK and protocol codes are passed through unchanged. */
export const CLI_ERROR_CODES = [
  'USAGE_COMMAND_UNKNOWN',
  'USAGE_OPTION_UNKNOWN',
  'USAGE_OPTION_DUPLICATE',
  'USAGE_OPTION_MISSING_VALUE',
  'USAGE_ARGUMENT_MISSING',
  'USAGE_ARGUMENT_EXTRA',
  'USAGE_VALUE_INVALID',
  'USAGE_OPTION_REQUIRES',
  'CONFIG_CONTRADICTORY',
  'INPUT_UNREADABLE',
  'INPUT_NOT_A_REGULAR_FILE',
  'INPUT_TOO_LARGE',
  'RPC_ENDPOINT_INVALID',
  'DEPLOYMENT_FILE_INVALID',
  'DEPLOYMENT_PINS_MISSING',
  'RPC_NOT_CONFIGURED',
  'INTERRUPTED',
] as const;
export type CliErrorCode = (typeof CLI_ERROR_CODES)[number];
