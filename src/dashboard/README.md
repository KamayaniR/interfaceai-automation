# Dashboard

**Not part of the take-home submission** — that is tagged `submission-v1`. This branch is
the agent-facing product built *on top of* the automation system, which is the boundary
REPORT §1 argues for: the dashboard decides *what* to do, the system underneath is how it
reliably does it.

```bash
npm run target-app     # the legacy app being automated  :3100
npm run dashboard      # this                            :3300
```

Needs `ANTHROPIC_API_KEY` in `.env` — the chat routes through the model.

## What it does

**Catalog browser.** Every capability with its version, approval status, measured
stability and whether it does anything irreversible. Clicking one opens the human review
projection — the same output as `npm run catalog -- review` — plus its recent runs.

**Chat with history.** A goal goes to the router, which either invokes an existing
capability, asks a clarifying question, or reports that nothing matches. Every message is
appended to `sessions/<id>.jsonl` with links back to the `runId` and `capabilityId`, so
the history can be audited rather than just read.

**Evidence from the conversation.** Every result message links its capability *and* its
run. Clicking the run opens the result contract, the step trace, the structured log and
any screenshots — so "why did it do that?" is answerable from the chat rather than by
grepping `runs/`.

**Live intervention alerts.** When a run escalates, an SSE event drives a modal and a
browser notification (works with the tab backgrounded).

## The one constraint

**Replay blocks when it escalates.** The engine sits inside `waitForResolution()` holding
a live browser session — cookies, half-filled form, mid-flow page.

So this dashboard **watches the intervention queue and resolves through it**. It never
calls "resume" on the engine, because there is nothing to call. A request/response shape
there would force the session to be reconstructed, losing exactly what §3.6 requires: the
human operates the *same* session the automation was using.

```
Replay ──escalate──▶ Queue ◀──SSE── Dashboard ──▶ browser notification
   │ (blocked)         ▲                              │
   └──resolved─────────┴──────── operator decides ─────┘
```

Verified end to end: a chat turn opened a sub-account, blocked at the irreversible step,
raised an intervention over SSE, was resolved through the queue, and the same chat turn
returned `newAccountNumber: "100442-S2"`.

## Known gaps

- **No auth.** Anyone reaching the port can resolve an intervention. Real deployment needs
  operator identity, and a check that the approver is not the requester — approving your
  own irreversible action defeats the point of escalating.
- **Operator actions aren't captured here.** The CLI path records what a human did in the
  browser; the dashboard's own resolve endpoint writes an empty `recordedActions`.
- **The chat session and the browser session are deliberately separate.** A conversation
  spans many runs; a browser session belongs to one. They are linked by `runId`, not merged.
- **SSE polls the queue every second** rather than watching the filesystem — `fs.watch`
  semantics vary by platform, and a second is unmeasurable against a human deciding.
