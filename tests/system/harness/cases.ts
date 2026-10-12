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
]);
