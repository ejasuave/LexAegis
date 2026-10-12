import { parseManifest, type SystemCaseV1 } from './manifest';

/*
 * The case manifest. A case is added here in the same change as the test that owns it, and its owner
 * path must exist (a test checks that). `requiredForMvp` cases that are missing, blocked, not run,
 * skipped or flaky keep the validation gate failing.
 */

const c = (
  id: string,
  owner: string,
  invariant: string,
  requiredEvidence: SystemCaseV1['requiredEvidence'],
  requiredForMvp = true,
): SystemCaseV1 => ({
  schema: 'lexaegis.system-case.v1',
  id,
  owner,
  invariant,
  requiredEvidence,
  requiredForMvp,
});

export const SYSTEM_CASES: readonly SystemCaseV1[] = parseManifest([
  c(
    'harness-refuses-public-targets',
    'tests/system/harness/harness.test.ts',
    'The harness refuses public chains, non-loopback endpoints, shared databases and wildcard cleanup.',
    'unit',
  ),
  c(
    'harness-non-pass-is-never-pass',
    'tests/system/harness/harness.test.ts',
    'Missing, blocked, skipped, flaky and weaker-evidence results never satisfy a required case.',
    'unit',
  ),
  c(
    'journey-setup-aegis-and-checks',
    'tests/system/full-review-journey.spec.ts',
    'Account access, explicit vault unlock, disclosure before Send, a cited Aegis answer, confirmed facts and deterministic checks run through rendered controls and match the integer oracle.',
    'browser_scripted',
  ),
  c(
    'journey-decisions-freeze-and-save',
    'tests/system/full-review-journey.spec.ts',
    'Human decisions are never preselected; freezing saves and reads back an encrypted package; saved is not approved, signed or an active receipt.',
    'browser_scripted',
  ),
  c(
    'journey-approval-and-local-broadcast',
    'tests/system/full-review-journey.spec.ts',
    'Exact action approval by a trusted click and a separate exact fee confirmation precede a local broadcast; signed, broadcast, confirmed and Active remain distinct.',
    'browser_scripted',
  ),
  c(
    'journey-export-and-independent-verification',
    'tests/system/full-review-journey.spec.ts',
    'The exported readable bundle verifies in a fresh verifier context against an independently supplied reference and the live registry, with no LexAegis backend contact.',
    'browser_scripted',
  ),
]);
