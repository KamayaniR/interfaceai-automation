/**
 * CLI entry point: discover / replay / catalog / approve.
 *
 * Thin by design — it parses arguments, wires dependencies and prints results. All the
 * behaviour worth reviewing lives in the modules it calls.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { discover } from './agent/loop.ts';
import { ReplayEngine } from './replay/engine.ts';
import { Catalog } from './catalog/catalog.ts';
import { renderForReview } from './catalog/review.ts';
import { proposeRoute, applyGuardrails } from './orchestrator/router.ts';
import { measureStability, saveReport, loadReport, promotionAdvice } from './stability/stability.ts';
import { parseArtifact } from './schema/artifact.ts';
import type { ReplayResult } from './schema/result.ts';

const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR ?? 'artifacts';
const RUNS_DIR = process.env.RUNS_DIR ?? 'runs';
const INTERVENTIONS_DIR = process.env.INTERVENTIONS_DIR ?? 'runs/interventions';
const POLICY_PATH = process.env.POLICY_PATH ?? 'policy.yaml';
const STABILITY_DIR = process.env.STABILITY_DIR ?? 'stability';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) return fallback;
  return process.argv[i + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** `--input key=value` may be repeated. */
function collectInputs(): Record<string, string> {
  const out: Record<string, string> = {};
  process.argv.forEach((a, i) => {
    if (a === '--input' && process.argv[i + 1]) {
      const [k, ...rest] = process.argv[i + 1]!.split('=');
      if (k) out[k] = rest.join('=');
    }
  });
  return out;
}

// ---------------------------------------------------------------------------

async function cmdDiscover(): Promise<void> {
  const goal = arg('goal');
  const url = arg('url', 'http://localhost:3100')!;
  if (!goal) {
    console.error('usage: npm run discover -- --goal "..." [--url http://localhost:3100] [--headed]');
    process.exit(2);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      '\nANTHROPIC_API_KEY is not set.\n\n' +
        'Discovery is the one path that genuinely needs a model — it is the run where an LLM\n' +
        'figures out the flow. Export a key and re-run:\n\n' +
        '    export ANTHROPIC_API_KEY=sk-ant-...\n',
    );
    process.exit(2);
  }

  console.log(`\nDiscovery run`);
  console.log(`  goal: ${goal}`);
  console.log(`  target: ${url}\n`);

  const result = await discover({
    goal,
    entryUrl: url,
    appId: arg('app-id', 'corevue')!,
    vendor: arg('vendor', 'meridian-systems')!,
    policyPath: POLICY_PATH,
    runsDir: RUNS_DIR,
    headed: flag('headed'),
    maxSteps: Number(arg('max-steps', '25')),
    timeoutMs: Number(arg('timeout', '300000')),
  });

  if (result.status !== 'success') {
    console.error(`\nDiscovery ${result.status}: ${result.reason}`);
    console.error(`Evidence: ${result.runDir}`);
    process.exit(1);
  }

  const { artifact } = result;
  const dir = join(ARTIFACTS_DIR, artifact.capability.id);
  mkdirSync(dir, { recursive: true });

  // Never overwrite an existing version. A capability's history is append-only —
  // re-recording an existing capability produces the NEXT version, so the artifact that
  // production has been replaying stays byte-identical and reviewable, and the two can
  // be diffed to see exactly what the model did differently this time.
  const existing = readdirSync(dir)
    .filter((f) => /^v\d+\.json$/.test(f))
    .map((f) => Number(f.slice(1, -5)));
  if (existing.length) {
    artifact.capability.version = Math.max(...existing) + 1;
  }

  const path = join(dir, `v${artifact.capability.version}.json`);
  writeFileSync(path, JSON.stringify(artifact, null, 2));

  console.log(`\nDiscovered capability "${artifact.capability.id}" v${artifact.capability.version}`);
  console.log(`  steps:    ${artifact.steps.length}`);
  console.log(`  inputs:   ${Object.keys(artifact.inputs).join(', ') || '(none)'}`);
  console.log(`  outputs:  ${Object.keys(artifact.outputs).join(', ') || '(none)'}`);
  console.log(`  outcomes: ${artifact.outcomes.map((o) => o.code).join(', ') || '(none)'}`);
  console.log(`  status:   ${artifact.capability.status}  (review it, then \`npm run catalog -- approve ...\`)`);
  console.log(`\n  artifact: ${path}`);
  console.log(`  evidence: ${result.runDir}\n`);
}

// ---------------------------------------------------------------------------

function printResult(result: ReplayResult): void {
  const line = '─'.repeat(64);
  console.log(`\n${line}`);

  if (result.status === 'success') {
    console.log(`STATUS   success`);
    console.log(`OUTPUTS  ${JSON.stringify(result.outputs, null, 2).replace(/\n/g, '\n         ')}`);
  } else if (result.status === 'business_outcome') {
    console.log(`STATUS   business_outcome     <- a legitimate answer, not a failure`);
    console.log(`OUTCOME  ${result.outcome.code}`);
    console.log(`         ${result.outcome.message}`);
  } else {
    console.log(`STATUS   failure`);
    console.log(`CLASS    ${result.failure.class}`);
    console.log(`STEP     ${result.failure.stepId ?? '(pre-flight)'}`);
    console.log(`MESSAGE  ${result.failure.message}`);
    if (result.failure.expected) console.log(`EXPECTED ${result.failure.expected}`);
    if (result.failure.observed) console.log(`OBSERVED ${result.failure.observed}`);
  }

  if (result.drift.length) {
    console.log(`\nDRIFT    ${result.drift.length} step(s) did not match on the preferred locator:`);
    for (const d of result.drift) console.log(`         · ${d.stepId}: ${d.note}`);
  }

  const human = result.trace.filter((t) => t.humanIntervention);
  if (human.length) {
    console.log(`\nHUMAN    ${human.length} intervention(s):`);
    for (const t of human) {
      const h = t.humanIntervention!;
      console.log(`         · ${t.stepId}: operator ${h.operator}, ${h.actionsRecorded} action(s) recorded, ${h.durationMs}ms`);
    }
  }

  console.log(`\nTRACE    ${result.trace.length} step(s), ${result.durationMs}ms`);
  for (const t of result.trace) {
    const cond = t.conditionFired ? `  [condition: ${t.conditionFired}]` : '';
    console.log(`         ${t.status.padEnd(9)} ${t.stepId}  ${t.intent}${cond}`);
  }
  console.log(`\nEVIDENCE ${result.evidence.logPath}`);
  console.log(`${line}\n`);
}

async function cmdReplay(): Promise<void> {
  const capabilityId = arg('capability');
  if (!capabilityId) {
    console.error('usage: npm run replay -- --capability <id> [--input k=v ...] [--fault <name>] [--headed]');
    process.exit(2);
  }

  const catalog = new Catalog(ARTIFACTS_DIR);
  const version = arg('version') ? Number(arg('version')) : undefined;
  const artifact = catalog.get(capabilityId, version);
  if (!artifact) {
    console.error(`No artifact found for capability "${capabilityId}" in ${ARTIFACTS_DIR}/`);
    process.exit(1);
  }

  console.log(`\nReplaying ${artifact.capability.id} v${artifact.capability.version} (${artifact.capability.status})`);
  if (!version && artifact.capability.status === 'draft') {
    console.log(`  ! no approved version exists — running a DRAFT that no human has reviewed.`);
    console.log(`    review it, then: npm run catalog -- approve ${artifact.capability.id}`);
  }
  console.log(`  no LLM in the decision loop\n`);

  const engine = new ReplayEngine({
    artifact,
    inputs: collectInputs(),
    policyPath: POLICY_PATH,
    headed: flag('headed'),
    runsDir: RUNS_DIR,
    interventionsDir: INTERVENTIONS_DIR,
    escalationTimeoutMs: Number(arg('escalation-timeout', '300000')),
    faultParam: arg('fault'),
  });

  const result = await engine.run();
  printResult(result);

  // Exit code carries the distinction too: a business outcome is a successful
  // invocation that produced a non-default answer, so it is not an error exit.
  process.exit(result.status === 'failure' ? 1 : 0);
}

// ---------------------------------------------------------------------------

/**
 * `ask` — the agent-facing entry point.
 *
 * This is what §8 means by "show one being invoked": a natural-language goal arrives,
 * the catalog is consulted, and an existing capability is replayed. Discovery is the
 * fallback, not the default — replay is ~800ms and free, discovery is minutes and
 * costs money, so routing to discovery when a capability already exists is the
 * expensive mistake.
 */
async function cmdAsk(): Promise<void> {
  const goal = process.argv.slice(3).filter((a) => !a.startsWith('--')).join(' ');
  if (!goal) {
    console.error('usage: npm run ask -- "look up member 100442\'s savings balance"');
    process.exit(2);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('\nANTHROPIC_API_KEY is not set — the router uses a model to match goals to capabilities.\n');
    process.exit(2);
  }

  const catalog = new Catalog(ARTIFACTS_DIR);
  const defs = catalog.toolDefs();

  console.log(`\nGOAL     ${goal}`);
  console.log(`CATALOG  ${defs.length} capability(s) available\n`);

  const proposed = await proposeRoute(goal, defs);
  const route = applyGuardrails(proposed, catalog, goal);

  console.log(`ROUTE    ${route.action}`);
  console.log(`REASON   ${route.reason}`);

  if (route.action === 'clarify') {
    console.log(`\n  ${route.question}\n`);
    process.exit(0);
  }

  if (route.action === 'refuse') {
    console.log();
    process.exit(1);
  }

  if (route.action === 'discover') {
    // Never silently spend minutes and money. The user asked a question; starting a
    // discovery run is a different, much larger action than answering it.
    console.log(`\n  Nothing in the catalog does this. To record a new capability:\n`);
    console.log(`      npm run discover -- --goal "${goal}"\n`);
    process.exit(0);
  }

  console.log(`INVOKE   ${route.artifact.capability.id} v${route.artifact.capability.version}`);
  console.log(`INPUTS   ${JSON.stringify(route.inputs)}`);
  console.log(`CONF     ${route.confidence}`);

  const engine = new ReplayEngine({
    artifact: route.artifact,
    inputs: route.inputs,
    policyPath: POLICY_PATH,
    headed: flag('headed'),
    runsDir: RUNS_DIR,
    interventionsDir: INTERVENTIONS_DIR,
    escalationTimeoutMs: Number(arg('escalation-timeout', '300000')),
  });
  printResult(await engine.run());
}

// ---------------------------------------------------------------------------

async function cmdStability(): Promise<void> {
  const capabilityId = arg('capability');
  if (!capabilityId) {
    console.error('usage: npm run stability -- --capability <id> [--input k=v ...] [--runs 10]');
    process.exit(2);
  }
  const catalog = new Catalog(ARTIFACTS_DIR);
  const artifact = catalog.get(capabilityId, arg('version') ? Number(arg('version')) : undefined);
  if (!artifact) {
    console.error(`No artifact found for "${capabilityId}"`);
    process.exit(1);
  }

  const runs = Number(arg('runs', '10'));
  console.log(`\nMeasuring ${artifact.capability.id} v${artifact.capability.version} over ${runs} runs`);
  console.log(`  inputs: ${JSON.stringify(collectInputs())}\n`);

  const report = await measureStability({
    artifact,
    inputs: collectInputs(),
    runs,
    policyPath: POLICY_PATH,
    runsDir: RUNS_DIR,
    interventionsDir: INTERVENTIONS_DIR,
    onProgress: (n, total, bucket) => process.stdout.write(`  run ${n}/${total}  ${bucket}\n`),
  });

  const path = saveReport(STABILITY_DIR, report);
  const line = '─'.repeat(64);
  console.log(`\n${line}`);
  console.log(`VERDICT   ${report.verdict.toUpperCase()}`);
  console.log(`          ${report.summary}`);
  console.log(`\nBUCKETS`);
  for (const [b, n] of Object.entries(report.buckets)) console.log(`          ${String(n).padStart(3)} × ${b}`);
  if (report.drift.length) {
    console.log(`\nDRIFT`);
    for (const d of report.drift) console.log(`          ${d.stepId}: ${d.occurrences} run(s), worst rung ${d.worstRung}`);
  }
  console.log(`\nDURATION  min ${report.durationMs.min}ms · median ${report.durationMs.median}ms · max ${report.durationMs.max}ms`);
  const advice = promotionAdvice(report);
  console.log(`\nPROMOTION ${advice.ok ? 'safe to approve' : 'NOT recommended'} — ${advice.note}`);
  console.log(`\nREPORT    ${path}`);
  console.log(`${line}\n`);

  process.exit(report.verdict === 'flaky' ? 1 : 0);
}

// ---------------------------------------------------------------------------

function cmdCatalog(): void {
  const catalog = new Catalog(ARTIFACTS_DIR);
  const sub = process.argv[3];

  if (sub === 'approve') {
    const id = process.argv[4];
    if (!id) {
      console.error('usage: npm run catalog -- approve <capability-id>');
      process.exit(2);
    }
    const artifact = catalog.get(id);
    if (!artifact) {
      console.error(`No such capability: ${id}`);
      process.exit(1);
    }
    // Approval is a human act, but it should be an INFORMED one. The measured
    // stability of this exact version is surfaced before promoting, and a capability
    // that is flaky or has never been measured requires an explicit --force.
    const report = loadReport(STABILITY_DIR, id, artifact.capability.version);
    const advice = promotionAdvice(report);
    console.log(`\n  stability: ${advice.note}`);

    if (!advice.ok && !flag('force')) {
      console.error(
        `\n  Not approving. Measure it first:\n` +
          `      npm run stability -- --capability ${id} --input <k=v> --runs 10\n\n` +
          `  Or approve anyway with --force if you have other evidence.\n`,
      );
      process.exit(1);
    }

    artifact.capability.status = 'approved';
    const path = join(ARTIFACTS_DIR, id, `v${artifact.capability.version}.json`);
    writeFileSync(path, JSON.stringify(artifact, null, 2));
    console.log(`  Approved ${id} v${artifact.capability.version} — now invocable unattended.\n`);
    return;
  }

  if (sub === 'review') {
    const id = process.argv[4];
    const artifact = id ? catalog.get(id, arg('version') ? Number(arg('version')) : undefined) : null;
    if (!artifact) {
      console.error('usage: npm run catalog -- review <capability-id> [--version N]');
      process.exit(2);
    }
    console.log('\n' + renderForReview(artifact) + '\n');
    return;
  }

  if (sub === 'show') {
    const id = process.argv[4];
    const artifact = id ? catalog.get(id) : null;
    if (!artifact) {
      console.error(`usage: npm run catalog -- show <capability-id>`);
      process.exit(2);
    }
    console.log(JSON.stringify(catalog.toToolDef(artifact), null, 2));
    return;
  }

  // Default: list. This is what a calling agent would be handed.
  const defs = catalog.toolDefs();
  if (!defs.length) {
    console.log(`\nNo capabilities in ${ARTIFACTS_DIR}/. Run a discovery first.\n`);
    return;
  }

  console.log(`\n${defs.length} capability(s) available to a calling agent:\n`);
  for (const d of defs) {
    const gate = d._meta.invocable ? 'approved' : 'DRAFT — not invocable unattended';
    console.log(`  ${d.name}  v${d._meta.version}  [${gate}]`);
    console.log(`    ${d.description.split('\n')[0]}`);
    console.log(`    args:    ${Object.keys(d.input_schema.properties).join(', ') || '(none)'}`);
    console.log(`    returns: ${Object.keys(d._meta.returns).join(', ') || '(none)'}`);
    if (d._meta.outcomes.length) {
      console.log(`    outcomes: ${d._meta.outcomes.map((o) => o.code).join(', ')}`);
    }
    console.log();
  }
  console.log(`Full JSON tool definition:  npm run catalog -- show <name>\n`);
}

// ---------------------------------------------------------------------------

const command = process.argv[2];
switch (command) {
  case 'discover':
    await cmdDiscover();
    break;
  case 'replay':
    await cmdReplay();
    break;
  case 'ask':
    await cmdAsk();
    break;
  case 'stability':
    await cmdStability();
    break;
  case 'catalog':
    cmdCatalog();
    break;
  default:
    console.error(`
Computer-use automation system

  npm run discover -- --goal "<natural language goal>" [--url ...] [--headed]
      One LLM-driven run against the live app. Emits a capability artifact.

  npm run ask -- "<natural language goal>"
      Route a goal to an existing capability and run it. Discovery is the fallback.

  npm run replay -- --capability <id> [--input k=v ...] [--fault <name>] [--headed]
      Deterministic replay. No LLM. Faults: notfound validation permdenied timeout dialog slow

  npm run stability -- --capability <id> [--input k=v ...] [--runs 10]
      Replay N times; report consistency, drift and a promotion recommendation.

  npm run catalog [-- review <id> | -- show <id> | -- approve <id>]
      review = the human projection; show = the agent tool definition.

  npm run operator
      Operator console for human escalation (separate process).
`);
    process.exit(2);
}
