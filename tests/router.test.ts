/**
 * Router guardrail tests.
 *
 * The router is the one component that can decide *wrong* — it picks which capability
 * runs against a member's account. So the tests here are about what it is prevented
 * from doing, not about whether the model picks well. Every rule below is enforced in
 * pure code (`applyGuardrails`), which is why none of this needs an API key: a
 * persuasive model cannot talk its way past a function that doesn't call it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Catalog } from '../src/catalog/catalog.ts';
import { applyGuardrails, CONFIDENCE_FLOOR, type ProposedRoute } from '../src/orchestrator/router.ts';

const catalog = new Catalog('artifacts');
const GOAL = 'read the savings balance for member 100442';

const propose = (over: Partial<ProposedRoute> = {}): ProposedRoute => ({
  action: 'invoke',
  capabilityId: 'member.read-savings-balance',
  inputs: { memberId: '100442' },
  confidence: 0.95,
  reason: 'test',
  ...over,
});

test('a well-formed match is invoked, resolved to the APPROVED version', () => {
  const route = applyGuardrails(propose(), catalog, GOAL);
  assert.equal(route.action, 'invoke');
  if (route.action !== 'invoke') return;
  assert.equal(route.artifact.capability.status, 'approved');
  assert.deepEqual(route.inputs, { memberId: '100442' });
});

test('the sanitised tool name resolves to the same capability as the raw id', () => {
  // Tool-calling names can't contain dots, so agents see `member_read-savings-balance`.
  // A router echoing that back must not be routed to discovery.
  const route = applyGuardrails(propose({ capabilityId: 'member_read-savings-balance' }), catalog, GOAL);
  assert.equal(route.action, 'invoke');
});

test('a DRAFT capability is refused, never invoked', () => {
  // The load-bearing one. v2 was written by an LLM and no human has reviewed it.
  const route = applyGuardrails(
    propose({
      capabilityId: 'draft-only-capability',
      inputs: {},
    }),
    new Catalog('tests/fixtures/artifacts'),
    GOAL,
  );
  assert.equal(route.action, 'refuse');
  if (route.action !== 'refuse') return;
  assert.match(route.reason, /draft/i);
  assert.match(route.reason, /review/i, 'the refusal should tell you how to resolve it');
});

test('a missing required input becomes a question, never a guess', () => {
  // The failure that matters: inventing a member number is unacceptable in a bank.
  const route = applyGuardrails(propose({ inputs: {} }), catalog, GOAL);
  assert.equal(route.action, 'clarify');
  if (route.action !== 'clarify') return;
  assert.match(route.question, /memberId/);
});

test('an input failing its declared pattern becomes a question, and does not echo the value', () => {
  const route = applyGuardrails(propose({ inputs: { memberId: 'not-a-number' } }), catalog, GOAL);
  assert.equal(route.action, 'clarify');
  if (route.action !== 'clarify') return;
  assert.match(route.question, /\^\\d\{6\}\$/, 'tells the user the required shape');
  assert.ok(!route.question.includes('not-a-number'), 'must not echo a value that may be PII');
});

test('low confidence downgrades an invoke to a question', () => {
  const route = applyGuardrails(propose({ confidence: CONFIDENCE_FLOOR - 0.01 }), catalog, GOAL);
  assert.equal(route.action, 'clarify');
});

test('an undeclared input is rejected rather than passed through', () => {
  const route = applyGuardrails(
    propose({ inputs: { memberId: '100442', transferAmount: '1000000' } }),
    catalog,
    GOAL,
  );
  assert.notEqual(route.action, 'invoke', 'must never forward an argument the contract does not declare');
});

test('an unknown capability falls through to discovery, not an error', () => {
  const route = applyGuardrails(propose({ capabilityId: 'does.not.exist' }), catalog, GOAL);
  assert.equal(route.action, 'discover');
});

test('invoke with no capability named falls through to discovery', () => {
  const route = applyGuardrails(propose({ capabilityId: undefined }), catalog, GOAL);
  assert.equal(route.action, 'discover');
});

test('clarify and discover proposals pass through untouched', () => {
  const c = applyGuardrails(propose({ action: 'clarify', question: 'which member?' }), catalog, GOAL);
  assert.equal(c.action, 'clarify');
  const d = applyGuardrails(propose({ action: 'discover' }), catalog, GOAL);
  assert.equal(d.action, 'discover');
});
