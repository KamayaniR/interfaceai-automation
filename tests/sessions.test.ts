/**
 * Session store tests.
 *
 * The chat history is only useful if it can point back at what actually happened, so
 * these focus on the links and on the append-only property — not on the UI.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/dashboard/sessions.ts';

function withStore(fn: (s: SessionStore, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'sessions-'));
  try { fn(new SessionStore(dir), dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('messages round-trip in order', () => {
  withStore((store) => {
    const id = store.create();
    store.append(id, 'user', 'look up member 100442');
    store.append(id, 'assistant', 'Done.');
    const msgs = store.messages(id);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0]!.role, 'user');
    assert.equal(msgs[1]!.content, 'Done.');
  });
});

test('a result message links back to its run and capability', () => {
  // Without these, history is prose you cannot audit — you can read that something
  // happened but not go and see what.
  withStore((store) => {
    const id = store.create();
    store.append(id, 'assistant', 'Done.', {
      runId: 'abc123', capabilityId: 'member.read-savings-balance',
      capabilityVersion: 1, status: 'success',
    });
    const refs = store.messages(id)[0]!.refs!;
    assert.equal(refs.runId, 'abc123');
    assert.equal(refs.capabilityId, 'member.read-savings-balance');
  });
});

test('storage is append-only — adding a message never rewrites earlier ones', () => {
  withStore((store, dir) => {
    const id = store.create();
    store.append(id, 'user', 'first');
    const afterFirst = readFileSync(join(dir, `${id}.jsonl`), 'utf8');
    store.append(id, 'user', 'second');
    const afterSecond = readFileSync(join(dir, `${id}.jsonl`), 'utf8');
    assert.ok(afterSecond.startsWith(afterFirst), 'earlier bytes must be untouched');
  });
});

test('sessions are titled from the first user message, newest first', () => {
  withStore((store) => {
    const a = store.create();
    store.append(a, 'user', 'what is the savings balance for member 100442?');
    const list = store.list();
    assert.equal(list.length, 1);
    assert.match(list[0]!.title, /savings balance/);
  });
});

test('an empty session is listed without crashing', () => {
  withStore((store) => {
    store.create();
    assert.equal(store.list()[0]!.title, 'New conversation');
  });
});
