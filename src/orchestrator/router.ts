/**
 * The router: turns a natural-language goal into a decision about what to run.
 *
 * This is deliberately a CLIENT of the system, not part of it. The brief draws the
 * line explicitly — "the agent-facing product decides *what* to do; this system is how
 * it reliably and safely does it" — and that separation is load-bearing rather than
 * pedantic: if routing lived inside the integration layer, every institution would be
 * forced to route our way. The catalog's typed tool definitions are the interface, and
 * this is one reference implementation of a consumer. A bank that won't put an LLM in
 * this path can swap it for a rules engine and every safety property still holds.
 *
 * Which matters because the router is the component that can decide WRONG. So its
 * decisions are gated by things it cannot overrule, none of which live in this file:
 *
 *   - it cannot invoke a `draft`          → Catalog resolves to approved versions
 *   - it cannot supply invalid inputs     → ParamSpec, checked here AND in replay
 *   - it cannot widen what an action does → Policy, enforced in Surface.act()
 *   - it must not guess                   → missing inputs become `clarify`, not a guess
 *
 * The split below is deliberate: `proposeRoute` is the only part that needs a model,
 * and `applyGuardrails` is pure. The guardrails are the part worth testing, and they
 * are testable without an API key.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Catalog, CapabilityToolDef } from '../catalog/catalog.ts';
import type { CapabilityArtifact } from '../schema/artifact.ts';

export const ROUTER_MODEL = 'claude-opus-5';

/** What the model proposes, before any of it is trusted. */
export interface ProposedRoute {
  action: 'invoke' | 'discover' | 'clarify';
  capabilityId?: string;
  inputs?: Record<string, string>;
  confidence: number;
  reason: string;
  /** Populated when the model wants something from the user. */
  question?: string;
}

/** What the system will actually do, after gating. */
export type Route =
  | { action: 'invoke'; artifact: CapabilityArtifact; inputs: Record<string, string>; reason: string; confidence: number }
  | { action: 'clarify'; question: string; reason: string }
  | { action: 'discover'; goal: string; reason: string; hint?: { variantOf: string } }
  | { action: 'refuse'; reason: string };

/**
 * Below this, asking is cheaper than being wrong.
 *
 * The asymmetry is the point: a clarifying question costs a second, and invoking the
 * wrong capability against a member's account is an incident. In a domain where the
 * downside is unbounded, a router should be biased toward asking.
 */
export const CONFIDENCE_FLOOR = 0.7;

const SYSTEM_PROMPT = `You route a user's goal to one of the automation capabilities available for a bank back-office application, or decide that none of them fit.

You are given each capability's typed contract: what it does, the arguments it takes (with validation patterns), what it returns, and the non-error answers it can produce.

Decide one of three things:

- "invoke"  — a capability clearly matches AND you can fill every required argument from the goal.
- "clarify" — a capability matches but a required argument is missing or ambiguous. Ask for exactly what you need. NEVER invent an account number, member number or amount.
- "discover" — nothing available does this. Recording a new capability requires a slow, expensive LLM run against the live application, so only choose this when you are confident nothing fits.

Earlier turns may be shown to you. Use them ONLY to resolve what the current goal is
referring to — a bare "100442" following your own question about a member number is that
answer. Never carry a value forward into an unrelated request: an account number
mentioned earlier is not an answer to a different question later.

Report "confidence" honestly as 0..1. Under-confidence is cheap; over-confidence acts on the wrong member's account. When a capability is a near-miss rather than a match, say so in "reason" — it may be a variant of the same underlying flow for a different institution.

Respond with ONLY a JSON object, no prose:
{"action":"invoke"|"clarify"|"discover","capabilityId":"...","inputs":{...},"confidence":0.0,"reason":"...","question":"..."}`;

function renderCatalogue(defs: CapabilityToolDef[]): string {
  if (!defs.length) return '(no capabilities are available)';
  return defs
    .map((d) => {
      const args = Object.entries(d.input_schema.properties)
        .map(([n, p]) => `      ${n}: ${p.type}${p.pattern ? ` matching ${p.pattern}` : ''} — ${p.description}`)
        .join('\n');
      const returns = Object.entries(d._meta.returns).map(([n, t]) => `      ${n}: ${t}`).join('\n');
      return [
        `  ${d.name}  (v${d._meta.version}, ${d._meta.status})`,
        `    ${d.description.split('\n')[0]}`,
        `    app: ${d._meta.app}`,
        args ? `    arguments:\n${args}` : '    arguments: (none)',
        returns ? `    returns:\n${returns}` : '',
      ].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

/**
 * A short window of prior turns, so a reply can resolve against the question that
 * prompted it. Asking "which member number?" is useless if the answer arrives with no
 * memory of the question.
 */
export interface PriorTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * How much conversation the router may see.
 *
 * Deliberately short. A long window is not more helpful — it is more dangerous: a member
 * number mentioned three topics ago becomes a plausible answer to an unrelated question,
 * which is precisely the "acted on the wrong account" failure the clarify path exists to
 * prevent. Six turns covers a question and its answer with room to spare.
 */
export const CONTEXT_TURNS = 6;

/** The only part that needs a model. */
export async function proposeRoute(
  goal: string,
  defs: CapabilityToolDef[],
  history: PriorTurn[] = [],
): Promise<ProposedRoute> {
  const client = new Anthropic();

  const recent = history.slice(-CONTEXT_TURNS);
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: `AVAILABLE CAPABILITIES:\n\n${renderCatalogue(defs)}` },
    { role: 'assistant', content: 'Understood. Give me a goal and I will route it.' },
    ...recent.map((t) => ({ role: t.role, content: t.content })),
    { role: 'user', content: `GOAL: ${goal}` },
  ];

  const response = await client.messages.create({
    model: ROUTER_MODEL,
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages,
  });

  const text = response.content.find((b) => b.type === 'text');
  const raw = text && text.type === 'text' ? text.text : '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    // An unparseable router response must not become an invocation.
    return { action: 'discover', confidence: 0, reason: `router returned no parseable decision: ${raw.slice(0, 120)}` };
  }
  return JSON.parse(match[0]) as ProposedRoute;
}

/**
 * Gate the proposal. Pure — no model, no I/O beyond reading the catalog — so every
 * rule below is testable, and none of them can be talked out of by a persuasive model.
 */
export function applyGuardrails(proposed: ProposedRoute, catalog: Catalog, goal: string): Route {
  if (proposed.action === 'clarify') {
    return {
      action: 'clarify',
      question: proposed.question || 'Which record should I act on?',
      reason: proposed.reason,
    };
  }

  if (proposed.action === 'discover') {
    return { action: 'discover', goal, reason: proposed.reason };
  }

  // --- invoke, from here down ---------------------------------------------

  if (!proposed.capabilityId) {
    return { action: 'discover', goal, reason: 'router chose invoke but named no capability' };
  }

  // Resolution is approval-aware: this returns the latest APPROVED version, so a
  // freshly discovered draft cannot become what a caller invokes.
  //
  // Accept either the real capability id or the sanitised tool name. Tool-calling
  // names can't contain dots, so `member.read-savings-balance` is advertised to agents
  // as `member_read-savings-balance` — and a router naturally echoes back the name it
  // was given. Resolving only the raw id sent every correct match to discovery.
  const artifact =
    catalog.get(proposed.capabilityId) ??
    catalog.list().find((a) => a.capability.id.replace(/[^a-zA-Z0-9_-]/g, '_') === proposed.capabilityId) ??
    null;

  if (!artifact) {
    return { action: 'discover', goal, reason: `no capability named "${proposed.capabilityId}" exists` };
  }

  if (artifact.capability.status !== 'approved') {
    // The approval gate, restated at the routing layer. An LLM wrote that flow and no
    // human has read it; a router that runs it anyway makes the gate decorative.
    return {
      action: 'refuse',
      reason:
        `"${artifact.capability.id}" v${artifact.capability.version} is a draft — an LLM recorded it and no human has reviewed it. ` +
        `Review it (npm run catalog -- review ${artifact.capability.id}) and approve it before it can be invoked.`,
    };
  }

  if (proposed.confidence < CONFIDENCE_FLOOR) {
    return {
      action: 'clarify',
      question: proposed.question || `Did you mean to run "${artifact.capability.name}"?`,
      reason: `confidence ${proposed.confidence} is below the floor of ${CONFIDENCE_FLOOR}`,
    };
  }

  // Validate inputs against the declared contract BEFORE launching a browser. Replay
  // checks this too — deliberately. Defence in depth, and here it converts a would-be
  // failure into a question the user can answer.
  const inputs = proposed.inputs ?? {};
  for (const [name, spec] of Object.entries(artifact.inputs)) {
    const value = inputs[name];
    if (value === undefined) {
      if (!spec.required) continue;
      return {
        action: 'clarify',
        question: `What ${name} should I use? (${spec.description})`,
        reason: `required input "${name}" was not present in the goal`,
      };
    }
    if (spec.pattern && !new RegExp(spec.pattern).test(value)) {
      return {
        action: 'clarify',
        // Never echo the value — it may be PII, and the point is the shape anyway.
        question: `That ${name} doesn't look right — it must match ${spec.pattern}. What should I use?`,
        reason: `input "${name}" failed its declared pattern`,
      };
    }
  }

  for (const name of Object.keys(inputs)) {
    if (!artifact.inputs[name]) {
      return { action: 'discover', goal, reason: `router supplied undeclared input "${name}"` };
    }
  }

  return { action: 'invoke', artifact, inputs, reason: proposed.reason, confidence: proposed.confidence };
}
