/**
 * Programmatic entry for the proof-of-review command. Prefer the `proof-of-review` binary; this
 * is for tests and tools that need the exit code and the structured result without a process.
 */
export { runCli, type Io } from './cli.js';
export { EXIT, EXIT_MEANING, CLI_ERROR_CODES, type CliErrorCode, type ExitCode } from './exit.js';
export { RESULT_SCHEMA, type CliResult, type PublicReport } from './output.js';
