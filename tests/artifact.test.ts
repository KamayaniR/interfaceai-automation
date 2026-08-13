/**
 * Schema and contract tests.
 *
 * The artifact is the interface between discovery, replay and a calling agent, so the
 * things worth asserting are the invariants a reviewer would rely on: that a shipped
 * artifact really parses, that a malformed one is rejected loudly rather than half-run,
 * and that the catalog's approval gate cannot be bypassed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArtifact, CapabilityArtifact } from '../src/schema/artifact.ts';
import { Catalog } from '../src/catalog/catalog.ts';

const FIXTURE = 'artifacts/member.read-savings-balance/v1.json';

/**
 * Tests pin an explicit version. `catalog.get(id)` without one returns the HIGHEST
 * version, so running a discovery — which appends a new version — would otherwise
 * rewrite what these assertions are testing against.
 */
const FIXTURE_VERSION = 1;

test('the shipped artifact parses against the schema', () => {
  const artifact = parseArtifact(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  assert.equal(artifact.schemaVersion, '1.0');
  assert.ok(artifact.steps.length > 0);
});

test('every business outcome referenced by a step is actually declared', () => {
  // A dangling outcome code would surface at runtime as a contract_violation deep in a
  // replay. Catching it statically is strictly better.
  const artifact = parseArtifact(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  const declared = new Set(artifact.outcomes.map((o) => o.code));

  for (const step of artifact.steps) {
    for (const rule of step.onCondition) {
      if (rule.then.then === 'business-outcome') {
        assert.ok(
          declared.has(rule.then.outcomeCode),
          `step ${step.id} maps a condition to undeclared outcome ${rule.then.outcomeCode}`,
        );
      }
    }
  }
});

test('every parameter placeholder resolves to a declared input', () => {
  const artifact = parseArtifact(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  const declared = new Set(Object.keys(artifact.inputs));

  const check = (value: string, stepId: string) => {
    for (const m of value.matchAll(/\{\{(\w+)\}\}/g)) {
      assert.ok(declared.has(m[1]!), `step ${stepId} references undeclared input {{${m[1]}}}`);
    }
  };

  for (const step of artifact.steps) {
    if (step.action.kind === 'type' || step.action.kind === 'select') check(step.action.value, step.id);
    for (const rule of step.onCondition) {
      if (rule.then.then !== 'recover') continue;
      for (const sub of rule.then.recovery) {
        if (sub.action.kind === 'type' || sub.action.kind === 'select') check(sub.action.value, sub.id);
      }
    }
  }
});

test('every extract writes into a declared output', () => {
  const artifact = parseArtifact(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  for (const step of artifact.steps) {
    if (step.action.kind === 'extract') {
      assert.ok(
        artifact.outputs[step.action.outputName],
        `step ${step.id} extracts into undeclared output "${step.action.outputName}"`,
      );
    }
  }
});

test('every target records the frame it lives in', () => {
  // In a frameset, a target with no frame path is not reproducible.
  const artifact = parseArtifact(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  for (const step of artifact.steps) {
    if (!step.target) continue;
    assert.ok(step.target.candidates.length >= 1, `step ${step.id} has an empty locator ladder`);
  }
});

test('a malformed artifact is rejected rather than partially accepted', () => {
  const raw = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  delete raw.checkpoint;
  assert.throws(() => parseArtifact(raw), /checkpoint/i);
});

test('an artifact with zero steps is rejected', () => {
  const raw = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  raw.steps = [];
  assert.throws(() => parseArtifact(raw));
});

// ---------------------------------------------------------------------------
// Catalog projection and the approval gate
// ---------------------------------------------------------------------------

test('the catalog projects an artifact into a typed tool definition', () => {
  const catalog = new Catalog('artifacts');
  const artifact = catalog.get('member.read-savings-balance', FIXTURE_VERSION);
  assert.ok(artifact);

  const def = catalog.toToolDef(artifact);
  assert.ok(def.input_schema.properties.memberId, 'declared inputs become tool args');
  assert.deepEqual(def.input_schema.required, ['memberId']);
  assert.equal(def.input_schema.additionalProperties, false);
  assert.ok(def._meta.returns.savingsBalance, 'declared outputs are advertised to the caller');
  // The caller must be able to see the non-error answers BEFORE invoking, so it can
  // branch on them instead of treating everything but success as a failure.
  assert.match(def.description, /MEMBER_NOT_FOUND/);
});

test('a draft capability is listed but refused for unattended invocation', () => {
  const catalog = new Catalog('artifacts');
  const artifact = catalog.get('member.read-savings-balance', FIXTURE_VERSION);
  assert.ok(artifact);

  const draft: CapabilityArtifact = {
    ...artifact,
    capability: { ...artifact.capability, status: 'draft' },
  };
  const def = catalog.toToolDef(draft);
  assert.equal(def._meta.invocable, false, 'LLM-authored, human-unreviewed flows must not run unattended');
  assert.match(def.description, /draft/i, 'the caller is told why');
});

test('pii inputs are flagged to the calling agent', () => {
  const catalog = new Catalog('artifacts');
  const def = catalog.toToolDef(catalog.get('member.read-savings-balance', FIXTURE_VERSION)!);
  assert.match(def.input_schema.properties.memberId!.description, /pii/);
});

test('an outcome that would fire on the success screen is rejected at record time', async () => {
  // Regression from a real discovery run: the model declared BALANCE_FOUND as a
  // business outcome, so replay detected it on the member-detail screen, terminated
  // "successfully", and never ran the extracts. Success is the absence of an outcome.
  const { recordArtifact } = await import('../src/agent/record.ts');

  const artifact = recordArtifact({
    actions: [
      { kind: 'navigate', intent: 'open', url: 'http://localhost:3100', resultingText: '', resultingUrl: 'http://localhost:3100' },
      { kind: 'extract', intent: 'read balance', outputName: 'balance', from: 'text',
        resultingText: 'Member Detail Savings (S1) Current Balance $4,182.55',
        resultingUrl: 'http://localhost:3100/member' },
    ],
    contract: {
      capability_id: 'test.cap', name: 'Test', description: 'Test capability',
      inputs: [], outputs: [{ name: 'balance', type: 'money', description: 'b', sensitivity: 'pii' }],
      outcomes: [
        { code: 'BALANCE_FOUND', description: 'found', detect_text: 'Savings (S1) Current Balance' },
        { code: 'MEMBER_NOT_FOUND', description: 'absent', detect_text: 'No member record found' },
      ],
      success_text: 'Savings (S1) Current Balance',
    },
    goal: 'g', entryUrl: 'http://localhost:3100', appId: 'corevue',
    vendor: 'v', model: 'test', runId: 'r', transcript: '',
  });

  const codes = artifact.outcomes.map((o) => o.code);
  assert.ok(!codes.includes('BALANCE_FOUND'), 'success-screen outcome must be dropped');
  assert.ok(codes.includes('MEMBER_NOT_FOUND'), 'genuine outcomes must survive');

  // And no orphaned condition rule may reference the dropped outcome.
  for (const step of artifact.steps) {
    for (const rule of step.onCondition) {
      if (rule.then.then === 'business-outcome') {
        assert.ok(codes.includes(rule.then.outcomeCode), 'no rule may point at a dropped outcome');
      }
    }
  }
});
