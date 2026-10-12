# Traction log

The only place a traction count may come from. `pnpm traction:summary` validates this file and prints the
counts; a pitch may cite only the **evidence-reviewed external** figures it prints, with the status, its
meaning and the as-of date. An honest empty log is valid. It is not failed development and not evidence
of traction.

This log records **current evidence-backed relationship statuses**, one row per actual relationship or
project, so follow-ups do not inflate counts. Dated history belongs in the referenced notes. Counts of
different statuses are not additive and are never a customer count; interest in a conversation is not a
developer integration.

## Row schema (one canonical form)

```text
| Subject ID | Audience | Origin | Status | Observed | Evidence | Evidence review | Attribution |
```

- **Subject ID**: a stable anonymous identifier, 3 to 40 characters (`A-Z a-z 0-9 . _ -`), unique in
  the log. Names, handles and contact details stay out of this file unless attribution permission is
  recorded in the evidence.
- **Audience**: `agent-builders`, `legal-tech` or `practitioners`.
- **Origin**: `internal` (the team, its examples, internal trials) or `external`. Internal rows are
  counted separately and never become external traction.
- **Status**: exactly one of `contacted`, `replied`, `call held`, `trial started`, `integrated`. A later
  status does not prove the earlier ones happened; never fill in a call or a reply from a later status.
- **Observed**: `YYYY-MM-DD`, a real date, not in the future.
- **Evidence**: a specific reference to the event, one of:
  - a safe `https://` link (no credentials, no tokens or signed-link parameters, no fragment);
  - a path under `docs/adoption/evidence/` to a substantive note (`.md` or `.txt`, at least 80
    characters, not a placeholder) or a screenshot or PDF that exists in the repository;
  - `private:<ID>` (for example `private:EV-001`): restricted evidence kept privately under an
    anonymous reference. It counts only with a recorded, authorised review (below); never copy private
    screenshots into this repository to satisfy a check.
  - Not evidence: a placeholder, a bare "yes", `NOT YET`, an empty note, or consent without proof of the
    event. Paths that escape the approved folder, including through symlinks, are rejected.
- **Evidence review**: `pending`, or `reviewed:YYYY-MM-DD:<reviewer-id>` recording that a person looked
  at the evidence and when (not before the observation, not in the future). Unreviewed or inaccessible
  evidence is pending and excluded from the pitch-eligible figures. The check cannot prove an observation
  is genuine; the review record is a human statement.
- **Attribution**: `none`, `anonymous` or `named`: the public attribution permission recorded.

What each status needs as evidence (see [`targets.md`](./targets.md)): `contacted` an actual sent
outreach record; `replied` an actual response; `call held` a dated, consented note (an agreement to
meet is not a call); `trial started` an observed attempt; `integrated` a demonstrably working
integration in the external party's **own** project (a GitHub star is not one). Team-authored examples
and internal install trials never count as external adoption. Disclose assistance, and distinguish an
assisted adoption from independently authored work, in the referenced note.

An issue submitted through a GitHub issue form (`.github/ISSUE_TEMPLATE/integration-report.yml`) is
self-reported interest, not verified adoption; a maintainer reviews it and adds a row here only with
evidence of the event. Nothing is ingested automatically.

## Entries

No entries yet

| Subject ID | Audience | Origin | Status | Observed | Evidence | Evidence review | Attribution |
| ---------- | -------- | ------ | ------ | -------- | -------- | --------------- | ----------- |
