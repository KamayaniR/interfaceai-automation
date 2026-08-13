/**
 * Target-resolution tests — the robustness story, exercised against a real browser.
 *
 * These run against hand-written hostile markup rather than the target app, so each
 * test isolates exactly one property of the ladder. The markup mirrors what legacy
 * enterprise screens actually look like: table layout, no <label for>, opaque names.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { resolveTarget, synthesiseTarget } from '../src/surface/web/resolve-target.ts';
import type { TargetRef } from '../src/schema/artifact.ts';

let browser: Browser;
let page: Page;

const HOSTILE_MARKUP = `
<html><body>
  <form>
    <table>
      <tr><td>Member Number</td><td><input type="text" name="f_mbr"></td></tr>
      <tr><td>Branch Code</td><td><input type="text" name="f_brn"></td></tr>
      <tr><td colspan="2"><input type="submit" value="Search"></td></tr>
    </table>
  </form>
  <table>
    <tr><td>Savings (S1) Current Balance</td><td>$4,182.55</td></tr>
  </table>
  <table>
    <tr><td>Duplicate</td><td><input type="text" name="dup_a"></td></tr>
    <tr><td>Duplicate</td><td><input type="text" name="dup_b"></td></tr>
  </table>
</body></html>`;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent(HOSTILE_MARKUP);
});

after(async () => {
  await browser?.close();
});

test('names a control from its adjacent table cell, with no <label for> anywhere', async () => {
  // This is the single heuristic that makes table-based enterprise UIs addressable
  // by name instead of by coordinate.
  const target: TargetRef = {
    framePath: [],
    candidates: [{ by: 'role-name', role: 'textbox', name: 'Member Number', nameIsSubstring: false }],
  };
  const outcome = await resolveTarget(page.mainFrame(), target);
  assert.equal(outcome.found, true);
  assert.equal(outcome.candidateIndex, 0, 'should match on the preferred rung');
});

test('falls through to a lower rung when the preferred locator fails, and reports it', async () => {
  const target: TargetRef = {
    framePath: [],
    candidates: [
      { by: 'role-name', role: 'textbox', name: 'A Label That Does Not Exist', nameIsSubstring: false },
      { by: 'label-proximity', labelText: 'Member Number', direction: 'right', index: 0 },
    ],
  };
  const outcome = await resolveTarget(page.mainFrame(), target);
  assert.equal(outcome.found, true);
  // Rung 1, not 0 — this is the drift signal the caller gets back in the result.
  assert.equal(outcome.candidateIndex, 1);
  assert.equal(outcome.strategy, 'label-proximity');
});

test('an AMBIGUOUS match is treated as no match', async () => {
  // The most important assertion in this file. Two fields share the label "Duplicate";
  // acting on "probably that one" is how automation quietly modifies the wrong record.
  const target: TargetRef = {
    framePath: [],
    candidates: [{ by: 'label-proximity', labelText: 'Duplicate', direction: 'right', index: 0 }],
  };
  const outcome = await resolveTarget(page.mainFrame(), target);
  assert.equal(outcome.found, false);
  assert.equal(outcome.attempts[0]?.matchCount, 2, 'should report that it saw two candidates');
});

test('reads a rendered value that is not a control at all', async () => {
  // Balances are plain <td> text. A locator model that only knows about inputs and
  // buttons cannot express "the value next to this label" — this one can.
  const target: TargetRef = {
    framePath: [],
    candidates: [
      { by: 'label-proximity', labelText: 'Savings (S1) Current Balance', direction: 'right', index: 0 },
    ],
  };
  const outcome = await resolveTarget(page.mainFrame(), target);
  assert.equal(outcome.found, true);
  const text = await page.locator('[__cua_target="1"]').textContent();
  assert.equal(text?.trim(), '$4,182.55');
});

test('fingerprint mismatch is reported without blocking the match', async () => {
  // Drift is information, not a veto: the element was found, but it no longer looks
  // like what we recorded, so the caller is told before the artifact rots further.
  const target: TargetRef = {
    framePath: [],
    candidates: [{ by: 'role-name', role: 'textbox', name: 'Member Number', nameIsSubstring: false }],
    fingerprint: { tagName: 'input', inputType: 'text', attrs: { name: 'THIS_CHANGED' } },
  };
  const outcome = await resolveTarget(page.mainFrame(), target);
  assert.equal(outcome.found, true);
  assert.equal(outcome.fingerprintMismatch, true);
});

test('returns not-found with a per-rung breakdown when every strategy fails', async () => {
  const target: TargetRef = {
    framePath: [],
    candidates: [
      { by: 'role-name', role: 'textbox', name: 'Nope', nameIsSubstring: false },
      { by: 'label-proximity', labelText: 'Also Nope', direction: 'right', index: 0 },
    ],
  };
  const outcome = await resolveTarget(page.mainFrame(), target);
  assert.equal(outcome.found, false);
  assert.equal(outcome.attempts.length, 2, 'every rung should be reported for debuggability');
});

test('synthesised ladders are ordered most-semantic first and always end in a fallback', () => {
  const target = synthesiseTarget({
    role: 'textbox',
    name: 'Member Number',
    framePath: ['content'],
    tagName: 'input',
    inputType: 'text',
    attrs: { name: 'f_mbr' },
    formIndex: 0,
    controlIndex: 0,
    labelHint: 'Member Number',
  });

  assert.equal(target.candidates[0]?.by, 'role-name');
  assert.equal(target.candidates.at(-1)?.by, 'structural', 'must always keep a last-resort rung');
  assert.ok(target.candidates.length >= 3, 'redundancy is the point of recording once');
  assert.deepEqual(target.framePath, ['content'], 'frame must be recorded or replay is not reproducible');
  assert.equal(target.fingerprint?.tagName, 'input');
});
