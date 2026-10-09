## Chapter 16 — Agent Identity: ERC-8004 Link, Availability-Gated

This chapter gives the Aegis assistant an optional, checkable identity. It first checks whether the required registries actually work on Monad testnet. If they do, the prompts add registration, save the identity reference with new reviews, and display it separately in the workspace and verifier. If they do not, reviews still work normally. An agent identity is not proof that its advice is correct or that a reviewer is qualified.

The maintained ERC-8004 repository now lists Monad testnet addresses, so the prompts recheck them rather than assume they are unavailable. The identity reference is covered by the existing file fingerprints; no new commitment formula or review-registry contract is introduced.

```text
📦 BUILD TASK #1: Chapter 16 scope, dependencies and compatibility contract
🛠️ ACTION TYPE: Validate

<execute_task>
Act as the LexAegis implementation engineer. Execute Tasks #1–#12 sequentially, following their availability conditions. Edit actual repository files; produce complete code, compact evidence and factual blockers. Omit conversational filler, architecture essays, full-file echoes and standalone terminal JSON status summaries. Runtime JSON required by scripts/APIs remains permitted.

Read applicable repository instructions, CLAUDE.md, docs/assistant-ui-contract.md, docs/build-state.json, the v3 brief and supplied Chapters 14–19 amendment. Inspect implemented agent-configuration artifacts, feature flags, SDK/verifier/CLI contracts, signing boundaries and evidence writers. Reuse existing paths/tooling; preserve unrelated changes; do not spawn agents.

Mapping: #2 = 16.1 [Must, 30-minute investigation limit]; #3 = 16.3 [Should]; #4–5 = 16.2 [Should]; #6–7/#9 = 16.5 [Should]; #8 = 16.4 [Should]; #10 = 16.6 [Stretch]; #12 = 16.7 [Should]; #1/#11 protect compatibility and test outcomes.

Preserve manifest, opening, receipt-reference and readable-export schemas; digest/commitment construction; EIP-712 review actions/domain; ProofOfReviewRegistry source/ABI/bytecode; account derivation/vault formats; existing SDK report semantics and CLI exit codes. Reuse Chapter 14–15 protected baselines. Missing implementation prerequisites block dependent tasks, not the deliberately supported unavailable branch.

Resolve the amendment's 16.7 wording against the v3 brief: agentIdentity is inside an already-hashed artifact, so its bytes ARE indirectly committed. It is not a new manifest/reference field or new input to the commitment formula. Existing packages keep their existing digests; a new or changed identity-bearing artifact changes the new package's digest/commitment normally. Record this clarification in SPEC's discrepancy section.

ERC-8004 identity is separate from the approving reviewer, Qwen's model identity and professional qualifications. No payments, autonomous agent transactions, marketplace, cross-chain registration, Validation Registry, BTX or new wallet stack. No public deployment/publication or Chapters 17–19 implementation. Registration and feedback writes require separate, explicit operator/user action; implementing a script never authorises its live execution.

Acceptance: source-to-task mapping, baselines and blockers recorded; no protected protocol change or invented deployment evidence.
</execute_task>

📦 BUILD TASK #2: scripts/probe-erc8004.ts and docs/erc8004-availability.md
🛠️ ACTION TYPE: Create

<execute_task>
Read current primary sources:
https://docs.monad.xyz/guides/erc-8004
https://eips.ethereum.org/EIPS/eip-8004
https://github.com/erc-8004/erc-8004-contracts

The maintained contract repository lists Monad mainnet and testnet targets as of this chapter's research date, 2026-10-06. Re-fetch and record exact source URLs, checked dates, repository revision, deployment entries and ABI provenance. Documentation is candidate evidence, not an observed working deployment. Do not preserve the brief's earlier absence-of-testnet-addresses assumption as a fact.

Implement a read-only probe against configured Monad testnet and, separately, the official public Monad mainnet RPC. Verify actual chain identity before interpreting results. Use eth_getCode and ABI-verified view calls at a recorded coherent checkpoint; use other read-only methods only where needed for network/proxy identity. Never load a signing key, connect a wallet, send transactions or fund anything.

Probe the documented Identity and Reputation targets independently. Nonempty code alone is insufficient: check documented deployment provenance, supported ABI behaviour and the Reputation Registry's linked Identity Registry. For upgradeable deployments, record proxy and implementation observations where supported; a proxy-code hash alone must not certify unchanged logic. Ambiguous version/identity evidence remains unknown.

Do not infer testnet addresses from another chain's vanity address or scan arbitrary addresses. Missing authoritative targets, inaccessible documentation, conflicting versions, RPC errors and timeouts are unknown, not proof that no registry exists. Successful empty-code reads establish absence at the checked target/checkpoint only. Mainnet success cannot establish testnet availability.

Write dated per-network/per-registry results, source revision, actual addresses, checkpoint, code/ABI evidence, reasons and safe endpoint identifiers to docs/erc8004-availability.md and the existing validated evidence store. Redact credential-bearing URLs and provider errors.

Set features.agentIdentity.availableOnTestnet to true|false|"unknown" without overwriting the product flag. For the amendment's full-integration gate, require both verified testnet registries and their correct relationship. Preserve individual results: a missing Reputation Registry is not proof that the Identity Registry is absent. False means a required checked target is demonstrably unavailable/incompatible; unresolved evidence remains unknown.

If the gate is not true, skip active registration/resolution/feedback work. Complete only optional schema compatibility, truthful unavailable/not-registered presentation and their tests/docs. Mark active integration NOT YET; do not ship fake registered responses, a local copy presented as canonical, or a mainnet substitute.

Time-box investigation to 30 minutes. Bound each RPC call to 5 seconds, with at most one transient retry, 32 RPC attempts total and a 120-second probe runtime. On budget exhaustion, retain observed evidence and unknown reasons. No background polling.

Acceptance: the report and state reflect actual reads; network/ABI errors cannot produce true; tests assert the probe performs no signing or transaction-submission operation.
</execute_task>

📦 BUILD TASK #3: Optional agentIdentity artifact schema and pinned runtime configuration
🛠️ ACTION TYPE: Extend

<execute_task>
Find the existing agent-configuration artifact schema and its construction in packages/agent, with shared types in the current appropriate package. Extend that artifact only with optional agentIdentity:
{standard:"erc-8004", chainId, identityRegistry, agentId, cardUri}

Use existing canonical decimal-string/uint256 and nonzero-address validators. agentId is a decimal string, including zero if valid for the deployed implementation; never round through Number. Distinguish identityRegistry from the review registry. Require the configured testnet for newly produced references. Bound cardUri and use a public HTTPS URI for this MVP's registrations; URI values must contain no credentials or matter-specific data.

Preserve the artifact's versioning conventions: retain old-schema parsing and exact old bytes; introduce a compatible new artifact version if the existing version contract requires it. Do not add fields to closed manifest/opening/reference schemas or rewrite already frozen artifacts. Absence of agentIdentity remains valid. Expose shared schema/types through the existing browser-safe contracts boundary; the SDK/verifier must not import the server-only agent runtime.

Include the reference only from verified operator configuration after confirmed registration and a successful current-session identity read. Qwen, document content, card text and client payloads cannot choose or replace it. Pin it with the exact agent configuration used for that review. If identity is unavailable at preparation, omit it; never add it retrospectively to an existing review or frozen package.

A later identity/configuration change requires the existing invalidation/new-review/new-freeze workflow before it can appear in an approval. Never modify review artifacts while approval is in flight. An optional lookup failure must not erase an already captured historical reference or block generic verification of its bytes.

When Task #2 is false/unknown, implement and test the compatible optional field but leave it unused in production output. Preserve Chapter 14's separate concepts: implementation verification, product flag, network availability and registration status.

Acceptance: old artifacts/packages verify unchanged; valid new references serialize losslessly; invalid producer references are rejected; old frozen reviews never acquire a new identity silently.
</execute_task>

📦 BUILD TASK #4: Public ERC-8004 registration card
🛠️ ACTION TYPE: Create

<execute_task>
Run active work only when Task #2's gate is true. Inspect the pinned ERC-8004 registration-file specification and actual deployed contract version. Create the LexAegis review assistant's registration card at one stable public HTTPS path using the existing web application's asset/route convention.

Use the real required field names/types, not remembered A2A examples. Include the application's actual name, bounded description, existing public URLs and only implemented services. Advertise a web endpoint if that is all that exists. Do not invent MCP/A2A endpoints, x402 support, validation, credentials or trust guarantees. Keep optional trust declarations empty/absent when unsupported. Use existing public visual assets if needed; do not create a new design system.

Validate the card using a separate external-format schema. Keep its numeric rules distinct from LexAegis's decimal-string artifact rules; reject unsupported precision instead of rounding large IDs. No user names, matters, source documents, receipt openings, provider credentials, analytics identifiers or authenticated endpoints.

Handle registration bootstrap explicitly. Before registration, do not guess the next agent ID or claim a completed registry entry. Use the specification's supported pre-registration representation, or its staged registration/URI-update procedure when necessary. After a confirmed transaction, populate the actual registration tuple and validate it again.

Serve application/json with existing security headers and no session-dependent content. A local file or localhost response is not a publicly reachable card. Do not deploy the application from this task: if the required HTTPS origin is not already available, record the publication prerequisite and stop live registration at preflight.

Card contents and ownership can change later. This chapter commits the reference fields in the review artifact, not a snapshot of remotely served card bytes. Do not fetch the card automatically into Qwen context or imply that card claims were validated by the review registry.

Acceptance: the card validates, contains only real capabilities/public metadata, and its registration tuple is absent or actual—never predicted. Hosted availability is recorded only after a successful read of the real URL.
</execute_task>

📦 BUILD TASK #5: scripts/register-agent.ts and registration evidence
🛠️ ACTION TYPE: Create

<execute_task>
Run active work only when Task #2's gate is true. Build a one-off operator script using the pinned deployed ABI and existing transaction utilities. Default to dry-run, with explicit target chain, Identity Registry, operator address, card URI, exact call/value and bounded fee estimate. Dry-run must not sign or require a private key merely to show the plan.

Separate this operator action from user review approval. The operator key comes only from a deliberately configured server/CLI environment variable; never reuse a user's Mera key, derive a key from a passkey, expose it through NEXT_PUBLIC configuration, print it or bundle the script into the applications/SDK/CLI verifier.

Live execution requires an explicit execute option and confirmation of the displayed plan. Immediately recheck actual chain ID 10143, approved registry identity/ABI, card availability, operator-key/address match and existing fee/funding limits. No mainnet override, automatic funding, unbounded gas or automatic execution during build/tests.

Use the deployed registration method and decode its real receipt/events. Do not predict an agent ID from supply or simulation. Persist a secret-free pending transaction/nonce journal before waiting; on interruption or timeout, reconcile the same operation before retrying. Never issue another registration merely because confirmation was not observed.

After confirmed execution, independently read the agent's owner/existence and URI at a trustworthy checkpoint. Verify the observed owner is the intended operator. Finalize the card's actual registration entry using the existing controlled publication workflow; if the served card is not updated yet, record that remaining step rather than claiming completion.

Write agent ID as a decimal string, chain, Identity Registry, confirmed transaction, owner, card URI and observation evidence to docs/DEPLOYMENTS.md only after confirmation/read-back. Keep pending/failed attempts separately and preserve them. No keys, raw signatures or serialized signed transactions in documentation/logs.

Acceptance: dry-run/guard tests prevent writes; local test-only composition covers confirmation and timeout reconciliation; an actual public registration is verified only after the operator runs it and the on-chain/card read-back succeeds.
</execute_task>

📦 BUILD TASK #6: packages/sdk read-only resolveAgentIdentity
🛠️ ACTION TYPE: Extend

<execute_task>
When Task #2 is not true, implement only the minimal typed unavailable handling needed by the approved fallback surfaces; do not claim an active resolver exists. When true, add resolveAgentIdentity through a browser/Node-compatible public SDK entry point. Reuse transport, cancellation and error conventions; importing the SDK performs no network access.

Accept a validated agentIdentity reference plus explicit caller transport and trusted ERC-8004 deployment policy. Never derive trust, RPC endpoints or contract identity from a package/card. Limit live resolution to the configured testnet; local fixtures are test-only. The mainnet probe is not a runtime mainnet fallback.

Read registry identity, agent existence/owner and current URI using the actual ABI at one coherent checkpoint. Preserve proxy/version observations where applicable. Decode the implementation's known nonexistent-token result; an arbitrary revert, missing registry code, unsupported ABI or RPC failure is unavailable, not notFound.

Return a separate closed AgentIdentityResolutionV1 with registered|notFound|unavailable, stable reason codes, public identity tuple, observation time/checkpoint and separately typed card/URI observations. Do not modify VerificationReportV1 or its existing chainStatus/signerAcceptance fields. Missing optional input is handled as not included/not evaluated by callers, not as a nonexistent token lookup.

A captured cardUri differing from today's on-chain URI is a separate changed-reference observation. Registration may still exist. Ownership transfer or changed card text does not rewrite the old package or prove who operated the assistant at review time. Registered means a current registry record was observed, not certified authorship, identity, quality or qualification.

Bound resolution to 15 seconds and 12 RPC attempts, at most one transient retry per read within that total; respect stricter existing caller limits. Accept AbortSignal and generation IDs. Changed input/network/configuration invalidates pending results; retain no success badge from an earlier session as current evidence.

Send public identity parameters only, never files, openings, hashes of private artifacts, user session tokens or case text. No signing, account connection, reputation write, implicit endpoint discovery or automatic card fetch.

Acceptance: registered/notFound/unavailable are correctly distinguished; stale or wrong-network results cannot resolve; optional identity errors cannot alter core receipt verification results.
</execute_task>

📦 BUILD TASK #7: Bounded, opt-in agent-card retrieval
🛠️ ACTION TYPE: Create

<execute_task>
Implement only with the active resolver branch. Keep registry resolution usable without card retrieval. Fetching requires explicit caller/user opt-in and a freshly observed on-chain URI; never fetch an arbitrary unverified cardUri from imported bytes. Compare captured and current URIs before choosing an explicitly requested target.

Use HTTPS only, no URL credentials, no redirects, no cookies/authentication headers, no referrer and no automatic resource requests. Apply a 5-second deadline, 32 KiB streamed/decompressed body limit, depth 16 and bounded arrays/strings. Enforce limits during reading, not only from Content-Length. Validate JSON before exposing any fields.

Reuse a hardened existing fetcher with an explicit caller-configured origin allowlist, not one supplied by the card/package. Reject literal loopback, private, link-local, reserved and metadata-service destinations, including IPv6 and mapped forms. Node/server fetching must also validate DNS results and bind a validated public destination to the actual connection to prevent rebinding. If that safe adapter is unavailable, report card retrieval unavailable; do not create a generic URL proxy.

Browser retrieval is direct, restricted to project-approved public origins, with credentials omitted and normal CORS enforcement; do not claim browser fetch exposes DNS-pinning controls. A blocked response remains unavailable; do not bypass browser controls through the LexAegis backend. Test-only local transports stay outside production entry points. IPFS/data/non-HTTPS URIs receive an unsupported-card-transport reason, not a claim that the on-chain identity is absent.

Treat returned JSON as inert, untrusted claims. Parse the pinned registration-file format, check its registration tuple against the observed chain/registry/ID, reject unsafe numeric conversions, and expose a small public projection. Cap displayed names at 120 characters, descriptions at 500 and shown service entries at 8; visibly mark display truncation without rewriting stored evidence.

Never render remote HTML/Markdown, load card images, invoke listed services, execute scripts, follow embedded links automatically or feed card instructions to Qwen. Only explicit safe HTTPS links may be opened with noreferrer/noopener. Card active/trust/reputation labels are self-declarations, not verification results.

A malformed, oversized, unreachable or inconsistent card affects card status only. Preserve a genuinely observed registered identity and all core file/receipt results. Never describe mutable card bytes as frozen by a commitment that includes only the URI/reference.

Acceptance: tests cover redirect attempts, disallowed destinations, rebinding protection where applicable, timeout/size/depth limits, malformed JSON, unsafe numbers, tuple mismatch, XSS and unsupported schemes with no hidden fallback request.
</execute_task>

📦 BUILD TASK #8: Aegis HUD Assistant identity line
🛠️ ACTION TYPE: Extend

<execute_task>
Use the existing Aegis status components and Chapter 14 server-owned agentIdentity flag. When off, show no identity line, placeholder, command or network lookup. Do not let a client value or model output enable the feature. Keep implementation verification separate from network availability and registration.

When enabled, show the truthful state:
- Registered: agent ID, registry and safe card link only after a successful chain read in the current session; include network and observation/checkpoint context.
- No configured registration or a proven nonexistent agent: Not registered, with the reason kept distinct internally.
- Required target demonstrably unavailable: Agent identity unavailable on this network, with an accurate dependency reason.
- Unknown/RPC failure: Unable to check agent identity; do not assert that the registry is absent.
- Reading: a neutral checking state, never a reused current-success badge.

Use the SDK result or the minimal unavailable branch. Do not equate a registration-card file or deployment-record string with on-chain registration. Display a changed URI/owner observation without mutating the historical review reference. Do not label the assistant verified, licensed or legally reliable merely because it is registered.

Distinguish the current assistant configuration from the identity recorded with a particular review. Navigating to an older matter must not substitute today's identity into its evidence. Keep Stop, explicit approval, source citations, capture-readiness checks and truthful receipt states unchanged.

Bound reads to initial explicit identity inspection and deliberate refresh under existing UI conventions; no background polling loop. Cancel/discard stale work on lock, matter change, flag/configuration change or unmount. Account access and the T0 workflow do not depend on successful identity resolution.

Acceptance: component/browser tests cover resolved, checking, unregistered, unavailable, unknown, stale-session and flag-off states, including keyboard/mobile layouts and zero optional traffic when disabled.
</execute_task>

📦 BUILD TASK #9: Independent verifier and CLI identity sidecar
🛠️ ACTION TYPE: Extend

<execute_task>
Add identity presentation without changing existing proof verification semantics. In apps/verifier, extract a reference only from the supplied agent-configuration artifact after its exact bytes pass integrity checks; validate the supported artifact schema separately. No artifact/reference means not included or not supplied, not failed receipt integrity.

Keep agentIdentity resolution as an optional sidecar using the verifier's own trusted public configuration and caller-controlled transport. Require no LexAegis backend/session, Mera, Qwen or Envio. Show the separate Agent identity section only under the applicable enabled-feature configuration; otherwise no optional controls or requests.

Resolve only after an explicit check; card retrieval requires a further explicit choice. Unknown/malformed optional identity metadata must not erase a valid generic byte check. Show current registry observations separately from the captured reference and remote self-declarations. A changed URI/card/owner is not tampering with unchanged package bytes.

Extend the read-only CLI's verify command with an explicit --agent-identity option and optional --fetch-agent-card, valid only with --agent-identity. Document required independent ERC-8004 policy configuration. Without opt-in, preserve Chapter 15's output contract and request behaviour. Status-only commands cannot discover an agent reference from the review registry; do not invent one or fetch an evidence package automatically.

For opted-in runs, print a separate Agent identity line and serialize a documented versioned CLI-only envelope containing the unchanged core report plus the identity sidecar. Preserve default JSON compatibility; do not add fields silently to a closed VerificationReportV1. Missing references and unsupported networks remain explicit nonfatal sidecar results.

Preserve all Chapter 15 exit codes and their precedence: optional identity notFound/unavailable or card failure cannot change a successful core verify exit code. Do not confuse the resolver's notFound with the core receipt's not_found. CLI never loads an operator key, registers, gives feedback or signs.

Acceptance: no-identity and identity-bearing packages retain their original core outcomes; opt-in JSON parses under its own versioned schema; default CLI compatibility holds; verifier independence and privacy tests pass.
</execute_task>

📦 BUILD TASK #10: Reputation feedback stretch branch
🛠️ ACTION TYPE: Extend

<execute_task>
This task is conditional stretch, not a new MVP prerequisite. Implement only if the full testnet gate is true, the Reputation Registry's relationship/ABI is verified, required delivery gates are on schedule, and the operator explicitly elects to spend time on it. Otherwise retain reputationFeedback=false and record not-started/cut accurately; add no dead controls or placeholder success.

Read the deployed ABI and current feedback rules. Add only a reviewer-initiated Record assistant feedback action using the existing Mera/Alchemy transaction path and synthetic demonstration account. The feedback submitter must satisfy the deployed ownership/operator restrictions; do not rate an agent from its owner/operator account or create accounts to manufacture independent reputation.

Build a bounded numeric rating and one fixed generic tag from explicit user input. Exclude matter names, document text, monetary amounts, filenames, receipt commitments, task/session identifiers and links to case material. Leave optional endpoint/feedbackURI/hash fields empty or zero only as permitted by the actual ABI. No off-chain feedback file, free-text field or automatic rating inferred from a review result.

Preview exact chain, target contract, agent ID, value/scale, tag, zero transfer value and fee before signing. Warn that the transaction publicly links the reviewer account to this agent. Registration ownership, contract compatibility, session authority and current account/network must be rechecked before submission.

Keep this separate from ProofOfReviewRegistry review actions and EIP-712 types. Do not widen an existing signing session into arbitrary calls, use the operator registration key, or add another wallet flow. If the existing supported Mera path cannot safely authorise this exact target/method, leave the stretch task blocked.

No automatic post-review feedback. Require its own explicit confirmation/Send, use existing budgets, track pending transactions and reconcile before retrying. Preserve honest Stop semantics: cancel unsent work; never claim cancellation of an already broadcast transaction. Record confirmed event/read-back evidence only after actual confirmation.

When the feature is off, hide it and reject direct/forged execution requests. No feedback score aggregation, trust badge, automatic acceptance policy or core-receipt validity dependency.

Acceptance: off-state tests pass without any live write. If elected and executed manually, a genuine permitted synthetic feedback transaction confirms, contains no case data and is recorded as demonstration feedback—not external adoption or independent endorsement.
</execute_task>

📦 BUILD TASK #11: Protocol compatibility, identity and privacy regressions
🛠️ ACTION TYPE: Validate

<execute_task>
Extend existing test suites rather than adding a second framework. Run all protected Chapter 2 vectors unchanged. Add synthetic agent-configuration artifacts/packages with and without agentIdentity, preserving old artifact-version support. Use newly computed independent expectations for new fixtures only; never regenerate existing goldens.

Run new package vectors through TypeScript and Chapter 15's independent Python checker. Include mutation of chain/registry/ID/cardUri after freeze: old expected references must detect changed bytes. Correctly constructed new packages have different commitments. Removing the optional field from an old supported package remains valid only when verifying that package's own original reference.

Test malformed artifact identity data separately from generic artifact integrity. Hash-correct arbitrary artifact bytes do not prove their identity claims are valid. Test URI/owner/card changes on the external registry without rewriting historical review artifacts or changing core receipt status.

Cover per-registry probe outcomes, partial availability, wrong chain, wrong ABI/proxy version, RPC timeout, known nonexistent token, card errors, stale generations, flag-off traffic, cross-matter identity isolation and default CLI compatibility. Use actual pinned-contract local fixtures where practical; otherwise label controlled adapters accurately. Local results never establish testnet availability or live registration.

For registration, test dry-run, mainnet rejection, key isolation, permission checks, predicted-ID rejection, receipt decoding and retry reconciliation. Exercise reputation tests only for implemented stretch paths, including prohibited owner/operator submission and disabled direct calls. Never run live write tests in CI.

Run affected typecheck/unit/component/build checks, packed SDK/CLI consumer checks, secret scans and Chapter 14 production exclusions. Confirm operator scripts, keys, test contracts and simulated responses are absent from shipped runtime entry points.

Run the existing T0 smoke path with agentIdentity and reputationFeedback off, then with the implemented identity path returning unavailable. Both must preserve review, vault, approval, receipt lifecycle and independent verification. Record missing prerequisites instead of producing a partial green result.

Acceptance: protected schemas/ABI/bytecode/vectors are unchanged, the optional extension interoperates, and failures or disabled features cannot weaken or block the core proof journey.
</execute_task>

📦 BUILD TASK #12: SPEC, QUICKSTART, availability evidence and handoff
🛠️ ACTION TYPE: Extend

<execute_task>
Update docs/SPEC.md, docs/QUICKSTART.md, relevant SDK/CLI/API documentation and docs/build-state.json using the existing validators/evidence writer. Document the implemented branch, exact artifact schema/version, feature conditions, read-only calls, optional CLI flags, result codes, fetch limits and measured network observations.

State accurately: the optional identity reference lives inside the committed agent-configuration artifact; it adds no manifest/reference field and changes no commitment formula or review-registry ABI. Its fields are fingerprinted. Mutable off-chain card contents and later registry ownership/status are not frozen merely by storing a URL. Record the correction to supplied Task 16.7 in Discrepancies found.

Describe current official deployment information as dated source evidence, separately from actual probe results. Do not repeat that testnet addresses are unpublished if current sources list them. Do not claim a successful read, registration, hosted card or feedback transaction unless the corresponding operation occurred.

Explain that registration is discovery, not proof of Qwen execution, agent authorship, legal correctness, human identity, professional qualification or reviewer acceptance. No Validation Registry or BTX integration is used. No ERC-8004 result changes an approved review receipt's lifecycle or overrides the recipient's signer policy.

Keep active integration NOT YET if prerequisites are unknown/unavailable. A completed probe/fallback branch is valid scoped work but is not completed live registration. Preserve separate evidence for implementation tests, mainnet read-only observations, testnet reads, operator registration and optional user feedback. No invented IDs, contract addresses, hashes, timings or sponsor claims.

Update CLAUDE.md and docs/assistant-ui-contract.md within their existing size budgets with actual module paths, commands, boundaries and blockers. Preserve prior chapter records and the remaining 17–19 sequence. Do not automatically enable optional flags just because documentation or a script exists.

Finish with actual edits and concise factual check/discrepancy evidence. Stop after Chapter 16. Do not deploy replacement registries, execute unsanctioned live writes, start Chapter 17 or substitute a standalone terminal JSON summary for the implementation.
</execute_task>
```
