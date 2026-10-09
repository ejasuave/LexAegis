/**
 * pnpm account:record-device-check -- --address 0x.. --browser "Chrome 141" --os "macOS 15" \
 *   --authenticator "iCloud Keychain" --create-prompts 1 --create-seconds 9 \
 *   --signed-in yes --locked-then-fresh yes --recovered-after-clear yes [--second-device yes|no|not-available]
 *
 * Records what a PERSON observed on real hardware as real_device evidence. It performs no
 * check itself and cannot be used to assert something nobody saw: every flag is required, and
 * anything other than "yes" for a step records that step as not shown.
 */
import { recordEvidence } from '../src/evidence-writer';
import { ROOT, stamp } from './lib';

const args = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const required = [
  'address',
  'browser',
  'os',
  'authenticator',
  'create-prompts',
  'create-seconds',
  'signed-in',
  'locked-then-fresh',
  'recovered-after-clear',
];
const missing = required.filter((name) => value(name) === undefined);
if (missing.length > 0) {
  console.error(`missing: ${missing.map((name) => `--${name}`).join(' ')}`);
  process.exit(2);
}
const address = value('address') ?? '';
if (!/^0x[0-9a-f]{40}$/.test(address)) {
  console.error('--address must be the lowercase 0x address shown in the Account panel');
  process.exit(2);
}
const yes = (name: string) => value(name) === 'yes';
const steps = {
  signedIn: yes('signed-in'),
  lockedThenFresh: yes('locked-then-fresh'),
  recoveredAfterClear: yes('recovered-after-clear'),
};
const all = Object.values(steps).every(Boolean);
const second = value('second-device') ?? 'not-available';

await recordEvidence({
  root: ROOT,
  results: [
    stamp({
      id: `mera-device-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`,
      subject: 'mera-real-device-check',
      command: 'manual: real passkey on real hardware, reported by the operator',
      evidenceClass: 'real_device',
      outcome: all ? 'pass' : 'fail',
      reasonCodes: [
        'OPERATOR_REPORTED',
        ...(all ? [] : ['STEPS_NOT_ALL_SHOWN']),
        ...(second === 'yes' ? [] : ['SECOND_DEVICE_NOT_SHOWN']),
      ],
      facts: {
        address,
        browser: (value('browser') ?? '').slice(0, 80),
        os: (value('os') ?? '').slice(0, 80),
        authenticator: (value('authenticator') ?? '').slice(0, 80),
        observedPromptsAtCreate: value('create-prompts') ?? '',
        createSeconds: value('create-seconds') ?? '',
        ...steps,
        secondDeviceRecovery: second,
      },
    }),
  ],
});
console.log(
  all ? 'recorded: real-device checks shown' : 'recorded: not every step was shown (outcome fail)',
);
