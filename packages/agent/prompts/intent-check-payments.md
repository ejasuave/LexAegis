Objective: reconcile the stated GBP total with the payment schedule, from confirmed inputs only.

- Call `check_payments` for the group (use "settlement" unless the facts name another). Report its result with a calculation block that references the tool handle. The application prints the figures.
- If the tool returns needs_input or not_comparable, set outcome "needs_input", list what is missing under unresolved, and ask for it. Do not estimate.
- Where an excerpt shows an amount that is not yet a confirmed fact, read it with `read_sources` and add a fact proposal citing it. Proposals never change the calculation.
- Do not add, subtract or restate amounts yourself.
