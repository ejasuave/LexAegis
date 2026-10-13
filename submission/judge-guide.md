# Judge guide

**Status 2026-10-13: the application and the independent verifier are hosted on Railway (Monad
Testnet, chain 10143).**

- Application: https://terrific-joy-production-54e8.up.railway.app
- Independent verifier (no login): https://lexaegis-verifier-production.up.railway.app

Unauthenticated smoke checks pass (`docs/evidence/chapter13-hosted-smoke-2026-10-13.json`). Not yet
verified on the hosted origin: hosted Envio history (unconfigured), real-device Mera ceremonies, and a
registry transaction signed through a real Mera account. The repository is still private (**NOT YET**).

## What you can do today (no account, no hosting)

1. Clone the repository once it is public (**NOT YET**: it is currently private; see
   `docs/release/publication.json`).
2. `pnpm install --frozen-lockfile`, then `pnpm quickstart:check` runs the README's verification
   example against the packed packages.
3. `pnpm hosted:smoke --app https://terrific-joy-production-54e8.up.railway.app --verifier https://lexaegis-verifier-production.up.railway.app` runs the unauthenticated hosted checks (outcome `partial`: person-dependent journeys are `not_run`).
4. The registry itself is real and readable: Monad Testnet, chain 10143,
   `0x453bfd1602d8a8666f55bf9a8d87b127cb94048f` (unaudited). `pnpm verify:deployment -- --public-rpc`
   rebuilds the contract from source and compares it with the deployed code (read-only, no key).

## Hosted path

A judge uses **their own** passkey; no key, shared passkey or
authenticated browser state is ever distributed. Supported browsers and passkey behaviour will be listed
here only after they are observed on the deployed origin. Testnet MON is requested explicitly, is
rate-limited and has a visible global budget; do not assume an unsupported device can finish onboarding.

## Synthetic review (reproducible)

The documents are fictional. Import them through the normal PDF input; no second demo app, pre-approved
gate or hidden recorded assistant exists.

| File                                              | Content                                        | SHA-256                                                            |
| ------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------ |
| `apps/web/public/sample/settlement-original.pdf`  | total £24,000, instalments £10,000 and £12,000 | `7257bb8b1c371a18102945acedc8d5b842b4fdcb2ad7e016da6e1ba3d4907789` |
| `apps/web/public/sample/settlement-corrected.pdf` | total £24,000, instalments £10,000 and £14,000 | `a00cd8bafb96fb3d5f07468b2242c22077a61b84a511ab2e5c11e221751d5beb` |

The assistant should open the **£2,000** gap at its source lines. The **£14,000 what-if** stays
**SIMULATED** until the corrected file is genuinely imported and reviewed as a new version.

## Pre-existing package and receipt reference (NOT YET)

No completed real review has been exported against a deployed registry, so there is **no** pre-issued
package, no public receipt reference and no tampered copy to offer. None is fabricated here. They will
be added only when derived from a real completed export, with the expected reference kept apart from
the package.

## Limits

Supported input is text-bearing PDF (no OCR). Rules are draft until reviewed. The assistant sends
selected plaintext to the model provider; the provider's retention is not known to this application.
Testnet fees apply. Voice is optional and local. A receipt proves that an account committed to an
exact package, **not** legal validity or anyone's qualification.
