/**
 * Guardrail tests.
 *
 * These are the tests worth having: a regression here is a safety incident, not a bug.
 * They assert the two properties the safety story depends on — that the allowlist is
 * actually closed, and that discovery is strictly more restricted than replay.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Policy, type PolicyConfig } from '../src/policy/policy.ts';
import { Redactor } from '../src/policy/redact.ts';

const CONFIG: PolicyConfig = {
  allowlist: {
    origins: ['http://localhost:3100'],
    paths: ['^/$', '^/search$', '^/member$'],
  },
  profiles: {
    discovery: {
      allowedActions: ['navigate', 'click', 'type', 'extract', 'assert'],
      risk: { safe: 'allow', mutating: 'allow', irreversible: 'escalate' },
    },
    replay: {
      allowedActions: ['navigate', 'click', 'type', 'select', 'press', 'extract', 'assert'],
      risk: { safe: 'allow', mutating: 'allow', irreversible: 'confirm' },
    },
  },
  redaction: { patterns: [], secretEnvVars: [] },
};

const replay = new Policy(CONFIG, 'replay');
const discovery = new Policy(CONFIG, 'discovery');

test('allowlist blocks a foreign origin', () => {
  const v = replay.checkAction({ kind: 'navigate', url: 'https://evil.example.com/x' }, 'safe');
  assert.equal(v.decision, 'block');
  assert.match((v as { reason: string }).reason, /not in the allowlist/);
});

test('allowlist blocks an unlisted path on an allowed origin', () => {
  // The subtle case: right host, wrong route. An origin-only allowlist would miss this.
  const v = replay.checkAction({ kind: 'navigate', url: 'http://localhost:3100/admin/wire-transfer' }, 'safe');
  assert.equal(v.decision, 'block');
  assert.match((v as { reason: string }).reason, /path/);
});

test('allowlist permits a listed origin and path', () => {
  assert.equal(replay.checkAction({ kind: 'navigate', url: 'http://localhost:3100/member' }, 'safe').decision, 'allow');
});

test('a malformed URL is blocked rather than parsed permissively', () => {
  assert.equal(replay.checkAction({ kind: 'navigate', url: 'not-a-url' }, 'safe').decision, 'block');
});

test('an action kind outside the profile is blocked, not escalated', () => {
  // Ordering matters: a disallowed action must never reach a human as a confirm
  // prompt they would only have to reject.
  const v = discovery.checkAction({ kind: 'select', value: 'S2' }, 'safe');
  assert.equal(v.decision, 'block');
});

test('irreversible actions are escalated in discovery but merely confirmed in replay', () => {
  // The core asymmetry: a model choosing actions on an unfamiliar screen may never
  // execute an irreversible step; a reviewed flow may, behind a human confirmation.
  assert.equal(discovery.checkAction({ kind: 'click' }, 'irreversible').decision, 'escalate');
  assert.equal(replay.checkAction({ kind: 'click' }, 'irreversible').decision, 'confirm');
});

test('safe actions are allowed under both profiles', () => {
  assert.equal(discovery.checkAction({ kind: 'click' }, 'safe').decision, 'allow');
  assert.equal(replay.checkAction({ kind: 'click' }, 'safe').decision, 'allow');
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const redactor = new Redactor({
  patterns: [
    { name: 'us-ssn', regex: '\\b\\d{3}-\\d{2}-\\d{4}\\b' },
    { name: 'bearer-token', regex: '\\b(bearer|token)\\s*[:=]\\s*\\S+', flags: 'gi' },
  ],
  secretEnvVars: [],
});

test('PII masking preserves shape but not content', () => {
  assert.equal(Redactor.mask('100442', 'pii'), '****42');
  assert.equal(Redactor.mask('100442', 'public'), '100442');
  assert.equal(Redactor.mask('hunter2', 'secret'), '[REDACTED]');
});

test('pattern sweep catches undeclared sensitive values', () => {
  assert.match(redactor.scrub('member ssn 123-45-6789 on file'), /\[REDACTED:us-ssn\]/);
  assert.match(redactor.scrub('Authorization Bearer: abc123xyz'), /\[REDACTED:bearer-token\]/);
});

test('undeclared inputs fail closed — treated as PII, not passed through', () => {
  // The important direction: an input nobody classified must not be logged in the
  // clear just because the classification is missing.
  const out = redactor.redactInputs({ mystery: '987654' }, {});
  assert.equal(out.mystery, '****54');
});

test('declared sensitivity drives per-input redaction', () => {
  const out = redactor.redactInputs(
    { memberId: '100442', accountType: 'S2' },
    {
      memberId: { type: 'string', description: '', required: true, sensitivity: 'pii', source: 'caller' as const },
      accountType: { type: 'string', description: '', required: true, sensitivity: 'public', source: 'caller' as const },
    },
  );
  assert.equal(out.memberId, '****42');
  assert.equal(out.accountType, 'S2');
});

test('deep scrub reaches nested log payloads', () => {
  const scrubbed = redactor.scrubDeep({ a: { b: ['ssn 123-45-6789'] } }) as { a: { b: string[] } };
  assert.match(scrubbed.a.b[0]!, /REDACTED/);
});

// ---------------------------------------------------------------------------
// Risk classification
//
// A real discovery run dead-ended here: "Submit the member lookup search" matched a
// bare "submit" keyword, was classified irreversible, and the model — correctly —
// refused to work around the block. These lock the calibration in both directions.
// ---------------------------------------------------------------------------

test('submitting a read-only search is NOT irreversible', async (t) => {
  const { classifyRisk } = await import('../src/policy/risk.ts');
  assert.equal(classifyRisk('Search Submit the member lookup search', 'click'), 'safe');
  assert.equal(classifyRisk('Search Submit the read-only lookup for member 100442', 'click'), 'safe');
});

test('actions with real consequences ARE irreversible', async () => {
  const { classifyRisk } = await import('../src/policy/risk.ts');
  const cases = [
    'Create Account Create the sub-account for this member',
    'Open New Sub-Account Open a new sub-account',
    'Transfer Transfer funds between shares',
    'Delete Delete the member record',
    'Submit Payment Submit payment to the payee',
  ];
  for (const c of cases) {
    assert.equal(classifyRisk(c, 'click'), 'irreversible', `should be irreversible: "${c}"`);
  }
});

test('reads can never be classified irreversible whatever the prose says', async () => {
  const { classifyRisk } = await import('../src/policy/risk.ts');
  assert.equal(classifyRisk('Delete transfer create account', 'extract'), 'safe');
  assert.equal(classifyRisk('Delete transfer create account', 'navigate'), 'safe');
});

test('correctable writes are classified mutating, not irreversible', async () => {
  const { classifyRisk } = await import('../src/policy/risk.ts');
  assert.equal(classifyRisk('Save Save the edited address', 'click'), 'mutating');
});
