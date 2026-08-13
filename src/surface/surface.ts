/**
 * The Surface abstraction — the seam between "how we perceive and act on a surface"
 * and "the recorded flow".
 *
 * Everything above this line (agent loop, replay engine, policy, escalation) is
 * surface-agnostic. It speaks in observations, element references, actions and
 * checkpoints. Nothing above this line knows what a CSS selector or a frame is.
 *
 * That is what makes the design extend. A desktop surface driven by the OS
 * accessibility APIs (UIAutomation / AX) implements exactly this interface: it can
 * enumerate controls with a role, a name and a value, it can click and type into them,
 * and it can screenshot. The artifact schema and the replay engine do not change —
 * only `WebSurface` gets a sibling. A terminal / 3270 green-screen surface is the same
 * story with a coarser element model.
 */

import type { TargetRef, Action } from '../schema/artifact.ts';

/**
 * One perceivable element. This vocabulary is deliberately the intersection of what
 * a browser a11y tree and a desktop a11y tree can both provide.
 */
export interface ObservedElement {
  /**
   * Ephemeral handle, valid only within the observation that produced it.
   *
   * The LLM acts by `ref`, never by selector — so the model is structurally incapable
   * of inventing a brittle locator. Durable targeting is TargetRef's job, and the
   * recorder converts a ref into a TargetRef ladder when it writes the artifact.
   */
  ref: number;
  role: string;
  name: string;
  value?: string;
  framePath: string[];
  /** Recorded so the artifact can carry a verification fingerprint. */
  tagName: string;
  inputType?: string;
  attrs: Record<string, string>;
  /** Ordinal position, for the last-resort structural strategy. */
  formIndex: number;
  controlIndex: number;
  /** Nearby text used to synthesise the label-proximity and anchor-relative rungs. */
  labelHint?: string;
  disabled: boolean;
}

export interface Observation {
  url: string;
  title: string;
  /** Interactive controls plus text-bearing landmarks the model may need to read. */
  elements: ObservedElement[];
  /** Flattened visible text per frame, for checkpoint and condition evaluation. */
  text: { framePath: string[]; content: string }[];
  capturedAt: string;
}

export interface ActResult {
  ok: boolean;
  /** Populated by `extract`. */
  extracted?: string;
  error?: string;
  /** Which rung of the TargetRef ladder matched, when resolution was involved. */
  resolution?: {
    candidateIndex: number;
    strategy: string;
    fingerprintMismatch: boolean;
  };
}

/** Who is allowed to drive the surface right now. See escalation/broker.ts. */
export type ControlHolder = 'automation' | 'human' | 'none';

export interface Surface {
  readonly kind: string;

  /** Read the current state. Never mutates. */
  perceive(): Promise<Observation>;

  /** Act by ephemeral ref (discovery path). */
  actByRef(action: Action, ref: number | null): Promise<ActResult>;

  /** Act by durable TargetRef (replay path). */
  actByTarget(action: Action, target: TargetRef | null): Promise<ActResult>;

  screenshot(path: string): Promise<void>;
  snapshotDom(path: string): Promise<void>;

  /** Control-token accessors — the escalation invariant lives here. */
  getControl(): ControlHolder;
  setControl(holder: ControlHolder): void;

  close(): Promise<void>;
}

/** Thrown when automation tries to act while a human holds the session. */
export class ControlDeniedError extends Error {
  constructor(holder: ControlHolder) {
    super(`Automation attempted to act while control is held by: ${holder}`);
    this.name = 'ControlDeniedError';
  }
}
