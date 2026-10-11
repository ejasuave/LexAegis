import { readFileSync } from 'node:fs';
import { parseArguments } from './args.js';
import { runStatus, runVerify, type Environment } from './commands.js';
import { CLI_ERROR_CODES, EXIT, type ExitCode } from './exit.js';
import { HELP } from './help.js';
import { escapeText, formatJson, formatText, type CliResult } from './output.js';

export interface Io {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly signal: AbortSignal;
  readonly fetch?: Environment['fetch'];
  readonly now?: Environment['now'];
}

function version(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Runs one command line and returns its exit code. It writes only through `io`, never exits the
 * process itself and never reads a key, signs, or sends anything other than the read-only RPC
 * calls the SDK documents.
 */
export async function runCli(argv: readonly string[], io: Io): Promise<ExitCode> {
  const parsed = parseArguments(argv);
  const emit = (result: CliResult, json: boolean): ExitCode => {
    io.stdout(json ? formatJson(result) : formatText(result));
    return result.exit;
  };
  switch (parsed.kind) {
    case 'help':
      io.stdout(HELP);
      return EXIT.OK;
    case 'version':
      io.stdout(`${version()}\n`);
      return EXIT.OK;
    case 'usage-error': {
      const result: CliResult = {
        command: 'none',
        exit: EXIT.USAGE,
        filesEvaluated: false,
        report: null,
        rpcSource: null,
        notes: [],
        error: {
          source: 'cli',
          code: parsed.error.code,
          ...(parsed.error.subject !== undefined && { subject: parsed.error.subject }),
        },
      };
      if (parsed.json) return emit(result, true);
      io.stderr(
        `error: ${escapeText(parsed.error.code)}${
          parsed.error.subject === undefined ? '' : ` (${escapeText(parsed.error.subject)})`
        }\nRun "proof-of-review --help" for usage.\n`,
      );
      return EXIT.USAGE;
    }
    case 'verify':
    case 'status': {
      const environment: Environment = {
        env: io.env,
        signal: io.signal,
        ...(io.fetch !== undefined && { fetch: io.fetch }),
        ...(io.now !== undefined && { now: io.now }),
      };
      const result =
        parsed.kind === 'verify'
          ? await runVerify(parsed, environment)
          : await runStatus(parsed, environment);
      return emit(result, parsed.json);
    }
  }
}

/** Every code the CLI adds, for documentation checks. */
export const DOCUMENTED_CLI_CODES: readonly string[] = CLI_ERROR_CODES;
