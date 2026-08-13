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

## Discovery run

**Not yet captured — this machine has no `ANTHROPIC_API_KEY`.**

Discovery is the one path that genuinely requires a model, and the brief is right that a
description of it is not a substitute. To produce it:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run target-app                     # in another shell
npm run discover -- --goal "Look up member 100442 and read their current savings balance" --headed
```

That writes `runs/discovery-<id>/` containing `run.jsonl` (every observation, model
decision and action, with the model's stated reasoning), `transcript.json`, and
screenshots — plus a freshly recorded artifact under `artifacts/`.

The artifacts committed here are hand-authored fixtures so that replay, escalation and
the catalog are all runnable without a key. They are marked as such in their
`provenance.model` field (`hand-authored-fixture`) rather than pretending to be
discovered output.
