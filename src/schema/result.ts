/**
 * The replay result contract — what a calling AI agent actually receives.
 *
 * Three top-level statuses, never conflated. The brief is blunt that mixing "no such
 * member" (an answer) with "the app fell over" (a bug) is the most common design
 * mistake here, so the type system makes it impossible to express the ambiguity: a
 * result is exactly one of success / business_outcome / failure.
 */

import { z } from 'zod';

/** Which rung of the TargetRef ladder actually matched, per step. */
export const DriftReport = z.object({
  stepId: z.string(),
  /** 0 = the preferred strategy matched. >0 means the surface has moved. */
  candidateIndex: z.number().int().min(0),
  strategy: z.string(),
  /** True if the element we found no longer matches the recorded fingerprint. */
  fingerprintMismatch: z.boolean(),
  note: z.string(),
});
export type DriftReport = z.infer<typeof DriftReport>;

export const StepTrace = z.object({
  stepId: z.string(),
  intent: z.string(),
  action: z.string(),
  status: z.enum(['ok', 'recovered', 'skipped', 'failed']),
  startedAt: z.string(),
  durationMs: z.number(),
  /** Populated when a condition matcher fired. */
  conditionFired: z.string().optional(),
  recoveryAttempts: z.number().int().min(0).default(0),
  /** Present when a human took over during this step. */
  humanIntervention: z
    .object({
      requestId: z.string(),
      operator: z.string(),
      actionsRecorded: z.number().int().min(0),
      durationMs: z.number(),
    })
    .optional(),
  error: z.string().optional(),
});
export type StepTrace = z.infer<typeof StepTrace>;

/**
 * Failure classes. Deliberately narrow — every hard stop must be attributable to one
 * of these, which keeps "something went wrong" out of the contract.
 */
export const FailureClass = z.enum([
  /** An unrecognised or unrecoverable app state. The default hard stop. */
  'hard',
  /** A `recover` disposition ran out of attempts. */
  'recovery_exhausted',
  /** The guardrails refused the action. Never a bug — the system working. */
  'policy_blocked',
  /** Escalated to a human, nobody took it in time. */
  'escalation_timeout',
  /** The artifact itself is invalid, or inputs failed validation. Pre-flight. */
  'contract_violation',
]);
export type FailureClass = z.infer<typeof FailureClass>;

export const Evidence = z.object({
  runId: z.string(),
  /** JSONL structured log of everything the run did and why. */
  logPath: z.string(),
  /** Richer signal on failure. */
  screenshots: z.array(z.string()).default([]),
  domSnapshots: z.array(z.string()).default([]),
});
export type Evidence = z.infer<typeof Evidence>;

const ResultBase = z.object({
  capabilityId: z.string(),
  capabilityVersion: z.number().int(),
  runId: z.string(),
  startedAt: z.string(),
  durationMs: z.number(),
  trace: z.array(StepTrace),
  drift: z.array(DriftReport).default([]),
  evidence: Evidence,
});

export const ReplayResult = z.discriminatedUnion('status', [
  /** The capability did what it says on the tin. `outputs` matches the declared shape. */
  ResultBase.extend({
    status: z.literal('success'),
    outputs: z.record(z.unknown()),
  }),

  /**
   * A legitimate business answer the caller needs. NOT an error — callers should
   * branch on `outcome.code`, which is guaranteed to be one the artifact declared.
   */
  ResultBase.extend({
    status: z.literal('business_outcome'),
    outcome: z.object({
      code: z.string(),
      message: z.string(),
    }),
    /** Any outputs extracted before the outcome was reached. */
    outputs: z.record(z.unknown()).default({}),
  }),

  /**
   * Something is wrong. `expected` and `observed` come straight from the failing
   * checkpoint, so the message is self-describing without reading our source.
   */
  ResultBase.extend({
    status: z.literal('failure'),
    failure: z.object({
      class: FailureClass,
      stepId: z.string().nullable(),
      message: z.string(),
      expected: z.string().nullable(),
      observed: z.string().nullable(),
    }),
  }),
]);
export type ReplayResult = z.infer<typeof ReplayResult>;
