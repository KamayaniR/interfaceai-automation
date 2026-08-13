/**
 * Human-in-the-loop escalation and control transfer.
 *
 * The seam the brief asks about is "automation must be able to pause, cede control, and
 * resume on the SAME session, and there must be a way to know who is in control."
 *
 * The answer here is a control token owned by the session, with one hard invariant:
 *
 *     Surface.act() asserts the token before every single action.
 *
 * So while a human holds control, automation does not merely *agree* not to act — it
 * throws if it tries. That makes the guarantee structural rather than a convention that
 * some future code path forgets. It also means the failure mode is a loud exception in
 * our logs, not two actors silently fighting over the same form.
 *
 * The session is a real, live browser context. When an operator takes control they
 * drive the same headed browser the automation was using: same cookies, same session
 * token on the server, same page state, mid-flow. Not a fresh login.
 *
 * The intervention queue is a file-backed JSON store. That is a deliberate cut — in
 * production this is a durable queue with routing, SLAs and auth. The shape of the
 * record and the transfer protocol are what matter, and those are real.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ControlHolder } from '../surface/surface.ts';

export type InterventionStatus = 'open' | 'in_progress' | 'resolved' | 'aborted' | 'timed_out';

/**
 * Everything a human needs to act on the request without reading our source or
 * guessing what the robot was doing. The brief is specific about this payload:
 * which capability, the current step, the current state, and why it stopped.
 */
export interface InterventionRequest {
  id: string;
  runId: string;
  createdAt: string;
  status: InterventionStatus;

  capability: { id: string; version: number; name: string };
  /** Goal in plain language, so the operator knows the intent, not just the step. */
  goal: string;

  step: {
    id: string;
    index: number;
    total: number;
    intent: string;
    risk: string;
  } | null;

  /** Why automation stopped. This is the operator's whole briefing. */
  reason: string;
  expected: string | null;
  observed: string | null;

  /** Inputs, already redacted. The operator gets shape, not raw PII. */
  inputs: Record<string, unknown>;

  /** Path to a screenshot of the live session at the moment it stopped. */
  screenshotPath: string | null;
  currentUrl: string;

  /** Filled in when an operator takes and returns control. */
  resolution?: {
    operator: string;
    action: 'resume' | 'abort';
    note: string;
    tookControlAt: string;
    returnedControlAt: string;
    /** Actions the human performed while holding control — the audit trail. */
    recordedActions: RecordedHumanAction[];
  };
}

export interface RecordedHumanAction {
  at: string;
  kind: string;
  detail: string;
}

/** A live session's control state. One per run. */
export class SessionControl {
  private holder: ControlHolder = 'automation';
  private readonly humanActions: RecordedHumanAction[] = [];

  get current(): ControlHolder {
    return this.holder;
  }

  cedeToHuman(): void {
    this.holder = 'human';
  }

  returnToAutomation(): void {
    this.holder = 'automation';
  }

  suspend(): void {
    this.holder = 'none';
  }

  recordHumanAction(action: RecordedHumanAction): void {
    // Only meaningful while a human actually holds the session; recording otherwise
    // would pollute the audit trail with the automation's own events.
    if (this.holder === 'human') this.humanActions.push(action);
  }

  drainHumanActions(): RecordedHumanAction[] {
    return this.humanActions.splice(0, this.humanActions.length);
  }
}

/**
 * File-backed intervention queue, shared between the replay process and the operator
 * console process. Polling a JSON file is not how you would build this for real, but it
 * keeps the two processes genuinely decoupled — the console is not a library call into
 * the engine, it is a separate actor, which is the property that matters.
 */
export class InterventionQueue {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  create(req: Omit<InterventionRequest, 'id' | 'createdAt' | 'status'>): InterventionRequest {
    const full: InterventionRequest = {
      ...req,
      id: randomUUID().slice(0, 8),
      createdAt: new Date().toISOString(),
      status: 'open',
    };
    writeFileSync(this.path(full.id), JSON.stringify(full, null, 2));
    return full;
  }

  get(id: string): InterventionRequest | null {
    const p = this.path(id);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8')) as InterventionRequest;
  }

  update(req: InterventionRequest): void {
    writeFileSync(this.path(req.id), JSON.stringify(req, null, 2));
  }

  list(): InterventionRequest[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as InterventionRequest)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Block until an operator resolves the request, or we give up.
   *
   * The timeout is not a nicety: an escalation nobody answers must fail loudly as
   * `escalation_timeout` rather than pinning a browser session open indefinitely.
   */
  async waitForResolution(id: string, timeoutMs: number, pollMs = 1000): Promise<InterventionRequest> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const req = this.get(id);
      if (req && (req.status === 'resolved' || req.status === 'aborted')) return req;
      if (Date.now() > deadline) {
        if (req) {
          req.status = 'timed_out';
          this.update(req);
          return req;
        }
        throw new Error(`intervention ${id} disappeared while waiting`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}
