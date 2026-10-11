# Result codes

Generated from `src/result-codes.ts` by `pnpm sdk:generate`; do not edit. A code never carries
artifact content, labels, hashes, openings, endpoints or credentials.

Retryability: **no** = the input or observation is final; **after-fix** = correct input,
configuration or policy first; **transient** = the same call may succeed later;
**informational** = not a failure, it states what was not evaluated.

## Protocol errors (`ProtocolFailure.code`)

| Code | Cause | Retry |
| --- | --- | --- |
| `INPUT_TOO_LARGE` | The input exceeds a size limit. | no |
| `INVALID_UTF8` | The bytes are not valid UTF-8. | no |
| `BYTE_ORDER_MARK` | The input starts with a byte-order mark. | no |
| `INVALID_JSON` | Not strict JSON (comment, trailing comma or content, bad grammar). | no |
| `DUPLICATE_KEY` | An object repeats a member name, including after escape decoding. | no |
| `NESTING_TOO_DEEP` | Containers are nested deeper than 32. | no |
| `UNSAFE_NUMBER` | A number is not a safe plain integer literal. | no |
| `LONE_SURROGATE` | A string or member name contains an unpaired UTF-16 surrogate. | no |
| `FORBIDDEN_KEY` | A member name could manipulate prototypes. | no |
| `UNSUPPORTED_VALUE` | Object input is not plain JSON data. | no |
| `UNSUPPORTED_VERSION` | The schema identifier is a version this SDK does not support. | no |
| `UNKNOWN_FIELD` | An object has a field the v1 schema does not define. | no |
| `SCHEMA_INVALID` | A value does not match its v1 schema. | no |
| `TOO_MANY_ARTIFACTS` | More than 128 artifacts are declared. | no |
| `DUPLICATE_ARTIFACT_ID` | Two artifacts share an ID. | no |
| `SOURCE_ARTIFACT_REQUIRED` | No artifact has the role source. | no |
| `DECISION_LOG_ARTIFACT_INVALID` | The manifest does not have exactly one decision log. | no |
| `DUPLICATE_SCOPE_ID` | An approval scope ID is listed twice. | no |
| `UNRESOLVED_ARTIFACT_REFERENCE` | A scope or decision-log ID names no artifact. | no |
| `SCOPE_INCOMPLETE` | The approval scope does not cover every artifact. | no |
| `DECISION_LOG_REFERENCE_INVALID` | decisionLogArtifactId names an artifact that is not the decision log. | no |
| `SUPERSEDES_CONTEXT_MISMATCH` | The declared predecessor is on another chain, registry or reviewer. | no |
| `ARTIFACT_TOO_LARGE` | An artifact is larger than 10 MiB. | no |
| `ARTIFACTS_TOO_LARGE` | The artifacts together exceed 32 MiB. | no |
| `ARTIFACT_INPUT_INVALID` | Supplied artifact bytes are malformed (not bytes, shared or detached). | after-fix |
| `ARTIFACT_MISSING` | A committed artifact was not supplied. | after-fix |
| `ARTIFACT_DUPLICATE` | The same artifact ID was supplied twice. | after-fix |
| `ARTIFACT_EXTRA` | A supplied artifact is not in the manifest. | after-fix |
| `ARTIFACT_LENGTH_MISMATCH` | Supplied bytes have a different length than committed. | no |
| `ARTIFACT_DIGEST_MISMATCH` | Supplied bytes hash to a different digest than committed. | no |
| `INVALID_HEX` | Not strict lowercase 0x-prefixed hexadecimal. | no |
| `INVALID_BYTE_LENGTH` | A decoded value is not the required byte length. | no |
| `CRYPTO_UNAVAILABLE` | This runtime has no Web Crypto digest or secure randomness. | after-fix |

## Readable-export errors (`PortableFailure.code`)

| Code | Cause | Retry |
| --- | --- | --- |
| `INPUT_TOO_LARGE` | The export file is larger than 48 MiB. | no |
| `INPUT_MALFORMED` | The file is not strict JSON (see cause for the parser code). | no |
| `WRONG_FORMAT_ENCRYPTED_BACKUP` | This is an encrypted backup; it needs its owner's vault. | no |
| `WRONG_FORMAT_CONTEXT_EXPORT` | This is a saved context export; it holds no review package. | no |
| `UNRECOGNISED_FORMAT` | The file is not a Proof of Review export. | no |
| `UNSUPPORTED_VERSION` | A review export of a version this SDK does not support. | no |
| `UNKNOWN_FIELD` | The export has a field the v1 envelope does not define. | no |
| `SCHEMA_INVALID` | The export envelope does not match its schema. | no |
| `OPENING_TOO_LARGE` | The manifest or opening is larger than 1 MiB. | no |
| `ARTIFACT_SET_MISMATCH` | Artifact entries are not exactly the manifest artifacts, once each, in order. | no |
| `ARTIFACT_ENCODING_INVALID` | Artifact bytes are not canonical unpadded base64url. | no |
| `ARTIFACT_TOO_LARGE` | One artifact is larger than 10 MiB. | no |
| `ARTIFACTS_TOO_LARGE` | The artifacts together exceed 32 MiB. | no |

## Registry helper errors (`RegistryFailure.code`)

| Code | Cause | Retry |
| --- | --- | --- |
| `SNAPSHOT_INVALID` | The prepared snapshot is not a real PreparedReviewPackage. | after-fix |
| `REFERENCE_INVALID` | A receipt reference does not match its schema. | after-fix |
| `UNSUPPORTED_VERSION` | A reference of an unsupported version. | no |
| `NONCE_INVALID` | The registry action nonce is not a canonical uint256 decimal. | after-fix |
| `DEADLINE_INVALID` | The deadline is zero or not a canonical uint256 decimal. | after-fix |
| `ZERO_COMMITMENT` | A commitment is bytes32(0), which is reserved. | no |
| `SUPERSEDES_UNEXPECTED` | ISSUE was requested for a package that names a predecessor; use SUPERSEDE. | after-fix |
| `SUPERSEDES_REQUIRED` | SUPERSEDE was requested for a package that names no predecessor. | after-fix |
| `SUPERSEDES_MISMATCH` | The package names a different predecessor than supplied. | after-fix |
| `CONTEXT_MISMATCH` | Chain, registry or reviewer differ between the package and the predecessor. | after-fix |
| `REPLACEMENT_EQUALS_PREVIOUS` | A replacement cannot be the commitment it replaces. | no |
| `ACTION_INVALID` | The action does not match its schema. | after-fix |
| `CHAIN_ID_INVALID` | The chain ID is not valid. | after-fix |
| `REGISTRY_ADDRESS_INVALID` | The registry address is not valid. | after-fix |
| `DOMAIN_MISMATCH` | The signing domain differs from the one the action was built for. | after-fix |
| `TYPED_DATA_INVALID` | The typed data does not match its schema. | after-fix |
| `CONTEXT_INVALID` | The chain or registry context is not valid. | after-fix |
| `EMPTY_RESPONSE` | A call returned no data (for example an address without code). | transient |
| `RESPONSE_MALFORMED` | Return data is not the expected shape. | no |
| `STATUS_UNKNOWN` | The receipt status is outside the known enum. | no |
| `LOG_MALFORMED` | A log does not decode as a registry event. | no |
| `LOG_ADDRESS_MISMATCH` | A log was emitted by another address. | no |
| `EVENT_UNKNOWN` | The log is not one of the four registry events. | no |
| `ERROR_UNKNOWN` | The revert data is not a known registry error. | no |
| `OPENING_INVALID` | The opening does not match its schema. | after-fix |
| `OBSERVATION_INVALID` | The observed record does not match its schema. | no |

## Verification report issues (`VerificationReportV1.issues[].code`)

| Code | Cause | Retry |
| --- | --- | --- |
| `EXPECTATION_FROM_FILE` | The expected reference came from the file itself: no protection against a substituted bundle. | informational |
| `MANIFEST_NOT_SUPPLIED` | Reference-only mode: no manifest was checked. | informational |
| `ARTIFACTS_NOT_SUPPLIED` | No artifact bytes were supplied. | informational |
| `ARTIFACTS_NOT_EVALUATED` | The manifest did not match, so artifacts were not evaluated. | informational |
| `DECLARED_REFERENCE_CONFLICT` | The file declares a different reference than the one expected. | no |
| `CONTEXT_MISMATCH` | The opening is for a different chain, registry or reviewer than expected. | no |
| `COMMITMENT_MISMATCH` | The opening does not recompute the expected commitment. | no |
| `ARTIFACT_MISSING` | A committed artifact was not supplied (integrity unknown). | after-fix |
| `ARTIFACT_LENGTH_MISMATCH` | A supplied artifact has the wrong length. | no |
| `ARTIFACT_DIGEST_MISMATCH` | A supplied artifact has the wrong digest. | no |
| `ARTIFACT_NOT_IN_MANIFEST` | A supplied file is not committed by the manifest. | no |
| `NETWORK_NOT_REQUESTED` | No live check was requested: chain status is unknown. | informational |
| `REGISTRY_POLICY_MISSING` | A live check needs a registry policy. | after-fix |
| `REGISTRY_POLICY_INVALID` | The registry policy or RPC endpoint is not valid. | after-fix |
| `REGISTRY_POLICY_MISMATCH` | The reference names a chain or registry the policy does not trust. | no |
| `LIVE_RPC_UNAVAILABLE` | The RPC endpoint could not be read. | transient |
| `LIVE_WRONG_CHAIN` | The endpoint serves another chain ID than the policy. | no |
| `LIVE_GENESIS_MISMATCH` | The endpoint's genesis block is not the pinned one. | no |
| `LIVE_FINALIZED_UNAVAILABLE` | The endpoint reports no finalized block. | transient |
| `LIVE_BELOW_DEPLOYMENT` | The selected block is before the deployment block. | transient |
| `LIVE_CODE_MISMATCH` | The registry code differs from the policy's runtime-code hash. | no |
| `LIVE_PROTOCOL_MISMATCH` | The registry reports a different protocol version. | no |
| `LIVE_BLOCK_CHANGED` | The pinned block hash changed during the read. | transient |
| `LIVE_RESPONSE_INVALID` | The endpoint returned an unexpected response. | transient |
| `LIVE_DEADLINE` | The 20 second budget ended. | transient |
| `LIVE_ATTEMPTS_EXHAUSTED` | The attempt budget ended. | transient |
| `LIVE_TIMEOUT` | A single read timed out. | transient |
| `LIVE_ABORTED` | The caller cancelled the check. | transient |
| `BINDING_NOT_EVALUATED` | No verified opening was available to bind to the record. | informational |
| `OPENING_CONTEXT_MISMATCH` | The opening and the reference disagree on chain, registry or reviewer. | no |
| `RECEIPT_TUPLE_MISMATCH` | The observed record is for a different tuple than requested. | no |
| `PREDECESSOR_MISMATCH` | The record's predecessor is not the one the manifest declares. | no |
| `IMPOSSIBLE_RECORD` | The record could not have been produced by the registry. | no |
| `SUCCESSOR_LIMIT_EXHAUSTED` | More than 8 successor links exist; the history is incomplete. | informational |
| `SUCCESSOR_CYCLE` | The successor chain loops. | no |
| `SUCCESSOR_LINK_INVALID` | A successor record is not reciprocal or not a valid receipt. | no |
| `SUCCESSOR_UNREADABLE` | A successor could not be read. | transient |
| `SIGNER_POLICY_ABSENT` | No signer policy was supplied: acceptance is unknown. | informational |
| `SIGNER_POLICY_ERROR` | The signer policy threw or answered with an invalid value. | after-fix |

## Live read outcomes that are `unknown` (`LiveUnknownReason`)

| Code | Cause | Retry |
| --- | --- | --- |
| `RPC_UNAVAILABLE` | A read failed or was refused. | transient |
| `WRONG_CHAIN` | The endpoint serves another chain. | no |
| `FINALIZED_UNAVAILABLE` | The endpoint has no finalized block. | transient |
| `BELOW_DEPLOYMENT` | The selected block predates the deployment. | transient |
| `CODE_MISMATCH` | The registry code is not the trusted runtime code. | no |
| `PROTOCOL_MISMATCH` | The registry protocol version is not the trusted one. | no |
| `BLOCK_CHANGED` | The block hash changed while reading. | transient |
| `RESPONSE_INVALID` | A response had an unexpected shape. | transient |
| `POLICY_INVALID` | The chain policy is not valid. | after-fix |

## Budget stops (`BudgetFailure`)

| Code | Cause | Retry |
| --- | --- | --- |
| `DEADLINE` | The total time budget (20 s) ended. | transient |
| `ATTEMPTS` | The attempt budget (64) ended. | transient |
| `ABORTED` | The caller's AbortSignal fired. | transient |
| `TIMEOUT` | One read exceeded its 5 s limit. | transient |

## RPC endpoint configuration errors (`RpcConfigError`)

| Code | Cause | Retry |
| --- | --- | --- |
| `NOT_HTTPS` | The endpoint is not HTTPS (loopback HTTP only when explicitly allowed). | after-fix |
| `HAS_CREDENTIALS` | The endpoint URL carries user information. | after-fix |
| `HAS_QUERY_OR_FRAGMENT` | The endpoint URL has a query or fragment, where a key could hide. | after-fix |
| `MALFORMED_URL` | The endpoint is not a URL. | after-fix |

