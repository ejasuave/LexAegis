import { describe, expect, it } from 'vitest';
import { parseArguments, USAGE_CODES } from './args';
import { CLI_ERROR_CODES } from './exit';

const ADDRESS = `0x${'11'.repeat(20)}`;
const verifyArgs = ['verify', 'review.json', '--chain-id', '10143', '--registry', ADDRESS];

describe('argument parsing', () => {
  it('parses verify with every documented option', () => {
    const parsed = parseArguments([
      ...verifyArgs,
      '--expected-reference=ref.json',
      '--deployment',
      'd.json',
      '--rpc',
      'https://rpc.example.invalid/',
      '--json',
    ]);
    expect(parsed).toMatchObject({
      kind: 'verify',
      packagePath: 'review.json',
      json: true,
      allowLoopbackHttp: false,
      values: {
        'chain-id': '10143',
        registry: ADDRESS,
        'expected-reference': 'ref.json',
        deployment: 'd.json',
        rpc: 'https://rpc.example.invalid/',
      },
    });
  });

  it('parses status and refuses a package argument for it', () => {
    const status = [
      'status',
      '--chain-id',
      '10143',
      '--registry',
      ADDRESS,
      '--reviewer',
      ADDRESS,
      '--commitment',
      `0x${'ab'.repeat(32)}`,
    ];
    expect(parseArguments(status)).toMatchObject({ kind: 'status' });
    expect(parseArguments([...status, 'review.json'])).toMatchObject({
      kind: 'usage-error',
      error: { code: 'USAGE_ARGUMENT_EXTRA' },
    });
  });

  it.each([
    [[], 'USAGE_COMMAND_UNKNOWN'],
    [['frobnicate'], 'USAGE_COMMAND_UNKNOWN'],
    [['--chain-id', '1'], 'USAGE_OPTION_UNKNOWN'],
    [['verify', '--chain-id', '10143', '--registry', ADDRESS], 'USAGE_ARGUMENT_MISSING'],
    [['verify', 'a.json', '--registry', ADDRESS], 'USAGE_ARGUMENT_MISSING'],
    [[...verifyArgs, '--sign'], 'USAGE_OPTION_UNKNOWN'],
    [[...verifyArgs, '--private-key', 'x'], 'USAGE_OPTION_UNKNOWN'],
    [[...verifyArgs, '--reviewer', ADDRESS], 'USAGE_OPTION_UNKNOWN'],
    [[...verifyArgs, '--chain-id', '1'], 'USAGE_OPTION_DUPLICATE'],
    [[...verifyArgs, '--rpc'], 'USAGE_OPTION_MISSING_VALUE'],
    [[...verifyArgs, '--rpc', '--json'], 'USAGE_OPTION_MISSING_VALUE'],
    [[...verifyArgs, '--rpc='], 'USAGE_OPTION_MISSING_VALUE'],
    [[...verifyArgs, '--json=true'], 'USAGE_VALUE_INVALID'],
    [[...verifyArgs, 'second.json'], 'USAGE_ARGUMENT_EXTRA'],
  ])('rejects %j as %s', (argv, code) => {
    expect(parseArguments(argv)).toMatchObject({ kind: 'usage-error', error: { code } });
  });

  it('never accepts a signing, key or issue option, and has no issue/revoke/supersede command', () => {
    for (const option of [
      '--private-key',
      '--mnemonic',
      '--sign',
      '--send',
      '--keystore',
      '--account',
    ]) {
      expect(parseArguments([...verifyArgs, option, 'x']).kind).toBe('usage-error');
    }
    for (const command of ['issue', 'revoke', 'supersede', 'sign', 'approve']) {
      expect(parseArguments([command])).toMatchObject({
        kind: 'usage-error',
        error: { code: 'USAGE_COMMAND_UNKNOWN' },
      });
    }
  });

  it('honours --json for a failure so it stays machine-readable, and never echoes a value', () => {
    const parsed = parseArguments([
      'verify',
      '--json',
      '--rpc',
      'https://user:secret@x.invalid/',
      '--bogus',
    ]);
    expect(parsed).toMatchObject({ kind: 'usage-error', json: true });
    expect(JSON.stringify(parsed)).not.toContain('secret');
  });

  it('answers --help and --version without requiring other arguments', () => {
    expect(parseArguments(['--help'])).toMatchObject({ kind: 'help' });
    expect(parseArguments(['verify', '--help'])).toMatchObject({ kind: 'help' });
    expect(parseArguments(['--version'])).toMatchObject({ kind: 'version' });
  });

  it('every usage code is a documented CLI code', () => {
    for (const code of USAGE_CODES) expect(CLI_ERROR_CODES).toContain(code);
  });
});
