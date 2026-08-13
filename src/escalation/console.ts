/**
 * Operator console — the human end of the handoff.
 *
 * DELIBERATELY MOCKED, and the brief permits it: this is a bare local page, not a
 * real-time co-browsing product. What is *not* mocked is the mechanism it drives:
 *
 *   - It is a separate process from the replay engine. They communicate through the
 *     file-backed intervention queue, so the console is a genuine external actor rather
 *     than a function call dressed up as a UI.
 *   - "Take control" flips the real control token on the real live session. The
 *     automation is structurally blocked from acting from that moment.
 *   - The human drives the SAME headed browser window the automation was using — same
 *     cookies, same server-side session, same half-filled form. There is no second
 *     login and no state reconstruction.
 *   - "Resume" hands the token back and the engine re-verifies before continuing.
 *
 * What a production version would add: authentication and operator identity, a real
 * queue with routing and SLAs, streamed video of the session for operators who can't
 * reach the host, and per-tenant access control. None of those change the protocol.
 */

import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { InterventionQueue, type InterventionRequest } from './broker.ts';

const PORT = Number(process.env.OPERATOR_PORT ?? 3200);
const QUEUE_DIR = process.env.INTERVENTIONS_DIR ?? 'runs/interventions';

const app = express();
const queue = new InterventionQueue(QUEUE_DIR);

app.use(express.urlencoded({ extended: false }));

const STYLE = `
  body { font: 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0;
         background: #0f1419; color: #e6e6e6; }
  header { background: #1a2332; padding: 14px 22px; border-bottom: 1px solid #2a3441; }
  header h1 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: .3px; }
  header span { color: #7d8b9a; font-weight: 400; }
  .wrap { padding: 22px; max-width: 900px; }
  .card { background: #161d26; border: 1px solid #2a3441; border-radius: 6px;
          padding: 18px; margin-bottom: 16px; }
  .card h2 { margin: 0 0 4px; font-size: 15px; }
  .muted { color: #7d8b9a; font-size: 12px; }
  .reason { background: #2d1f1f; border-left: 3px solid #d05656; padding: 10px 14px;
            margin: 14px 0; border-radius: 3px; }
  table.kv { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
  table.kv td { padding: 5px 0; vertical-align: top; }
  table.kv td:first-child { color: #7d8b9a; width: 150px; }
  code { background: #0f1419; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
  img.shot { max-width: 100%; border: 1px solid #2a3441; border-radius: 4px; margin-top: 10px; }
  form.actions { margin-top: 16px; display: flex; gap: 10px; align-items: center; }
  input[type=text] { background: #0f1419; border: 1px solid #2a3441; color: #e6e6e6;
                     padding: 8px 10px; border-radius: 4px; flex: 1; font: inherit; }
  button { font: inherit; font-weight: 600; padding: 8px 18px; border-radius: 4px;
           border: none; cursor: pointer; }
  .resume { background: #2f7d4f; color: #fff; }
  .abort { background: #8a3838; color: #fff; }
  .pill { display: inline-block; padding: 2px 9px; border-radius: 10px; font-size: 11px;
          font-weight: 600; text-transform: uppercase; letter-spacing: .5px; }
  .pill.open { background: #7a5c1a; color: #ffd97a; }
  .pill.resolved { background: #1e4d33; color: #7ee2a8; }
  .pill.aborted, .pill.timed_out { background: #4d1e1e; color: #ffa0a0; }
  .banner { background: #1a3350; border-left: 3px solid #4a90d9; padding: 12px 16px;
            border-radius: 3px; margin-bottom: 16px; font-size: 13px; }
  a { color: #6fb3f2; }
`;

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Operator Console</title><meta http-equiv="refresh" content="5">
<style>${STYLE}</style></head><body>
<header><h1>Operator Console <span>— interface.ai computer-use automation</span></h1></header>
<div class="wrap">${body}</div></body></html>`;
}

function renderRequest(r: InterventionRequest, detailed: boolean): string {
  const kv = `
    <table class="kv">
      <tr><td>Capability</td><td><code>${r.capability.id}</code> v${r.capability.version} &mdash; ${r.capability.name}</td></tr>
      <tr><td>Goal</td><td>${r.goal}</td></tr>
      ${r.step ? `<tr><td>Stopped at step</td><td>${r.step.index} of ${r.step.total}: <b>${r.step.intent}</b>
        <span class="muted">(risk: ${r.step.risk})</span></td></tr>` : ''}
      <tr><td>Current URL</td><td><code>${r.currentUrl}</code></td></tr>
      <tr><td>Inputs</td><td><code>${JSON.stringify(r.inputs)}</code> <span class="muted">(redacted)</span></td></tr>
      ${r.expected ? `<tr><td>Expected</td><td>${r.expected}</td></tr>` : ''}
      ${r.observed ? `<tr><td>Observed</td><td>${r.observed}</td></tr>` : ''}
      <tr><td>Run</td><td><code>${r.runId}</code></td></tr>
    </table>`;

  const shot =
    detailed && r.screenshotPath && existsSync(r.screenshotPath)
      ? `<img class="shot" src="/screenshot/${r.id}" alt="live session at the moment automation stopped">`
      : '';

  const resolution = r.resolution?.recordedActions?.length
    ? `<div class="muted" style="margin-top:14px">Recorded operator actions:</div>
       <table class="kv">${r.resolution.recordedActions
         .map((a) => `<tr><td>${a.at.slice(11, 19)}</td><td><code>${a.kind}</code> ${a.detail}</td></tr>`)
         .join('')}</table>`
    : '';

  const actions =
    r.status === 'open' || r.status === 'in_progress'
      ? `<div class="banner">
           <b>You now hold the session.</b> The automation is blocked from acting until you hand
           control back. Drive the headed browser window directly &mdash; it is the same live
           session, mid-flow. When the manual steps are done, click Resume.
         </div>
         <form class="actions" method="post" action="/resolve/${r.id}">
           <input type="text" name="note" placeholder="What did you do? (recorded in the run log)">
           <button class="resume" name="action" value="resume">Resume automation</button>
           <button class="abort" name="action" value="abort">Abort run</button>
         </form>`
      : '';

  return `<div class="card">
    <h2>${r.capability.name} <span class="pill ${r.status}">${r.status.replace('_', ' ')}</span></h2>
    <div class="muted">request ${r.id} &middot; raised ${r.createdAt}</div>
    <div class="reason"><b>Why automation stopped:</b> ${r.reason}</div>
    ${kv}${shot}${resolution}${actions}
    ${!detailed ? `<div><a href="/request/${r.id}">Open request &rarr;</a></div>` : ''}
  </div>`;
}

app.get('/', (_req, res) => {
  const all = queue.list();
  const open = all.filter((r) => r.status === 'open' || r.status === 'in_progress');
  const past = all.filter((r) => r.status !== 'open' && r.status !== 'in_progress').slice(0, 5);

  const body = open.length
    ? open.map((r) => renderRequest(r, true)).join('')
    : `<div class="card"><h2>No open interventions</h2>
       <div class="muted">Waiting for a run to escalate. This page refreshes every 5s.</div></div>`;

  const history = past.length
    ? `<h2 style="font-size:13px;color:#7d8b9a;margin-top:26px">RECENT</h2>` +
      past.map((r) => renderRequest(r, false)).join('')
    : '';

  res.type('html').send(page(body + history));
});

app.get('/request/:id', (req, res) => {
  const r = queue.get(req.params.id);
  if (!r) return res.status(404).type('html').send(page('<div class="card">No such request.</div>'));
  res.type('html').send(page(renderRequest(r, true) + '<a href="/">&larr; All requests</a>'));
});

app.get('/screenshot/:id', (req, res) => {
  const r = queue.get(req.params.id);
  if (!r?.screenshotPath || !existsSync(r.screenshotPath)) return res.status(404).end();
  res.type('png').send(readFileSync(r.screenshotPath));
});

/**
 * The control handback. Writing `resolved` to the queue is what unblocks the engine's
 * `waitForResolution`, which then takes the token back and re-verifies before it
 * continues.
 */
app.post('/resolve/:id', (req, res) => {
  const r = queue.get(req.params.id);
  if (!r) return res.status(404).end();

  const action = String(req.body.action ?? 'resume');
  r.status = action === 'abort' ? 'aborted' : 'resolved';
  r.resolution = {
    operator: process.env.OPERATOR_NAME ?? 'local-operator',
    action: action === 'abort' ? 'abort' : 'resume',
    note: String(req.body.note ?? ''),
    tookControlAt: r.createdAt,
    returnedControlAt: new Date().toISOString(),
    recordedActions: [],
  };
  queue.update(r);
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`Operator console on http://localhost:${PORT}`);
  console.log(`Watching intervention queue: ${QUEUE_DIR}`);
});
