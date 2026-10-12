# Adoption targets

This file records **who might be worth talking to** and, separately, **what has actually happened**.
It is not authorisation to contact anyone: nobody is contacted until a person chooses to do so and
records it. It contains no invented names. Interest from a conversation is not a design partnership, a
paying customer or an integration.

Related: [`outreach-messages.md`](./outreach-messages.md) (drafts, not sent),
[`interview-guide.md`](./interview-guide.md), [`traction-log.md`](./traction-log.md) (the only place a
count may come from) and `ROADMAP.md`.

## What exists today (checked 2026-10-12)

Drafts may claim only what this table supports. A generated prompt, a planned README link or a local
example is not "available".

| Item                                        | Built locally                                 | Deployed on testnet                                                               | Publicly accessible                                                                                                                                                     |
| ------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry contract                           | Yes (tested locally and by campaigns)         | Yes: Monad testnet, `0x453bfd16…4048f`, see [`DEPLOYMENTS.md`](../DEPLOYMENTS.md) | The deployed contract is readable on-chain by anyone. Its source matches an explorer verification (Sourcify). It is **unaudited**. Monadscan verification: **NOT YET**. |
| Protocol, SDK, read-only CLI                | Yes                                           | n/a                                                                               | **NOT YET.** Packages are private and unpublished; they install only from local tarballs.                                                                               |
| Independent verifier app                    | Yes                                           | n/a                                                                               | **NOT YET.** No hosted URL is recorded.                                                                                                                                 |
| Embeddable widget, second-domain example    | Yes (local chain evidence)                    | **NOT YET.** No live testnet receipt page; no operator-run testnet issue          | **NOT YET.**                                                                                                                                                            |
| Source repository                           | Yes                                           | n/a                                                                               | **NOT YET.** The GitHub repository is private (checked 2026-10-12).                                                                                                     |
| LexAegis reference application              | Yes                                           | Uses the testnet registry                                                         | **NOT YET** as a hosted service recorded here. Not for client data.                                                                                                     |
| Real-device passkey recovery, live Qwen run | **NOT YET** (open from earlier chapters)      | n/a                                                                               | n/a                                                                                                                                                                     |
| An active receipt on testnet                | **NOT YET** among recorded lifecycle examples |                                                                                   |                                                                                                                                                                         |

Because the repository and packages are not public, any message that points a recipient at "the SDK"
or "the repo" is not ready to send until that changes, or until the sender shares access deliberately.

## Status ladder

One current status per actual relationship or project, in this order only:

`contacted` → `replied` → `call held` → `trial started` → `integrated`

| Status          | Means (and the evidence it needs, per the traction-log rules)                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contacted`     | A real outreach message was sent. Evidence: the sent record.                                                                                                             |
| `replied`       | The person answered. Evidence: the response. A reply is not a call.                                                                                                      |
| `call held`     | A call took place. Evidence: a dated note recorded with the participant's consent. An agreement to meet is not a call.                                                   |
| `trial started` | The person observably attempted the install or an integration. Evidence: an observed attempt.                                                                            |
| `integrated`    | A demonstrably working integration in **the external party's own project**. Team-authored examples and internal trials never count; a GitHub star is not an integration. |

A later status does not prove the earlier ones happened; never fill them in.

## Target segments (not contacts)

These are kinds of people worth considering. Nobody is named, and a segment is not a relationship.

- **Teams building AI agents on Monad, including ERC-8004 agents**: they hand work to other agents or
  humans and may want a portable, checkable record that an exact output package was approved.
- **Legal-technology builders**: they build AI-assisted review tools for solicitors and want a way for a
  recipient to check an approved package without trusting the tool.

## Table 1: teams building AI agents on Monad (including ERC-8004 agents)

| Team / person | Why they fit | Contact route | Status | Date | Evidence reference |
| ------------- | ------------ | ------------- | ------ | ---- | ------------------ |

No rows. A row is added only when an outreach event has actually happened.

## Table 2: legal-technology builders

| Team / person | Why they fit | Contact route | Status | Date | Evidence reference |
| ------------- | ------------ | ------------- | ------ | ---- | ------------------ |

No rows. A row is added only when an outreach event has actually happened.

## Rules for adding a row

1. Record the real event first (the sent message, the reply, the dated consented note).
2. Put an anonymous or permitted identifier in the public row; keep names, contact details and private
   mappings out of public files unless permission is recorded.
3. Add the matching row to [`traction-log.md`](./traction-log.md) with its evidence reference; the
   summary command reads only that log.
