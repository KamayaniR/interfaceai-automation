/**
 * Wrong-account protection.
 *
 * "Acted on the wrong account" is the canonical banking failure, and it is the one this
 * system was structurally unable to notice: the capability's contract was
 * `memberId -> savingsBalance`, so a caller who asked for Rosa's balance and supplied
 * someone else's member number got that someone else's money, confidently and fast.
 *
 * The fix is a declared assertion rather than a smarter model, and these tests pin the
 * three properties that make it trustworthy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArtifact } from '../src/schema/artifact.ts';

const savings = parseArtifact(
  JSON.parse(readFileSync('artifacts/member.read-savings-balance/v1.json', 'utf8')),
);

test('the capability returns WHO it read, not only what it read', () => {
  // Without this the caller has no way to audit which record answered them.
  assert.ok(savings.outputs.memberName, 'memberName must be a declared output');
  assert.equal(savings.outputs.memberName?.sensitivity, 'pii');
});

test('the name is read off the screen, not echoed from the input', () => {
  // An assertion that compares the input to itself always passes. The value has to come
  // from the record that actually loaded.
  const step = savings.steps.find(
    (s) => s.action.kind === 'extract' && s.action.outputName === 'memberName',
  );
  assert.ok(step, 'a step must extract memberName from the page');
  assert.ok(step!.target, 'and it must target an element, not a constant');
});

test('the identity check runs BEFORE any value is extracted', () => {
  // Order is the whole point: stopping after reading the wrong account still leaked it.
  const assertIdx = savings.steps.findIndex((s) =>
    s.onCondition.some((c) => c.when.id === 'member-name-mismatch'),
  );
  const firstExtract = savings.steps.findIndex((s) => s.action.kind === 'extract');
  assert.ok(assertIdx >= 0, 'the mismatch condition must be declared');
  assert.ok(assertIdx < firstExtract, 'it must fire before the first extraction');
});

test('a mismatch is a business outcome, not a crash', () => {
  const rule = savings.steps
    .flatMap((s) => s.onCondition)
    .find((c) => c.when.id === 'member-name-mismatch');
  assert.equal(rule?.then.then, 'business-outcome');
  assert.ok(savings.outcomes.some((o) => o.code === 'MEMBER_NAME_MISMATCH'));
});

test('the check is optional, and inert when the caller supplies no name', () => {
  // Every existing caller passes only memberId. Making the name required would have
  // broken them all, and a check nobody can satisfy gets disabled rather than fixed.
  assert.equal(savings.inputs.expectedName?.required, false);
  const rule = savings.steps
    .flatMap((s) => s.onCondition)
    .find((c) => c.when.id === 'member-name-mismatch');
  const clause = rule!.when.anyOf[0]!;
  assert.equal(clause.kind, 'text-absent');
  if (clause.kind !== 'text-absent') return;
  assert.equal(clause.text, '{{expectedName}}', 'resolved against the caller input');
  assert.equal(clause.ignoreCase, true, 'CoreVue shouts names; callers do not');
});
