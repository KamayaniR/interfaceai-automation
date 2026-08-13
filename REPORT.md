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
And **both discovery and replay pass through the same policy choke point**, so guardrails
can't be bypassed by a future code path that forgets to check.

Decisions worth defending:

- **Playwright is a driver, not the source of truth for targeting.** The artifact holds no
  CSS selectors. Resolution goes through the accessibility ladder (§2), which tags the
  winning element; only then does Playwright act, so we keep its actionability checks and
  trusted input events without inheriting selector brittleness.
- **Perception is the accessibility tree**, not the DOM (brittle on non-semantic markup) and
  not pixels (the least stable thing to freeze into a replayable artifact). Role/name/value
  is the one vocabulary a browser and a desktop app both expose.
- **One legacy-specific addition:** real core banking screens label fields with an adjacent
  table cell and no `<label for>`. Computing the accessible name by walking left across the
  row, then up to the header cell, is what makes `<td>Member Number</td><td><input></td>`
  addressable by name rather than by ordinal.
- **A local hostile app, not a public sandbox.** §3.3 grades session expiry, permission
  denial and unexpected dialogs; on a public site those are unreachable, so the error
  taxonomy would have stayed theoretical. Injectable faults make them reproducible.
- **Single process, files for storage.** The brief explicitly doesn't reward queue and
  cluster infrastructure, and none of it would change these abstractions.

## 2. Artifact schema

`src/schema/artifact.ts`. Shaping principle: **the artifact must be sufficient on its own** —
nothing replay needs may live in the model transcript, which is kept as evidence and
referenced by digest only.

```
CapabilityArtifact
  schemaVersion  "1.0"                    -- separate from the capability's own version
  capability     { id, version, name, description, status: draft|approved }
  app            { appId, vendor, variantOf, tenantId, entryUrl }
  inputs         Record<name, ParamSpec>  -- typed; carries `sensitivity`
  outputs        Record<name, OutputSpec> -- typed shape the caller gets back
  outcomes       BusinessOutcome[]        -- declared legitimate non-error answers
  preconditions  Checkpoint[]
  steps          Step[]
  checkpoint     Checkpoint               -- capability-level success condition
  provenance     { model, runId, discoveredAt, transcriptDigest }
```

**`TargetRef` — an ordered ladder, not a selector**, most-semantic first:

```
role-name        → a11y role + accessible name        (ports to desktop unchanged)
label-proximity  → "the control right of the text X"  (table layouts, no labels)
anchor-relative  → "the Nth control of role R after X"
structural       → form index + control ordinal       (last resort; always present)
```

Plus a `fingerprint` used **only to verify** a match, never to find one. Separating matching
from verification is deliberate: conflating them is how brittle selectors happen. `framePath`
is part of the target, because a target that doesn't name its frame isn't reproducible.

**`Checkpoint`** is a discriminated union (`text-present`, `url-matches`, `element-present`, …)
with a timeout and a human-readable description that surfaces verbatim in failure output.

**`Step.onCondition` is the error taxonomy as data**: each rule pairs a `ConditionMatcher`
with a `Disposition` of exactly `recover` / `business-outcome` / `fail` / `escalate`. The
engine therefore *cannot* express "I'm not sure which of these this is", and a reviewer sees
a capability's whole failure model without reading the executor.

Also: `sensitivity` lives on the parameter spec, so a capability can't be defined without
someone classifying its inputs. `status: draft|approved` gates unattended invocation — a
freshly discovered capability is a draft nobody has read. Storage is plain JSON at
`artifacts/<id>/v<N>.json`, git-diffable, so a capability change is reviewable in a PR.

## 3. Determinism & error handling

Replay imports no model client, transitively. Fixed per-step control flow:

```
policy gate → act → detect conditions → dispatch disposition → verify checkpoint
```

**Conditions are checked before the checkpoint**, and the ordering is load-bearing. A
"record not found" banner is the app working correctly; checkpoint-first would report a
10-second timeout instead of a clean business outcome — the exact conflation the brief warns
about. Measured: 451ms. With a navigation race present, the same case took 12.4s.

Determinism rests on four things:

1. **Unique-match-or-fail.** A strategy counts only if it matches exactly one element.
   Ambiguity falls through, because acting on "probably that one" is how automation quietly
   modifies the wrong account. Tested.
2. **Verify everything** — every step asserts a checkpoint; nothing assumes a click worked.
3. **Wait for the document, not the load state.** In a frameset the page is already loaded,
   so `waitForLoadState` returns instantly while the child frame is mid-navigation. We poll
   the frame URL until the document is replaced.
4. **Typed inputs validated pre-flight**, before the browser launches (8ms to reject).

**Result contract** — three statuses, never conflated:

| Status | Meaning | Exit |
|---|---|---|
| `success` | Goal reached, `outputs` matches the declared shape | 0 |
| `business_outcome` | A legitimate answer (`MEMBER_NOT_FOUND`) | 0 |
| `failure` | Something is wrong | 1 |

A business outcome exits 0 because the *invocation* succeeded. Failures carry a narrow class
— `hard`, `recovery_exhausted`, `policy_blocked`, `escalation_timeout`, `contract_violation` —
plus `expected`/`observed` lifted from the failing checkpoint. `recovery_exhausted` is
deliberately distinct: "we recognised this and our fix didn't work" is a different problem
from "we've never seen this state".

**Version resolution is by approval, not recency.** `catalog.get(id)` returns the latest
*approved* artifact. A discovery run appends a draft that can legitimately change the
contract — the real run here renamed an input — and resolving by recency would silently make
an unreviewed draft what every caller invokes.

**Drift** (secondary, per the brief): every resolution reports which rung matched. Rung 0 is
healthy; lower means the surface moved, and it comes back to the caller rather than being
swallowed. A fingerprint mismatch is reported without blocking.

**What live runs found.** Four defects surfaced only under a real model — a risk heuristic
matching bare `submit`; perception indexing only interactive controls, so a balance rendered
in a `<td>` had no reference to point at; a model declaring success itself as a business
outcome; and the version-resolution hazard above. All four are written up in
`evidence/README.md`, and all four were diagnosable in minutes *because* the result contract
reports which step, what was expected and what was observed.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** `perceive()` yields elements with a role, name, value and frame path
— chosen as the intersection of what a browser a11y tree and an OS accessibility API both
provide. A **desktop** surface implements the same interface over UIAutomation/AX:
`role-name` and `anchor-relative` port directly, `label-proximity` becomes "the control right
of this label within the group", `structural` becomes a control-tree path, and `framePath`
generalises to a window/pane path. Schema and replay engine are unchanged. A
**terminal/3270** surface is the same with a coarser element model. The weak case is a
surface with no accessibility layer at all, where the ladder degrades to
anchor-relative-to-OCR-text and would want a screenshot-diff checkpoint type.

**Multi-tenant reuse.** `app.variantOf` and `app.tenantId` are the hooks. A capability
recorded against the base vendor product carries `variantOf: null` and is the shared asset. A
diverging tenant specialises rather than re-records: a small artifact pointing at the base,
containing only the steps whose targets or checkpoints actually differ, merged by step id.
**Drift is already the fleet-health signal** — aggregated across tenants sharing a base
capability, a rung-0 success rate decaying for one tenant means that tenant diverged;
decaying everywhere means the vendor shipped a new version. New tenants then cost a
*verification* run, not a *recording* run.

## 5. Escalation & handoff

**Detecting stuck** — three distinct triggers: a step's condition maps to `escalate`; the
policy classifies the step `irreversible` and the profile requires confirmation (escalation
*before* anything happens, not after something broke); or bounded recovery exhausts.

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
context. Their actions are recorded (element-level semantics, never password values) into the
intervention record.

**Mocked deliberately:** the console is a bare local page and the queue is JSON files. Both
are real *actors* — separate processes talking through the queue, not a function call in a
costume. Production adds operator identity and auth, a durable queue with routing and SLAs,
and streamed video for operators who can't reach the host. None of that changes the protocol.

## 6. Safety

Enforced in one place — `Surface.act()` — so discovery and replay can't diverge.

**Discovery is strictly more restricted than replay**, the asymmetry I'd defend hardest.
During discovery an LLM is choosing actions on a page it has never seen, so `irreversible`
maps to `escalate`: it records the step and stops, and the refusal is returned as a message it
can reason about, with an explicit instruction not to route around it. Replay executes a
human-reviewed flow, so `irreversible` maps to `confirm`. Autonomy during discovery isn't
worth the ability to move money.

Demonstrated, not just argued: in `evidence/discovery-blocked-by-guardrail/` the model
navigated seven steps correctly, was refused at the "Create Account" click
(`decision: escalate`), and called `stuck` explaining the step needed escalation — rather
than hunting for a way around it. The same step completes under replay in scenario 09,
behind a human confirmation.

**Redaction, three overlapping layers.** *Structural*: artifacts record parameter names and
shapes, never values. *Declared*: `sensitivity` drives masking — PII keeps length and last two
characters (`****42`), enough to correlate log lines without disclosing the record.
*Pattern*: a regex sweep for SSNs, card numbers and tokens catches what nobody declared.
Unclassified inputs **fail closed** as PII (tested). Credentials never enter the system —
password fields read as `undefined` at the perception layer.

**Limits, plainly.** The allowlist is origin/path based, so it is *structural, not semantic*:
it cannot distinguish a $10 transfer from a $10M one, because both are a POST to the same
route. Closing that needs a policy engine inspecting action *parameters* against
per-capability limits. Risk classification is a keyword heuristic over an intent string — it
has no idea whether a button labelled "Continue" commits a wire transfer. And **screenshots
in evidence are not redacted**; a real deployment needs region masking driven by the same
sensitivity metadata, and I wouldn't ship this to production without it.

## 7. Cuts

**Left out deliberately:** desktop surface (interface defined, not implemented); multi-tenant
merging (hooks and the drift story are there; no override merge, no second variant); operator
console auth and durable queue; screenshot redaction; shared sub-flows — both capabilities
repeat the sign-on steps verbatim.

**The cut that bothers me most:** the recorder captures every successful action, so when the
model deliberately probed the not-found path to learn its wording, that detour landed in the
flow. Telling it not to explore fixed the flow but cost the knowledge — the discovered `v2`
declares no business outcomes, where the hand-authored `v1` declares three.
Record-what-happened and record-the-intended-flow are different problems, and the schema is
ahead of the recorder here.

**Next, in order:** (1) a non-recording `probe` action, so discovery can explore failure paths
without polluting the flow — the highest-value fix, because it is what stands between a
discovered artifact and a *complete* one; (2) shared sub-flows in the schema; (3) semantic
policy limits on action parameters, the real gap in the safety model; (4) multi-run stability
scoring, to make the approval gate evidence-based rather than purely human judgement;
(5) bounded, policy-checked single-step LLM recovery, hooking into the `recovery_exhausted`
class that exists precisely so this can be added without blurring the taxonomy.
