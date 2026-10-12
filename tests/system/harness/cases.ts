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
  c(
    'recovery-frozen-review-after-storage-clear',
    'tests/system/account-and-vault-recovery.spec.ts',
    "After only the test origin's storage and cookies are cleared, the same passkey recovers the same account, decrypted artifact bytes and original commitment without creating a passkey, vault or object; an approval ticket is never restored.",
    'browser_scripted',
  ),
  c(
    'recovery-wrong-credential-and-missing-prf',
    'tests/system/account-and-vault-recovery.spec.ts',
    'A different, PRF-less or cancelled authenticator yields a typed failure and never creates a replacement account, vault, session or silent passkey.',
    'browser_scripted',
  ),
  c(
    'recovery-storage-faults-are-not-an-empty-vault',
    'tests/system/account-and-vault-recovery.spec.ts',
    'Altered, forged, missing or unreachable ciphertext is reported as a specific failure, never as an empty vault, and nothing is overwritten or recreated.',
    'browser_scripted',
  ),
  c(
    'recovery-session-limits-and-late-callbacks',
    'tests/system/account-and-vault-recovery.spec.ts',
    'The 5-minute idle and 10-minute absolute limits lock the signing session and vault, a clock rollback and BFCache restoration lock them, and an expired backend session is never silently renewed.',
    'browser_scripted',
  ),
  c(
    'recovery-rollback-detection-and-limits',
    'tests/system/account-and-vault-recovery.spec.ts',
    'A head already observed in the active session cannot regress; a full replay of a valid old head after all local state is lost is a recorded, undetectable limitation.',
    'browser_scripted',
  ),
  c(
    'vault-browser-crypto-tamper',
    'packages/vault/src/crypto/tamper.test.ts',
    'In real browser Web Crypto, truncated, extended and cross-owner or cross-vault envelopes fail authentication and a failure never echoes plaintext, key or ciphertext.',
    'browser_scripted',
  ),
  c(
    'vault-storage-fault-matrix',
    'tests/system/vault-storage.spec.ts',
    'An interruption before or after each upload, the read-back, the catalog and the head commit never reports a save, and a retry reuses the identity and ends with exactly one review and one new revision.',
    'local_integration',
  ),
  c(
    'vault-storage-concurrency-and-immutability',
    'tests/system/vault-storage.spec.ts',
    'On a real PostgreSQL and S3-compatible store, a stale session conflicts and keeps its draft, objects are immutable and success needs a complete read-back reachable from the catalog.',
    'local_integration',
  ),
  c(
    'vault-storage-corruption-swaps-and-outage',
    'tests/system/vault-storage.spec.ts',
    'Missing, swapped-between-accounts and unreachable objects block readiness before any plaintext is used, a restart during a save never shows a pending capture as saved and a lock during decryption releases nothing.',
    'local_integration',
  ),
  c(
    'vault-exports-roundtrip-real-stores',
    'tests/system/vault-storage.spec.ts',
    'Encrypted, readable and context exports round-trip through preview and confirm, previews persist nothing, malformed bundles persist nothing and a fresh destination encryption keeps the package identity.',
    'local_integration',
  ),
  c(
    'auth-siwe-challenge-session-and-cookies',
    'tests/system/auth-and-ownership.spec.ts',
    'Only a signature over the exact server-built EIP-4361 message by that address, from the browser holding the pre-auth cookie, creates exactly one session; replay, expiry, swapping and spoofed forwarding headers fail, and session tokens never appear in a body.',
    'local_integration',
  ),
  c(
    'ownership-cross-account-routes',
    'tests/system/auth-and-ownership.spec.ts',
    "Another account's vault, assistant run, operation and funding recipient answer exactly like an unknown ID, anonymous callers are refused, and authority comes from the session only.",
    'local_integration',
  ),
  c(
    'http-origin-headers-and-body-limits',
    'tests/system/auth-and-ownership.spec.ts',
    'State-changing routes need the configured Origin, JSON and the application header, authenticated responses are no-store with no credentialed CORS, route body limits reject limit+1 before work, and an HTTPS-configured app issues Secure __Host- cookies.',
    'local_integration',
  ),
  c(
    'shared-store-two-instances-and-outage',
    'tests/system/auth-and-ownership.spec.ts',
    'Sessions, rate limits and operation ownership are shared through the database across two application processes, and an unreachable database disables protected work without a bypass.',
    'local_integration',
  ),
  c(
    'privacy-observed-journey-disclosure-matrix',
    'tests/privacy/disclosure-boundaries.spec.ts',
    'Across a complete journey with a real local broadcast, planted canaries appear only where the disclosure matrix allows, in every observed layer and encoding, and unobserved layers are stated.',
    'browser_scripted',
  ),
  c(
    'privacy-assistant-consent-and-failure-boundaries',
    'tests/privacy/disclosure-boundaries.spec.ts',
    'No assistant request is made without an explicit Send, a changed selection renews consent, only the consented excerpt is sent, and a provider failure or Stop is bounded and never retried silently.',
    'browser_scripted',
  ),
  c(
    'privacy-logging-and-evidence-hygiene',
    'tests/privacy/disclosure-boundaries.spec.ts',
    'Server logs hold only allowlisted operational fields, and no test produces or commits a trace, HAR, video, screenshot or saved authentication state.',
    'browser_scripted',
  ),
  c(
    'aegis-injection-capability-boundaries',
    'packages/agent/src/runtime/hostile-boundaries.test.ts',
    'Only the six read-only tools can execute; hostile text in a document, note, history or tool output, and forged roles, execute or change nothing.',
    'unit',
  ),
  c(
    'aegis-handles-and-forged-results',
    'packages/agent/src/runtime/hostile-boundaries.test.ts',
    'Source, tool and rule handles must come from this run, calculation and status blocks must cite the right kind of result, and the model cannot supply offsets, quotes or results.',
    'unit',
  ),
  c(
    'aegis-oracle-arithmetic',
    'packages/agent/src/runtime/hostile-boundaries.test.ts',
    'The integer oracle 2400000-(1000000+1200000)=200000 is the only source of figures, and a simulated instalment is refused and changes nothing.',
    'unit',
  ),
  c(
    'aegis-run-ceilings-and-admission',
    'packages/agent/src/runtime/run-agent.hardening.test.ts',
    'Six provider attempts, eight tools, 120 seconds, token reservations, one active run, duplicate admission, lease expiry and cross-replica cancellation hold, with no provider fallback or background continuation.',
    'unit',
  ),
  c(
    'aegis-cancellation-races-and-streams',
    'packages/agent/src/runtime/run-agent.test.ts',
    'Exactly one real terminal outcome results from completion and cancel races, Stop is not cancellation until acknowledged, and partial, duplicate, gapped or lost event streams never become a completed result.',
    'unit',
  ),
]);
