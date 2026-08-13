# Design write-up

## 1. Architecture

Five layers, with one seam that carries the weight.

```
  Discovery (LLM in the loop)   Replay (no LLM)      Catalog (agent-facing)
              \                      |                      /
               ──────── Policy / guardrails ───────────────
                  allowlist · risk class · redaction
                                 │
                        Surface interface
                   perceive() → Observation
                   act(Action) → ActResult
                                 │
                  WebSurface (Playwright + a11y tree)
              [ future: DesktopSurface, TerminalSurface ]
                                 │
                    Session + control token
                  automation | human | none
```

**Everything above `Surface` is surface-agnostic.** It speaks in observations, element
references, actions and checkpoints — never selectors, frames or coordinates. Adding a
desktop surface means implementing one interface, not touching the artifact schema or the
replay engine.

**Both discovery and replay drive the same `Surface` and pass through the same policy
choke point.** That is what makes the guardrails credible rather than decorative: there
is no code path to the browser that bypasses the check, so the two paths cannot drift
apart and no future change can quietly forget to enforce.

Key decisions and trade-offs:

- **TypeScript + Playwright, single process.** Playwright is a *driver* — it clicks,
  types and waits — but never the source of truth for targeting. The artifact does not
  contain CSS selectors. Targeting resolves through the accessibility ladder, which tags
  the winning element; only then does Playwright act on it, so we still get actionability
  checks, auto-waiting and trusted input events for free. Single process, files for
  storage: the brief explicitly does not reward building queue and cluster
  infrastructure, and none of it would change the abstractions.

- **Perception is the accessibility tree, not the DOM and not pixels.** Legacy screens
  have no test IDs and non-semantic markup, so DOM selectors are brittle by construction;
  coordinates are worse, because they are the least stable thing you could freeze into a
  replayable artifact. The a11y model (role, name, value) is the one vocabulary a browser
  and a desktop app both expose, which is what makes the seam real rather than aspirational.

- **One legacy-specific addition earns its place.** Real core banking screens label
  fields with an adjacent table cell and no `<label for>`. A computed accessible name
  that walks left across the row, then up to the header cell, is what turns
  `<td>Member Number</td><td><input name="f_mbr"></td>` into a control addressable as
  *"Member Number"*. Without it these screens are only navigable by ordinal position.

- **Target application: a local hostile app rather than a public demo site.** Frameset,
  table layout, no test IDs, opaque control names, server-rendered full page reloads —
  plus injectable faults. Section 3.3 grades how replay handles session expiry, permission
  denial and unexpected dialogs; on a public sandbox those are unreachable, so the error
  taxonomy would have stayed theoretical. Faults make them reproducible on demand.

## 2. Artifact schema

`src/schema/artifact.ts`. The shaping principle: **the artifact must be sufficient on its
own.** Nothing replay needs may live in the model transcript — the transcript is kept as
evidence and referenced by digest only.

```
CapabilityArtifact
  schemaVersion   "1.0"                  -- schema evolution, separate from capability version
  capability      { id, version, name, description, status: draft|approved }
  app             { appId, vendor, variantOf, tenantId, entryUrl }
  inputs          Record<name, ParamSpec>    -- typed; carries `sensitivity`
  outputs         Record<name, OutputSpec>   -- typed shape the caller gets back
  outcomes        BusinessOutcome[]          -- declared legitimate non-error answers
  preconditions   Checkpoint[]
  steps           Step[]
  checkpoint      Checkpoint                 -- capability-level success condition
  provenance      { model, runId, discoveredAt, transcriptDigest }
```

Three sub-types do the real work.

**`TargetRef` — an ordered ladder, not a selector.** Most-semantic first:

```
role-name        → a11y role + accessible name           (ports to desktop unchanged)
label-proximity  → "the control right of the text X"     (table layouts with no labels)
anchor-relative  → "the Nth control of role R after X"   (unlabelled rows, image labels)
structural       → form index + control ordinal          (last resort; always present)
```

Plus a `fingerprint` used **only** to verify a match, never to find one. Separating
matching from verification is deliberate — conflating them is how brittle selectors
happen. `framePath` is part of the target because a target that doesn't say which frame
it lives in is not reproducible in a frameset.

**`Checkpoint` — a discriminated union**, so verification is declarative and replayable
(`text-present`, `text-absent`, `element-present`, `url-matches`, `value-equals`), each
with a timeout and a human-readable `description` that surfaces verbatim in failure output.

**`Step.onCondition` — the error taxonomy as data, not as code branches.** Each rule pairs
a `ConditionMatcher` with a `Disposition` of exactly `recover` / `business-outcome` /
`fail` / `escalate`. Putting the taxonomy in the schema means the engine has no way to
express "I'm not sure which of these this is", and a reviewer can see a capability's whole
failure model without reading the executor.

Other choices worth defending:

- **`sensitivity` lives on the parameter spec**, so a capability cannot be defined without
  someone deciding how sensitive its inputs are. It drives redaction everywhere downstream.
- **`status: draft | approved`.** A freshly discovered capability is a draft — an LLM wrote
  it and nobody has read it. Promotion is a human act, and the catalog refuses to expose
  drafts for unattended invocation.
- **`outcomes` are declared up front**, so a calling agent can see every answer a
  capability can give *before* invoking it, and branch instead of treating everything but
  success as a failure.
- **Storage is plain JSON at `artifacts/<id>/v<N>.json`** — git-diffable, so a capability
  change is reviewable in a pull request. That is what "reviewable" has to mean in practice.

## 3. Determinism & error handling

Replay imports no model client, transitively. The per-step control flow is fixed:

```
policy gate → act → detect conditions → dispatch disposition → verify checkpoint
```

**Conditions are checked before the checkpoint**, and that ordering is load-bearing. A
"record not found" banner is the app working correctly; if the checkpoint ran first we
would report a 10-second timeout instead of a clean business outcome — precisely the
conflation the brief warns about. Measured: this path returns in **451ms**. When I
originally had the ordering right but a navigation race wrong, the same case took 12.4s
and only resolved on a late sweep — the evidence for why this ordering matters is in the
run logs.

Determinism comes from four things:

1. **Unique-match-or-fail.** A candidate strategy only counts if it matches exactly one
   element. Ambiguity is treated as no match and falls through, because acting on
   "probably that one" is how automation quietly modifies the wrong account. Tested.
2. **Verify everything.** Every step asserts a checkpoint; nothing assumes a click worked.
3. **Wait for the document, not the load state.** In a frameset, waiting on the *page's*
   load state is useless — the page is the frameset and is already loaded. A click inside
   a child frame navigates only that frame, and `click()` returns before the navigation
   has even started. We poll the frame URL until the document is replaced. Getting this
   wrong cost a full checkpoint timeout per step and made conditions look "missed".
4. **Typed inputs validated pre-flight**, before the browser launches (8ms to reject).

**The result contract** is three statuses that are never conflated:

| Status | Meaning | Exit code |
|---|---|---|
| `success` | Goal reached, `outputs` matches the declared shape | 0 |
| `business_outcome` | A legitimate answer the caller needs (`MEMBER_NOT_FOUND`) | 0 |
| `failure` | Something is wrong | 1 |

A business outcome exits 0 because the *invocation* succeeded; it simply produced a
non-default answer. Failures carry a narrow class — `hard`, `recovery_exhausted`,
`policy_blocked`, `escalation_timeout`, `contract_violation` — plus `expected` and
`observed` lifted straight from the failing checkpoint, so the message is self-describing.
`recovery_exhausted` is deliberately distinct from `hard`: "we recognised this and our fix
didn't work" is a different engineering problem from "we have never seen this state".

**Drift** (secondary, per the brief). Every resolution reports which rung matched. Rung 0
is healthy; anything lower means the surface moved and the artifact is running on a
fallback, so it comes back to the caller as a `drift` entry rather than being swallowed.
A fingerprint mismatch is reported without blocking — drift is information, not a veto.

All of this is exercised in [evidence/](evidence/README.md): four business outcomes, three
recoveries, one contract violation, one escalation.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** The seam is `Surface`: `perceive() → Observation` and
`act(Action) → ActResult`, where an `Observation` is a list of elements each with a role,
a name, a value and a frame path. That vocabulary was chosen as the intersection of what a
browser a11y tree and an OS accessibility API both provide.

- **Legacy web** is already the implemented case — frameset, no test IDs, table layout.
- **Desktop** implements the same interface over UIAutomation / AX. Those APIs return
  control types and names, so `role-name` and `anchor-relative` port directly.
  `label-proximity` becomes "the control to the right within the same group", and
  `structural` becomes a control-tree path. The artifact schema and replay engine are
  unchanged; `framePath` generalises to a window/pane path.
- **Terminal / 3270** is the same story with a coarser element model — a field-addressed
  screen is, structurally, an accessibility tree with one level.

What would need care: coordinate-only surfaces with no accessibility layer at all. There
the ladder degrades to anchor-relative-to-OCR-text, which is real but materially weaker,
and I would want a screenshot-diff checkpoint type to compensate.

**Multi-tenant reuse.** The schema already carries `app.variantOf` and `app.tenantId`.
The intended model, designed but not built:

- A capability recorded against the **base vendor product** has `variantOf: null`. It is
  the shared asset — one recording for all tenants running that product and version.
- A tenant that differs specialises rather than re-records: a small artifact with
  `variantOf: "<base-id>"` and `tenantId`, containing **only the steps whose targets or
  checkpoints actually differ**, merged over the base by step `id`. Branding and layout
  changes typically alter one or two targets, not a flow.
- **Drift detection is already the fleet-health signal.** Every replay reports which
  locator rung carried each step. Aggregated across tenants that share a base capability,
  a rung-0 success rate that decays for one tenant means *that tenant* diverged; decaying
  everywhere means the *vendor* shipped a new version. That turns "which of our 2,000 app
  instances is about to break" into a metric rather than a support ticket.
- Promotion path: record once against the base, replay it in shadow mode across a sample
  of tenants, and let the drift signal decide who needs an override. That is the property
  I care about — new tenants cost a *verification* run, not a *recording* run.

## 5. Escalation & handoff

**Detecting stuck.** Three distinct triggers, all first-class rather than a catch-all:

1. A step's declared condition maps to `escalate`.
2. The policy classifies the step `irreversible` and the profile requires confirmation —
   escalation before anything happens, not after something went wrong.
3. Bounded recovery exhausts its attempts.

**The control-transfer model.** The session owns a token: `automation | human | none`, and
`Surface.act()` asserts it before **every** action. So while a human holds the session,
automation does not merely agree not to act — it throws `ControlDeniedError`. The
guarantee is structural rather than a convention some later change forgets, and the
failure mode is a loud exception in the log rather than two actors fighting over one form.

The sequence:

```
capture screenshot + state  →  file intervention request  →  cede token
   →  block until resolved or timeout  →  take token back  →  RE-VERIFY  →  continue
```

The re-verification step matters: we do not assume the human left the session where we
expect it. If the step declares a checkpoint, it is asserted before the run continues.

**The request payload** carries what an operator actually needs: which capability and
version, which step of how many and its risk class, why automation stopped, expected vs
observed, the redacted inputs, and a screenshot of the live session.

**It is the same session.** The browser is launched headed and the operator drives that
window — same cookies, same server-side session, same half-filled form, mid-flow. Not a
fresh login and no state reconstruction. While they hold control, page-level listeners
record their actions (element-level semantics, never password values) into the run log, so
the handoff is auditable and could later inform a revised artifact.

**Approval is consumed, not sticky.** After a resume, that one step is marked approved so
the retry passes the gate; a later irreversible step escalates again. Getting this wrong
first time produced an infinite escalation loop — the retry hit the same gate.

**Mocked deliberately** (the brief permits it): the operator console is a bare local page,
and the intervention queue is JSON files. Both are real *actors* — the console is a
separate process communicating through the queue, not a function call in a costume. A
production version adds operator identity and auth, a durable queue with routing and SLAs,
and streamed video for operators who cannot reach the host. None of that changes the
protocol.

## 6. Safety

**Placement over cleverness.** The guardrails are enforced inside `Surface.act()` — the
one choke point every action passes through. Discovery and replay are covered by the same
code.

**Discovery is strictly more restricted than replay,** which is the asymmetry I would
defend hardest. During discovery an LLM is choosing actions on a page it has never seen;
it may navigate, read and fill forms, but `irreversible` maps to `escalate` — it records
the step and stops, and the refusal is returned to the model as a message it can reason
about, with an explicit instruction not to route around it. Replay executes a flow a human
has read and approved, so `irreversible` maps to `confirm`. Autonomy during discovery is
not worth the ability to move money.

**Risk classification is conservative by construction.** The recorder classifies from the
step's own semantics and treats anything resembling create/transfer/delete as
irreversible. Over-classifying costs one human confirmation; under-classifying is
unbounded.

**Redaction, three overlapping layers:**

1. *Structural* — artifacts record parameter names and shapes, never values. A capability
   says "takes a memberId matching `^\d{6}$`", not "takes 100442".
2. *Declared* — `sensitivity` drives masking. PII keeps its length and last two characters
   (`****42`), enough to correlate two log lines as being about the same record without
   disclosing it. Secrets become `[REDACTED]`.
3. *Pattern* — a regex sweep for SSNs, card numbers and bearer tokens catches what nobody
   remembered to declare, which is the case that actually causes incidents.

**Fail closed:** an input with no declared sensitivity is treated as PII. Tested.
Credentials never enter the system at all — password fields are read as `undefined` at the
perception layer, so there is no code path that could log one.

**Limits, stated plainly.** The allowlist is origin and path based, so it is *structural,
not semantic*: it cannot distinguish a $10 transfer from a $10M one, because both are a
POST to the same route. Closing that needs a policy engine that inspects action
*parameters* against per-capability limits — the natural next layer, and the schema has
the hook for it (`risk` is per-step and could carry constraints). Redaction is
best-effort on free text; a novel PII format in a page body would reach a log. Screenshots
in evidence are **not** redacted — a real deployment needs region masking driven by the
same sensitivity metadata, and I would not ship this to production without it.

## 7. Cuts

**Deliberately not built:**

- **The discovery run has not been executed.** This machine has no API key, so
  `/evidence/` contains no discovery log. The loop is complete and runnable
  (`src/agent/loop.ts`, one command in the README); the committed artifacts are
  hand-authored fixtures, marked as such in `provenance.model` rather than dressed up as
  discovered output, so that everything else is runnable without a key. I would rather
  ship a labelled fixture than an unlabelled fake — but this is the one gap I would close
  first, and it is the brief's one non-negotiable.
- **Desktop surface** — interface defined and argued, not implemented.
- **Multi-tenant merging** — schema hooks and the drift-based detection story are there;
  no override merge, no second variant app.
- **Operator console** — bare page, file-backed queue, no auth. Seam is real.
- **Screenshot redaction** — noted above as a genuine gap for regulated data.
- **Recovery sub-steps are duplicated in the artifact** rather than referenced as a shared
  sub-flow. Both capabilities repeat the sign-on steps verbatim. A `subflows` section
  referenced by id is the obvious fix and would have been ~30 lines; I left it because the
  duplication is visible and harmless at this size, and shared-subflow versioning is a
  design question I did not want to answer badly.

**What I would build next, in order:**

1. **Run discovery for real** and commit the evidence.
2. **Shared sub-flows** in the schema — sign-on is duplicated across two capabilities
   today and would be duplicated across twenty tomorrow.
3. **Semantic policy limits** — per-capability constraints on action parameters, which is
   the real gap in the safety model rather than a missing feature.
4. **Multi-run stability scoring** — replay each capability N times, publish a flakiness
   signal, and gate unattended invocation on it as well as on human approval. The approval
   gate exists; it is currently binary and human-judged, and it should be evidence-based.
5. **Assisted single-step recovery** — a bounded, policy-checked LLM call for exactly one
   failed step, recorded as evidence and never open-ended. The seam is the
   `recovery_exhausted` failure class, which is already distinct precisely so this can hook
   in without blurring the taxonomy.
