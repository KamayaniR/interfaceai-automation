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

**Conversational follow-ups.** The router sees the last few turns, so answering a
clarifying question works: *"look up the savings balance for Rosa"* → *"What is Rosa's
6-digit member number?"* → *"100442"* → it runs. The window is deliberately short — a
number from three topics back must not become a plausible answer to a new question — and
values recovered from history face the same `ParamSpec` validation as freshly typed ones.

**Live view of CoreVue, side by side with the chat.** While a capability runs, the right
pane streams frames from the automation's *own* browser session over CDP — you watch it
sign on, type the member number and read the balance, next to the conversation that asked
for it.

Deliberately **not** an iframe of `localhost:3100`. A second browser pointed at the same
URL is a different session with different cookies and no sign-on, so it would show
something that looks like the run and isn't. During an escalation that would mislead an
operator into thinking they were driving the automation when they were not — the same
class of error as calling `resume` on the engine. What you see here *is* the session.

The view is read-only: watching is safe, acting is not, because the control token decides
who may act and a clickable viewer would route around it. Taking over still means driving
the headed window — the same session either way. Full co-browsing (forwarding input back
over CDP) is what the brief scopes out.

**Live intervention alerts.** When a run escalates, an SSE event drives a modal and a
browser notification (works with the tab backgrounded).

**Recording new capabilities, without leaving the dashboard.** When nothing in the
catalog matches, the reply carries a **Record this capability** button. Pressing it runs
a real discovery session — you watch the model drive CoreVue in the live pane while its
reasoning and actions stream into the chat — and it lands as a **draft**.

Drafts can't be invoked. Opening one in the drawer gives you the rest of the loop inline:
**Measure** (replays it N times and scores consistency) and **Approve** (refused unless
the measurement supports it, with an explicit force). So the whole lifecycle —
discover → review → measure → approve → invoke — happens in one place, with the same
gates the CLI enforces.

Discovery is behind a confirmation on purpose. It drives a live application with a model
for minutes and costs real money; starting one because a match was fuzzy is the wrong
default. The chat offers it, a human presses it.

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

## Route caching — the last model call removed

Replay never calls a model. Routing did: every chat turn paid one model call just to decide
*which* capability to run, even for a request answered a hundred times before.

The deciding node now checks the catalog first. The key is the **intent**, not the prompt —
values matching a declared input's `pattern` are replaced by a placeholder before lookup:

```
"what is the savings balance for member 100442?"
"what is the savings balance for member 100443?"
                    ↓  both normalise to
"what is the savings balance for member {memberId}?"      ← one cache entry
```

Measured on the running dashboard: **9.44s → 2.60s**, second call model-free, and it
returned the *other* member's balance — the value is re-extracted per request, never stored.

That is also the privacy property. Member numbers are classified `pii`; a cache full of them
would be a quiet second copy of exactly what the redactor exists to keep out of files. Only
the shape is persisted.

Invalidation is structural, not manual. Each entry is stamped with a fingerprint of the
catalog's resolved state — ids, versions, statuses, input names — and any change drops the
whole cache. A cached route pointing at a capability since revoked or superseded would be
wrong on *every* repeat, which is worse than a one-off because it is consistent and silent.
It fails closed: a miss costs one model call, which is what was being paid anyway.

The cache short-circuits the **proposal**, never the checking. A hit still passes through
`applyGuardrails`, so a route cached while a capability was approved stops working the moment
it isn't. The dashboard also skips the cache when the turn has history, because a reply like
`100442` answering a clarifying question has no intent of its own.

Cached to `routes/cache.json` (gitignored — it is derived, and rebuilds itself).

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
