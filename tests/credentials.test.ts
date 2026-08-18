/**
 * Credentials are session infrastructure, not capability arguments.
 *
 * The discovered `read-checking-balance` artifact declared `operatorPassword` as a
 * required, caller-supplied `secret`. The model was right that sign-on is parameterised
 * and wrong about who fills it: with that shape, an agent asks a person to type a service
 * password into a chat box. It then lives in conversation history on disk and passes
 * through a model's context, and no downstream redaction takes it back out.
 *
 * So `source: 'runtime'` exists, and these tests pin the three places it has to hold —
 * because it only takes one of them leaking for the property to be worthless.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArtifact } from '../src/schema/artifact.ts';
import { Catalog } from '../src/catalog/catalog.ts';
import { applyGuardrails, type ProposedRoute } from '../src/orchestrator/router.ts';

const catalog = new Catalog('artifacts');
const checking = parseArtifact(
  JSON.parse(readFileSync('artifacts/member.read-checking-balance/v1.json', 'utf8')),
);

test('every secret input is runtime-supplied, in every shipped artifact', () => {
  for (const a of catalog.list()) {
    for (const [name, spec] of Object.entries(a.inputs)) {
      if (spec.sensitivity !== 'secret') continue;
      assert.equal(spec.source, 'runtime', `${a.capability.id}.${name} must not be caller-supplied`);
      assert.ok(spec.env, `${a.capability.id}.${name} must name an environment variable`);
    }
  }
});

test('runtime inputs are invisible in the tool definition an agent sees', () => {
  // An argument a model can see is an argument it will try to fill.
  const def = catalog.toToolDef(checking);
  const props = Object.keys(def.input_schema.properties);
  assert.ok(!props.includes('operatorPassword'), 'a credential must never appear in a tool schema');
  assert.ok(!props.includes('operatorId'));
  assert.ok(props.includes('memberNumber'), 'the real arguments are still there');
  assert.ok(!def.input_schema.required.includes('operatorId'));
});

test('the router refuses a capability that asks a caller for a secret', () => {
  // Defence in depth: even if such an artifact were hand-written or restored from an
  // old version, it must not be invokable.
  const bad = parseArtifact({
    ...JSON.parse(readFileSync('artifacts/member.read-checking-balance/v1.json', 'utf8')),
  });
  bad.inputs.operatorPassword!.source = 'caller';

  const stub = {
    list: () => [bad],
    get: () => bad,
    toToolDef: () => catalog.toToolDef(bad),
  } as unknown as Catalog;

  const proposed: ProposedRoute = {
    action: 'invoke',
    capabilityId: bad.capability.id,
    inputs: { memberNumber: '100442', operatorPassword: 'hunter2' },
    confidence: 0.99,
    reason: 'test',
  };
  const route = applyGuardrails(proposed, stub, 'read the checking balance');
  assert.equal(route.action, 'refuse');
  if (route.action !== 'refuse') return;
  assert.match(route.reason, /secret/i);
  assert.ok(!route.reason.includes('hunter2'), 'and it must not echo the value it refused');
});

test('a runtime input a model tried to fill anyway is dropped, not forwarded', () => {
  const proposed: ProposedRoute = {
    action: 'invoke',
    capabilityId: 'member.read-checking-balance',
    inputs: { memberNumber: '100442', operatorPassword: 'guessed-by-a-model' },
    confidence: 0.99,
    reason: 'test',
  };
  const route = applyGuardrails(proposed, catalog, 'read the checking balance');
  assert.equal(route.action, 'invoke');
  if (route.action !== 'invoke') return;
  assert.ok(!('operatorPassword' in route.inputs), 'a guessed credential must not reach the engine');
});
