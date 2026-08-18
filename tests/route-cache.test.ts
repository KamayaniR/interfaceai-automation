/**
 * Route cache tests.
 *
 * Routing was the last model call in the production path. Caching it is only safe if
 * three things hold, and each is a way this could quietly do the wrong thing forever
 * rather than once — which is what makes them worth testing rather than the hit rate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArtifact } from '../src/schema/artifact.ts';
import { RouteCache, catalogFingerprint, normaliseIntent } from '../src/orchestrator/route-cache.ts';

const artifacts = [parseArtifact(JSON.parse(readFileSync('artifacts/member.read-savings-balance/v1.json', 'utf8')))];
const fp = catalogFingerprint(artifacts);

function withCache(fn: (c: RouteCache, path: string) => void, fingerprint = fp) {
  const dir = mkdtempSync(join(tmpdir(), 'routes-'));
  const path = join(dir, 'cache.json');
  try { fn(new RouteCache(path, fingerprint), path); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const invoke = {
  action: 'invoke' as const,
  capabilityId: 'member.read-savings-balance',
  inputs: { memberId: '100442' },
  confidence: 0.96,
  reason: 'test',
};

test('the key is the intent, not the prompt — so a different member still hits', () => {
  // The whole point. Cache on raw text and you would almost never hit, because the
  // parameter is in the string.
  withCache((cache) => {
    cache.remember('what is the savings balance for member 100442?', artifacts, invoke);
    const hit = cache.lookup('what is the savings balance for member 100443?', artifacts);
    assert.ok(hit, 'a different value for the same intent must hit');
    assert.equal(hit.inputs?.memberId, '100443', 'and the NEW value must be extracted');
  });
});

test('parameter values are never written to disk', () => {
  // Member numbers are classified pii. A cache full of them would be a second copy of
  // exactly what the redactor exists to keep out of files.
  withCache((cache, path) => {
    cache.remember('savings balance for member 100442', artifacts, invoke);
    const raw = readFileSync(path, 'utf8');
    assert.ok(!raw.includes('100442'), 'the value must not be persisted');
    assert.match(raw, /\{memberId\}/, 'only its shape is');
  });
});

test('a catalog change invalidates every entry', () => {
  // A route pointing at a capability that has since been revoked or superseded would do
  // the wrong thing on EVERY repeat — worse than a one-off, because it is consistent.
  withCache((cache, path) => {
    cache.remember('savings balance for member 100442', artifacts, invoke);
    assert.equal(cache.size, 1);

    const reopened = new RouteCache(path, 'a-different-catalog-fingerprint');
    assert.equal(reopened.size, 0, 'entries learned against another catalog must not survive');
    assert.equal(reopened.lookup('savings balance for member 100442', artifacts), null);
  });
});

test('changing a capability status changes the fingerprint', () => {
  const draft = [{ ...artifacts[0]!, capability: { ...artifacts[0]!.capability, status: 'draft' as const } }];
  assert.notEqual(catalogFingerprint(artifacts), catalogFingerprint(draft));
});

test('a prompt missing a required placeholder is a miss, not a wrong hit', () => {
  // "look up Rosa's balance" matches the intent but supplies no number. That needs a
  // clarifying question worded by the model — not a cached answer to a fuller question.
  withCache((cache) => {
    cache.remember('what is the savings balance for member 100442?', artifacts, invoke);
    assert.equal(cache.lookup('what is the savings balance for member ?', artifacts), null);
  });
});

test('only invoke decisions are cached', () => {
  // Caching "nothing matches" would freeze a gap in place: record the capability, and
  // the cache would keep insisting it does not exist.
  withCache((cache) => {
    cache.remember('do something else', artifacts, { action: 'discover', confidence: 0.9, reason: 'x' });
    cache.remember('ambiguous thing', artifacts, { action: 'clarify', confidence: 0.4, reason: 'x' });
    assert.equal(cache.size, 0);
  });
});

test('normalisation is case- and whitespace-insensitive', () => {
  const a = normaliseIntent('What  IS the  Savings Balance for member 100442?', artifacts).intent;
  const b = normaliseIntent('what is the savings balance for member 999999?', artifacts).intent;
  assert.equal(a, b);
});
