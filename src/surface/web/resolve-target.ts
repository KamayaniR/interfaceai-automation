/**
 * TargetRef resolution — how a recorded capability finds a control on replay.
 *
 * The contract, and the reasoning behind it:
 *
 *  1. Walk the candidate ladder in order, most-semantic strategy first.
 *  2. A candidate only counts if it matches EXACTLY ONE element. An ambiguous match is
 *     treated as no match and we fall through, because acting on "probably that one"
 *     is how automation quietly does the wrong thing to the wrong account.
 *  3. Verify the match against the recorded fingerprint. A mismatch does not block —
 *     the element may legitimately have been re-tagged — but it is reported.
 *  4. Report which rung matched. Rung 0 is healthy. Any lower rung means the surface
 *     moved and the artifact is running on borrowed time; that is a drift signal the
 *     caller gets back in the result, not something we swallow.
 *
 * This is the whole answer to "how do you achieve determinism without brittle
 * selectors": not one clever locator, but an ordered set of independent ones plus an
 * explicit ambiguity rule and an honest report of which one carried the run.
 */

import type { Frame } from 'playwright';
import { BROWSER_HELPERS, TARGET_ATTR } from './browser-lib.ts';
import type { TargetCandidate, TargetRef, TargetFingerprint } from '../../schema/artifact.ts';

export interface ResolutionOutcome {
  found: boolean;
  candidateIndex: number;
  strategy: string;
  fingerprintMismatch: boolean;
  /** Populated on failure — what each rung saw, for a debuggable error. */
  attempts: { strategy: string; matchCount: number }[];
}

interface InPageResult {
  matchCount: number;
  fingerprint?: TargetFingerprint;
}

/**
 * Runs one candidate strategy in the page. On a unique match, tags the element with
 * TARGET_ATTR so Playwright can then act on it through its normal locator machinery
 * (which gives us actionability checks, auto-waiting and trusted events for free).
 */
function candidateScript(candidate: TargetCandidate): string {
  const c = JSON.stringify(candidate);
  return `(() => {
    ${BROWSER_HELPERS}
    const TARGET_ATTR = ${JSON.stringify(TARGET_ATTR)};
    const c = ${c};

    // Clear any tag from a previous resolution in this frame.
    document.querySelectorAll('[' + TARGET_ATTR + ']').forEach((n) => n.removeAttribute(TARGET_ATTR));

    let matches = [];

    if (c.by === 'role-name') {
      const want = c.name.toLowerCase();
      matches = allControls().filter((el) => {
        if (roleOf(el) !== c.role) return false;
        const got = nameOf(el).toLowerCase();
        return c.nameIsSubstring ? got.includes(want) : got === want;
      });

    } else if (c.by === 'label-proximity') {
      // Find the cell whose text is the label, then take the control in the
      // neighbouring cell. This is the strategy that makes table layouts tractable.
      const want = c.labelText.toLowerCase();
      const cells = Array.prototype.slice.call(document.querySelectorAll('td, th'));
      const labelCells = cells.filter((cell) => {
        if (cell.querySelector(CONTROL_SELECTOR)) return false;
        return norm(cell.textContent).toLowerCase() === want;
      });

      const found = [];
      for (const cell of labelCells) {
        let target = null;
        if (c.direction === 'right') {
          let n = cell.nextElementSibling;
          while (n && !target) {
            // Prefer a control in the neighbouring cell; if the cell holds a plain
            // value instead (a rendered balance, a status), the cell itself IS the
            // target. Read-only fields are as much a part of these screens as inputs.
            target = n.querySelector(CONTROL_SELECTOR) || (norm(n.textContent) ? n : null);
            n = n.nextElementSibling;
          }
        } else {
          const row = cell.parentElement;
          const colIdx = Array.prototype.indexOf.call(row.children, cell);
          const nextRow = row.nextElementSibling;
          const below = nextRow && nextRow.children[colIdx];
          if (below) target = below.querySelector(CONTROL_SELECTOR) || (norm(below.textContent) ? below : null);
        }
        if (target && isVisible(target)) found.push(target);
      }
      matches = c.index > 0 ? found.slice(c.index, c.index + 1) : found;

    } else if (c.by === 'anchor-relative') {
      // "The Nth control of this role appearing after the text X in document order."
      const anchorWant = c.anchorText.toLowerCase();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let anchorNode = null;
      while (walker.nextNode()) {
        if (norm(walker.currentNode.textContent).toLowerCase().includes(anchorWant)) {
          anchorNode = walker.currentNode;
          break;
        }
      }
      if (anchorNode) {
        // role "text" means "the next text-bearing cell", which is how you address a
        // rendered value that is not a control at all. Everything else walks controls.
        const pool =
          c.role === 'text'
            ? Array.prototype.slice.call(document.querySelectorAll('td, th')).filter(
                (el) => isVisible(el) && norm(el.textContent) && !el.querySelector(CONTROL_SELECTOR),
              )
            : allControls().filter((el) => roleOf(el) === c.role);

        const after = pool.filter((el) => {
          const pos = anchorNode.compareDocumentPosition(el);
          return !!(pos & Node.DOCUMENT_POSITION_FOLLOWING);
        });
        if (after[c.offset]) matches = [after[c.offset]];
      }

    } else if (c.by === 'structural') {
      const forms = Array.prototype.slice.call(document.querySelectorAll('form'));
      const scope = c.formIndex >= 0 ? forms[c.formIndex] : document;
      if (scope) {
        const ctrls = Array.prototype.slice.call(scope.querySelectorAll(CONTROL_SELECTOR))
          .filter((el) => (el.getAttribute('type') || '').toLowerCase() !== 'hidden');
        if (ctrls[c.controlIndex]) matches = [ctrls[c.controlIndex]];
      }
    }

    if (matches.length === 1) {
      matches[0].setAttribute(TARGET_ATTR, '1');
      return { matchCount: 1, fingerprint: fingerprintOf(matches[0]) };
    }
    return { matchCount: matches.length };
  })()`;
}

function fingerprintDiffers(recorded: TargetFingerprint | undefined, live: TargetFingerprint | undefined): boolean {
  if (!recorded || !live) return false;
  if (recorded.tagName !== live.tagName) return true;
  if ((recorded.inputType ?? '') !== (live.inputType ?? '')) return true;
  // Only compare attributes we actually recorded — a new attribute appearing is not
  // by itself evidence of drift.
  for (const [k, v] of Object.entries(recorded.attrs)) {
    if (live.attrs[k] !== v) return true;
  }
  return false;
}

/**
 * Resolve a TargetRef within a frame. On success the element carries TARGET_ATTR and
 * the caller acts via `frame.locator('[__cua_target="1"]')`.
 */
export async function resolveTarget(frame: Frame, target: TargetRef): Promise<ResolutionOutcome> {
  const attempts: { strategy: string; matchCount: number }[] = [];

  for (let i = 0; i < target.candidates.length; i++) {
    const candidate = target.candidates[i]!;
    let result: InPageResult;
    try {
      result = (await frame.evaluate(candidateScript(candidate))) as InPageResult;
    } catch {
      attempts.push({ strategy: candidate.by, matchCount: -1 });
      continue;
    }

    attempts.push({ strategy: candidate.by, matchCount: result.matchCount });

    // Ambiguity is failure, not a coin flip.
    if (result.matchCount !== 1) continue;

    return {
      found: true,
      candidateIndex: i,
      strategy: candidate.by,
      fingerprintMismatch: fingerprintDiffers(target.fingerprint, result.fingerprint),
      attempts,
    };
  }

  return { found: false, candidateIndex: -1, strategy: 'none', attempts, fingerprintMismatch: false };
}

/** Human-readable explanation of a resolution failure, for the failure message. */
export function describeFailure(target: TargetRef, outcome: ResolutionOutcome): string {
  const tried = outcome.attempts
    .map((a) => `${a.strategy}=${a.matchCount === -1 ? 'error' : `${a.matchCount} match(es)`}`)
    .join(', ');
  const frame = target.framePath.length ? ` in frame [${target.framePath.join(' > ')}]` : '';
  return `could not uniquely resolve target${frame}; tried ${tried}`;
}

/**
 * Synthesise a durable TargetRef from a perceived element.
 *
 * Called by the recorder when it converts a discovery run into an artifact. The ladder
 * is built most-stable-first, and every rung that the element actually supports is
 * included — redundancy here is the whole point, since we are recording once and
 * replaying for months.
 */
export function synthesiseTarget(el: {
  role: string;
  name: string;
  framePath: string[];
  tagName: string;
  inputType?: string;
  attrs: Record<string, string>;
  formIndex: number;
  controlIndex: number;
  labelHint?: string;
}): TargetRef {
  const candidates: TargetCandidate[] = [];

  if (el.name) {
    candidates.push({ by: 'role-name', role: el.role, name: el.name, nameIsSubstring: false });
  }
  if (el.labelHint && el.labelHint !== el.name) {
    candidates.push({ by: 'label-proximity', labelText: el.labelHint, direction: 'right', index: 0 });
  } else if (el.labelHint) {
    candidates.push({ by: 'label-proximity', labelText: el.labelHint, direction: 'right', index: 0 });
  }
  if (el.name) {
    // Loose-name rung: survives padding, punctuation and casing changes in labels.
    candidates.push({ by: 'role-name', role: el.role, name: el.name, nameIsSubstring: true });
  }
  candidates.push({ by: 'structural', formIndex: el.formIndex, controlIndex: el.controlIndex });

  return {
    framePath: el.framePath,
    candidates,
    fingerprint: { tagName: el.tagName, inputType: el.inputType, attrs: el.attrs },
  };
}
