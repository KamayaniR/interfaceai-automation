# Design write-up

## 1. Architecture

```
  Discovery (LLM in the loop)   Replay (no LLM)   Catalog (agent-facing)
              \                      |                   /
               ─────── Policy / guardrails ─────────────
                  allowlist · risk class · redaction
                                 │
                        Surface interface
              perceive() → Observation ; act(Action) → ActResult
                                 │
                  WebSurface (Playwright + a11y tree)
              [ future: DesktopSurface, TerminalSurface ]
                                 │
              Session + control token (automation|human|none)
```

Two properties do the work. **Everything above `Surface` is surface-agnostic** — it speaks
in observations, element references, actions and checkpoints, never selectors or frames.
And **discovery and replay share one policy choke point**, so guardrails can't be bypassed
by a future code path that forgets to check.

**The router sits outside that boundary, deliberately.** `npm run ask` turns a goal into a
decision — match a capability, ask a question, or record a new one — as a *client* of the
catalog. The brief draws this line ("the agent-facing product decides what to do; this
system is how it reliably and safely does it"), and it is load-bearing: a bank that won't
put an LLM in that path can swap it for a rules engine and every safety property holds,
because the gates it must pass — approval status, `ParamSpec`, policy — are enforced
elsewhere.

- **Playwright is a driver, not the source of truth for targeting.** The artifact holds no
  CSS selectors: the accessibility ladder (§2) resolves and tags the element, then Playwright
  acts — keeping its actionability checks and trusted input events without the brittleness.
- **Perception is the accessibility tree**, not the DOM (brittle on non-semantic markup) and
  not pixels (the least stable thing to freeze into an artifact). Role/name/value is the one
  vocabulary a browser and a desktop app both expose. One legacy addition: core banking
  screens label fields with an adjacent cell and no `<label for>`, so the accessible name is
  computed by walking left across the row then up to the header — which makes
  `<td>Member Number</td><td><input></td>` addressable by name rather than ordinal.
- **A local hostile app, not a public sandbox.** §3.3 grades session expiry, permission
  denial and unexpected dialogs; on a public site those are unreachable and the taxonomy
  would have stayed theoretical. Injectable faults make them reproducible.
- **Single process, files for storage.** The brief doesn't reward queue and cluster
  infrastructure, and none of it would change these abstractions.

## 2. Artifact schema

`src/schema/artifact.ts`. Shaping principle: **the artifact is sufficient on its own** —
nothing replay needs may live in the transcript, which is evidence, referenced by digest.

```
CapabilityArtifact
  schemaVersion  "1.0"                    -- separate from the capability's own version
  capability     { id, version, name, description, status: draft|approved }
  app            { appId, vendor, variantOf, tenantId, entryUrl }
  inputs         Record<name, ParamSpec>  -- typed; carries `sensitivity` and `source`
  outputs        Record<name, OutputSpec> -- typed shape the caller gets back
  outcomes       BusinessOutcome[]        -- declared legitimate non-error answers
  preconditions  Checkpoint[]
  steps          Step[]
  checkpoint     Checkpoint               -- capability-level success condition
  provenance     { model, runId, discoveredAt, transcriptDigest, contentHash }
```

**`TargetRef` — an ordered ladder, not a selector**, most-semantic first:

```
role-name        → a11y role + accessible name        (ports to desktop unchanged)
label-proximity  → "the control right of the text X"  (table layouts, no labels)
anchor-relative  → "the Nth control of role R after X"
structural       → form index + control ordinal       (last resort; always present)
```

Plus a `fingerprint` used **only to verify** a match, never to find one. Separating matching
from verification is deliberate — conflating them is how brittle selectors happen. `framePath`
is part of the target, because a target that doesn't name its frame isn't reproducible.

**`Checkpoint`** is a discriminated union (`text-present`, `text-absent`, `url-matches`,
`element-present`, `value-equals`) with a timeout and a description that surfaces verbatim on
failure. Its text may contain `{{param}}`, which lets a capability assert something about the
*caller's intent*, not just the app's chrome (§3).

**`Step.onCondition` is the error taxonomy as data**: each rule pairs a `ConditionMatcher`
with a `Disposition` of exactly `recover` / `business-outcome` / `fail` / `escalate`. The
engine therefore *cannot* express "I'm not sure which of these this is", and a reviewer sees
a capability's whole failure model without reading the executor.

**Approval binds to content, not a version number.** `provenance.contentHash` is a sha256
over the canonical artifact excluding itself, and replay refuses to run on a mismatch.
Without it, `status: "approved"` is a mutable field inside the document it approves —
nothing stops someone editing a step and leaving the status alone. Canonicalisation sorts
keys, so a reformat isn't mistaken for tampering.

**One artifact, two projections.** §3.2 asks for reviewability by "both a human reviewer and
a calling agent". Diffable is not understandable: 250 lines of nested locator ladders get
skimmed, which makes the approval gate theatre. `catalog show` renders the typed contract for
agents; `catalog review` renders what an approver must judge — steps in plain language, what
each verifies, the failure model, whether anything is irreversible. Neither is stored.

`sensitivity` lives on the parameter spec, so a capability can't be defined without someone
classifying its inputs; `source` says whether a value comes from the caller or the runtime
(§6). Storage is plain JSON at `artifacts/<id>/v<N>.json`, so a change is reviewable in a PR.

## 3. Determinism & error handling

Replay imports no model client, transitively. Fixed per-step control flow:

```
policy gate → act → detect conditions → dispatch disposition → verify checkpoint
```

**Conditions are checked before the checkpoint**, and the ordering is load-bearing. A
"record not found" banner is the app working correctly; checkpoint-first would report a
10-second timeout instead of a clean business outcome — the exact conflation the brief warns
about. Measured: 451ms, against 12.4s with a navigation race present.

Determinism rests on four things:

1. **Unique-match-or-fail.** A strategy counts only if it matches exactly one element.
   Ambiguity falls through, because acting on "probably that one" is how automation quietly
   modifies the wrong account. Tested.
2. **Verify every state change.** Each step that navigates or clicks asserts a checkpoint —
   nothing assumes a click worked. Steps that cannot change page state (typing into a
   field, extracting a value) carry none; an extract that cannot resolve its target
   already fails loudly, and a checkpoint there would assert the page it just read.
3. **Wait for the document, not the load state.** In a frameset the page is already loaded,
   so `waitForLoadState` returns instantly while the child frame is mid-navigation. We poll
   the frame URL until the document is replaced.
4. **Typed inputs validated pre-flight**, before the browser launches (8ms to reject).

**Result contract** — three statuses, never conflated: `success`, `business_outcome` (a
legitimate answer such as `MEMBER_NOT_FOUND`), and `failure`. The first two exit 0, because
the *invocation* succeeded. Failures carry a narrow class — `hard`, `recovery_exhausted`,
`policy_blocked`, `escalation_timeout`, `contract_violation` — plus `expected`/`observed`
lifted from the failing checkpoint. `recovery_exhausted` is deliberately distinct:
"we recognised this and our fix didn't work" is not "we've never seen this state".

All seven runtime conditions the brief names are handled and reproducible via `--fault`. The
instructive one is an **HTTP 500, which escalates rather than retries**: "the app is broken
right now" and "the app answered no" both stop the run, but only one is the system working,
and blind retry against an unhealthy core is worse than asking a person.

**Identity is asserted, not assumed.** A contract of `memberId → savingsBalance` answers
"what is Rosa's balance?" with someone else's money if the caller supplies the wrong number —
the name never enters the contract, so nothing downstream can notice. Router intelligence
can't fix that: a model comparing names is a suggestion, a checkpoint is enforcement. So
capabilities take an optional `expectedName`, assert it against the record on screen *before*
extracting anything, and return `MEMBER_NAME_MISMATCH` without a balance. `memberName` is
returned unconditionally, so every answer says which record produced it. The check is inert
when omitted — a check nobody can satisfy gets disabled rather than fixed.

**Version resolution is by approval, not recency.** `catalog.get(id)` returns the latest
*approved* artifact. A discovery run appends a draft that can legitimately change the contract
— the real run here renamed an input — and resolving by recency would silently make an
unreviewed draft what every caller invokes.

**Drift** (secondary, per the brief): every resolution reports which rung matched. Rung 0 is
healthy; lower means the surface moved, and it reaches the caller rather than being swallowed.

**What live runs found.** Six defects surfaced only under a real model — a risk heuristic
matching bare `submit`; perception indexing only interactive controls, so a balance in a
`<td>` had no reference; a model declaring success itself as a business outcome; the
version-resolution hazard above. All are in `evidence/README.md`, and all were diagnosable in
minutes *because* the result contract reports step, expected and observed.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** `perceive()` yields elements with role, name, value and frame path —
the intersection of what a browser a11y tree and an OS accessibility API both provide. A
**desktop** surface implements the same interface over UIAutomation/AX: `role-name` and
`anchor-relative` port directly, `label-proximity` becomes "the control right of this label
within the group", `structural` becomes a control-tree path, `framePath` a window/pane path.
Schema and replay engine are unchanged; a **terminal/3270** surface is the same with a coarser
element model. The weak case is a surface with no accessibility layer, where the ladder
degrades to anchor-relative-over-OCR.

**Multi-tenant reuse.** `app.variantOf` and `app.tenantId` are the hooks. The capability
recorded against the base vendor product is the shared asset; a diverging tenant specialises
rather than re-records — an artifact pointing at the base, holding only the steps whose
targets or checkpoints differ, merged by step id. **Drift is already the fleet-health
signal**: aggregated across tenants sharing a base, a rung-0 success rate decaying for one
tenant means that tenant diverged; decaying everywhere means the vendor shipped a new version.
New tenants then cost a *verification* run, not a *recording* run.

## 5. Escalation & handoff

**Detecting stuck** — four triggers: a step's condition maps to `escalate`; the policy
classifies a step `irreversible` and the profile requires confirmation (escalation *before*
anything happens, not after something broke); bounded recovery exhausts; or discovery dead-ends.
That last escalates *before the browser closes*, because "this app cannot do this" needs a
person on the live session to confirm — they either demonstrate the flow or record a
human-verified negative. Resume is not the only valid resolution.

**Control transfer.** The session owns a token — `automation | human | none` — and
`Surface.act()` asserts it before **every** action. While a human holds the session,
automation doesn't merely agree not to act; it throws. Structural, not conventional.

```
capture state → file request → cede token → block until resolved
  → take token back → RE-VERIFY → continue
```

Re-verification matters: we don't assume the human left the session where we expect it.

**It is the same session.** The browser is headed and the operator drives that window — same
cookies, same server-side session, same half-filled form. In
`evidence/replay/09-escalation-human-handoff/`, the operator changed the account type to S3
and the automation's own result came back `100442-S3`. That is the proof it isn't a fresh
context. Their actions are recorded — element-level semantics, never values — into the
intervention record.

**Mocked deliberately:** the console is a bare local page and the queue is JSON files — but
they are real *actors*, separate processes talking through a queue, not a function call in a
costume. Production adds operator identity and auth, a durable queue with routing and SLAs,
and streamed video. None of that changes the protocol.

## 6. Safety

Enforced in one place — `Surface.act()` — so discovery and replay can't diverge.

**Discovery is strictly more restricted than replay**, the asymmetry I'd defend hardest.
During discovery an LLM chooses actions on a page it has never seen, so `irreversible` maps to
`escalate`: it records the step and stops, and the refusal returns as a message it can reason
about, with an explicit instruction not to route around it. Replay executes a human-reviewed
flow, so `irreversible` maps to `confirm`. Autonomy during discovery isn't worth the ability
to move money. Demonstrated, not argued: in `evidence/discovery-blocked-by-guardrail/` the
model navigated seven steps correctly, was refused at "Create Account", and called `stuck`
rather than hunting for a way around it. The same step completes under replay in scenario 09,
behind a human confirmation.

**Redaction, three overlapping layers.** *Structural*: artifacts record parameter names and
shapes, never values. *Declared*: `sensitivity` drives masking — PII keeps length and last two
characters (`****42`), enough to correlate log lines without disclosing the record. *Pattern*:
a regex sweep for SSNs, card numbers and tokens catches what nobody declared. Unclassified
inputs **fail closed** as PII.

**Credentials are session infrastructure, not arguments.** §3.4 says never persist secrets,
and the subtle way to violate it is to accept one as a caller argument — the discovered
capability parameterised the operator sign-on, which would have an agent ask a person to type
a service password into a chat window, landing it in conversation history and a model's
context. So `ParamSpec.source` distinguishes `caller` from `runtime`. Runtime inputs are
hidden from the tool definition an agent sees, dropped if a model fills them anyway, resolved
from the environment, and validated pre-flight — a missing credential fails as
`contract_violation` before a browser launches. The recorder reclassifies any `secret` at
record time and the router refuses a caller-supplied one outright, so no artifact contains a
credential literal.

**Limits, plainly.** The allowlist is origin/path based, so it is *structural, not semantic*:
it cannot distinguish a $10 transfer from a $10M one, because both are a POST to the same
route. Closing that needs a policy engine inspecting action *parameters* against
per-capability limits. Risk classification is a keyword heuristic over an intent string — it
has no idea whether a button labelled "Continue" commits a wire transfer. And **screenshots in
evidence are not redacted**; a real deployment needs region masking driven by the same
sensitivity metadata, and I wouldn't ship this to production without it.

## 7. Cuts

**Stretch goals: one thread, not three features.** I took *confidence & approval* and built
what it requires. An approval gate is theatre without evidence, so `npm run stability` replays
N times and scores **consistency, not success rate** — a capability returning
`MEMBER_NOT_FOUND` every time is behaving perfectly, while all-green runs that only passed on
a fallback locator score `degraded`: green and rotting. That gates promotion (`catalog
approve` refuses an unmeasured or degraded capability without `--force`). An approved
capability is worthless if nothing can call it, so the catalog exposes each artifact as a
typed tool definition. Scores live in `stability/`, never inside the artifact: an artifact is
a contract with a fixed content hash, a score is an observation that changes every time.

**Left out deliberately:** desktop surface (interface defined, not implemented); multi-tenant
merging (hooks and the drift story are there; no override merge, no second variant); operator
console auth and durable queue; screenshot redaction; shared sub-flows.

**Storage: files, not a document DB, and not sub-flow references at runtime.** A DB wins on
search and loses on review (§2) — a change becomes a diff inside one blob, with no
per-capability history. References are worse: re-recording `sign-on@v1` for a new MFA step
would silently change an `approved` capability while its file, version and diff stayed
identical, so approval would stop meaning anything. The right shape is compose at author
time, **flatten at publish**, record what it composed from, and add a *derived* index when
search hurts. Most duplication isn't a sub-flow problem anyway — sign-on is session
infrastructure. An artifact declaring "I need an authenticated session on corevue", satisfied
once and amortised across a hundred replays, beats both copying and referencing.

**The cut that bothers me most:** the recorder captures every successful action, so when the
model deliberately probed the not-found path to learn its wording, that detour landed in the
flow. Telling it not to explore fixed the flow but cost the knowledge — the discovered `v2`
declares no business outcomes where the hand-authored `v1` declares four.
Record-what-happened and record-the-intended-flow are different problems, and the schema is
ahead of the recorder here.

**Checkpoint derivation is the weakest part of the recorder.** Discovered artifacts infer
per-step checkpoints from what changed on screen, and that under-covers — a click that
navigates sometimes gets none. The cause is the frameset: `resultingText` joins every frame,
so chrome pollutes the diff. Hand-authored artifacts avoid it by scoping to
`framePath: ['content']`. The fix is per-frame text in the recorder, a change to the recording
shape rather than a smarter heuristic. Left named rather than half-done. **Bounded retry
through a frameset** defeated me similarly: recovery must navigate back through the frameset,
but `framePath: ['content']` exists only at the root URL, so every variant resolved the wrong
control. Escalating a 500 is defensible on its merits — it is also what I could make correct.

**Checkpoint derivation is the weakest part of the recorder.** Discovered artifacts get
per-step checkpoints inferred from what changed on screen, and that under-covers: a click
that navigates sometimes gets none. The cause is the frameset again — `resultingText`
joins every frame, so chrome pollutes the diff. The hand-authored artifacts avoid it by
scoping checkpoints with `framePath: ['content']`. The fix is carrying per-frame text
through the recorder and emitting frame-scoped checkpoints, which is a change to the
discovery loop's recording shape rather than a smarter heuristic. Left named rather than
half-done.

**Next, in order:** (1) a non-recording `probe` action, so discovery can explore failure paths
without polluting the flow — the highest-value fix, because it stands between a discovered
artifact and a *complete* one; (2) a session provider satisfying `preconditions`, subsuming
both sub-flows and credentials; (3) semantic policy limits on action parameters, the real gap
in the safety model; (4) bounded, policy-checked single-step LLM recovery, hooking into the
`recovery_exhausted` class that exists precisely so it can be added without blurring the
taxonomy.
