/**
 * Dashboard client.
 *
 * Three surfaces over data the system already produces — it derives nothing of its own:
 * the catalog list, a chat that drives the router, and an intervention alert fed by SSE.
 *
 * The intervention path is the one with a real constraint. Replay is BLOCKED while a
 * human holds the session, so resolving goes to the queue endpoint and nothing here ever
 * asks the engine to resume. See the note at the top of server.ts.
 */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let sessionId = localStorage.getItem('sessionId');

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

async function loadCatalog() {
  const caps = await (await fetch('/api/capabilities')).json();
  const pane = $('#catalog');
  pane.innerHTML = '';
  pane.append(el('div', 'tag', `${caps.length} capabilities`));

  for (const c of caps) {
    const card = el('div', 'cap');
    card.append(el('h3', null, c.name));
    card.append(el('div', 'id', `${c.id}  v${c.version}`));

    const tags = el('div', 'tags');
    tags.append(el('span', `tag ${c.status}`, c.status));
    if (c.stability) tags.append(el('span', `tag ${c.stability}`, c.stability));
    else tags.append(el('span', 'tag', 'unmeasured'));
    if (c.irreversible) tags.append(el('span', 'tag irreversible', 'irreversible'));
    if (c.versions.length > 1) tags.append(el('span', 'tag', `${c.versions.length} versions`));
    card.append(tags);

    card.onclick = () => openDrawer(c.id);
    pane.append(card);
  }
}

async function openDrawer(id) {
  const d = await (await fetch(`/api/capabilities/${id}`)).json();
  const drawer = $('#drawer');
  drawer.innerHTML = '';

  const close = el('button', 'ghost', 'Close');
  close.onclick = () => {
    drawer.classList.remove('open');
    $('#backdrop').classList.remove('open');
  };
  drawer.append(close);

  // The human projection is the point of this panel — an approver reads this, not JSON.
  drawer.append(el('pre', null, d.review));

  if (d.runs.length) {
    drawer.append(el('h3', null, `Recent runs (${d.runs.length})`));
    const t = el('table', 'kv');
    for (const r of d.runs.slice(0, 10)) {
      const row = el('tr');
      row.append(el('td', null, r.status));
      row.append(el('td', null, `${r.durationMs}ms · ${r.runId}`));
      t.append(row);
    }
    drawer.append(t);
  }

  drawer.classList.add('open');
  $('#backdrop').classList.add('open');
}

/**
 * A run's evidence: the result contract, what it did and why, and any screenshots.
 * This is the "why did it do that" path — reachable from the conversation rather than
 * by grepping a directory.
 */
async function openRun(runId) {
  const d = await (await fetch(`/api/runs/${runId}`)).json();
  const drawer = $('#drawer');
  drawer.innerHTML = '';

  const close = el('button', 'ghost', 'Close');
  close.onclick = () => {
    drawer.classList.remove('open');
    $('#backdrop').classList.remove('open');
  };
  drawer.append(close);

  drawer.append(el('h3', null, `Run ${runId}`));

  if (d.result) {
    const r = d.result;
    const head = [`STATUS   ${r.status}`];
    if (r.status === 'success') head.push(`OUTPUTS  ${JSON.stringify(r.outputs)}`);
    if (r.status === 'business_outcome') head.push(`OUTCOME  ${r.outcome.code}`, `         ${r.outcome.message}`);
    if (r.status === 'failure') {
      head.push(`CLASS    ${r.failure.class}`, `STEP     ${r.failure.stepId ?? '(pre-flight)'}`,
                `MESSAGE  ${r.failure.message}`);
      if (r.failure.expected) head.push(`EXPECTED ${r.failure.expected}`, `OBSERVED ${r.failure.observed}`);
    }
    head.push('', `DURATION ${r.durationMs}ms over ${r.trace.length} step(s)`);
    for (const t of r.trace) {
      head.push(`  ${t.status.padEnd(9)} ${t.stepId}  ${t.intent}` +
                (t.conditionFired ? `   [${t.conditionFired}]` : ''));
    }
    if (r.drift?.length) {
      head.push('', 'DRIFT');
      for (const dr of r.drift) head.push(`  ${dr.stepId}: ${dr.note}`);
    }
    drawer.append(el('pre', null, head.join('\n')));
  }

  for (const name of d.screenshots) {
    const img = el('img', 'shot');
    img.src = `/api/runs/${runId}/screenshot/${name}`;
    drawer.append(img);
  }

  // The structured log, which is the actual audit trail.
  drawer.append(el('h3', null, `Log (${d.log.length} events)`));
  drawer.append(el('pre', null, d.log.map((e) => `${e.at.slice(11, 19)}  ${e.type}`).join('\n')));

  drawer.classList.add('open');
  $('#backdrop').classList.add('open');
}

$('#backdrop').onclick = () => {
  $('#drawer').classList.remove('open');
  $('#backdrop').classList.remove('open');
};

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

function renderMessage(m) {
  const wrap = el('div', `msg ${m.role}`);
  wrap.append(el('div', 'who', m.role));
  wrap.append(el('div', 'body', m.content));

  // A history that can't link back to the run is just text. These are what make it
  // useful a week later.
  if (m.refs && (m.refs.runId || m.refs.capabilityId)) {
    const refs = el('div', 'refs');
    if (m.refs.capabilityId) {
      const a = el('a', null, `${m.refs.capabilityId} v${m.refs.capabilityVersion ?? ''}`);
      a.onclick = () => openDrawer(m.refs.capabilityId);
      refs.append(a);
    }
    if (m.refs.runId) {
      const r = el('a', null, `run ${m.refs.runId}`);
      r.onclick = () => openRun(m.refs.runId);
      refs.append(r);
    }
    wrap.append(refs);
  }
  $('#messages').append(wrap);
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

/**
 * Without this the panel is a blank void, and the three things the router can do are
 * invisible to anyone who doesn't already know them. Each example is chosen to land on
 * a different branch.
 */
const EXAMPLES = [
  ['what is the savings balance for member 100442?', 'runs an existing capability'],
  ['look up the savings balance for Rosa', 'asks rather than guessing a member number'],
  ["export last month's wire transfer audit log as a csv", 'finds nothing, offers discovery'],
];

function renderEmptyState() {
  const wrap = el('div', 'empty');
  wrap.append(el('h2', null, 'Ask in plain language.'));
  wrap.append(el('p', null,
    'A goal is matched against the capability catalog and replayed — no model decides how to drive the UI.'));

  for (const [text, note] of EXAMPLES) {
    const row = el('div', 'example');
    row.append(el('div', 'ex-text', text));
    row.append(el('div', 'ex-note', note));
    row.onclick = () => {
      $('#input').value = text;
      $('#input').focus();
    };
    wrap.append(row);
  }

  const warn = el('p', 'ex-note');
  warn.textContent =
    'Opening a sub-account pauses for human approval — a browser window will open and it is yours to drive.';
  wrap.append(warn);
  $('#messages').append(wrap);
}

async function loadSession() {
  if (!sessionId) {
    sessionId = (await (await fetch('/api/sessions', { method: 'POST' })).json()).id;
    localStorage.setItem('sessionId', sessionId);
  }
  const msgs = await (await fetch(`/api/sessions/${sessionId}`)).json();
  $('#messages').innerHTML = '';
  if (msgs.length === 0) renderEmptyState();
  else msgs.forEach(renderMessage);
}

$('#composer').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('#input');
  const content = input.value.trim();
  if (!content) return;

  $('.empty')?.remove();
  renderMessage({ role: 'user', content, at: new Date().toISOString() });
  input.value = '';
  $('#send').disabled = true;
  // A replay can pause for minutes on an escalation; silence here is
  // indistinguishable from a hang.
  $('#send').textContent = 'Working…';

  try {
    const res = await fetch(`/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    (await res.json()).forEach(renderMessage);
  } catch (err) {
    renderMessage({ role: 'system', content: `Request failed: ${err.message}` });
  } finally {
    $('#send').disabled = false;
    $('#send').textContent = 'Send';
    loadCatalog();
  }
};

$('#newchat').onclick = async () => {
  sessionId = (await (await fetch('/api/sessions', { method: 'POST' })).json()).id;
  localStorage.setItem('sessionId', sessionId);
  $('#messages').innerHTML = '';
  renderEmptyState();
};

// ---------------------------------------------------------------------------
// Interventions
// ---------------------------------------------------------------------------

let current = null;

function showIntervention(r) {
  current = r;
  const card = $('#modalCard');
  card.innerHTML = '';
  card.append(el('h2', null, 'Human intervention required'));
  card.append(el('div', 'id', `${r.capability.name} · request ${r.id}`));

  const reason = el('div', 'reason');
  reason.append(el('b', null, 'Why automation stopped: '));
  reason.append(document.createTextNode(r.reason));
  card.append(reason);

  const t = el('table', 'kv');
  const row = (k, v) => {
    const tr = el('tr');
    tr.append(el('td', null, k));
    tr.append(el('td', null, v));
    t.append(tr);
  };
  row('Capability', `${r.capability.id} v${r.capability.version}`);
  if (r.step) row('Stopped at', `step ${r.step.index}/${r.step.total}: ${r.step.intent} (${r.step.risk})`);
  row('Inputs', JSON.stringify(r.inputs) + '  (redacted)');
  row('URL', r.currentUrl);
  card.append(t);

  const note = el('div');
  note.innerHTML =
    '<b>You now hold the session.</b> The automation is blocked until you hand control back. ' +
    'Drive the headed browser window directly — it is the same live session, mid-flow.';
  card.append(note);

  const shot = el('img', 'shot');
  shot.src = `/api/interventions/${r.id}/screenshot`;
  shot.onerror = () => shot.remove();
  card.append(shot);

  const input = el('input');
  input.id = 'opnote';
  input.placeholder = 'What did you do? (recorded in the run log)';
  input.style.cssText = 'width:100%;margin-top:14px;padding:9px;background:#0f1419;border:1px solid #2a3441;color:#e6e6e6;border-radius:5px;font:inherit';
  card.append(input);

  const actions = el('div');
  actions.style.cssText = 'display:flex;gap:9px;margin-top:12px';
  const resume = el('button', null, 'Resume automation');
  resume.onclick = () => resolve('resume');
  const abort = el('button', 'ghost', 'Abort run');
  abort.onclick = () => resolve('abort');
  actions.append(resume, abort);
  card.append(actions);

  $('#modal').classList.add('open');

  if (Notification.permission === 'granted' && document.hidden) {
    new Notification('Automation needs you', {
      body: `${r.capability.name} — ${r.reason.slice(0, 90)}`,
    });
  }
}

async function resolve(action) {
  // Writing to the queue is what unblocks the engine. We never call "resume" on it —
  // it is sitting inside waitForResolution() holding the live session.
  await fetch(`/api/interventions/${current.id}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, note: $('#opnote')?.value ?? '' }),
  });
  $('#modal').classList.remove('open');
  $('#bell').style.display = 'none';
  current = null;
}

const events = new EventSource('/api/events');
events.addEventListener('intervention', (e) => {
  const r = JSON.parse(e.data);
  $('#bell').style.display = 'inline-block';
  $('#bell').textContent = 'Intervention needs you';
  $('#bell').onclick = () => showIntervention(r);
  showIntervention(r);
});
events.addEventListener('ping', (e) => {
  if (JSON.parse(e.data).open === 0) $('#bell').style.display = 'none';
});

if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

loadCatalog();
loadSession();
setInterval(loadCatalog, 15000);
