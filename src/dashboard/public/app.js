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
    if (m.refs.runId) refs.append(el('span', null, `run ${m.refs.runId}`));
    wrap.append(refs);
  }
  $('#messages').append(wrap);
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

async function loadSession() {
  if (!sessionId) {
    sessionId = (await (await fetch('/api/sessions', { method: 'POST' })).json()).id;
    localStorage.setItem('sessionId', sessionId);
  }
  const msgs = await (await fetch(`/api/sessions/${sessionId}`)).json();
  $('#messages').innerHTML = '';
  msgs.forEach(renderMessage);
}

$('#composer').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('#input');
  const content = input.value.trim();
  if (!content) return;

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
