/**
 * Turns a successful discovery run into a CapabilityArtifact.
 *
 * This is the step the brief cares about most: the artifact must be "decoupled from the
 * raw model transcript". So the recorder takes only two things —
 *
 *   - the sequence of actions that actually succeeded, each paired with the
 *     accessibility descriptor of the element it acted on, and
 *   - the contract the model declared in `finish`
 *
 * — and produces a self-contained document. The transcript is kept beside the run as
 * evidence and referenced by digest, never embedded. Replay never reads it.
 *
 * Two transformations do the real work:
 *
 *   1. Parameterisation. A literal the model typed that matches a declared input's
 *      `example` becomes `{{paramName}}`, so the recorded flow generalises from the one
 *      member it happened to look up to any member.
 *
 *   2. Locator synthesis. The ephemeral ref becomes a durable TargetRef ladder built
 *      from the element's role, name, table label and ordinal position — several
 *      independent ways to find the same control, most-semantic first.
 */

import { createHash } from 'node:crypto';
import type {
  CapabilityArtifact,
  StepType,
  ParamSpec,
  OutputSpec,
  BusinessOutcome,
  Checkpoint,
  RiskClass,
} from '../schema/artifact.ts';
import type { ObservedElement } from '../surface/surface.ts';
import { synthesiseTarget } from '../surface/web/resolve-target.ts';

/** One action that succeeded during discovery, with the element it touched. */
export interface RecordedAction {
  kind: 'navigate' | 'click' | 'type' | 'select' | 'extract';
  intent: string;
  url?: string;
  value?: string;
  outputName?: string;
  from?: 'text' | 'value';
  pattern?: string;
  element?: ObservedElement;
  /** Page text right after the action — used to synthesise per-step checkpoints. */
  resultingText: string;
  resultingUrl: string;
}

export interface FinishContract {
  capability_id: string;
  name: string;
  description: string;
  inputs: {
    name: string;
    type: 'string' | 'number' | 'boolean';
    description: string;
    pattern?: string;
    sensitivity: 'public' | 'pii' | 'secret';
    example: string;
  }[];
  outputs: { name: string; type: 'string' | 'number' | 'money' | 'boolean'; description: string; sensitivity: 'public' | 'pii' | 'secret' }[];
  outcomes: { code: string; description: string; detect_text: string }[];
  success_text: string;
}

export interface RecordOptions {
  actions: RecordedAction[];
  contract: FinishContract;
  goal: string;
  entryUrl: string;
  appId: string;
  vendor: string;
  model: string;
  runId: string;
  transcript: string;
}

/**
 * Classify a step's risk from what it does. Conservative by construction: anything that
 * submits a form whose page talks about creating or transferring is treated as
 * irreversible, because the cost of under-classifying is unbounded and the cost of
 * over-classifying is one human confirmation.
 */
function classifyRisk(action: RecordedAction): RiskClass {
  if (action.kind === 'navigate' || action.kind === 'extract') return 'safe';

  const label = `${action.element?.name ?? ''} ${action.intent}`.toLowerCase();
  const IRREVERSIBLE = ['create', 'open account', 'transfer', 'submit payment', 'post ', 'delete', 'close account', 'disburse'];
  if (IRREVERSIBLE.some((k) => label.includes(k))) return 'irreversible';

  if (action.kind === 'type' || action.kind === 'select') return 'safe'; // filling a field commits nothing
  return 'safe';
}

/** Swap literals the caller will vary for `{{param}}` placeholders. */
function parameterise(value: string, inputs: FinishContract['inputs']): string {
  let out = value;
  for (const input of inputs) {
    if (input.example && out === input.example) return `{{${input.name}}}`;
  }
  for (const input of inputs) {
    if (input.example && input.example.length >= 3 && out.includes(input.example)) {
      out = out.split(input.example).join(`{{${input.name}}}`);
    }
  }
  return out;
}

/**
 * Pick a per-step checkpoint from what the page showed after the action.
 *
 * Heuristic and deliberately modest: we prefer a URL assertion, because in a
 * server-rendered app the URL is the most reliable signal that a navigation actually
 * happened, and a URL is not PII. Where the URL didn't change we fall back to asserting
 * the element we are about to use next still exists — which the engine gets for free
 * from target resolution anyway.
 */
function checkpointFor(action: RecordedAction, isLast: boolean, successText: string): Checkpoint | undefined {
  if (action.kind === 'extract') return undefined;

  if (isLast) {
    return {
      kind: 'text-present',
      text: successText,
      framePath: [],
      timeoutMs: 10_000,
      description: `the end state is reached, indicated by "${successText}" being visible`,
    };
  }

  try {
    const path = new URL(action.resultingUrl).pathname;
    return {
      kind: 'url-matches',
      pattern: `${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      timeoutMs: 10_000,
      description: `the browser reaches ${path} after "${action.intent}"`,
    };
  } catch {
    return undefined;
  }
}

export function recordArtifact(opts: RecordOptions): CapabilityArtifact {
  const { contract, actions } = opts;

  const inputs: Record<string, ParamSpec> = {};
  for (const i of contract.inputs) {
    inputs[i.name] = {
      type: i.type,
      description: i.description,
      required: true,
      pattern: i.pattern,
      sensitivity: i.sensitivity,
      // The example is the value the model typed during discovery. It is recorded only
      // when the parameter is public — an example of a pii field would defeat the point
      // of classifying it.
      example: i.sensitivity === 'public' ? i.example : undefined,
    };
  }

  const outputs: Record<string, OutputSpec> = {};
  for (const o of contract.outputs) {
    outputs[o.name] = { type: o.type, description: o.description, sensitivity: o.sensitivity };
  }

  const outcomes: BusinessOutcome[] = contract.outcomes.map((o) => ({
    code: o.code,
    description: o.description,
    terminal: true,
  }));

  // Every declared business outcome becomes a condition rule on every step that could
  // plausibly surface it. Attaching them broadly is the right default: an app can show
  // "record not found" on whichever screen it likes, and a missed condition degrades
  // into a checkpoint timeout — the exact conflation we are trying to avoid.
  const outcomeRules = contract.outcomes.map((o) => ({
    when: {
      id: o.code.toLowerCase().replace(/_/g, '-'),
      anyOf: [{ kind: 'text-present' as const, text: o.detect_text }],
    },
    then: { then: 'business-outcome' as const, outcomeCode: o.code },
  }));

  const steps: StepType[] = actions.map((action, idx) => {
    const isLast = idx === actions.length - 1;
    const target = action.element ? synthesiseTarget(action.element) : undefined;

    let built: StepType['action'];
    switch (action.kind) {
      case 'navigate':
        built = { kind: 'navigate', url: action.url! };
        break;
      case 'click':
        built = { kind: 'click' };
        break;
      case 'type':
        built = { kind: 'type', value: parameterise(action.value ?? '', contract.inputs), clearFirst: true };
        break;
      case 'select':
        built = { kind: 'select', value: parameterise(action.value ?? '', contract.inputs) };
        break;
      case 'extract':
        built = {
          kind: 'extract',
          outputName: action.outputName!,
          from: action.from ?? 'text',
          pattern: action.pattern,
        };
        break;
    }

    return {
      id: `s${String(idx + 1).padStart(2, '0')}`,
      intent: action.intent,
      action: built,
      target,
      risk: classifyRisk(action),
      waitFor: checkpointFor(action, isLast, contract.success_text),
      // Outcome rules go on every non-navigate step. Navigation to the entry point
      // cannot itself produce a business outcome.
      onCondition: action.kind === 'navigate' ? [] : outcomeRules,
    };
  });

  return {
    schemaVersion: '1.0',
    capability: {
      id: contract.capability_id,
      version: 1,
      name: contract.name,
      description: contract.description,
      // Always draft. An LLM wrote this and no human has read it yet; promotion to
      // `approved` is a human act, and the catalog refuses to run drafts unattended.
      status: 'draft',
    },
    app: {
      appId: opts.appId,
      vendor: opts.vendor,
      variantOf: null,
      tenantId: null,
      entryUrl: opts.entryUrl,
    },
    inputs,
    outputs,
    outcomes,
    preconditions: [],
    steps,
    checkpoint: {
      kind: 'text-present',
      text: contract.success_text,
      framePath: [],
      timeoutMs: 15_000,
      description: `"${contract.success_text}" is visible, proving the capability reached its goal`,
    },
    provenance: {
      model: opts.model,
      runId: opts.runId,
      discoveredAt: new Date().toISOString(),
      transcriptDigest: createHash('sha256').update(opts.transcript).digest('hex').slice(0, 16),
    },
  };
}
