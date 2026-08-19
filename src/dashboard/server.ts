/**
 * The dashboard: catalog browser, chat, and live intervention alerts.
 *
 * The one architectural constraint, because it is easy to get wrong and expensive to
 * discover late:
 *
 *   Replay BLOCKS when it escalates. It is sitting inside `waitForResolution()`,
 *   holding a live browser session — cookies, half-filled form, mid-flow page.
 *
 * So the dashboard watches the **intervention queue** and resolves through it. It never
 * calls "resume" on the engine, because there is nothing to call. A request/response
 * shape there would force the live session to be reconstructed on resume, which loses
 * the exact property §3.6 requires: the human operates the SAME session the automation
 * was using.
 *
 *     Replay ──escalate──▶ Queue ◀──SSE── Dashboard ──▶ browser notification
 *        │ (blocked)         ▲                              │
 *        └──resolved─────────┴──────── operator decides ─────┘
 *
 * This is a client of the system, like the router — it consumes the catalog and the
 * queue, and holds no automation logic of its own.
 */

import express from 'express';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { Catalog } from '../catalog/catalog.ts';
import { renderForReview } from '../catalog/review.ts';
import { loadReport } from '../stability/stability.ts';
import { InterventionQueue } from '../escalation/broker.ts';
import { SessionStore } from './sessions.ts';
import { proposeRoute, applyGuardrails, CONTEXT_TURNS } from '../orchestrator/router.ts';
import { RouteCache, catalogFingerprint } from '../orchestrator/route-cache.ts';
import { setPaceMs, paceMs } from '../obs/pace.ts';
import { ReplayEngine } from '../replay/engine.ts';
import { verifyContentHash } from '../schema/hash.ts';
import { discover } from '../agent/loop.ts';
import { measureStability, saveReport, loadReport as loadStability, promotionAdvice } from '../stability/stability.ts';

const PORT = Number(process.env.DASHBOARD_PORT ?? 3300);
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR ?? 'artifacts';
const RUNS_DIR = process.env.RUNS_DIR ?? 'runs';
const INTERVENTIONS_DIR = process.env.INTERVENTIONS_DIR ?? 'runs/interventions';
const STABILITY_DIR = process.env.STABILITY_DIR ?? 'stability';
const SESSIONS_DIR = process.env.SESSIONS_DIR ?? 'sessions';
const POLICY_PATH = process.env.POLICY_PATH ?? 'policy.yaml';
const ROUTE_CACHE = process.env.ROUTE_CACHE ?? 'routes/cache.json';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();
const catalog = new Catalog(ARTIFACTS_DIR, STABILITY_DIR);
const queue = new InterventionQueue(INTERVENTIONS_DIR);
const sessions = new SessionStore(SESSIONS_DIR);

/**
 * The most recent frame from whichever run is live, plus who is watching.
 *
 * One slot rather than a buffer: a viewer wants "what is on screen now", and a queue of
 * stale frames is worse than none. Held in memory because it is worthless the moment the
 * run ends — this is a window, not a record. The record is the run log.
 */
let liveFrame: string | null = null;
let liveRun: { runId: string; capabilityId: string } | null = null;
const watchers = new Set<import('express').Response>();

function pushFrame(frame: string): void {
  liveFrame = frame;
  for (const w of watchers) {
    try {
      w.write(`event: frame\ndata: ${frame}\n\n`);
    } catch {
      watchers.delete(w);
    }
  }
}

/** Step progress for the live pane. Same one-slot rule as frames: current, not history. */
function pushStep(e: Record<string, unknown>): void {
  for (const w of watchers) {
    try {
      w.write(`event: step\ndata: ${JSON.stringify(e)}\n\n`);
    } catch {
      watchers.delete(w);
    }
  }
}

function announceRun(run: typeof liveRun): void {
  liveRun = run;
  for (const w of watchers) {
    try {
      w.write(`event: run\ndata: ${JSON.stringify(run)}\n\n`);
    } catch {
      watchers.delete(w);
    }
  }
}

/**
 * Live view of the automation's actual session.
 *
 * Deliberately NOT an iframe of the target app: a second browser pointed at the same URL
 * is a different session with different cookies, and during an escalation that would
 * show an operator something that looks like the run but isn't. These frames come out of
 * the very page the engine is driving.
 */
app.get('/api/screen', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  watchers.add(res);
  if (liveRun) res.write(`event: run\ndata: ${JSON.stringify(liveRun)}\n\n`);
  if (liveFrame) res.write(`event: frame\ndata: ${liveFrame}\n\n`);
  const keepalive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(keepalive);
    watchers.delete(res);
  });
});

app.use(express.json());
// No caching. A stale app.js against a fresh index.html is the worst kind of bug here:
// the new control renders, silently sends nothing, and the server falls back to its
// default — which reads as "the feature does not work" rather than "reload the page".
app.use(
  express.static(join(here, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
  }),
);

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

app.get('/api/capabilities', (_req, res) => {
  res.json(
    catalog.list().map((a) => ({
      id: a.capability.id,
      name: a.capability.name,
      version: a.capability.version,
      status: a.capability.status,
      description: a.capability.description,
      app: `${a.app.vendor}/${a.app.appId}`,
      inputs: Object.keys(a.inputs),
      outputs: Object.keys(a.outputs),
      outcomes: a.outcomes.map((o) => o.code),
      irreversible: a.steps.some((s) => s.risk === 'irreversible'),
      stability: loadReport(STABILITY_DIR, a.capability.id, a.capability.version)?.verdict ?? null,
      versions: allVersions(a.capability.id),
    })),
  );
});

function allVersions(id: string): number[] {
  const dir = join(ARTIFACTS_DIR, id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^v\d+\.json$/.test(f))
    .map((f) => Number(f.slice(1, -5)))
    .sort((a, b) => a - b);
}

app.get('/api/capabilities/:id', (req, res) => {
  const version = req.query.version ? Number(req.query.version) : undefined;
  const artifact = catalog.get(req.params.id, version);
  if (!artifact) return res.status(404).json({ error: 'no such capability' });

  res.json({
    artifact,
    // All three projections of the same source, so the UI never re-derives any of them.
    review: renderForReview(artifact),
    toolDef: catalog.toToolDef(artifact),
    integrity: verifyContentHash(artifact),
    stability: loadReport(STABILITY_DIR, artifact.capability.id, artifact.capability.version),
    versions: allVersions(req.params.id),
    runs: runsFor(artifact.capability.id),
  });
});

/** Past runs of a capability, newest first — read straight from the run logs. */
function runsFor(capabilityId: string): unknown[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter((d) => d.startsWith('replay-'))
    .map((d) => join(RUNS_DIR, d, 'result.json'))
    .filter((p) => existsSync(p))
    .map((p) => {
      try {
        const r = JSON.parse(readFileSync(p, 'utf8'));
        return { ...r, _mtime: statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((r): r is Record<string, unknown> => !!r && r.capabilityId === capabilityId)
    .sort((a, b) => (b._mtime as number) - (a._mtime as number))
    .slice(0, 20);
}

/**
 * One run's evidence, by id.
 *
 * This is the "why did it do that" path. A chat message that says a capability ran is
 * only half a record — the other half is the trace, the result contract and the
 * screenshots, and an auditor asking about a decision six months later needs to reach
 * them from the conversation, not by grepping a directory.
 */
app.get('/api/runs/:runId', (req, res) => {
  const dir = readdirSync(RUNS_DIR).find((d) => d.endsWith(req.params.runId));
  if (!dir) return res.status(404).json({ error: 'no such run' });
  const runDir = join(RUNS_DIR, dir);

  const resultPath = join(runDir, 'result.json');
  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null;

  const logPath = join(runDir, 'run.jsonl');
  const log = existsSync(logPath)
    ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];

  res.json({
    runId: req.params.runId,
    dir: runDir,
    result,
    log,
    screenshots: readdirSync(runDir).filter((f) => f.endsWith('.png')),
  });
});

app.get('/api/runs/:runId/screenshot/:name', (req, res) => {
  const dir = readdirSync(RUNS_DIR).find((d) => d.endsWith(req.params.runId));
  // Basename the filename — it comes from a URL and must never escape the run directory.
  const safe = req.params.name.replace(/[^a-zA-Z0-9._-]/g, '');
  if (!dir || !safe) return res.status(404).end();
  const p = join(RUNS_DIR, dir, safe);
  if (!existsSync(p)) return res.status(404).end();
  res.type('png').send(readFileSync(p));
});

// ---------------------------------------------------------------------------
// Sessions and chat
// ---------------------------------------------------------------------------

app.get('/api/sessions', (_req, res) => res.json(sessions.list()));
app.post('/api/sessions', (_req, res) => res.json({ id: sessions.create() }));
app.get('/api/sessions/:id', (req, res) => res.json(sessions.messages(req.params.id)));

/**
 * The chat turn. Routes the goal, then either runs it, asks a question, or offers
 * discovery — and records every one of those as a message, so the history explains
 * itself later.
 */
app.post('/api/sessions/:id/messages', async (req, res) => {
  const sessionId = req.params.id;
  const goal = String(req.body.content ?? '').trim();
  // Presentation speed, chosen per turn by the viewer. Adds idle time only — it cannot
  // change what a step does, and it is read at browser launch so it never mutates a run
  // already in flight. See obs/pace.ts.
  setPaceMs(Number(req.body.paceMs ?? 0));
  console.log(`[chat] pace=${paceMs()}ms  goal=${goal.slice(0, 60)}`);
  if (!goal) return res.status(400).json({ error: 'empty message' });

  sessions.append(sessionId, 'user', goal);

  if (!process.env.ANTHROPIC_API_KEY) {
    const m = sessions.append(sessionId, 'system', 'ANTHROPIC_API_KEY is not set — the router needs a model to match goals to capabilities.');
    return res.json([m]);
  }

  const emitted: unknown[] = [];
  try {
    // Prior turns, so an answer to a clarifying question resolves against the question.
    // The guardrails still validate whatever inputs come back — history can inform the
    // router's reading of the goal, but it can never widen what is allowed.
    const history = sessions
      .messages(sessionId)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-(CONTEXT_TURNS + 1), -1) // exclude the message we just appended
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const artifacts = catalog.list();
    const cache = new RouteCache(ROUTE_CACHE, catalogFingerprint(artifacts));
    // Only consult the cache for a self-contained request. A short reply resolving a
    // clarifying question ("100442") has no intent of its own — its meaning lives in
    // the previous turn, so it must go to the model.
    const cached = history.length === 0 ? cache.lookup(goal, artifacts) : null;

    // Timed so the UI can show what routing actually cost. Without it, "no model call"
    // is a claim the viewer has to take on trust — and the whole argument for recording
    // capabilities is that replay is cheap, which is only convincing if it is visible.
    const routeStarted = Date.now();
    const proposed = cached ?? (await proposeRoute(goal, catalog.toolDefs(), history));
    const routeMs = Date.now() - routeStarted;
    if (!cached) cache.remember(goal, artifacts, proposed);
    const route = applyGuardrails(proposed, catalog, goal);

    if (route.action === 'clarify') {
      emitted.push(sessions.append(sessionId, 'assistant', route.question));
      return res.json(emitted);
    }
    if (route.action === 'refuse') {
      emitted.push(sessions.append(sessionId, 'assistant', route.reason));
      return res.json(emitted);
    }
    if (route.action === 'discover') {
      emitted.push(
        sessions.append(
          sessionId,
          'assistant',
          `Nothing in the catalog does this. ${route.reason}`,
          { offerDiscovery: goal },
        ),
      );
      return res.json(emitted);
    }

    // Say what is about to run BEFORE running it — a replay can pause for minutes on
    // an escalation, and a silent UI during that is indistinguishable from a hang.
    emitted.push(
      sessions.append(
        sessionId,
        'assistant',
        `Using ${route.artifact.capability.id} v${route.artifact.capability.version} — ${route.reason}`,
        {
          capabilityId: route.artifact.capability.id,
          capabilityVersion: route.artifact.capability.version,
          routeSource: cached ? 'cache' : 'model',
          routeMs,
        },
      ),
    );

    const engine = new ReplayEngine({
      artifact: route.artifact,
      inputs: route.inputs,
      policyPath: POLICY_PATH,
      headed: true, // an escalation hands this window to a human
      runsDir: RUNS_DIR,
      interventionsDir: INTERVENTIONS_DIR,
      escalationTimeoutMs: 600_000,
      onFrame: pushFrame,
      onStep: pushStep,
    });

    announceRun({ runId: 'starting', capabilityId: route.artifact.capability.id });
    const result = await engine.run();
    announceRun(null);
    const summary =
      result.status === 'success'
        ? `Done. ${JSON.stringify(result.outputs)}`
        : result.status === 'business_outcome'
        ? `${result.outcome.code} — ${result.outcome.message}`
        : `Failed (${result.failure.class}): ${result.failure.message}`;

    emitted.push(
      sessions.append(sessionId, 'assistant', summary, {
        runId: result.runId,
        capabilityId: result.capabilityId,
        capabilityVersion: result.capabilityVersion,
        status: result.status,
        outcomeCode: result.status === 'business_outcome' ? result.outcome.code : undefined,
        // Only the execution cost. The routing cost was already reported on the "Using …"
        // message two lines up, and printing it twice per turn reads as noise rather than
        // as the two-halves story it is meant to tell.
        replayMs: result.durationMs,
      }),
    );
    res.json(emitted);
  } catch (err) {
    emitted.push(sessions.append(sessionId, 'system', `Error: ${(err as Error).message}`));
    res.json(emitted);
  }
});

// ---------------------------------------------------------------------------
// Discovery — expensive, so confirmed and streamed rather than fire-and-forget
// ---------------------------------------------------------------------------

/**
 * Record a new capability.
 *
 * Deliberately a separate, explicit call rather than something the chat does on its own
 * when nothing matches. A discovery run drives a live application for minutes and costs
 * real money; starting one because a match was fuzzy is the wrong default. The chat
 * offers it, a human presses it.
 */
app.post('/api/sessions/:id/discover', async (req, res) => {
  const sessionId = req.params.id;
  const goal = String(req.body.goal ?? '').trim();
  if (!goal) return res.status(400).json({ error: 'no goal' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.json([sessions.append(sessionId, 'system', 'ANTHROPIC_API_KEY is not set — discovery needs a model.')]);
  }

  sessions.append(sessionId, 'system', `Recording a new capability for: ${goal}`);
  announceRun({ runId: 'discovery', capabilityId: '(recording a new capability)' });
  // Discovery has no fixed step list — it is exploring. Reset the pane so it stops
  // showing the previous REPLAY's steps, which is worse than showing nothing: the
  // ticks look like this run's progress.
  pushStep({ phase: 'reset', mode: 'discovery' });
  let explored = 0;

  try {
    const result = await discover({
      goal,
      entryUrl: process.env.TARGET_URL ?? 'http://localhost:3100',
      appId: 'corevue',
      vendor: 'meridian-systems',
      policyPath: POLICY_PATH,
      runsDir: RUNS_DIR,
      headed: true,
      maxSteps: 25,
      timeoutMs: 300_000,
      onFrame: pushFrame,
      /**
       * A dead end is a question for a person, not a silent failure. Raise it on the
       * same queue replay uses, so it reaches the operator through the same modal and
       * the same notification — and block here, keeping the browser open, so whoever
       * answers is looking at the live session rather than a screenshot of a dead one.
       */
      onDeadEnd: async (ctx) => {
        const request = queue.create({
          runId: ctx.runId,
          capability: { id: '(none)', version: 0, name: 'Discovery dead end' },
          goal: ctx.goal,
          step: null,
          reason: `Discovery could not record a capability: ${ctx.reason}`,
          expected: 'a repeatable flow that satisfies the goal',
          observed: ctx.reason,
          inputs: {},
          currentUrl: '',
          screenshotPath: ctx.screenshotPath,
        });
        // No explicit announce: /api/events polls the queue every second and picks up
        // anything open, which is the same path a replay escalation takes.
        const resolved = await queue.waitForResolution(request.id, 600_000);
        const action = resolved.status === 'resolved' ? 'demonstrated' : 'abort';
        return {
          action,
          operator: resolved.resolution?.operator ?? 'unknown',
          note: resolved.resolution?.note ?? '',
        };
      },
      onProgress: (e) => {
        // Streamed into the session as it happens, so the history shows HOW the
        // capability was found, not just that it was.
        if (e.kind === 'thinking') sessions.append(sessionId, 'assistant', e.text);
        else sessions.append(sessionId, 'system', `${e.kind}: ${e.text}`);

        // The model's actions ARE the step trace during discovery. No total: it does
        // not know how many steps the flow has until it has found one.
        if (e.kind === 'action' || e.kind === 'refused') {
          explored += 1;
          pushStep({
            phase: 'end',
            index: explored,
            id: `explore-${explored}`,
            intent: e.text,
            risk: 'safe',
            status: e.kind === 'refused' ? 'failed' : 'ok',
          });
        }
      },
    });
    announceRun(null);

    if (result.status !== 'success') {
      // A dead end that a person has looked at is a different message from one nobody
      // saw. Say which it was, and what they concluded.
      const hr = result.humanReview;
      const verdict = !hr
        ? ''
        : hr.action === 'abort'
          ? `\n\nA human reviewed this and confirmed it cannot be done here. Note: ${hr.note || '(none)'}`
          : hr.actionsRecorded > 0
            // Only claim a demonstration when the human actually did something. Saying
            // "demonstrated 0 actions" is worse than saying nothing.
            ? `\n\nA human took the session and demonstrated ${hr.actionsRecorded} action(s), recorded in the run log for authoring a capability from. Note: ${hr.note || '(none)'}`
            : `\n\nA human reviewed the live session and took no action. Note: ${hr.note || '(none)'}`;
      return res.json([
        sessions.append(
          sessionId,
          'assistant',
          `Could not record this capability — ${result.status}: ${result.reason}${verdict}`,
        ),
      ]);
    }

    // Never overwrite an existing version; a capability's history is append-only.
    const { artifact } = result;
    const dir = join(ARTIFACTS_DIR, artifact.capability.id);
    mkdirSync(dir, { recursive: true });
    const existing = readdirSync(dir).filter((f) => /^v\d+\.json$/.test(f)).map((f) => Number(f.slice(1, -5)));
    if (existing.length) artifact.capability.version = Math.max(...existing) + 1;
    writeFileSync(join(dir, `v${artifact.capability.version}.json`), JSON.stringify(artifact, null, 2));

    return res.json([
      sessions.append(
        sessionId,
        'assistant',
        `Recorded ${artifact.capability.id} v${artifact.capability.version} as a DRAFT — ` +
          `${artifact.steps.length} steps, inputs: ${Object.keys(artifact.inputs).join(', ') || 'none'}, ` +
          `outputs: ${Object.keys(artifact.outputs).join(', ') || 'none'}.\n\n` +
          `An LLM wrote this and nobody has reviewed it, so it cannot be invoked yet. ` +
          `Review it, measure it, then approve.`,
        { capabilityId: artifact.capability.id, capabilityVersion: artifact.capability.version },
      ),
    ]);
  } catch (err) {
    announceRun(null);
    return res.json([sessions.append(sessionId, 'system', `Discovery failed: ${(err as Error).message}`)]);
  }
});

/** Measure a capability from the UI — the evidence the approval gate wants. */
app.post('/api/capabilities/:id/measure', async (req, res) => {
  const artifact = catalog.get(req.params.id, req.body.version ? Number(req.body.version) : undefined);
  if (!artifact) return res.status(404).json({ error: 'no such capability' });
  try {
    const report = await measureStability({
      artifact,
      inputs: req.body.inputs ?? {},
      runs: Number(req.body.runs ?? 5),
      policyPath: POLICY_PATH,
      runsDir: RUNS_DIR,
      interventionsDir: INTERVENTIONS_DIR,
      onFrame: undefined,
    } as never);
    saveReport(STABILITY_DIR, report);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Promote a draft — refused unless the measurement supports it. */
app.post('/api/capabilities/:id/approve', (req, res) => {
  const artifact = catalog.get(req.params.id, req.body.version ? Number(req.body.version) : undefined);
  if (!artifact) return res.status(404).json({ error: 'no such capability' });

  const advice = promotionAdvice(loadReport(STABILITY_DIR, artifact.capability.id, artifact.capability.version));
  if (!advice.ok && !req.body.force) {
    return res.status(409).json({ error: advice.note, needsForce: true });
  }

  artifact.capability.status = 'approved';
  writeFileSync(
    join(ARTIFACTS_DIR, artifact.capability.id, `v${artifact.capability.version}.json`),
    JSON.stringify(artifact, null, 2),
  );
  res.json({ ok: true, note: advice.note });
});

// ---------------------------------------------------------------------------
// Interventions — watched, never driven
// ---------------------------------------------------------------------------

app.get('/api/interventions', (_req, res) => res.json(queue.list()));

app.post('/api/interventions/:id/resolve', (req, res) => {
  const r = queue.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'no such intervention' });

  const action = req.body.action === 'abort' ? 'abort' : 'resume';
  r.status = action === 'abort' ? 'aborted' : 'resolved';
  r.resolution = {
    operator: process.env.OPERATOR_NAME ?? 'dashboard-operator',
    action,
    note: String(req.body.note ?? ''),
    tookControlAt: r.createdAt,
    returnedControlAt: new Date().toISOString(),
    recordedActions: [],
  };
  // Writing this is the ONLY thing that unblocks the engine. The dashboard does not
  // — and cannot — call resume directly.
  queue.update(r);
  res.json({ ok: true });
});

app.get('/api/interventions/:id/screenshot', (req, res) => {
  const r = queue.get(req.params.id);
  if (!r?.screenshotPath || !existsSync(r.screenshotPath)) return res.status(404).end();
  res.type('png').send(readFileSync(r.screenshotPath));
});

/**
 * Server-sent events over the queue. Polled server-side rather than watched with
 * fs.watch: the queue is a directory two processes write to, and fs.watch semantics
 * differ per platform. A 1s poll is unmeasurable next to a browser session sitting idle
 * waiting for a human.
 */
app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  let announced = new Set<string>();
  const tick = () => {
    const open = queue.list().filter((r) => r.status === 'open' || r.status === 'in_progress');
    for (const r of open) {
      if (announced.has(r.id)) continue;
      announced.add(r.id);
      res.write(`event: intervention\ndata: ${JSON.stringify(r)}\n\n`);
    }
    // Forget resolved ones so a genuinely new request for the same run re-announces.
    announced = new Set([...announced].filter((id) => open.some((r) => r.id === id)));
    res.write(`event: ping\ndata: {"open":${open.length}}\n\n`);
  };

  tick();
  const timer = setInterval(tick, 1000);
  req.on('close', () => clearInterval(timer));
});

app.listen(PORT, () => {
  console.log(`Dashboard on http://localhost:${PORT}`);
  console.log(`  catalog: ${ARTIFACTS_DIR}  ·  sessions: ${SESSIONS_DIR}  ·  queue: ${INTERVENTIONS_DIR}`);
});
