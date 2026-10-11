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
