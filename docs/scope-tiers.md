# Scope tiers

<!-- Generated from tooling/src/register.ts by `pnpm scope:docs`. Do not edit by hand. -->

Status is exactly `not-started`, `in-progress`, `verified` or `cut`. A feature is `verified` only
with a passing, current, recorded check; code that exists without one is not verified. A
tier does not remove a dependency: freeze still needs recoverable encrypted storage, approval
still needs a real signer, and the Envio pipeline stays required despite its T2 label.

## T0: the golden path (no submission without it)

| Feature                                   | ID                            | Chapter | Status      |
| ----------------------------------------- | ----------------------------- | ------- | ----------- |
| Document import                           | `document-import`             | 08      | not-started |
| Consent before analysis                   | `consent`                     | 10      | not-started |
| Live Qwen-assisted source-linked findings | `qwen-source-linked-findings` | 09      | not-started |
| Human decision                            | `human-decision`              | 10      | not-started |
| Immutable freeze and verified save        | `freeze-and-verified-save`    | 05      | in-progress |
| Explicit real-signature approval          | `real-signature-approval`     | 04      | in-progress |
| Confirmed Monad testnet receipt           | `confirmed-monad-receipt`     | 06      | not-started |
| Independent verification                  | `independent-verification`    | 11      | not-started |
| Tamper detection                          | `tamper-detection`            | 11      | not-started |
| Supersession and revocation               | `supersession-revocation`     | 03      | in-progress |
| Deployed registry                         | `deployed-registry`           | 06      | in-progress |
| SDK verification                          | `sdk-verification`            | 11      | in-progress |

## T1: required for a credible product and developer story

| Feature                        | ID                           | Chapter | Status      |
| ------------------------------ | ---------------------------- | ------- | ----------- |
| Mera account recovery          | `mera-recovery`              | 04      | in-progress |
| Encrypted vault                | `encrypted-vault`            | 05      | in-progress |
| Payment what-if                | `payment-what-if`            | 08      | not-started |
| Compact labelled orb           | `compact-labelled-orb`       | 10      | not-started |
| Pinned runtime prompts         | `pinned-runtime-prompts`     | 09      | not-started |
| CLI                            | `cli`                        | 15      | not-started |
| Embeddable widget              | `embeddable-widget`          | 18      | not-started |
| Second-domain example          | `second-domain-example`      | 18      | not-started |
| Specification and test vectors | `specification-test-vectors` | 15      | in-progress |
| Quickstart                     | `quickstart`                 | 15      | not-started |
| Judge path                     | `judge-path`                 | 19      | not-started |

## T2: depth and assurance

| Feature                           | ID                      | Chapter | Status      |
| --------------------------------- | ----------------------- | ------- | ----------- |
| Envio history and derived status  | `envio-history`         | 07      | not-started |
| Matter notes                      | `matter-notes`          | 10      | not-started |
| Availability-gated agent identity | `agent-identity`        | 16      | not-started |
| Invariant tests                   | `invariant-tests`       | 17      | in-progress |
| Threat model                      | `threat-model`          | 17      | not-started |
| Verified deployment               | `verified-deployment`   | 17      | not-started |
| Eight evaluation fixtures         | `evaluation-fixtures-8` | 12      | not-started |

## T3: stretch (first to be cut)

| Feature                                               | ID                       | Chapter | Status      |
| ----------------------------------------------------- | ------------------------ | ------- | ----------- |
| Voice                                                 | `voice`                  | 10      | not-started |
| Document comparison                                   | `document-comparison`    | 10      | not-started |
| Matter briefing                                       | `matter-briefing`        | 10      | not-started |
| Reputation feedback                                   | `reputation-feedback`    | 16      | not-started |
| Four additional evaluation fixtures (twelve in total) | `evaluation-fixtures-12` | 12      | not-started |
| Additional visual polish                              | `visual-polish`          | 19      | not-started |
