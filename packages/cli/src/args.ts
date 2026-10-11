import { CLI_ERROR_CODES, type CliErrorCode } from './exit.js';

/*
 * Strict argument parsing. Unknown options, duplicates, missing values and extra positionals are
 * usage errors: nothing is guessed, defaulted from the environment here, or silently ignored.
 */

export interface UsageError {
  readonly code: CliErrorCode;
  /** The option or argument at fault, never a value (values may be secrets). */
  readonly subject?: string;
}

type ValueOption =
  'chain-id' | 'registry' | 'rpc' | 'expected-reference' | 'deployment' | 'reviewer' | 'commitment';
type FlagOption = 'json' | 'allow-loopback-http' | 'help' | 'version';

const COMMAND_OPTIONS: Readonly<Record<'verify' | 'status', readonly ValueOption[]>> = {
  verify: ['chain-id', 'registry', 'rpc', 'expected-reference', 'deployment'],
  status: ['chain-id', 'registry', 'reviewer', 'commitment', 'rpc', 'deployment'],
};
const FLAGS: readonly FlagOption[] = ['json', 'allow-loopback-http', 'help', 'version'];

export interface CommonOptions {
  readonly json: boolean;
  readonly allowLoopbackHttp: boolean;
  readonly values: Readonly<Partial<Record<ValueOption, string>>>;
}

export type Parsed =
  | { readonly kind: 'help'; readonly json: boolean }
  | { readonly kind: 'version'; readonly json: boolean }
  | ({ readonly kind: 'verify'; readonly packagePath: string } & CommonOptions)
  | ({ readonly kind: 'status' } & CommonOptions)
  | { readonly kind: 'usage-error'; readonly json: boolean; readonly error: UsageError };

const fail = (json: boolean, code: CliErrorCode, subject?: string): Parsed => ({
  kind: 'usage-error',
  json,
  error: subject === undefined ? { code } : { code, subject },
});

export function parseArguments(argv: readonly string[]): Parsed {
  // --json is honoured even when the rest is wrong, so the failure itself stays machine-readable.
  const json = argv.includes('--json');
  const [head, ...rest] = argv;

  // The command must come first: `proof-of-review <command> [options]`.
  if (head === undefined) return fail(json, 'USAGE_COMMAND_UNKNOWN');
  if (head === '--help' || head === '-h') return { kind: 'help', json };
  if (head === '--version') return { kind: 'version', json };
  if (head !== 'verify' && head !== 'status') {
    return fail(
      json,
      head.startsWith('-') ? 'USAGE_OPTION_UNKNOWN' : 'USAGE_COMMAND_UNKNOWN',
      head.startsWith('-') ? head.split('=')[0] : 'command',
    );
  }
  const command = head;

  const flags = new Set<FlagOption>();
  const values: Partial<Record<ValueOption, string>> = {};
  const positionals: string[] = [];
  const known = new Set<string>([...FLAGS, ...COMMAND_OPTIONS[command]]);
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index] ?? '';
    if (item === '--') {
      positionals.push(...rest.slice(index + 1));
      break;
    }
    if (item === '-h') {
      flags.add('help');
      continue;
    }
    if (!item.startsWith('--')) {
      positionals.push(item);
      continue;
    }
    const equals = item.indexOf('=');
    const name = item.slice(2, equals === -1 ? undefined : equals);
    if (!known.has(name)) return fail(json, 'USAGE_OPTION_UNKNOWN', `--${name}`);
    if ((FLAGS as readonly string[]).includes(name)) {
      if (equals !== -1) return fail(json, 'USAGE_VALUE_INVALID', `--${name}`);
      flags.add(name as FlagOption);
      continue;
    }
    if (name in values) return fail(json, 'USAGE_OPTION_DUPLICATE', `--${name}`);
    let value: string | undefined;
    if (equals !== -1) value = item.slice(equals + 1);
    else {
      const next = rest[index + 1];
      if (next === undefined || next.startsWith('--')) {
        return fail(json, 'USAGE_OPTION_MISSING_VALUE', `--${name}`);
      }
      value = next;
      index += 1;
    }
    if (value === '') return fail(json, 'USAGE_OPTION_MISSING_VALUE', `--${name}`);
    values[name as ValueOption] = value;
  }

  if (flags.has('help')) return { kind: 'help', json };
  if (flags.has('version')) return { kind: 'version', json };

  const common: CommonOptions = {
    json: flags.has('json'),
    allowLoopbackHttp: flags.has('allow-loopback-http'),
    values,
  };
  const required: readonly ValueOption[] =
    command === 'verify'
      ? ['chain-id', 'registry']
      : ['chain-id', 'registry', 'reviewer', 'commitment'];
  if (command === 'verify') {
    const [packagePath, ...extra] = positionals;
    if (packagePath === undefined) return fail(json, 'USAGE_ARGUMENT_MISSING', '<package-path>');
    if (extra.length > 0) return fail(json, 'USAGE_ARGUMENT_EXTRA', 'argument');
    for (const option of required) {
      if (values[option] === undefined) return fail(json, 'USAGE_ARGUMENT_MISSING', `--${option}`);
    }
    return { kind: 'verify', packagePath, ...common };
  }
  if (positionals.length > 0) return fail(json, 'USAGE_ARGUMENT_EXTRA', 'argument');
  for (const option of required) {
    if (values[option] === undefined) return fail(json, 'USAGE_ARGUMENT_MISSING', `--${option}`);
  }
  return { kind: 'status', ...common };
}

/** Exhaustiveness helper for tests: every usage code is a documented CLI code. */
export const USAGE_CODES = CLI_ERROR_CODES.filter((code) => code.startsWith('USAGE_'));
