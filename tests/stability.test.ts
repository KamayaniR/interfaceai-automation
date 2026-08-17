/**
 * Stability scoring tests.
 *
 * The measurement loop needs a browser, so these test the part that encodes the
 * judgement — how raw run outcomes become a verdict, and what that verdict says about
 * promotion. That's where the design decisions live, and where a regression would
 * quietly turn the approval gate back into a rubber stamp.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  StabilityReport,
  saveReport,
  loadReport,
  promotionAdvice,
} from '../src/stability/stability.ts';

const base = {
  capabilityId: 'test.cap',
  capabilityVersion: 1,
  inputs: { memberId: '100442' },
  runs: 10,
  measuredAt: new Date().toISOString(),
  drift: [],
  durationMs: { min: 900, median: 950, max: 1100 },
};

const report = (over: Partial<StabilityReport>): StabilityReport =>
  StabilityReport.parse({ ...base, buckets: { success: 10 }, verdict: 'stable', summary: 's', ...over });

test('a consistent BUSINESS OUTCOME is stable, not a failure', () => {
  // The definition that matters. A member number that doesn't exist should return
  // MEMBER_NOT_FOUND every time — a score built on success rate would call that broken.
  const r = report({
    buckets: { 'business_outcome:MEMBER_NOT_FOUND': 10 },
    verdict: 'stable',
    summary: 'consistently business_outcome:MEMBER_NOT_FOUND across 10 runs',
  });
  assert.equal(promotionAdvice(r).ok, true);
});

test('mixed result classes block promotion', () => {
  // Nine greens and one hard failure is the case a single manual test never sees.
  const r = report({
    buckets: { success: 9, 'failure:hard': 1 },
    verdict: 'flaky',
    summary: 'the same inputs produced 2 different classes of result',
  });
  const advice = promotionAdvice(r);
  assert.equal(advice.ok, false);
  assert.match(advice.note, /flaky/);
});

test('all-green runs still block promotion when locators are drifting', () => {
  // "Green but rotting": every run succeeded, but only because a fallback locator
  // caught it. Success rate alone would happily promote this.
  const r = report({
    buckets: { success: 10 },
    drift: [{ stepId: 's06', occurrences: 10, worstRung: 2, note: 'fell to structural' }],
    verdict: 'degraded',
    summary: 'consistently success across 10 runs, but 1 step(s) resolved on a fallback locator',
  });
  const advice = promotionAdvice(r);
  assert.equal(advice.ok, false);
  assert.match(advice.note, /degraded/);
});

test('an unmeasured capability is not promotable, and says why', () => {
  const advice = promotionAdvice(null);
  assert.equal(advice.ok, false);
  assert.match(advice.note, /never measured/);
  assert.match(advice.note, /npm run stability/, 'tells you how to fix it');
});

test('promotion advice names the inputs it was measured with', () => {
  // A score measured on the not-found path says nothing about the happy path, so the
  // advice must never read as a blanket endorsement.
  assert.match(promotionAdvice(report({})).note, /memberId/);
});

test('reports round-trip through disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stability-'));
  try {
    const r = report({});
    saveReport(dir, r);
    const loaded = loadReport(dir, 'test.cap', 1);
    assert.ok(loaded);
    assert.equal(loaded.verdict, 'stable');
    assert.deepEqual(loaded.inputs, { memberId: '100442' });
    assert.equal(loadReport(dir, 'test.cap', 99), null, 'a different version is a different measurement');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stability report is NOT stored inside the artifact', async () => {
  // An artifact is a contract with a fixed content hash; a stability score is an
  // observation that changes every time you measure. Writing one into the other would
  // break the hash and conflate a promise with an observation.
  const { readFileSync } = await import('node:fs');
  const artifact = JSON.parse(readFileSync('artifacts/member.read-savings-balance/v1.json', 'utf8'));
  assert.equal(artifact.stability, undefined);
  assert.equal(artifact.capability.stability, undefined);
  assert.ok(artifact.provenance.contentHash, 'the artifact still carries its own hash');
});
