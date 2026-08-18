/**
 * The capability artifact: a typed, versioned, reviewable description of a UI flow.
 *
 * This is the contract between three parties, which is why it is shaped the way it is:
 *
 *   1. The discovery agent, which WRITES it once after a successful LLM-driven run.
 *   2. The replay engine, which READS it forever after with no model in the loop.
 *   3. A calling AI agent (and a human reviewer), who need to understand what the
 *      capability does, what it needs, and what it returns — without reading our code.
 *
 * Design rule that drives everything below: the artifact must be sufficient on its own.
 * Nothing that replay needs may live in the raw model transcript.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Targeting
// ---------------------------------------------------------------------------

/**
 * How we find a control. Deliberately NOT a CSS selector.
 *
 * Legacy bank apps have no test IDs, non-semantic markup, and generated ids that
 * change between releases — so a single selector is a single point of failure. Instead
 * a TargetRef carries an ORDERED LADDER of candidate strategies, most-semantic first.
 * Resolution walks the ladder and stops at the first candidate that matches exactly one
 * element.
 *
 * Which rung matched is reported back in the replay result. Falling to a lower rung
 * still succeeds, but it is a drift signal — the surface moved under us, and the
 * artifact should be re-recorded before the higher rungs stop working entirely.
 */
export const TargetCandidate = z.discriminatedUnion('by', [
  /**
   * Accessibility role + accessible name. The most stable thing on any surface, and
   * the one that ports directly to desktop apps (same a11y APIs, same concepts).
   */
  z.object({
    by: z.literal('role-name'),
    role: z.string(),
    name: z.string(),
    /** Match `name` loosely (case-insensitive substring). Legacy apps pad labels. */
    nameIsSubstring: z.boolean().default(false),
  }),

  /**
   * "The input immediately right of / below the text 'Member Number'."
   * Table-based layouts pair a label cell with an input cell but almost never use
   * <label for>, so proximity is the only semantic link that actually exists.
   */
  z.object({
    by: z.literal('label-proximity'),
    labelText: z.string(),
    direction: z.enum(['right', 'below']).default('right'),
    /** Which control to take if several sit in that direction. */
    index: z.number().int().min(0).default(0),
  }),

  /**
   * "The Nth control of that role after the heading 'Member Lookup'."
   * Survives when labels are images or when the whole row is unlabelled.
   */
  z.object({
    by: z.literal('anchor-relative'),
    anchorText: z.string(),
    role: z.string(),
    offset: z.number().int().min(0),
  }),

  /**
   * Pure ordinal position within a form. Last resort: it works when nothing is
   * labelled at all, but it breaks the moment a field is inserted. Recorded so that
   * a capability degrades rather than dies, and always reported as drift when used.
   */
  z.object({
    by: z.literal('structural'),
    /** -1 means the control is not inside any <form> — scope is the document. */
    formIndex: z.number().int().min(-1),
    controlIndex: z.number().int().min(0),
  }),
]);
export type TargetCandidate = z.infer<typeof TargetCandidate>;

/**
 * Recorded at discovery time. NOT used to find the element — only to verify that what
 * we found still looks like what we recorded, and to quantify drift when it doesn't.
 * Keeping this separate from the candidate ladder is deliberate: matching and
 * verification are different jobs, and conflating them is how brittle selectors happen.
 */
export const TargetFingerprint = z.object({
  tagName: z.string(),
  inputType: z.string().optional(),
  /** Stable-ish attributes only. Never values — values may be PII. */
  attrs: z.record(z.string()).default({}),
});
export type TargetFingerprint = z.infer<typeof TargetFingerprint>;

export const TargetRef = z.object({
  /**
   * Frame path, e.g. ["content"]. Legacy apps are full of framesets and iframes, and
   * a target that doesn't say which frame it lives in is not reproducible.
   */
  framePath: z.array(z.string()).default([]),
  /** Ordered ladder. At least one candidate; index 0 is the preferred strategy. */
  candidates: z.array(TargetCandidate).min(1),
  fingerprint: TargetFingerprint.optional(),
});
export type TargetRef = z.infer<typeof TargetRef>;

// ---------------------------------------------------------------------------
// Checkpoints — "did the thing I asked for actually happen?"
// ---------------------------------------------------------------------------

/**
 * A declarative, replayable assertion about page state.
 *
 * Every step carries one. This is the difference between "I clicked at the right
 * coordinates" and "I reached the state I expected" — the brief calls this out as the
 * single most common failure of naive replay, and it is also what lets a failure
 * message say what was expected vs. what was observed without reading source.
 */
export const Checkpoint = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text-present'),
    /**
     * May contain `{{param}}`, resolved against validated inputs at replay time. That is
     * what lets a capability assert something about the CALLER's intent — "the record on
     * screen is the one you asked for" — rather than only about the app's own chrome.
     */
    text: z.string(),
    framePath: z.array(z.string()).default([]),
    /** Legacy apps shout: "ALVAREZ, ROSA M" should match a caller who typed "Rosa". */
    ignoreCase: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('text-absent'),
    text: z.string(),
    framePath: z.array(z.string()).default([]),
    ignoreCase: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('element-present'),
    target: TargetRef,
  }),
  z.object({
    kind: z.literal('url-matches'),
    /** Regex source, anchored by the caller if desired. */
    pattern: z.string(),
  }),
  z.object({
    kind: z.literal('value-equals'),
    target: TargetRef,
    value: z.string(),
  }),
]).and(
  z.object({
    timeoutMs: z.number().int().positive().default(10_000),
    /** Human-readable. Surfaces verbatim in failure output, so write it for a debugger. */
    description: z.string(),
  }),
);
export type Checkpoint = z.infer<typeof Checkpoint>;

// ---------------------------------------------------------------------------
// Runtime conditions and what to do about them
// ---------------------------------------------------------------------------

/**
 * How we RECOGNISE an exceptional runtime state. Because the UI is stable, the
 * interesting failures aren't layout drift — they're legitimate runtime conditions.
 */
export const ConditionMatcher = z.object({
  /** Stable id for logs and for the outcome mapping. */
  id: z.string(),
  /** Any of these matching counts as a hit. */
  anyOf: z.array(
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('text-present'), text: z.string(), ignoreCase: z.boolean().default(false) }),
      /**
       * The absence of something is a condition too. Asserting that the record on screen
       * belongs to the person the caller named can only be expressed this way: "fire when
       * the expected name is NOT here". Without it the wrong-account check is unstatable.
       */
      z.object({
        kind: z.literal('text-absent'),
        text: z.string(),
        framePath: z.array(z.string()).default([]),
        ignoreCase: z.boolean().default(false),
      }),
      z.object({ kind: z.literal('url-matches'), pattern: z.string() }),
      z.object({ kind: z.literal('element-present'), target: TargetRef }),
    ]),
  ).min(1),
});
export type ConditionMatcher = z.infer<typeof ConditionMatcher>;

/**
 * The error taxonomy, as data rather than as code branches.
 *
 * The brief asks replay to distinguish three things, and conflating them is called out
 * as the most common design mistake. So they are three distinct dispositions here, and
 * the replay engine has no way to express "I don't know which of these this is":
 *
 *   recover          — recoverable condition. Dismiss the interstitial, re-auth, wait
 *                      and retry. Bounded by maxAttempts; exhausting it is a failure.
 *   business-outcome — an expected result the CALLER needs to know about. "No such
 *                      member" is an answer, not a crash. Terminates the run cleanly
 *                      with a declared outcome code.
 *   fail             — hard stop. Something is wrong that we do not understand.
 *   escalate         — we cannot safely proceed; route to a human on the live session.
 */
export const Disposition = z.discriminatedUnion('then', [
  z.object({
    then: z.literal('recover'),
    /** Sub-steps to run to get back on track (dismiss dialog, re-login, ...). */
    recovery: z.array(z.lazy(() => Step)).default([]),
    maxAttempts: z.number().int().min(1).max(5).default(2),
  }),
  z.object({
    then: z.literal('business-outcome'),
    /** Must reference an entry in the artifact's `outcomes`. */
    outcomeCode: z.string(),
  }),
  z.object({
    then: z.literal('fail'),
    message: z.string(),
  }),
  z.object({
    then: z.literal('escalate'),
    reason: z.string(),
  }),
]);
export type Disposition = z.infer<typeof Disposition>;

// ---------------------------------------------------------------------------
// Actions and steps
// ---------------------------------------------------------------------------

/**
 * Values may interpolate typed inputs as `{{memberId}}`. Interpolation is resolved and
 * validated against `inputs` at replay time — an artifact referencing an undeclared
 * parameter fails loudly before the browser is ever touched.
 */
export const Action = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), url: z.string() }),
  z.object({ kind: z.literal('click') }),
  z.object({ kind: z.literal('type'), value: z.string(), clearFirst: z.boolean().default(true) }),
  z.object({ kind: z.literal('select'), value: z.string() }),
  z.object({ kind: z.literal('press'), key: z.string() }),
  /** Reads a value out of the page into a declared output. */
  z.object({
    kind: z.literal('extract'),
    outputName: z.string(),
    /** Which part of the element to read. */
    from: z.enum(['text', 'value']).default('text'),
    /** Optional regex with one capture group, to pull "1,234.56" out of "Balance: $1,234.56". */
    pattern: z.string().optional(),
  }),
  /** Pure assertion step — no interaction, just verify state. */
  z.object({ kind: z.literal('assert') }),
]);
export type Action = z.infer<typeof Action>;

/**
 * Risk class. Drives the guardrails: the policy layer decides per class whether an
 * action is allowed, audited, or must be escalated to a human before it happens.
 *
 *   safe         — read-only / reversible navigation. Search, click a link, read a value.
 *   mutating     — writes state but is correctable. Saving a draft, editing a field.
 *   irreversible — money movement, account creation, anything you cannot take back.
 */
export const RiskClass = z.enum(['safe', 'mutating', 'irreversible']);
export type RiskClass = z.infer<typeof RiskClass>;

// Typed as `unknown` on the input side: several fields carry Zod defaults, so the
// parsed output type is stricter than the accepted input type.
export const Step: z.ZodType<StepType, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    id: z.string(),
    /**
     * Prose, written for the human reviewer: "Type the member number into the lookup
     * field". The artifact is meant to be readable in a pull request.
     */
    intent: z.string(),
    action: Action,
    /** Omitted for `navigate`, required for anything that touches a control. */
    target: TargetRef.optional(),
    risk: RiskClass.default('safe'),
    /** Asserted after the action. Nothing assumes a click worked. */
    waitFor: Checkpoint.optional(),
    /** Checked BEFORE waitFor — an exceptional state is not a checkpoint timeout. */
    onCondition: z.array(z.object({ when: ConditionMatcher, then: Disposition })).default([]),
  })
);

export interface StepType {
  id: string;
  intent: string;
  action: Action;
  target?: TargetRef;
  risk: RiskClass;
  waitFor?: Checkpoint;
  onCondition: { when: ConditionMatcher; then: Disposition }[];
}

// ---------------------------------------------------------------------------
// The capability contract: inputs, outputs, outcomes
// ---------------------------------------------------------------------------

/**
 * `sensitivity` is the hook the redactor uses. It lives on the parameter spec rather
 * than in a separate config so that a capability cannot be defined without someone
 * having decided how sensitive its inputs are.
 */
export const ParamSpec = z.object({
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string(),
  required: z.boolean().default(true),
  /** Regex the value must satisfy. Validated before the run starts. */
  pattern: z.string().optional(),
  sensitivity: z.enum(['public', 'pii', 'secret']).default('public'),
  example: z.string().optional(),
});
export type ParamSpec = z.infer<typeof ParamSpec>;

export const OutputSpec = z.object({
  type: z.enum(['string', 'number', 'money', 'boolean']),
  description: z.string(),
  sensitivity: z.enum(['public', 'pii', 'secret']).default('public'),
});
export type OutputSpec = z.infer<typeof OutputSpec>;

/**
 * An expected, legitimate, non-error result. Declared up front so that a caller can
 * see — before invoking — every answer this capability can give them.
 */
export const BusinessOutcome = z.object({
  code: z.string(),
  description: z.string(),
  /** True if this outcome ends the run (it usually does). */
  terminal: z.boolean().default(true),
});
export type BusinessOutcome = z.infer<typeof BusinessOutcome>;

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

/**
 * `variantOf` and `tenantId` are the multi-tenant seam. Hundreds of institutions run
 * the same vendor product, configured and branded differently. A capability recorded
 * against the base product carries `variantOf: null`; a tenant-specific specialisation
 * points at the base capability and overrides only the steps that actually differ.
 * Not implemented in this slice — but the schema does not have to change to support it,
 * which is the point.
 */
export const AppRef = z.object({
  appId: z.string(),
  vendor: z.string(),
  /** Capability id this one specialises, if any. */
  variantOf: z.string().nullable().default(null),
  tenantId: z.string().nullable().default(null),
  entryUrl: z.string(),
});
export type AppRef = z.infer<typeof AppRef>;

export const CapabilityArtifact = z.object({
  /** Schema evolution. Separate from the capability's own version. */
  schemaVersion: z.literal('1.0'),

  capability: z.object({
    id: z.string(),
    /** Bumps on any change to steps or targets. */
    version: z.number().int().positive(),
    name: z.string(),
    description: z.string(),
    /**
     * Gate for unattended execution. A freshly discovered capability is a `draft`:
     * an LLM wrote it and no human has looked at it yet. Promotion to `approved` is a
     * human act, and the catalog refuses to expose drafts for unattended invocation.
     */
    status: z.enum(['draft', 'approved']).default('draft'),
  }),

  app: AppRef,

  inputs: z.record(ParamSpec).default({}),
  outputs: z.record(OutputSpec).default({}),
  outcomes: z.array(BusinessOutcome).default([]),

  /** Asserted before step 1 — "are we even on the right app / logged in?" */
  preconditions: z.array(Checkpoint).default([]),

  steps: z.array(Step).min(1),

  /** The success condition for the capability as a whole. */
  checkpoint: Checkpoint,

  provenance: z.object({
    model: z.string(),
    runId: z.string(),
    discoveredAt: z.string(),
    /**
     * Digest only. The raw transcript is evidence, kept beside the run; the artifact
     * deliberately does not embed it, so the reusable capability stays decoupled from
     * the model conversation that happened to produce it.
     */
    transcriptDigest: z.string(),
    /**
     * sha256 over the canonical artifact, excluding this field. Optional because
     * artifacts recorded before content addressing existed are still valid — but when
     * present, replay verifies it, so approval binds to content rather than to a
     * version number someone could edit around.
     */
    contentHash: z.string().optional(),
  }),
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifact>;

/** Parse + validate. Throws a readable ZodError on a malformed artifact. */
export function parseArtifact(raw: unknown): CapabilityArtifact {
  return CapabilityArtifact.parse(raw);
}
