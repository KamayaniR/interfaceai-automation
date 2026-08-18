/**
 * Checkpoint verification and runtime-condition detection.
 *
 * These are two different jobs and the distinction is load-bearing:
 *
 *   A CHECKPOINT answers "did I reach the state I expected?" It is the positive
 *   assertion after every step. Failing it means something is wrong.
 *
 *   A CONDITION answers "is the app telling me something specific went differently?"
 *   It is checked BEFORE the checkpoint, because a "no such member" banner is not a
 *   checkpoint timeout — it is the app working correctly and giving us an answer. If
 *   we let the checkpoint time out first we would report a 10-second hang instead of a
 *   clean business outcome, which is exactly the conflation the brief warns about.
 */

import type { Checkpoint, ConditionMatcher, TargetRef } from '../schema/artifact.ts';
import type { WebSurface } from '../surface/web/web-surface.ts';
import { resolveTarget } from '../surface/web/resolve-target.ts';

export interface CheckOutcome {
  passed: boolean;
  /** What the artifact said should be true. */
  expected: string;
  /** What we actually saw. Written to be readable in a failure message. */
  observed: string;
}

function frameText(texts: { framePath: string[]; content: string }[], framePath: string[]): string {
  if (framePath.length === 0) return texts.map((t) => t.content).join('\n');
  const match = texts.find(
    (t) => t.framePath.length === framePath.length && t.framePath.every((s, i) => s === framePath[i]),
  );
  // If the named frame isn't present, fall back to all text rather than reporting a
  // false negative — frame naming varies more than content does.
  return match ? match.content : texts.map((t) => t.content).join('\n');
}

async function targetExists(surface: WebSurface, target: TargetRef): Promise<boolean> {
  const page = surface.rawPage;
  const frames = [page.mainFrame(), ...page.frames()];
  for (const frame of frames) {
    const outcome = await resolveTarget(frame, target).catch(() => null);
    if (outcome?.found) return true;
  }
  return false;
}

/**
 * Evaluate a checkpoint, polling until it passes or its timeout expires.
 *
 * Polling rather than a one-shot check because legacy apps do full-page reloads and
 * the state we want may be one navigation away. The timeout comes from the artifact,
 * per checkpoint, so a screen known to be slow can declare that.
 */
/**
 * Substring test, optionally case-insensitive.
 *
 * An empty needle is always "contained", which is deliberate: it is what makes an
 * assertion built from an OPTIONAL input inert when the caller omits it, without the
 * artifact needing a second conditional shape to express "only check this if supplied".
 */
function contains(haystack: string, needle: string, ignoreCase = false): boolean {
  if (!needle) return true;
  return ignoreCase ? haystack.toLowerCase().includes(needle.toLowerCase()) : haystack.includes(needle);
}

export async function verifyCheckpoint(surface: WebSurface, cp: Checkpoint): Promise<CheckOutcome> {
  const deadline = Date.now() + cp.timeoutMs;
  let observed = '(nothing observed)';

  for (;;) {
    const obs = await surface.perceive();

    switch (cp.kind) {
      case 'text-present': {
        const text = frameText(obs.text, cp.framePath);
        if (contains(text, cp.text, cp.ignoreCase))
          return { passed: true, expected: cp.description, observed: `found "${cp.text}"` };
        observed = `page text did not contain "${cp.text}"`;
        break;
      }
      case 'text-absent': {
        const text = frameText(obs.text, cp.framePath);
        if (!contains(text, cp.text, cp.ignoreCase))
          return { passed: true, expected: cp.description, observed: `"${cp.text}" absent` };
        observed = `page text still contained "${cp.text}"`;
        break;
      }
      case 'url-matches': {
        if (new RegExp(cp.pattern).test(obs.url)) {
          return { passed: true, expected: cp.description, observed: `url ${obs.url}` };
        }
        observed = `url was ${obs.url}, expected to match /${cp.pattern}/`;
        break;
      }
      case 'element-present': {
        if (await targetExists(surface, cp.target)) {
          return { passed: true, expected: cp.description, observed: 'element present' };
        }
        observed = 'expected element was not found';
        break;
      }
      case 'value-equals': {
        observed = 'value did not match';
        break;
      }
    }

    if (Date.now() > deadline) return { passed: false, expected: cp.description, observed };
    await new Promise((r) => setTimeout(r, 400));
  }
}

/**
 * Check whether an exceptional condition is currently present. Single-shot: conditions
 * describe what the app is showing right now, not something we wait for.
 */
export async function detectCondition(surface: WebSurface, matcher: ConditionMatcher): Promise<boolean> {
  const obs = await surface.perceive();
  const allText = obs.text.map((t) => t.content).join('\n');

  for (const clause of matcher.anyOf) {
    if (clause.kind === 'text-present' && contains(allText, clause.text, clause.ignoreCase)) return true;
    if (clause.kind === 'text-absent') {
      // Scoped to the clause's frame: an unscoped check would see the nav chrome and
      // could call a name "present" because it appears somewhere unrelated.
      const scoped = frameText(obs.text, clause.framePath);
      // An empty needle means the caller supplied nothing, so there is nothing to
      // assert — never fire, rather than firing on every run.
      if (clause.text && !contains(scoped, clause.text, clause.ignoreCase)) return true;
    }
    if (clause.kind === 'url-matches' && new RegExp(clause.pattern).test(obs.url)) return true;
    if (clause.kind === 'element-present' && (await targetExists(surface, clause.target))) return true;
  }
  return false;
}
