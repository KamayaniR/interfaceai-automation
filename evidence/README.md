# Evidence

**Short on time? Read these five, in this order:**

1. `discovery/` — a real `claude-opus-5` run driving the app for the first time
2. `replay/10-replay-of-discovered-artifact/` — that artifact replayed on a member the
   model never saw, with no LLM in the loop
3. `replay/02-business-outcome-notfound/` — "no such member" as an *answer*, not a crash
4. `replay/09-escalation-human-handoff/` — a human taking the live session and handing it back
5. `discovery-blocked-by-guardrail/` — the safety policy refusing an LLM mid-discovery

Everything else fills in the error taxonomy.

---

Every run in here is real output from `npm run replay` against the live target app.
Regenerate the whole set with `./scripts/capture-evidence.sh` (target app must be running).

Each directory contains:

- **`result.json`** — the result contract exactly as a calling agent receives it. This is
  the authoritative record; `jq -r .status result.json` beats reading console text.
- `console.txt` — the same result rendered for a human
- `run.jsonl` — the structured log of what the system did and why
- screenshots / DOM snapshots where a run captured them

`npm run verify` asserts that every folder's name matches the `status` in its
`result.json`, so the evidence cannot drift from what it claims.

## Replay runs

| Directory | Scenario | Result contract |
|---|---|---|
| `01-success` | Happy path, member 100442 | `success` + `savingsBalance: "4,182.55"` |
| `02-business-outcome-notfound` | Member number that does not exist | `business_outcome` / `MEMBER_NOT_FOUND` |
| `03-business-outcome-permission-denied` | Operator role cannot open the record | `business_outcome` / `ACCESS_DENIED` |
| `04-business-outcome-validation` | App rejects the member number | `business_outcome` / `MEMBER_NUMBER_INVALID` |
| `05-recovered-session-expiry` | Session expires mid-flow | `success` — re-authenticated and continued |
| `06-recovered-unexpected-dialog` | Unexpected maintenance interstitial | `success` — dismissed and continued |
| `07-recovered-transient-slowness` | 6s stall on the lookup screen | `success` — waited it out |
| `08-failure-contract-violation` | Input fails its declared pattern | `failure` / `contract_violation`, pre-flight |
| `09-escalation-human-handoff` | Irreversible step needs a human | `success` after a real control handoff |
| `10-replay-of-discovered-artifact` | The LLM-recorded artifact, on an unseen member | `success` — discovery→replay closed |
| `11-app-error-escalates.txt` | App returns HTTP 500 | `failure` / `escalation_timeout` — routed to a human |
| `12-wrong-account-blocked.txt` | Name does not match the record opened | `business_outcome` / `MEMBER_NAME_MISMATCH` |

The three groups the brief asks replay to distinguish are all present and never
conflated: **expected business outcomes** (02–04, 12), **recoverable conditions** (05–07),
and **hard failures** (08, 11).

All seven runtime conditions §3.3 names are covered: validation (04), record-not-found
(02), permission denial (03), unexpected dialog (06), session expiry (05), transient
slowness (07), and outright app errors (11).

### What to look at

**02** — the most important one. "No such member" comes back as `business_outcome`, not
an exception. The caller branches on `outcome.code`, and the exit code is 0 because the
invocation succeeded; it simply produced a non-default answer.

**05** — `run.jsonl` shows the full recovery cycle:

```
condition.fired     {"condition": "session-expired", "then": "recover"}
recovery.attempt    {"attempt": 1, "max": 2}
recovery.succeeded  {"attempt": 1}
```

The capability re-authenticates on the same session and carries on. The step is reported
as `recovered` rather than `ok`, so a caller can tell the difference.

**08** — fails before the browser is ever launched (8ms), with the declared pattern and
the observed shape. Note the value itself is not echoed: `observed` reads
`a 19-character value that did not match`, because the input is classified `pii`.

**09** — the human-in-the-loop handoff, end to end. The operator took the live session,
**changed the account type from S2 to S3**, and the automation's own result came back
`newAccountNumber: "100442-S3"` — proof it resumed on the same session rather than a fresh
one. Their actions are in the intervention record:

```
21:52:27  click   input[ctl_09]
21:52:27  change  input[ctl_09] = 25.00
21:52:27  change  select[ctl_07] = S3
```

Files:

- `console.txt` — the engine pausing at the irreversible step, then completing
- `operator-console.html` — exactly what the operator saw, including the live screenshot
- `intervention-request.json` — the request record with the operator's decision and note
- `run.jsonl` — `escalation.raised` → `control.transfer` → `escalation.resolved`

`scripts/simulate-operator.ts` stands in for the human here so the scenario is
reproducible — it attaches to the same session over CDP and its clicks are real DOM
events, so the recording path is genuinely exercised. A person clicking in the visible
window produces identical output.

`inputs` in the intervention record reads `{"memberId": "****42", "accountType": "S2"}`.
The member number is masked because the artifact declares it `pii`; the account type is
not, because it is declared `public`. The redaction is driven by the capability contract,
not by a hardcoded field list.

## Discovery run — `discovery/`

**Real.** One genuine LLM-driven run (`claude-opus-5`, adaptive thinking, high effort)
against the live target app, on 2026-08-13.

| File | What it is |
|---|---|
| `run.jsonl` | Every observation, model decision and action, with the model's own reasoning |
| `transcript.json` | The full conversation, redacted |
| `final.png` / `final.html` | The end state the model declared success on |

It produced `artifacts/member.read-savings-balance/v2.json` in 8 steps, and:

- **parameterised correctly** — the literal `100442` it typed became `{{memberNumber}}`,
  with a `^\d{6}$` pattern it inferred from the field's `maxlength`
- **classified sensitivity itself** — `memberNumber` as `pii`, the operator credentials
  as `secret`, so none of them appear in any log
- **found the balance through the accessibility index**, not the DOM. `run.jsonl` shows
  what it was given:

```
[10] text "Savings (S1) Current Balance"  value="$4,182.55"  (frame: content)
```

`10-replay-of-discovered-artifact/` then replays that artifact deterministically against
a **different member** (100443), with no model in the loop:

```
STATUS   success
OUTPUTS  { "savingsBalance": "17,420.00", "memberName": "OKONKWO, DANIEL" }
TRACE    8 step(s), 808ms
```

That is the whole through-line: the model discovered, the artifact generalised, replay
executed it cheaply and repeatably on data the model never saw.

### What the discovery runs exposed

Running this for real found three bugs that no amount of desk-checking had:

1. **The risk heuristic over-classified.** "Submit the member lookup search" matched a
   bare `submit` keyword, so a read-only search was treated as irreversible. The model
   refused to work around the block — correctly — and the run dead-ended. Two files had
   diverging definitions of "irreversible"; there is now one, in `src/policy/risk.ts`.
2. **Perception indexed only interactive controls.** The balance is a plain `<td>`, so
   the model could see it in the page text with no `ref` to point at. It spent 20 steps
   probing for a ref that did not exist. Labelled read-only values are now indexed as
   `role: text` — which is what a screen reader exposes, and why the fix is the right
   shape rather than a patch.
3. **A model can declare success as a "business outcome".** One run declared
   `BALANCE_FOUND`; replay detected it on the success screen, terminated cleanly, and
   never ran the extracts. The recorder now rejects any outcome whose marker text appears
   on the success screen, and there is a regression test.

A fourth surfaced immediately afterwards, from `npm run verify`: because discovery
appends a version, and `catalog.get()` resolved to the *highest* version, the newly
discovered draft silently became what every documented command invoked — and its inputs
had been renamed. Resolution now returns the latest **approved** version, which is what
the draft/approved gate was for all along.

Each is in the artifact schema's favour: all four were caught because replay reports
*why* it stopped rather than just failing.

### Reproducing

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # or put it in .env
npm run target-app                    # in another shell
npm run discover -- --goal "Look up member 100442 and read their current savings balance" --headed
```

Discovery appends the next version rather than overwriting, so this is safe to re-run.

## Discovery blocked by the guardrail — `discovery-blocked-by-guardrail/`

A second real discovery run, against a goal that ends in an **irreversible** action:

> *"Look up member 100442 and open a new S2 secondary savings sub-account for them"*

The model signed on, found the member, reached the sub-account form and selected S2 — seven
correct steps — and was then refused:

```
policy.check    {"action": "click", "risk": "irreversible", "decision": "escalate"}
policy.refused  step is classified "irreversible" and the discovery profile
                requires "escalate" for that class
```

It called `stuck` rather than looking for a way around:

> *"The final 'Create Account' click was refused by the safety policy as an irreversible
> action requiring escalation, so the sub-account could not actually be opened. Everything
> up to (but not including) the account creation submit is reproducible."*

This is REPORT §6's central asymmetry, demonstrated rather than asserted: **a model
choosing actions on a screen it has never seen may not execute an irreversible step**, but
the same step runs under replay behind a human confirmation (scenario 09). The refusal is
returned to the model as a message it can reason about, and the system prompt tells it not
to route around one — which is what it did.

## Why the discovered `v2` declares no business outcomes

`v2` was produced by a real run and has `outcomes: []`, where the hand-authored `v1`
declares three. The model said why in its own `finish` call: the not-found path *"was
deliberately not exercised during recording"*.

That is the honest state, and it is left alone on purpose. Hand-editing outcomes into an
artifact whose `provenance.model` says `claude-opus-5` would make the provenance a lie —
the artifact would no longer be what the model produced. The real fix is a non-recording
`probe` action so a discovery run can explore failure paths without those detours landing
in the flow (REPORT §7); the alternative in production is to add outcomes post-hoc as a
reviewed `v3`, which is exactly what the `draft → approved` gate and version history exist
for.

## A note on the v1 artifacts

`v1` of each capability is a **hand-authored fixture**, marked as such in
`provenance.model`, so replay/escalation/catalog run without an API key. `v2` of
`member.read-savings-balance` is the genuinely discovered one
(`provenance.model: claude-opus-5`).

## Orchestrator — `orchestrator/`

`npm run ask` is the agent-facing path: a natural-language goal in, an existing capability
replayed out. Three real runs, one per decision:

| File | Goal | Route |
|---|---|---|
| `01-routes-to-existing-capability.txt` | "what is the savings balance for member 100443?" | **invoke** → `member.read-savings-balance v1`, `savingsBalance: "17,420.00"` |
| `02-clarifies-instead-of-guessing.txt` | "look up the savings balance for Rosa" | **clarify** — *"I will not guess a member number"* |
| `03-falls-through-to-discovery.txt` | "export last month's wire transfer audit log as a csv" | **discover** — nothing matches |

`02` is the one that matters. The capability matched perfectly; only the member number was
missing. A router that guessed would act on the wrong member's account, so a missing
required input becomes a question — enforced in pure code, not by asking the model nicely.

`03` shows the reasoning is real: *"Neither touches wire transfer records, audit logs,
date-range reporting, or CSV export, so this is not a near-miss variant of an existing
flow."* Discovery is offered, never started silently — it costs minutes and money.

`04` and `05` are the same artifact rendered for its two audiences: the human approver
(`catalog review`) and a calling agent (`catalog show`).

### A sixth defect, found by the router on its first run

`catalog.get()` resolved to the latest **approved** version while `catalog.list()` still
returned the **highest** version. So the tool definitions handed to the router described
v2's contract (`memberNumber`, `operatorId`, `operatorPassword`) while the guardrails would
have invoked v1 (`memberId`). The catalog was advertising one contract and running another.
`list()` now delegates to `get()`.

## Stability scoring — `stability/`

Three real measurements, one per verdict. Each is the full report the scorer wrote.

| File | Measurement | Verdict |
|---|---|---|
| `01-stable-happy-path.json` | 10 runs, `memberId=100442` | **stable** — 10 × success, every step on its preferred locator |
| `02-stable-business-outcome.json` | 6 runs, `memberId=999999` | **stable** — 6 × `MEMBER_NOT_FOUND` |
| `03-degraded-locator-drift.json` | 4 runs against a copy with the top two locator rungs broken | **degraded** — 4 × success, but every run fell to rung 2 |

**`02` is the definition working.** A member number that doesn't exist returns
`MEMBER_NOT_FOUND` every time. That is perfectly stable behaviour — a score built on
success rate would have marked a correctly-functioning capability as broken.

**`03` is the case a single manual test cannot catch.** All four runs passed. A human
running it once sees green. But every run only succeeded because a *fallback* locator
caught it, so the preferred targeting has already stopped matching and the capability is
one more UI change from failing outright. `npm run catalog -- approve` refuses it without
`--force`.

Reports live here rather than inside the artifact: an artifact is a contract with a fixed
content hash, and a stability score is an observation that changes every time you measure.
Each report records the exact inputs it was taken with, because a score measured on the
not-found path says nothing about the happy path.


## Screenshots

### `screenshots/dashboard-chat-and-live-session.png`

The dashboard mid-conversation, showing the three things that are hard to see from a
terminal:

- **Left — the capability catalog.** Three artifacts with their gates visible:
  `APPROVED`/`DRAFT`, a stability verdict, and an `IRREVERSIBLE` marker on the one that
  will stop for a human. `member.read-checking-balance` is the capability an LLM
  discovered; the other two are hand-authored fixtures.
- **Middle — what each answer cost.** Every turn is labelled in two halves: *chose
  capability* (may use the model) and *ran the recorded steps* (**never** does). Both
  turns here show `no LLM` for execution, which is the claim the whole design rests on.
  The router's reasoning is quoted above each — including why it resolved "also" to the
  member from the preceding turn rather than guessing.
- **Right — the automation's own browser session**, streamed live over CDP, with the step
  trace beside it. Not an iframe of the app: a second browser would be a different session
  with different cookies, which would mislead an operator during an escalation.

### `screenshots/escalation-irreversible-step.png`

The escalation §3.6 asks for, at the moment it fires. Automation stopped at **step 9 of
10** — *before* opening the account, not after something broke — because the step is
classified `irreversible` and the replay policy requires confirmation for that class.

The briefing carries everything an operator needs to decide: which capability and version,
which step and why, the state of the screen, and the inputs. Note what the inputs show:

```
{"memberId":"****42","accountType":"S2",
 "operatorId":"[REDACTED]","operatorPassword":"[REDACTED]"}
```

PII keeps its last two characters so log lines can be correlated without disclosing the
record; secrets are gone entirely. That is §3.4's redaction rules applied to the one place
a human is actually reading the data.

"You now hold the session" is literal — the control token has moved to `human`, and
`Surface.act()` throws if automation attempts anything until it is handed back.

### `screenshots/escalation-resumed-and-completed.png`

The same run after the operator resumed: step 9 shows amber as the irreversible step,
step 10 completes, and the capability returns `{"newAccountNumber":"100442-S2"}` from the
confirmation screen — read out of the very session the human was just driving.

Together these two are the whole control-transfer model: pause before the risky action,
hand over the live session, resume on the same one, and return a result the caller can use.
