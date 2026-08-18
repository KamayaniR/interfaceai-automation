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
import { classifyRisk } from '../policy/risk.ts';
import { computeContentHash } from '../schema/hash.ts';

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
 * Pick a per-step checkpoint from what actually changed on screen.
 *
 * The obvious choice — assert the URL — is worthless here, and that is a lesson about
 * the target rather than a shortcut. In a frameset the page URL never changes: every
 * navigation happens inside a child frame, so `resultingUrl` stays `http://host/` for
 * the whole flow. Recording it produced `url-matches "/"` on every step: a checkpoint
 * that matches any page and can never fail, which is worse than no checkpoint because
 * it looks like verification.
 *
 * So instead we assert what the action CAUSED: a line of text that appeared on screen
 * after it and was not there before. That is the definition of "did this step do
 * something", it survives the frameset problem entirely, and it degrades honestly — if
 * nothing changed, no checkpoint is emitted rather than a vacuous one.
 *
 * KNOWN LIMITATION. This still under-covers. Steps that only type into a field correctly
 * get nothing (typing changes no page text), but a click that navigates sometimes gets
 * nothing either, because `resultingText` is every frame's text joined into one blob and
 * the diff against the previous step can come up empty. The hand-authored artifacts do
 * not have this problem because their checkpoints are scoped with
 * `framePath: ['content']` — they assert against the content frame alone.
 *
 * The real fix is to carry per-frame text through `RecordedAction` instead of a joined
 * string, and emit `framePath`-scoped checkpoints to match. That is a change to the
 * discovery loop's recording shape, not to this function, and it is written up in
 * REPORT §7 rather than half-done here.
 */
function checkpointFor(
  action: RecordedAction,
  previousText: string,
  /**
   * Text from the first screen of the flow. Anything present there is chrome — the nav
   * bar, the product name, the frameset furniture — and it is on every subsequent screen
   * too, so a checkpoint built from it asserts nothing. Excluding it is what stops
   * "MERIDIAN CU | CoreVue 7.2" from being chosen as proof that we reached Member Detail.
   */
  chromeText: string,
  isLast: boolean,
  successText: string,
): Checkpoint | undefined {
  if (action.kind === 'extract') return undefined;

  if (isLast) {
    return {
      kind: 'text-present',
      ignoreCase: false,
      text: successText,
      framePath: [],
      timeoutMs: 10_000,
      description: `the end state is reached, indicated by "${successText}" being visible`,
    };
  }

  const before = new Set([
    ...previousText.split('\n').map((l) => l.trim()),
    ...chromeText.split('\n').map((l) => l.trim()),
  ]);
  const appeared = action.resultingText
    .split('\n')
    .map((l) => l.trim())
    // Long enough to be distinctive, short enough to be a label rather than a paragraph,
    // and never a bare number — those are balances and member ids, i.e. the data.
    .filter((l) => l.length >= 8 && l.length <= 60 && !/^[\d.,$\s-]+$/.test(l))
    .find((l) => !before.has(l));

  // Nothing new appeared. For a step that only fills a field that is correct — typing
  // changes no page text, and inventing an assertion would be dishonest. But a CLICK
  // that reached a new screen must be verifiable, and "new vs. the previous step" can
  // miss it if the observation raced the navigation. Fall back to asserting something
  // distinctive that is on screen NOW: weaker than "this appeared", still a real check,
  // and vastly better than leaving the step that navigates unverified.
  const assertion =
    appeared ??
    (action.kind === 'click'
      ? action.resultingText
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length >= 8 && l.length <= 60 && !/^[\d.,$\s-]+$/.test(l))
          .filter((l) => !before.has(l)) // never fall back onto chrome either
          .sort((a, b) => b.length - a.length)[0]
      : undefined);

  if (!assertion) return undefined;

  return {
    kind: 'text-present',
    ignoreCase: false,
    text: assertion,
    framePath: [],
    timeoutMs: 10_000,
    description: appeared
      ? `"${assertion}" appears after "${action.intent}"`
      : `"${assertion}" is on screen after "${action.intent}"`,
  };
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

  // Reject outcomes that fire on the SUCCESS screen.
  //
  // A business outcome is by definition an alternative to success, so one whose marker
  // text is visible on the successful end state is self-defeating: replay would detect
  // it, terminate cleanly, and never run the extracts. A real discovery run did exactly
  // this — it declared BALANCE_FOUND as an outcome, and replay stopped one step before
  // reading the balance. Prompting alone is not enough to prevent it; this is the check.
  const successScreen = (actions.at(-1)?.resultingText ?? '') + ' ' + contract.success_text;
  const rejected: string[] = [];
  const outcomes: BusinessOutcome[] = contract.outcomes
    .filter((o) => {
      const firesOnSuccess =
        successScreen.includes(o.detect_text) || contract.success_text.includes(o.detect_text);
      if (firesOnSuccess) rejected.push(o.code);
      return !firesOnSuccess;
    })
    .map((o) => ({ code: o.code, description: o.description, terminal: true }));

  if (rejected.length) {
    console.warn(
      `  ! dropped ${rejected.length} declared outcome(s) that would fire on the success ` +
        `screen and short-circuit replay: ${rejected.join(', ')}`,
    );
  }

  // Every declared business outcome becomes a condition rule on every step that could
  // plausibly surface it. Attaching them broadly is the right default: an app can show
  // "record not found" on whichever screen it likes, and a missed condition degrades
  // into a checkpoint timeout — the exact conflation we are trying to avoid.
  const keptCodes = new Set(outcomes.map((o) => o.code));
  const outcomeRules = contract.outcomes
    .filter((o) => keptCodes.has(o.code))
    .map((o) => ({
      when: {
        id: o.code.toLowerCase().replace(/_/g, '-'),
        anyOf: [{ kind: 'text-present' as const, text: o.detect_text, ignoreCase: false }],
      },
      then: { then: 'business-outcome' as const, outcomeCode: o.code },
    }));

  const steps: StepType[] = actions.map((action, idx) => {
    const isLast = idx === actions.length - 1;
    const previousText = idx > 0 ? (actions[idx - 1]?.resultingText ?? '') : '';
    const chromeText = idx === 0 ? '' : (actions.find((a) => a.resultingText)?.resultingText ?? '');
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
      risk: classifyRisk(`${action.element?.name ?? ''} ${action.intent}`, action.kind),
      waitFor: checkpointFor(action, previousText, chromeText, isLast, contract.success_text),
      // Outcome rules go on every non-navigate step. Navigation to the entry point
      // cannot itself produce a business outcome.
      onCondition: action.kind === 'navigate' ? [] : outcomeRules,
    };
  });

  const artifact: CapabilityArtifact = {
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
      ignoreCase: false,
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

  // Stamp the content hash so a discovered artifact is tamper-evident from birth.
  // Without this, only hand-stamped artifacts were protected — every capability the
  // system recorded itself silently opted out of the check.
  artifact.provenance.contentHash = computeContentHash(artifact);
  return artifact;
}
