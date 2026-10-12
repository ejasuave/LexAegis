# Practitioner interview guide

**Goal, not a result: 8 to 12 practitioner conversations.** No conversation, pilot or interview has
taken place yet. This guide prepares them; it does not record any, and it does not authorise contacting
anyone. Practitioner interest is not a design partnership, a paying customer or a completed
integration, and a conversation is not a developer integration.

## Purpose

To learn how people who review settlement agreements and similar documents actually work today, where
approvals and source versions get lost, and whether a portable, independently checkable record of an
approved package would help in a real handover. We are looking for **disconfirming** answers as much as
supporting ones.

## Before the call

- **Participation is voluntary.** They can skip any question, stop at any time and withdraw what they
  said afterwards.
- **Ask permission** before recording, taking notes they can be identified from, quoting or naming
  them or their employer. Agree and write down the use: private learning only, anonymous paraphrase,
  or an attributed quotation. Anything not agreed stays private.
- **Never request or accept real client documents, confidential matter details, credentials, private
  openings or usable signatures.** Ask for a fictional example or a description without client
  identifiers. If sensitive material is offered, decline it, say why, and continue with synthetic
  material. Do not copy it into repository notes.
- **Say what the product is not** if asked: it does not decide legal questions, does not replace a
  solicitor's judgement and does not prove who a reviewer is.

## Questions (current behaviour first)

Ask these **before** showing anything. Do not demonstrate the product until section 6.

1. **The current settlement-review workflow.** Walk me through the last settlement agreement you
   reviewed (a description without names is fine): where did the documents come from, who touched them,
   what did you produce and who received it?
2. **Source versions and approvals.** How do you know which version was reviewed and approved? Where is
   that written down? Has the wrong version ever been relied on, or nearly?
3. **A second reviewer.** If someone else checks the work, what do they look at and what do they take on
   trust? What would they want to see to avoid redoing everything?
4. **Rework and missing evidence.** When does a handover go wrong or a file turn out incomplete? What
   do you do then? How often does it happen, roughly?
5. **AI-assisted findings.** If a tool suggested an issue or a summary, when would you trust it, and
   when would you reject it outright? What would you need to see to rely on it, or to refuse to?
6. **A portable receipt (show it only now).** Using a fictional example: a receipt says these exact
   files were approved by this account, and a recipient can check that without your software. In an
   actual handover, would that be useful, harmless or irrelevant? Who would need to see it? What would
   make it unusable for you?
7. **Alternatives you already use.** What do you use today for this (email trails, document management
   systems, e-signature logs, checklists)? What would it take to change, and what would make you not?
8. **Close.** What did I not ask that I should have? May I follow up, and how?

Record **negative and neutral answers** and existing alternatives with the same care as positive ones.
Do not steer toward endorsement: no leading phrasing, no "wouldn't it be useful if", no silence-filling
suggestions. "We would not use this" is a valuable result.

## Notes template

Copy one per participant. Keep names and contact details **out of public artifacts** unless the
participant explicitly permitted that, and then only in the permitted form.

```text
Participant ID: (anonymous, e.g. P-001)
Role / setting: (e.g. solicitor, small firm; legal-tech builder; no employer name unless permitted)
Date:
Consent and attribution permissions: (recording yes/no; notes yes/no; paraphrase yes/no;
  attributed quotation yes/no; naming of person/employer yes/no; date given and how)
Current workflow:
Observed problems (with source versions, approvals, second review, missing evidence):
AI-assisted findings: when trusted, when rejected:
Reaction to a portable receipt (fictional example): useful / harmless / irrelevant, and why:
Existing alternatives:
Objections and negative or neutral answers:
Exact consented quotations (verbatim, with permission):
Paraphrases (clearly marked as the interviewer's words):
Follow-up permission: (yes/no, how, until when)
Sensitive material offered and declined: (yes/no; not copied)
Evidence reference: (path of the stored note under docs/adoption/, or an anonymous private reference
  with a recorded authorised review)
```

## After the call

1. Store the note under the participant ID. Do not mix quotations and paraphrase.
2. Add a row to [`traction-log.md`](./traction-log.md) only if a status event happened (`call held`
   needs this dated, consented note as its evidence). Do not count interest, a promise to try, or a
   meeting that did not occur.
3. Count conversations only from recorded notes. Fewer than eight is a finding, not a failure; say so.
