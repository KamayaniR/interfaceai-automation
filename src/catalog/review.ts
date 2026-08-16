/**
 * The human projection of an artifact.
 *
 * §3.2 asks that an artifact be reviewable by "both a human reviewer and a calling
 * agent". Those are different readers with different needs, and one document can't
 * serve both well:
 *
 *   - A calling agent needs the typed contract → `catalog.toToolDef()`
 *   - A human needs to decide whether to APPROVE it → this
 *
 * Diffable is not the same as understandable. 250 lines of nested locator ladders are
 * technically reviewable; realistically a reviewer skims and clicks approve, which
 * makes the approval gate theatre. This renders the same artifact as the handful of
 * things a reviewer actually has to judge: what it takes, what it returns, what it
 * does step by step, what it verifies, and — most importantly — what it can do that
 * cannot be undone.
 *
 * Both views are projections of one source of truth. Neither is stored.
 */

import type { CapabilityArtifact, StepType, Checkpoint, TargetRef } from '../schema/artifact.ts';
import { verifyContentHash } from '../schema/hash.ts';

/** Describe a target the way a person would say it out loud. */
function describeTarget(target: TargetRef | undefined): string {
  if (!target) return '';
  const first = target.candidates[0];
  const frame = target.framePath.length ? `  (${target.framePath.join(' > ')})` : '';

  let what: string;
  switch (first?.by) {
    case 'role-name':
      what = `${first.role} "${first.name}"`;
      break;
    case 'label-proximity':
      what = `the field labelled "${first.labelText}"`;
      break;
    case 'anchor-relative':
      what = `the ${first.role} after "${first.anchorText}"`;
      break;
    case 'structural':
      what = `control #${first.controlIndex} in form #${first.formIndex}`;
      break;
    default:
      what = 'an element';
  }
  // The ladder depth is a robustness signal a reviewer should see: one candidate means
  // one point of failure.
  const depth = target.candidates.length;
  return `${what}${frame}   [${depth} locator${depth === 1 ? '' : 's'}]`;
}

function describeCheckpoint(cp: Checkpoint | undefined): string | null {
  if (!cp) return null;
  switch (cp.kind) {
    case 'text-present':
      return `verify: "${cp.text}" appears`;
    case 'text-absent':
      return `verify: "${cp.text}" is gone`;
    case 'url-matches':
      return `verify: url matches /${cp.pattern}/`;
    case 'element-present':
      return `verify: ${describeTarget(cp.target)} exists`;
    case 'value-equals':
      return `verify: field equals "${cp.value}"`;
  }
}

function describeStep(step: StepType, index: number): string[] {
  const lines: string[] = [];
  const n = String(index + 1).padStart(2, ' ');

  let action: string;
  switch (step.action.kind) {
    case 'navigate':
      action = `open ${step.action.url}`;
      break;
    case 'type':
      action = `type ${step.action.value} into ${describeTarget(step.target)}`;
      break;
    case 'select':
      action = `choose ${step.action.value} in ${describeTarget(step.target)}`;
      break;
    case 'click':
      action = `click ${describeTarget(step.target)}`;
      break;
    case 'press':
      action = `press ${step.action.key}`;
      break;
    case 'extract':
      action = `read ${step.action.outputName} from ${describeTarget(step.target)}`;
      break;
    case 'assert':
      action = `assert ${describeTarget(step.target)}`;
      break;
  }

  const risk = step.risk === 'safe' ? '' : `  ⚠ ${step.risk.toUpperCase()}`;
  lines.push(` ${n}  ${action}${risk}`);

  const cp = describeCheckpoint(step.waitFor);
  if (cp) lines.push(`     ${cp}`);

  // The failure model is the part a reviewer most needs and is least likely to dig
  // out of raw JSON.
  for (const rule of step.onCondition) {
    const trigger = rule.when.anyOf
      .map((c) => (c.kind === 'text-present' ? `"${c.text}"` : c.kind))
      .join(' or ');
    let outcome: string;
    switch (rule.then.then) {
      case 'business-outcome':
        outcome = `→ returns ${rule.then.outcomeCode}`;
        break;
      case 'recover':
        outcome = `→ recovers (${rule.then.recovery.length} step${rule.then.recovery.length === 1 ? '' : 's'}, ≤${rule.then.maxAttempts} attempts)`;
        break;
      case 'fail':
        outcome = `→ fails`;
        break;
      case 'escalate':
        outcome = `→ escalates to a human`;
        break;
    }
    lines.push(`     if ${trigger} ${outcome}`);
  }
  return lines;
}

export function renderForReview(artifact: CapabilityArtifact): string {
  const c = artifact.capability;
  const out: string[] = [];
  const rule = '─'.repeat(74);

  out.push(rule);
  out.push(`CAPABILITY  ${c.name}`);
  out.push(`            ${c.id}  v${c.version}  ·  ${c.status.toUpperCase()}`);
  out.push(`APP         ${artifact.app.vendor}/${artifact.app.appId}`);
  out.push(`RECORDED BY ${artifact.provenance.model}  on ${artifact.provenance.discoveredAt.slice(0, 10)}`);

  const verdict = verifyContentHash(artifact);
  const integrity =
    verdict.state === 'match' ? 'content hash verified'
    : verdict.state === 'absent' ? 'no content hash (recorded before content addressing)'
    : `⚠ CONTENT HAS BEEN MODIFIED SINCE RECORDING`;
  out.push(`INTEGRITY   ${integrity}`);
  out.push('');
  out.push(c.description);
  out.push('');

  out.push('TAKES');
  const inputs = Object.entries(artifact.inputs);
  if (!inputs.length) out.push('  (nothing)');
  for (const [name, spec] of inputs) {
    const sens = spec.sensitivity === 'public' ? '' : `  [${spec.sensitivity}]`;
    const pat = spec.pattern ? `  matching ${spec.pattern}` : '';
    out.push(`  ${name.padEnd(18)} ${spec.type}${pat}${sens}`);
    out.push(`  ${' '.repeat(18)} ${spec.description}`);
  }
  out.push('');

  out.push('RETURNS');
  const outputs = Object.entries(artifact.outputs);
  if (!outputs.length) out.push('  (nothing)');
  for (const [name, spec] of outputs) {
    const sens = spec.sensitivity === 'public' ? '' : `  [${spec.sensitivity}]`;
    out.push(`  ${name.padEnd(18)} ${spec.type}${sens}  — ${spec.description}`);
  }
  out.push('');

  out.push('OR ANSWERS WITH');
  if (!artifact.outcomes.length) {
    // Worth calling out. A capability with no declared outcomes will surface every
    // exceptional app state as a hard failure.
    out.push('  (none declared — every exceptional state will surface as a failure)');
  }
  for (const o of artifact.outcomes) out.push(`  ${o.code.padEnd(24)} ${o.description}`);
  out.push('');

  out.push(`STEPS  (${artifact.steps.length})`);
  artifact.steps.forEach((s, i) => out.push(...describeStep(s, i)));
  out.push('');

  const success = describeCheckpoint(artifact.checkpoint);
  out.push('SUCCEEDS WHEN');
  out.push(`  ${artifact.checkpoint.description}`);
  if (success) out.push(`  ${success}`);
  out.push('');

  // The single most important line for an approver.
  const risky = artifact.steps.filter((s) => s.risk !== 'safe');
  if (risky.length) {
    out.push('⚠ REQUIRES HUMAN CONFIRMATION');
    for (const s of risky) out.push(`  ${s.risk}: ${s.intent}`);
  } else {
    out.push('No irreversible steps — this capability only reads.');
  }
  out.push(rule);

  return out.join('\n');
}
