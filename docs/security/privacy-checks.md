# Disclosure-boundary checks

Where private material may go, how that is checked, and what was observed. These are **bounded
local checks with planted synthetic canaries**. They do not prove the absence of every encoding,
side channel or same-origin compromise, they say nothing about a real provider's or host's logs, and
they are not an audit.

Chapter 12's full validation run has not happened. These checks reuse the Chapter 10 (HUD and human
approval) and Chapter 9 (assistant) scripted journeys and are recorded as such; Chapter 12 is not
marked complete by them.

## What runs

`pnpm test:privacy:browser` (`tooling/scripts/privacy-browser-check.ts`):

1. runs the two existing journeys through the **rendered controls** (real consent and Send, freeze,
   approval, signing and transaction controllers) with an observation layer attached
   (`tooling/src/privacy/observe.ts`);
2. applies the disclosure matrix (`tooling/src/privacy/analyse.ts`) to everything observed;
3. scans the production assets those runs built (`tooling/src/privacy/assets.ts`).

Everything is test-owned: synthetic PDFs, a CDP **virtual** authenticator, a throwaway PostgreSQL and
S3-compatible server, a **scripted** loopback provider (not Qwen) and a **scripted** chain. No real
credential is instrumented. The temporary observation files hold the synthetic canary values and are
deleted before the command exits; the retained report names canaries by ID and class, never by value.

### Canaries

| Class                                       | Source in the journey                                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `selected_text`, `unselected_text`          | Lines of the synthetic PDF; page 1 is never selected                                                                                                                                 |
| `filename`, `matter_title`, `reviewer_note` | The uploaded file name, the matter title and the reviewer's written reason                                                                                                           |
| `money_field`                               | Confirmed amounts in GBP minor units, matched only as whole values                                                                                                                   |
| `opening_nonce`, `artifact_hash`            | The blinding nonce and artifact digests of the frozen package, and the SHA-256 of the uploaded file                                                                                  |
| `prf_output`, `signing_key`                 | Both PRF results of the virtual authenticator, and the signing key re-derived from each                                                                                              |
| `session_cookie`                            | The opaque backend session value                                                                                                                                                     |
| `storage_credential`, `database_credential` | The synthetic object-store keys and database URL the server runs with                                                                                                                |
| `provider_credential`                       | The scripted provider's placeholder (in browser assets), and the negative controls' marker                                                                                           |
| `vault_key`, `signing_session_secret`       | No extractable value exists in a real journey (keys are non-extractable and held in memory); these classes are exercised by the negative controls and by the stored-`CryptoKey` rule |

Each canary is searched as plain text, JSON-escaped, URL- and form-encoded, hex, base64 and
base64url at all three alignments, and (for bytes) as a decimal array.

### Observation layers

| Layer               | How it is observed                                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Browser storage     | Every **write** is intercepted (`localStorage`, `sessionStorage`, IndexedDB `put`/`add`, `Cache.put`, `document.cookie`), so a value written and deleted is still seen; plus **snapshots** of all stores at seven phases, with `CryptoKey` objects described |
| Browser network     | Every request of the context (pages and workers) with its body and URL; every API response body once its request has finished                                                                                                                                |
| Browser console     | Every message; a request blocked by the Content Security Policy is an attempted disclosure                                                                                                                                                                   |
| Provider            | Every request the scripted provider received                                                                                                                                                                                                                 |
| Server log          | Standard output and standard error of the application server                                                                                                                                                                                                 |
| Server database     | Every row of every application table                                                                                                                                                                                                                         |
| Server object store | Every stored object, byte for byte                                                                                                                                                                                                                           |
| Server egress       | The host and port of every outbound socket the server process opened (a recorder preloaded into the test server; it records no content)                                                                                                                      |
| Built assets        | Client chunks, styles, reachable source maps, emitted HTML and payloads; the server bundle separately; the packed `@lexaegis/protocol` and `@lexaegis/sdk` entry points; the standalone verifier                                                             |

Phases: before the account exists, after unlock, save and fact confirmation, after freeze and save
(HUD) or a consented run (assistant), after approval is signed, after the transaction stage fails or
Stop during a provider wait, after lock, and after reload.

## The disclosure matrix

Anything not listed is forbidden everywhere in plaintext. Ciphertext is opaque: an encrypted object
that contains a canary does not match.

| Material                                                              | May appear                                                                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Selected excerpt, confirmed amounts                                   | The analysis route, the provider request and the returned result, **only in a journey where Send was pressed** |
| Digests in an excerpt's source reference                              | The analysis route and its returned result, under the same consent. **Never the provider**                     |
| Backend session value                                                 | The HttpOnly cookie jar only. Readable by page script is a violation                                           |
| A 65-byte action or sign-in signature                                 | In transit on the authentication and chain routes only. Never at rest, in a log or on another route            |
| Unselected text, file name, matter title, notes                       | Nowhere                                                                                                        |
| Opening nonce                                                         | Nowhere                                                                                                        |
| PRF output, signing key, vault key, session secret                    | Nowhere. A persisted `CryptoKey` is a violation even when it is non-extractable                                |
| Provider, storage and database credentials                            | Nowhere outside the server process                                                                             |
| Any request outside the application origin                            | Violation, as is a request the policy blocked                                                                  |
| Any server connection outside its database, object store and provider | Violation                                                                                                      |
| Cache storage or a service worker                                     | Violation (the application uses neither)                                                                       |

Assets: a browser asset may not name a server-only configuration variable (41 names from
`.env.example` and the test switches), contain a server-only module marker, a canary value, private
fixture text or key material by shape (PEM private key, provider API key, JSON Web Token, credential
in a URL). Every 64-hex-digit value is a candidate and must be **classified against a named public
source** or it is reported; no directory is waved through and not every hash is treated as a leak.
The server bundle is scanned for literal secret values only: reading configuration at run time is
not a client leak.

## Observed

`pnpm test:privacy:browser`, 2026-10-11T20:38:22Z, 111 s, commit `821a23b` (the journeys and the
checker were committed; two unrelated documentation files were uncommitted at the time, so the
evidence records a dirty worktree). Chromium 153, virtual authenticator. **Outcome: pass, 0
violations, 0 asset findings.** Evidence:
[`chapter17-privacy-boundaries-2026-10-11.json`](../evidence/chapter17-privacy-boundaries-2026-10-11.json).

|                                | HUD and human approval                                                    | Assistant                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Journey checks                 | 69 of 69                                                                  | 61 of 61                                                                                                                                         |
| Canaries                       | 27 in 12 classes                                                          | 16 in 11 classes                                                                                                                                 |
| Storage writes intercepted     | 2 (`lexaegis.account-profile.v1`, `lexaegis.voice.preference.v1`)         | 1 (`lexaegis.account-profile.v1`)                                                                                                                |
| Storage snapshots              | 7                                                                         | 7                                                                                                                                                |
| Requests, API responses read   | 177, 90                                                                   | 116, 53                                                                                                                                          |
| Provider request bytes         | 17,079                                                                    | 81,808                                                                                                                                           |
| Stored objects, database bytes | 43, 9,748                                                                 | 35, 11,007                                                                                                                                       |
| Server log bytes               | 250                                                                       | 768                                                                                                                                              |
| Server egress destinations     | 3, all on the allowlist                                                   | 3, all on the allowlist                                                                                                                          |
| Cookies                        | `lexaegis_session` (HttpOnly) only                                        | `lexaegis_session` (HttpOnly) only                                                                                                               |
| Permitted appearances          | session value in the cookie jar; source digests on the analysis route (3) | session value in the cookie jar; source digests on the analysis route (5); a confirmed amount on the analysis route and at the provider (1 each) |
| Violations                     | 0                                                                         | 0                                                                                                                                                |

Assets, per journey build: 32 client files (4.1 MB, one source map, scanned), 8 emitted HTML and
payload files, 437 server-bundle files; 29 `@lexaegis/protocol` and 33 `@lexaegis/sdk` packed files;
4 verifier files. **0 findings.** Key-shaped values classified as public: 13 curve constants from
`@noble/curves`, 2 from the public account-derivation profile, 5 low-entropy patterns, 1 decimal
string, 2 Next.js route-cache keys (classified only when the value is the `routeCache.key` of a
prerender metadata file), 3 values of the public deployment record and the EIP-1967 implementation
slot (computed, not copied).

### What the first complete run found

The first run that completed reported ten items. Each was resolved by its cause, not suppressed:

| Finding                                                        | Cause and resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Artifact digests in the body of `POST /api/assistant/runs`     | **Real and by design.** Each excerpt carries its `lexaegis.source-ref.v1`, which names the SHA-256 of the source file and of its extraction. The consent digest covers it, and it does not reach the provider. The disclosure preview did not say so. Fixed in the consent module: `DISCLOSURE_FACTS` now states it (`apps/web/src/features/assistant/disclosure.ts`), with a regression test (`selected-context.test.ts` :: says on the preview that an excerpt carries the digests of its source, which it does). The matrix permits these digests on the analysis route only, under consent. No wire format changed. |
| The HUD journey was declared as having no consented disclosure | Wrong declaration in the harness: the journey presses Send once, for the excerpt "24,000". Corrected; the two PDF lines it never selects are now `unselected_text`, which is stricter.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `scripted-test-no-key` in the server bundle                    | The documented non-secret placeholder the server sends to the scripted provider. Not a secret, so no longer a server-bundle canary. It remains a canary for every browser asset.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Two 64-hex values in `.meta` files                             | Next.js route-cache keys. Classified by their exact field, as above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| One 64-hex value in the SDK and the verifier                   | The EIP-1967 implementation storage slot, a public standard constant used by the read-only agent-identity resolver. Classified against the computed value.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### Not observed

Stated by the run itself and kept in the evidence:

- **Response bodies of requests that never finished.** A request cut off by a navigation, a lock or
  Stop has no complete body: 3 `GET /api/auth/me`, 2 `GET /api/chain/account` and 1
  `POST /api/assistant/runs` in the HUD journey; 2, 2 and 1 in the assistant journey. The HUD
  journey's single consented result stream is among them; the assistant journey read four complete
  result streams.
- The real model provider: the provider here is a scripted loopback server.
- Session expiry in a browser (idle and absolute limits are covered by unit tests).
- A broadcast transaction (the chain is scripted).
- Storage **writes** made inside a worker (snapshots still see what persisted).
- Memory, and anything outside this machine.
- A key-shaped value added to one of the named public sources (for example the public
  account-derivation profile) would be classified as public. A registered canary is still found.

### The run that did not end, and its fix

The first observed run never finished. The observer asked for every API response body as soon as the
response started and then awaited all of them; a request interrupted by a navigation never reports
that it finished, so that wait never ended, and nothing bounded the journey. Fixed in three places:

- a body is read only after its request **finished**, for at most 5 seconds, and a response that
  never finishes is listed as unobserved instead of awaited (`observe.ts`);
- a storage snapshot is bounded at 15 seconds and a blocked IndexedDB open is an error;
- each journey has an 8-minute limit, after which the **whole process tree** it started (server,
  database, object store, browser) is stopped and the check fails with `JOURNEY_TIMED_OUT`
  (`tooling/src/privacy/run-bounded.ts`, with regression tests in `run-bounded.test.ts`).

A journey that stops early still hands over what it observed, so its failure is analysed.

## Negative controls

A check that has only ever passed has not been shown to detect anything. `pnpm test:privacy:controls`
(`tooling/scripts/privacy-negative-controls.ts`, faults in `tooling/src/privacy/faults.ts`) introduces
**one fault at a time** into the module that owns a boundary and requires the owning check to fail
**for that boundary and that canary**. A crash, a compile error or a missing observation file is not
a detection.

- The faults are applied to a **disposable git worktree** of the tested commit, outside the working
  tree, which is never edited. The worktree, its build output and its services are removed at the end.
- Markers are synthetic and derived from labels; no fault, switch or marker is compiled into a
  shipped entry point (`pnpm exclusion:check`).
- The only "forbidden receiver" is a loopback server started by the control run. The browser's
  request to it is stopped by the Content Security Policy before it leaves the page; the server's
  request reaches that loopback receiver and nothing else.
- After each fault the file is reverted with git, the copy is checked to be clean, and the owning
  check is run again and must pass.
- Owning check: the observed HUD journey and the scan of the assets it built
  (`pnpm test:privacy:browser --journey hud`). A baseline run of the unchanged copy with every fault
  canary registered must pass first.

Observed 2026-10-11T21:03:17Z on commit `841c347` (clean working tree), 1070 s: baseline
**pass**; **13 of 13 faults detected by their intended check and passing again when
restored**. Evidence:
[`chapter17-privacy-negative-controls-2026-10-11.json`](../evidence/chapter17-privacy-negative-controls-2026-10-11.json).

| Fault                                                 | Mistake introduced                                                              | Owning module             | Observed failure                                                                                                                                        | Restored |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `A1-server-secret-in-browser-module`                  | A server-only configuration name and its value are written into a client module | `derivation-profile.ts`   | `SERVER_ENV_NAME` in the client assets (`QWEN_API_KEY`); `CANARY_VALUE` in the client assets (`provider_credential`).                                   | pass     |
| `S1-signing-key-in-localStorage`                      | A signing key is cached next to the public account hint                         | `derivation-profile.ts`   | `CANARY_IN_FORBIDDEN_DESTINATION` at `browser.localStorage`, class `signing_key`.                                                                       | pass     |
| `S2-prf-output-in-sessionStorage`                     | A PRF output is kept for the tab session                                        | `derivation-profile.ts`   | `CANARY_IN_FORBIDDEN_DESTINATION` at `browser.sessionStorage`, class `prf_output`.                                                                      | pass     |
| `S3-vault-key-bytes-in-IndexedDB`                     | Unwrapped vault key bytes are stored in IndexedDB                               | `derivation-profile.ts`   | `CANARY_IN_FORBIDDEN_DESTINATION` at `browser.indexedDB`, class `vault_key`.                                                                            | pass     |
| `S4-session-secret-in-a-script-cookie`                | A signing-session secret is written to a cookie by page script                  | `derivation-profile.ts`   | `CANARY_IN_FORBIDDEN_DESTINATION` at `browser.cookie`, class `signing_session_secret`.                                                                  | pass     |
| `S5-secret-in-the-Cache-API`                          | A response holding a session secret is put into Cache storage                   | `derivation-profile.ts`   | `CACHE_OR_SERVICE_WORKER_USED` at `browser.cache`; `CANARY_IN_FORBIDDEN_DESTINATION` at `browser.cache`, class `signing_session_secret`.                | pass     |
| `S6-secret-written-then-deleted`                      | A PRF output is written to localStorage and removed again at once               | `derivation-profile.ts`   | `CANARY_IN_FORBIDDEN_DESTINATION` at `browser.localStorage`, class `prf_output`.                                                                        | pass     |
| `S7-CryptoKey-in-IndexedDB`                           | A non-extractable CryptoKey is stored in IndexedDB                              | `derivation-profile.ts`   | `CRYPTOKEY_PERSISTED` at `browser.indexedDB`.                                                                                                           | pass     |
| `L1-document-text-through-the-logger`                 | Document text and a file name are passed to the logger as a code                | `assistant/runs/route.ts` | `CANARY_IN_FORBIDDEN_DESTINATION` at `server.log`, class `unselected_text`; `CANARY_IN_FORBIDDEN_DESTINATION` at `server.log`, class `filename`.        | pass     |
| `L2-amount-and-secret-on-the-error-path`              | An error carrying an amount and a credential is printed with its stack          | `assistant/runs/route.ts` | `CANARY_IN_FORBIDDEN_DESTINATION` at `server.log`, class `money_field`; `CANARY_IN_FORBIDDEN_DESTINATION` at `server.log`, class `provider_credential`. | pass     |
| `N1-browser-sends-to-a-forbidden-receiver`            | Client code posts unselected text to another host                               | `derivation-profile.ts`   | `BROWSER_REQUEST_BLOCKED_BY_POLICY` at `request.outside`. Receiver: 0 request(s).                                                                       | pass     |
| `N2-server-sends-to-a-forbidden-receiver`             | A route posts unselected text to another host                                   | `auth/me/route.ts`        | `SERVER_EGRESS_NOT_ALLOWED` at `server.egress`. Receiver: 4 request(s).                                                                                 | pass     |
| `N3-consented-request-with-an-extra-unselected-field` | The request builder adds text that the reviewer never selected                  | `selected-context.ts`     | `CANARY_IN_FORBIDDEN_DESTINATION` at `request.assistant`, class `unselected_text`.                                                                      | pass     |

Notes on what these show:

- **S6** is detected only by the intercepted write. The control fails if a later snapshot is what saw
  the value, so it shows that a write-then-delete is not missed.
- **S5** and **S7** are violations whatever is stored: the application uses no Cache storage, and a
  persisted `CryptoKey` breaks the memory-only rule even when it is non-extractable.
- **N1** is reported as a request the policy blocked: the attempt is the finding. The receiver saw
  nothing from the browser.
- **N2** needs no consent to be detected: `/api/auth/me` is called before any Send.
- **N3** is a request the reviewer did consent to, carrying text they did not select.
- Each fault also made other checks fail (the journey's own checks, the asset scan finding the
  marker in the bundle). Those are not counted as the detection.

Two earlier attempts of the control run stopped before any fault was applied and are not evidence:
the first could not install dependencies offline in a worktree on a temporary filesystem (the copy
now lives on the same disk as the package store), and the second had a baseline that expected
package builds a fresh copy does not have (a single-journey run now checks that journey's assets
only).

## CI and evidence

`.github/workflows/ci.yml` has two jobs for this chapter, in addition to the existing `check` job
(which already runs the unit tests, including the comparator, detector and fault-anchor tests, and
the contract suite):

| Job                    | Runs                                                                                                                                    | Notes                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `security`             | `pnpm threat:check`, `pnpm contracts:test:ci`, `pnpm contracts:static` (pinned Slither 0.11.6), `pnpm test:privacy:browser --no-record` | Bounded, local, synthetic. The contract campaign is the **reduced** `ci` profile, never the full campaign. A tool that did not run fails the job. |
| `deployment-read-only` | `pnpm verify:deployment --public-rpc`                                                                                                   | A separate read-only gate. A failed, unavailable or skipped run is **not** a verified deployment. It does not block other changes.                |

**These jobs have not been observed running on GitHub: NOT YET.** They were added in this chapter and
every command in them was run locally. The negative controls and the full campaigns are not CI jobs.

Recorded results in `docs/build-state.json`: `privacy-boundaries`, `privacy-negative-controls`,
`contract-campaign-full` (two seeds), `contract-campaign-ci`, `deployment-verification`,
`explorer-verification`.
