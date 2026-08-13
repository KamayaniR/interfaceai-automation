/**
 * What makes a step irreversible — defined once.
 *
 * This lived in two places (the discovery loop and the recorder) with two slightly
 * different keyword lists, and the looser one classified "Submit the member lookup
 * search" as irreversible. A read-only search was treated like moving money: discovery
 * refused it, the model correctly declined to work around the block, and the run
 * dead-ended. Two definitions of a safety-critical predicate is one too many.
 *
 * The calibration principle stands, and it is asymmetric on purpose: over-classifying
 * costs one human confirmation, under-classifying is unbounded. But "conservative" has
 * to mean *conservative about consequences*, not "matches a scary-sounding verb".
 * Submitting a form is not itself a consequence — what the form DOES is.
 *
 * Honest about what this is: a keyword heuristic over a natural-language intent string,
 * which is a stopgap. It has no idea whether a button labelled "Continue" commits a
 * wire transfer. The real answer is a per-capability policy that classifies by the
 * route and parameters an action hits, reviewed by a human at approval time — noted in
 * REPORT.md §6 as the main gap in the safety model. Until then this errs toward asking.
 */

import type { RiskClass } from '../schema/artifact.ts';

/**
 * Phrases that denote an actual irreversible consequence. Deliberately specific:
 * every entry names a thing that happens to a member's record or their money, not a
 * generic UI verb.
 *
 * Note "submit payment" and "post transaction" rather than bare "submit" / "post" —
 * that specificity is the entire fix.
 */
const IRREVERSIBLE_PHRASES = [
  'create account',
  'create the account',
  'create sub-account',
  'create the sub-account',
  'open account',
  'open a new account',
  'open new account',
  'open sub-account',
  'open a new sub-account',
  'close account',
  'close the account',
  'delete',
  'remove member',
  'transfer',
  'disburse',
  'withdraw',
  'submit payment',
  'post payment',
  'post transaction',
  'issue card',
  'reissue',
  'authorize payment',
  'approve payment',
];

/**
 * Phrases that write state but are correctable — worth auditing, not worth stopping
 * a run for.
 */
const MUTATING_PHRASES = ['save', 'update', 'edit', 'change', 'add note', 'flag'];

/**
 * Classify from what the step is trying to do.
 *
 * `label` should combine the control's accessible name with the recorded intent, so
 * that both "the button says Create Account" and "the operator meant to create an
 * account" can trigger it.
 */
export function classifyRisk(label: string, actionKind: string): RiskClass {
  // Reads cannot be irreversible, whatever the surrounding prose says.
  if (actionKind === 'navigate' || actionKind === 'extract' || actionKind === 'assert') return 'safe';

  const text = label.toLowerCase();

  if (IRREVERSIBLE_PHRASES.some((p) => text.includes(p))) return 'irreversible';
  if (MUTATING_PHRASES.some((p) => text.includes(p))) return 'mutating';

  // Filling a field commits nothing on its own; the commit is the click that follows.
  if (actionKind === 'type' || actionKind === 'select' || actionKind === 'press') return 'safe';

  return 'safe';
}
