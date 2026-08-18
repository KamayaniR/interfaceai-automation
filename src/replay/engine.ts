/**
 * Deterministic replay — the production execution path.
 *
 * This is the file an AI agent's request ultimately lands in. Two properties define it:
 *
 *   1. No LLM. There is no Anthropic import reachable from here, transitively. The
 *      model discovered the flow; it does not get to re-decide it on every invocation.
 *      That is what makes replay cheap, fast, auditable and repeatable.
 *
 *   2. Nothing is assumed. Every step verifies a checkpoint, every exceptional state
 *      is checked for explicitly before the checkpoint runs, and every resolution
 *      reports which locator strategy carried it.
 *
 * The control flow per step is deliberately fixed:
 *
 *      policy gate -> act -> detect conditions -> dispatch disposition -> checkpoint
 *
 * Conditions are checked before the checkpoint so that a recognised app state (a
 * "record not found" banner) produces a clean business outcome rather than a checkpoint
 * timeout that looks like a hang.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import type {
  CapabilityArtifact,
  Step,
  StepType,
  Action,
  Checkpoint,
  Disposition,
} from '../schema/artifact.ts';
import type { ReplayResult, StepTrace, DriftReport } from '../schema/result.ts';
import { WebSurface, PolicyBlockedError, ConfirmationRequiredError } from '../surface/web/web-surface.ts';
import { ControlDeniedError } from '../surface/surface.ts';
import { verifyCheckpoint, detectCondition } from './conditions.ts';
import { verifyContentHash } from '../schema/hash.ts';
import { Policy } from '../policy/policy.ts';
import { Redactor } from '../policy/redact.ts';
import { RunLogger } from '../obs/logger.ts';
import { pace } from '../obs/pace.ts';
import { SessionControl, InterventionQueue, type InterventionRequest } from '../escalation/broker.ts';

export interface ReplayOptions {
  artifact: CapabilityArtifact;
  inputs: Record<string, string>;
  policyPath: string;
  headed: boolean;
  runsDir: string;
  interventionsDir: string;
  /** How long to wait for a human once we escalate. */
  escalationTimeoutMs: number;
  /** Appended to every target-app URL, to reproduce a runtime condition on demand. */
  faultParam?: string;
  /** Optional live-frame sink, for a viewer watching this exact session. */
  onFrame?: (frame: string) => void;
  /**
   * Optional step-progress sink. Pixels alone do not explain a run: a paced replay
   * shows a static screen, then an instant jump, which reads as "nothing, then magic".
   * Naming the step as it starts is what makes the flow legible to someone watching.
   * Presentation only — nothing in the engine branches on it.
   */
  onStep?: (e: {
    phase: 'start' | 'end';
    index: number;
    total: number;
    id: string;
    intent: string;
    risk: string;
    status?: string;
  }) => void;
}

/** Thrown internally to unwind to the top-level result builder. */
class Terminate extends Error {
  constructor(
    readonly kind: 'business_outcome' | 'failure',
    readonly payload: Record<string, unknown>,
  ) {
    super('terminate');
  }
}

export class ReplayEngine {
  private readonly runId = randomUUID().slice(0, 8);
  private readonly trace: StepTrace[] = [];
  private readonly drift: DriftReport[] = [];
  private readonly outputs: Record<string, unknown> = {};
  private surface!: WebSurface;
  private logger!: RunLogger;
  private redactor!: Redactor;
  private control = new SessionControl();
  /** Steps an operator has explicitly approved during this run. Consumed on retry. */
  private readonly approvedSteps = new Set<string>();
  private queue!: InterventionQueue;
  private startedAt = new Date();

  constructor(private readonly opts: ReplayOptions) {}

  async run(): Promise<ReplayResult> {
    const { artifact } = this.opts;
    const policy = Policy.load(this.opts.policyPath, 'replay');
    this.redactor = new Redactor(policy.redactionConfig);
    this.logger = new RunLogger(join(this.opts.runsDir, `replay-${this.runId}`), this.runId, this.redactor);
    this.queue = new InterventionQueue(this.opts.interventionsDir);

    this.logger.log('replay.start', {
      capability: artifact.capability.id,
      version: artifact.capability.version,
      status: artifact.capability.status,
      inputs: this.redactor.redactInputs(this.opts.inputs, artifact.inputs),
    });

    try {
      // Pre-flight. An invalid invocation must fail before we touch a browser —
      // cheaper, and it keeps contract errors clearly distinct from app errors.
      this.verifyIntegrity();
      this.validateInputs();

      this.surface = await WebSurface.launch({
        headed: this.opts.headed,
        policy,
        control: this.control,
        onEvent: (e) => this.logger.log(e.type, e.detail),
        onFrame: this.opts.onFrame,
      });

      await this.checkPreconditions();
      await this.runSteps(artifact.steps);

      // The capability-level success condition. Getting through the steps is not the
      // same as having arrived — this is the assertion that we actually did.
      const final = await verifyCheckpoint(this.surface, artifact.checkpoint);
      if (!final.passed) {
        await this.captureFailureEvidence('final-checkpoint');
        throw new Terminate('failure', {
          class: 'hard',
          stepId: null,
          message: 'capability completed its steps but the success checkpoint did not hold',
          expected: final.expected,
          observed: final.observed,
        });
      }

      this.logger.log('replay.success', { outputs: this.redactor.scrubDeep(this.outputs) });
      return this.build({ status: 'success', outputs: this.outputs });
    } catch (err) {
      if (err instanceof Terminate) {
        this.logger.log(`replay.${err.kind}`, err.payload);
        return err.kind === 'business_outcome'
          ? this.build({ status: 'business_outcome', outcome: err.payload as never, outputs: this.outputs })
          : this.build({ status: 'failure', failure: err.payload as never });
      }
      // Anything unclassified is a hard failure. There is no "unknown" status.
      const message = (err as Error).message;
      await this.captureFailureEvidence('unexpected').catch(() => {});
      this.logger.log('replay.failure', { class: 'hard', message });
      return this.build({
        status: 'failure',
        failure: { class: 'hard', stepId: null, message, expected: null, observed: null },
      });
    } finally {
      await this.surface?.close();
    }
  }

  // -------------------------------------------------------------------------
  // Pre-flight
  // -------------------------------------------------------------------------

  /**
   * Refuse to run an artifact whose content doesn't match the hash recorded in it.
   *
   * This is the check that makes approval mean something: a reviewer approved specific
   * *content*, and if the steps have been edited since, the mismatch surfaces here —
   * before a browser exists, let alone before anything is clicked in a bank's core.
   */
  private verifyIntegrity(): void {
    const verdict = verifyContentHash(this.opts.artifact);
    this.logger.log('integrity.check', { state: verdict.state });

    if (verdict.state === 'mismatch') {
      throw new Terminate('failure', {
        class: 'contract_violation',
        stepId: null,
        message:
          'artifact content does not match its recorded hash — it has been modified since it was recorded',
        expected: verdict.recorded,
        observed: verdict.actual,
      });
    }
  }

  private validateInputs(): void {
    const specs = this.opts.artifact.inputs;

    // Resolve runtime-supplied inputs from the environment first, so they are validated
    // on exactly the same path as everything else. A credential that never reaches the
    // caller still has to be present and well-formed, and a missing one must fail here
    // — before a browser is launched — rather than as a mystery sign-on failure later.
    for (const [name, spec] of Object.entries(specs)) {
      if (spec.source !== 'runtime') continue;
      const fromEnv = spec.env ? process.env[spec.env] : undefined;
      if (fromEnv === undefined) {
        throw new Terminate('failure', {
          class: 'contract_violation',
          stepId: null,
          message: `runtime input "${name}" is not set in the environment`,
          expected: `environment variable ${spec.env ?? '(none declared)'} to be set`,
          observed: 'unset',
        });
      }
      this.opts.inputs[name] = fromEnv;
    }

    for (const [name, spec] of Object.entries(specs)) {
      const value = this.opts.inputs[name];
      if (value === undefined) {
        if (spec.required) {
          throw new Terminate('failure', {
            class: 'contract_violation',
            stepId: null,
            message: `required input "${name}" was not supplied`,
            expected: `${name}: ${spec.type}${spec.pattern ? ` matching /${spec.pattern}/` : ''}`,
            observed: 'missing',
          });
        }
        continue;
      }
      if (spec.pattern && !new RegExp(spec.pattern).test(value)) {
        throw new Terminate('failure', {
          class: 'contract_violation',
          stepId: null,
          message: `input "${name}" does not satisfy its declared pattern`,
          expected: `/${spec.pattern}/`,
          // The value itself may be PII, so report shape rather than content.
          observed: `a ${value.length}-character value that did not match`,
        });
      }
    }
    for (const name of Object.keys(this.opts.inputs)) {
      if (!specs[name]) {
        throw new Terminate('failure', {
          class: 'contract_violation',
          stepId: null,
          message: `input "${name}" is not declared by this capability`,
          expected: `one of: ${Object.keys(specs).join(', ') || '(none)'}`,
          observed: name,
        });
      }
    }
  }

  private async checkPreconditions(): Promise<void> {
    for (const cp of this.opts.artifact.preconditions) {
      const outcome = await verifyCheckpoint(this.surface, cp);
      if (!outcome.passed) {
        await this.captureFailureEvidence('precondition');
        throw new Terminate('failure', {
          class: 'hard',
          stepId: null,
          message: 'precondition did not hold before the first step',
          expected: outcome.expected,
          observed: outcome.observed,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step execution
  // -------------------------------------------------------------------------

  private async runSteps(steps: StepType[]): Promise<void> {
    for (let i = 0; i < steps.length; i++) {
      await this.runStep(steps[i]!, i, steps.length);
    }
  }

  private async runStep(step: StepType, index: number, total: number): Promise<void> {
    const started = Date.now();
    const entry: StepTrace = {
      stepId: step.id,
      intent: step.intent,
      action: step.action.kind,
      status: 'ok',
      startedAt: new Date().toISOString(),
      durationMs: 0,
      recoveryAttempts: 0,
    };

    this.logger.log('step.start', { stepId: step.id, intent: step.intent, risk: step.risk });
    this.opts.onStep?.({
      phase: 'start',
      index: index + 1,
      total,
      id: step.id,
      intent: step.intent,
      risk: step.risk,
    });
    // Idle time only, so the previous step's result stays on screen long enough to read.
    await pace();

    try {
      await this.act(step, entry, index, total);

      // Conditions BEFORE the checkpoint. See the note at the top of conditions.ts.
      const fired = await this.dispatchConditions(step, entry, index, total);
      if (fired === 'recovered') {
        entry.status = 'recovered';
        // After recovery, re-run this step's action once — recovery got us back to a
        // state where the original intent is achievable again.
        await this.act(step, entry, index, total);
      }

      if (step.waitFor) {
        const outcome = await verifyCheckpoint(this.surface, this.interpolateCheckpoint(step.waitFor));
        if (!outcome.passed) {
          // One last condition sweep: a slow app may only have rendered its error
          // banner while the checkpoint was polling.
          const late = await this.dispatchConditions(step, entry, index, total);
          if (late === 'recovered') {
            await this.act(step, entry, index, total);
            const retry = await verifyCheckpoint(this.surface, this.interpolateCheckpoint(step.waitFor));
            if (retry.passed) return;
          }
          await this.captureFailureEvidence(`step-${step.id}`);
          entry.status = 'failed';
          throw new Terminate('failure', {
            class: 'hard',
            stepId: step.id,
            message: `step "${step.intent}" did not reach its expected state`,
            expected: outcome.expected,
            observed: outcome.observed,
          });
        }
      }
    } finally {
      entry.durationMs = Date.now() - started;
      this.trace.push(entry);
      this.logger.log('step.end', { stepId: step.id, status: entry.status, durationMs: entry.durationMs });
      this.opts.onStep?.({
        phase: 'end',
        index: index + 1,
        total,
        id: step.id,
        intent: step.intent,
        risk: step.risk,
        status: entry.status,
      });
    }
  }

  /** Perform the step's action, handling policy verdicts and recording drift. */
  private async act(step: StepType, entry: StepTrace, index: number, total: number): Promise<void> {
    const action = this.interpolate(step.action);

    let result;
    try {
      result = await this.surface.actByTarget(
        action,
        step.target ?? null,
        step.risk,
        this.approvedSteps.has(step.id),
      );
    } catch (err) {
      if (err instanceof PolicyBlockedError) {
        entry.status = 'failed';
        throw new Terminate('failure', {
          class: 'policy_blocked',
          stepId: step.id,
          message: err.message,
          expected: 'an action permitted by the active policy profile',
          observed: `${action.kind} classified as ${step.risk}`,
        });
      }
      if (err instanceof ConfirmationRequiredError) {
        // The guardrails demand a human decision for this risk class. This is the
        // system working, not failing. `escalate` throws if the operator aborts or
        // nobody answers, so reaching the next line means we have real approval.
        await this.escalate(step, index, total, err.reason, entry);
        this.approvedSteps.add(step.id);
        return this.act(step, entry, index, total);
      }
      if (err instanceof ControlDeniedError) {
        entry.status = 'failed';
        throw new Terminate('failure', {
          class: 'hard',
          stepId: step.id,
          message: err.message,
          expected: 'automation holds the session control token',
          observed: this.surface.getControl(),
        });
      }
      throw err;
    }

    if (result.resolution) {
      const { candidateIndex, strategy, fingerprintMismatch } = result.resolution;
      // Rung 0 is healthy and not worth reporting. Anything else means the surface
      // moved and this artifact is running on a fallback — surface it to the caller.
      if (candidateIndex > 0 || fingerprintMismatch) {
        const report: DriftReport = {
          stepId: step.id,
          candidateIndex,
          strategy,
          fingerprintMismatch,
          note:
            candidateIndex > 0
              ? `preferred locator failed; matched via fallback strategy "${strategy}" (rung ${candidateIndex}). Re-record this capability before the remaining rungs degrade.`
              : `matched on the preferred locator, but the element no longer matches its recorded fingerprint.`,
        };
        this.drift.push(report);
        this.logger.log('drift.detected', report as unknown as Record<string, unknown>);
      }
    }

    if (!result.ok) {
      // Don't fail yet — an app-level condition may explain this, and the condition
      // sweep in runStep gets first refusal. Record and continue.
      entry.error = result.error;
      this.logger.log('action.failed', { stepId: step.id, error: result.error });
      return;
    }

    if (action.kind === 'extract' && result.extracted !== undefined) {
      this.outputs[action.outputName] = result.extracted;
      const spec = this.opts.artifact.outputs[action.outputName];
      this.logger.log('output.captured', {
        name: action.outputName,
        value: spec ? Redactor.mask(result.extracted, spec.sensitivity) : '[undeclared]',
      });
    }
  }

  /**
   * Check every declared condition for this step and act on the first that fires.
   * Returns 'recovered' if a recovery ran and the caller should retry the step.
   */
  private async dispatchConditions(
    step: StepType,
    entry: StepTrace,
    index: number,
    total: number,
  ): Promise<'none' | 'recovered'> {
    for (const rule of step.onCondition) {
      if (!(await detectCondition(this.surface, this.interpolateMatcher(rule.when)))) continue;

      entry.conditionFired = rule.when.id;
      // Bind to a local so TypeScript narrows the discriminated union across the switch.
      const disposition: Disposition = rule.then;
      this.logger.log('condition.fired', { stepId: step.id, condition: rule.when.id, then: disposition.then });

      switch (disposition.then) {
        case 'business-outcome': {
          const declared = this.opts.artifact.outcomes.find((o) => o.code === disposition.outcomeCode);
          if (!declared) {
            throw new Terminate('failure', {
              class: 'contract_violation',
              stepId: step.id,
              message: `step maps condition "${rule.when.id}" to undeclared outcome "${disposition.outcomeCode}"`,
              expected: `an outcome declared in the artifact`,
              observed: disposition.outcomeCode,
            });
          }
          throw new Terminate('business_outcome', {
            code: declared.code,
            message: declared.description,
          });
        }

        case 'fail':
          await this.captureFailureEvidence(`condition-${rule.when.id}`);
          throw new Terminate('failure', {
            class: 'hard',
            stepId: step.id,
            message: disposition.message,
            expected: `condition "${rule.when.id}" not to be present`,
            observed: `condition "${rule.when.id}" matched`,
          });

        case 'escalate':
          await this.escalate(step, index, total, disposition.reason, entry);
          return 'recovered';

        case 'recover': {
          const max = disposition.maxAttempts;
          for (let attempt = 1; attempt <= max; attempt++) {
            entry.recoveryAttempts = attempt;
            this.logger.log('recovery.attempt', { stepId: step.id, condition: rule.when.id, attempt, max });

            for (const sub of disposition.recovery) {
              await this.act(sub as StepType, entry, index, total);
              if (sub.waitFor) await verifyCheckpoint(this.surface, sub.waitFor);
            }

            if (!(await detectCondition(this.surface, this.interpolateMatcher(rule.when)))) {
              this.logger.log('recovery.succeeded', { stepId: step.id, condition: rule.when.id, attempt });
              return 'recovered';
            }
          }
          // A bounded recovery that never clears is its own failure class — this is
          // materially different from "we never recognised the state at all".
          await this.captureFailureEvidence(`recovery-${rule.when.id}`);
          throw new Terminate('failure', {
            class: 'recovery_exhausted',
            stepId: step.id,
            message: `condition "${rule.when.id}" persisted after ${max} recovery attempt(s)`,
            expected: `condition "${rule.when.id}" to clear after recovery`,
            observed: `still present after ${max} attempt(s)`,
          });
        }
      }
    }
    return 'none';
  }

  // -------------------------------------------------------------------------
  // Escalation
  // -------------------------------------------------------------------------

  /**
   * Pause, hand the live session to a human, wait, then resume on the same session.
   *
   * The ordering here is the whole control-transfer model:
   *   1. capture state as evidence for the operator
   *   2. file the request
   *   3. cede the token — automation is now structurally unable to act
   *   4. block until resolved or timed out
   *   5. take the token back
   *   6. RE-VERIFY before continuing
   *
   * Step 6 matters: we do not assume the human left the session where we expect. If
   * the step declares a checkpoint we assert it before carrying on.
   */
  private async escalate(
    step: StepType,
    index: number,
    total: number,
    reason: string,
    entry: StepTrace,
  ): Promise<void> {
    const shotPath = this.logger.screenshotPath(`escalation-${step.id}`);
    await this.surface.screenshot(shotPath);

    const request = this.queue.create({
      runId: this.runId,
      capability: {
        id: this.opts.artifact.capability.id,
        version: this.opts.artifact.capability.version,
        name: this.opts.artifact.capability.name,
      },
      goal: this.opts.artifact.capability.description,
      step: { id: step.id, index: index + 1, total, intent: step.intent, risk: step.risk },
      reason,
      expected: step.waitFor?.description ?? null,
      observed: `automation stopped before executing this step`,
      inputs: this.redactor.redactInputs(this.opts.inputs, this.opts.artifact.inputs),
      screenshotPath: shotPath,
      currentUrl: this.surface.currentUrl,
    });

    this.logger.log('escalation.raised', { requestId: request.id, stepId: step.id, reason });
    console.log(`\n  [escalation] ${reason}`);
    console.log(`  [escalation] request ${request.id} — open the operator console to take control\n`);

    const tookControlAt = Date.now();
    this.surface.setControl('human');

    let resolved: InterventionRequest;
    try {
      resolved = await this.queue.waitForResolution(request.id, this.opts.escalationTimeoutMs);
    } finally {
      this.surface.setControl('automation');
    }

    const humanActions = this.control.drainHumanActions();
    entry.humanIntervention = {
      requestId: request.id,
      operator: resolved.resolution?.operator ?? 'unknown',
      actionsRecorded: humanActions.length,
      durationMs: Date.now() - tookControlAt,
    };

    // Persist what the human actually did, so the handoff is auditable and can inform
    // a future revision of the artifact.
    resolved.resolution = {
      operator: resolved.resolution?.operator ?? 'unknown',
      action: resolved.status === 'resolved' ? 'resume' : 'abort',
      note: resolved.resolution?.note ?? '',
      tookControlAt: new Date(tookControlAt).toISOString(),
      returnedControlAt: new Date().toISOString(),
      recordedActions: humanActions,
    };
    this.queue.update(resolved);
    this.logger.log('escalation.resolved', {
      requestId: request.id,
      status: resolved.status,
      humanActions: humanActions.length,
    });

    if (resolved.status === 'timed_out') {
      throw new Terminate('failure', {
        class: 'escalation_timeout',
        stepId: step.id,
        message: `escalation ${request.id} was not answered within ${this.opts.escalationTimeoutMs}ms`,
        expected: 'an operator to take control and resume',
        observed: 'no response',
      });
    }
    if (resolved.status === 'aborted') {
      throw new Terminate('failure', {
        class: 'hard',
        stepId: step.id,
        message: `operator aborted the run: ${resolved.resolution?.note || '(no note)'}`,
        expected: 'operator to resume the run',
        observed: 'operator aborted',
      });
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve `{{param}}` placeholders against validated inputs.
   *
   * `optional` is used for checkpoints. An assertion built from an input the caller did
   * not supply must go quiet, not blow up: `text-absent "{{expectedName}}"` with no
   * expectedName resolves to an empty needle, which `contains()` treats as always found,
   * so the assertion is inert. Actions keep the strict behaviour — a step that types an
   * undeclared parameter is a contract violation, not a no-op.
   */
  private sub(text: string, optional = false): string {
    return text.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
      const value = this.opts.inputs[key];
      if (value === undefined) {
        if (optional) return '';
        throw new Terminate('failure', {
          class: 'contract_violation',
          stepId: null,
          message: `step references undeclared parameter "{{${key}}}"`,
          expected: `a declared input`,
          observed: key,
        });
      }
      return value;
    });
  }

  /** Same, for every clause of a condition matcher. */
  private interpolateMatcher<T extends { anyOf: unknown[] }>(m: T): T {
    return { ...m, anyOf: m.anyOf.map((c) => this.interpolateCheckpoint(c)) };
  }

  /** Resolve placeholders inside a checkpoint's text, so it can assert on caller intent. */
  private interpolateCheckpoint<T>(cp: T): T {
    const c = cp as unknown as { kind?: string; text?: string };
    if (c && (c.kind === 'text-present' || c.kind === 'text-absent') && typeof c.text === 'string') {
      return { ...(cp as object), text: this.sub(c.text, true) } as T;
    }
    return cp;
  }

  private interpolate(action: Action): Action {
    const sub = (s: string): string => this.sub(s);

    if (action.kind === 'type') return { ...action, value: sub(action.value) };
    if (action.kind === 'select') return { ...action, value: sub(action.value) };
    if (action.kind === 'navigate') {
      let url = sub(action.url);
      // Fault injection is a test affordance, threaded through here so that an
      // exceptional path is reproducible on demand rather than waited for.
      if (this.opts.faultParam) {
        url += (url.includes('?') ? '&' : '?') + `_fault=${this.opts.faultParam}`;
      }
      return { ...action, url };
    }
    return action;
  }

  private async captureFailureEvidence(label: string): Promise<void> {
    if (!this.surface) return;
    await this.surface.screenshot(this.logger.screenshotPath(label));
    await this.surface.snapshotDom(this.logger.domPath(label));
  }

  private build(partial: Record<string, unknown>): ReplayResult {
    const result = {
      capabilityId: this.opts.artifact.capability.id,
      capabilityVersion: this.opts.artifact.capability.version,
      runId: this.runId,
      startedAt: this.startedAt.toISOString(),
      durationMs: Date.now() - this.startedAt.getTime(),
      trace: this.trace,
      drift: this.drift,
      evidence: {
        runId: this.runId,
        logPath: this.logger.logPath,
        screenshots: this.logger.screenshots,
        domSnapshots: this.logger.domSnapshots,
      },
      ...partial,
    } as ReplayResult;

    // Persist the result contract itself, not just a rendering of it. The console output
    // is for a human watching; this is what a calling agent receives and what an auditor
    // reads six months later, so it belongs in the evidence alongside the log.
    writeFileSync(join(this.logger.runDir, 'result.json'), JSON.stringify(result, null, 2));
    return result;
  }
}
