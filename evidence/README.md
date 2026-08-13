# Evidence

Every run in here is real output from `npm run replay` against the live target app.
Regenerate the whole set with `./scripts/capture-evidence.sh` (target app must be running).

Each directory contains `console.txt` (the caller-facing result), `run.jsonl` (the
structured log of what the system did and why), and screenshots / DOM snapshots where a
run captured them.

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

The three groups the brief asks replay to distinguish are all present and never
conflated: **expected business outcomes** (02–04), **recoverable conditions** (05–07),
and **hard failures** (08).

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

**09** — the human-in-the-loop handoff, end to end:

- `console.txt` — the engine pausing at the irreversible step, then completing
- `operator-console.html` — exactly what the operator saw, including the live screenshot
- `intervention-request.json` — the request record with the operator's decision and note
- `run.jsonl` — `escalation.raised` → `control.transfer` → `escalation.resolved`

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

## A note on the v1 artifacts

`v1` of each capability is a **hand-authored fixture**, marked as such in
`provenance.model`, so replay/escalation/catalog run without an API key. `v2` of
`member.read-savings-balance` is the genuinely discovered one
(`provenance.model: claude-opus-5`).
