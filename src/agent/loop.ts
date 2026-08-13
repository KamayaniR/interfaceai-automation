/**
 * The LLM-driven discovery loop: observe -> decide -> act, against a live surface.
 *
 * This is the only place a model is in the decision loop. It runs once per capability;
 * everything after this is deterministic replay.
 *
 * A manual tool-use loop rather than the SDK's tool runner, for a specific reason: each
 * iteration has to do three things the runner does not model — re-perceive the surface
 * and render it as the tool result, record the accessibility descriptor of the element
 * that was acted on (which is what the recorder later turns into a locator ladder), and
 * translate a policy refusal into a message the model can reason about rather than an
 * exception. Owning the loop keeps all three in one readable place.
 */

import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import { DISCOVERY_TOOLS, SYSTEM_PROMPT } from './tools.ts';
import { recordArtifact, type RecordedAction, type FinishContract } from './record.ts';
import { renderIndex } from '../surface/web/a11y-index.ts';
import { WebSurface, PolicyBlockedError, ConfirmationRequiredError } from '../surface/web/web-surface.ts';
import { Policy } from '../policy/policy.ts';
import { classifyRisk } from '../policy/risk.ts';
import { Redactor } from '../policy/redact.ts';
import { RunLogger } from '../obs/logger.ts';
import { SessionControl } from '../escalation/broker.ts';
import type { CapabilityArtifact, Action } from '../schema/artifact.ts';
import type { Observation } from '../surface/surface.ts';

export const DISCOVERY_MODEL = 'claude-opus-5';

export interface DiscoverOptions {
  goal: string;
  entryUrl: string;
  appId: string;
  vendor: string;
  policyPath: string;
  runsDir: string;
  headed: boolean;
  maxSteps: number;
  timeoutMs: number;
}

export type DiscoverResult =
  | { status: 'success'; artifact: CapabilityArtifact; runId: string; runDir: string }
  | { status: 'stuck'; reason: string; runId: string; runDir: string }
  | { status: 'exhausted'; reason: string; runId: string; runDir: string };

/** Render an observation as the text block the model reads. */
function renderObservation(obs: Observation, note?: string): string {
  const text = obs.text
    .map((t) => `--- text (${t.framePath.join(' > ') || 'main'}) ---\n${t.content}`)
    .join('\n');
  return [
    note ? `RESULT: ${note}` : null,
    `URL: ${obs.url}`,
    `TITLE: ${obs.title}`,
    '',
    'CONTROLS:',
    renderIndex(obs.elements),
    '',
    'VISIBLE TEXT:',
    text.slice(0, 4000),
  ]
    .filter((x) => x !== null)
    .join('\n');
}

export async function discover(opts: DiscoverOptions): Promise<DiscoverResult> {
  const runId = randomUUID().slice(0, 8);
  const runDir = join(opts.runsDir, `discovery-${runId}`);

  const policy = Policy.load(opts.policyPath, 'discovery');
  const redactor = new Redactor(policy.redactionConfig);
  const logger = new RunLogger(runDir, runId, redactor);
  const control = new SessionControl();

  const client = new Anthropic();
  const surface = await WebSurface.launch({
    headed: opts.headed,
    policy,
    control,
    onEvent: (e) => logger.log(e.type, e.detail),
  });

  const recorded: RecordedAction[] = [];
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  const deadline = Date.now() + opts.timeoutMs;

  logger.log('discovery.start', { goal: opts.goal, entryUrl: opts.entryUrl, model: DISCOVERY_MODEL });

  try {
    // Seed: navigate to the entry point ourselves and show the model what it sees.
    // Doing this outside the loop means the model's first decision is about the task,
    // not about how to get to the front door.
    const navResult = await surface.actByTarget({ kind: 'navigate', url: opts.entryUrl }, null, 'safe');
    if (!navResult.ok) {
      return { status: 'stuck', reason: `could not open entry URL: ${navResult.error}`, runId, runDir };
    }
    recorded.push({
      kind: 'navigate',
      intent: `Open the ${opts.appId} entry point`,
      url: opts.entryUrl,
      resultingText: '',
      resultingUrl: surface.currentUrl,
    });

    let obs = await surface.perceive();
    messages.push({
      role: 'user',
      content: `GOAL: ${opts.goal}\n\n${renderObservation(obs)}`,
    });

    for (let step = 0; step < opts.maxSteps; step++) {
      if (Date.now() > deadline) {
        return { status: 'exhausted', reason: `timed out after ${opts.timeoutMs}ms`, runId, runDir };
      }

      // Streamed, not a plain create(): a thinking turn at this budget can exceed the
      // SDK's non-streaming timeout, and it refuses the request outright rather than
      // hanging. `finalMessage()` gives us the accumulated turn once it completes.
      const stream = client.beta.messages.stream({
        model: DISCOVERY_MODEL,
        // Generous: adaptive thinking shares this budget with the response, and a turn
        // that spends it all on reasoning returns no tool call at all.
        max_tokens: 32_000,
        system: SYSTEM_PROMPT,
        tools: DISCOVERY_TOOLS,
        messages,
        // Adaptive thinking + high effort: choosing the next action on an unfamiliar
        // legacy screen is exactly the kind of step where reasoning pays for itself,
        // and this loop runs once per capability rather than once per invocation.
        // Cast because the installed SDK's typings predate `adaptive`; the wire value
        // is current for Opus 5.
        //
        // `fallbacks: "default"` opts into server-side refusal fallback. Opus 5 runs
        // safety classifiers that can decline a request outright (HTTP 200,
        // stop_reason: "refusal"), and driving a *banking* UI sits close enough to the
        // boundary that benign automation work does occasionally trip them. Rather than
        // dead-ending the run, the API re-serves the same request on the recommended
        // fallback model inside the same call.
        ...({
          thinking: { type: 'adaptive' },
          output_config: { effort: 'high' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        } as object),
      } as never);
      const response = await stream.finalMessage();

      // A refusal is a successful HTTP response, so it must be checked BEFORE reading
      // content — indexing into `content` here would just find a thinking block.
      if (response.stop_reason === 'refusal') {
        const details = (response as unknown as { stop_details?: { category?: string; explanation?: string } })
          .stop_details;
        const reason =
          `the request was declined by a safety classifier ` +
          `(category: ${details?.category ?? 'unknown'})` +
          (details?.explanation ? `: ${details.explanation}` : '') +
          `. The whole fallback chain declined.`;
        logger.log('discovery.refused', { category: details?.category, explanation: details?.explanation });
        return { status: 'stuck', reason, runId, runDir };
      }

      messages.push({ role: 'assistant', content: response.content });

      // Narrate the model's reasoning into the run log — this is the "what did it do
      // and why" half of the evidence requirement.
      for (const block of response.content) {
        if (block.type === 'text' && block.text.trim()) {
          logger.log('model.text', { text: block.text.slice(0, 1000) });
          console.log(`  · ${block.text.trim().split('\n')[0]?.slice(0, 110)}`);
        }
      }

      logger.log('model.response', {
        stopReason: response.stop_reason,
        blocks: response.content.map((b) => b.type),
        usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
      });

      const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (toolUses.length === 0) {
        // No tool call and no finish. Report WHY — a turn truncated by max_tokens and a
        // model that has genuinely run out of ideas look identical without stop_reason,
        // and they need opposite fixes.
        const reason =
          response.stop_reason === 'max_tokens'
            ? `the model's turn was truncated by max_tokens before it emitted a tool call (blocks: ${response.content.map((b) => b.type).join(', ') || 'none'}). Raise max_tokens or lower effort.`
            : `model produced no tool call (stop_reason: ${response.stop_reason}, blocks: ${response.content.map((b) => b.type).join(', ') || 'none'})`;
        logger.log('discovery.stuck', { reason });
        return { status: 'stuck', reason, runId, runDir };
      }

      const toolResults: Anthropic.Beta.BetaToolResultBlockParam[] = [];

      for (const use of toolUses) {
        const input = use.input as Record<string, unknown>;
        logger.log('model.tool_use', { tool: use.name, input: redactor.scrubDeep(input) });
        console.log(`  → ${use.name}(${JSON.stringify(input).slice(0, 100)})`);

        // ---- terminal tools -------------------------------------------------
        if (use.name === 'stuck') {
          const reason = String(input.reason ?? 'unspecified');
          await surface.screenshot(logger.screenshotPath('stuck'));
          logger.log('discovery.stuck', { reason });
          return { status: 'stuck', reason, runId, runDir };
        }

        if (use.name === 'finish') {
          const contract = input as unknown as FinishContract;
          await surface.screenshot(logger.screenshotPath('final'));
          await surface.snapshotDom(logger.domPath('final'));

          const transcript = JSON.stringify(messages, null, 2);
          writeFileSync(join(runDir, 'transcript.json'), redactor.scrub(transcript));

          const artifact = recordArtifact({
            actions: recorded,
            contract,
            goal: opts.goal,
            entryUrl: opts.entryUrl,
            appId: opts.appId,
            vendor: opts.vendor,
            model: DISCOVERY_MODEL,
            runId,
            transcript,
          });

          logger.log('discovery.success', {
            capability: artifact.capability.id,
            steps: artifact.steps.length,
            inputs: Object.keys(artifact.inputs),
            outputs: Object.keys(artifact.outputs),
            outcomes: artifact.outcomes.map((o) => o.code),
          });
          return { status: 'success', artifact, runId, runDir };
        }

        // ---- acting tools ---------------------------------------------------
        const ref = typeof input.ref === 'number' ? input.ref : null;
        const element = ref !== null ? obs.elements.find((e) => e.ref === ref) : undefined;

        let action: Action;
        let kind: RecordedAction['kind'];
        switch (use.name) {
          case 'navigate':
            action = { kind: 'navigate', url: String(input.url) };
            kind = 'navigate';
            break;
          case 'click':
            action = { kind: 'click' };
            kind = 'click';
            break;
          case 'type':
            action = { kind: 'type', value: String(input.text), clearFirst: true };
            kind = 'type';
            break;
          case 'select':
            action = { kind: 'select', value: String(input.value) };
            kind = 'select';
            break;
          case 'extract':
            action = {
              kind: 'extract',
              outputName: String(input.output_name),
              from: (input.from as 'text' | 'value') ?? 'text',
              pattern: input.pattern ? String(input.pattern) : undefined,
            };
            kind = 'extract';
            break;
          default:
            toolResults.push({
              type: 'tool_result',
              tool_use_id: use.id,
              content: `Unknown tool "${use.name}".`,
              is_error: true,
            });
            continue;
        }

        if (use.name !== 'navigate' && !element) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: `ref ${ref} is not in the current observation. Refs change after every action — re-read the CONTROLS list above and use a ref from it.`,
            is_error: true,
          });
          continue;
        }

        // Under the discovery profile, an irreversible action is escalated rather than
        // executed. We surface that to the model as a refusal it can reason about, not
        // as a crash — and it is instructed not to route around it.
        //
        // Classified from the control's own name AND the model's stated intent, through
        // the single shared definition in policy/risk.ts.
        const risk = classifyRisk(`${element?.name ?? ''} ${String(input.intent ?? '')}`, kind);

        let result;
        try {
          result = await surface.actByRef(action, ref, risk);
        } catch (err) {
          if (err instanceof PolicyBlockedError || err instanceof ConfirmationRequiredError) {
            logger.log('policy.refused', { tool: use.name, reason: err.message });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: use.id,
              content:
                `REFUSED BY SAFETY POLICY: ${err.message}\n\n` +
                `This action is irreversible and the discovery profile does not permit executing it. ` +
                `Do not attempt to work around this. If the goal cannot be completed without it, call \`stuck\`.`,
              is_error: true,
            });
            continue;
          }
          throw err;
        }

        if (!result.ok) {
          logger.log('action.failed', { tool: use.name, error: result.error });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: `Action failed: ${result.error}`,
            is_error: true,
          });
          continue;
        }

        // Re-perceive after every successful action. In a server-rendered app the page
        // has almost certainly been replaced.
        obs = await surface.perceive();

        recorded.push({
          kind,
          intent: String(input.intent ?? use.name),
          url: kind === 'navigate' ? String(input.url) : undefined,
          value: kind === 'type' ? String(input.text) : kind === 'select' ? String(input.value) : undefined,
          outputName: kind === 'extract' ? String(input.output_name) : undefined,
          from: kind === 'extract' ? ((input.from as 'text' | 'value') ?? 'text') : undefined,
          pattern: kind === 'extract' && input.pattern ? String(input.pattern) : undefined,
          element,
          resultingText: obs.text.map((t) => t.content).join('\n').slice(0, 2000),
          resultingUrl: obs.url,
        });

        const note =
          kind === 'extract'
            ? `extracted "${result.extracted}" into output "${String(input.output_name)}"`
            : `${use.name} succeeded`;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: renderObservation(obs, note),
        });
      }

      messages.push({ role: 'user', content: toolResults });
    }

    return { status: 'exhausted', reason: `reached the ${opts.maxSteps}-step limit`, runId, runDir };
  } finally {
    await surface.close();
  }
}
