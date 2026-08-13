/**
 * CLI entry point: discover / replay / catalog / approve.
 *
 * Thin by design — it parses arguments, wires dependencies and prints results. All the
 * behaviour worth reviewing lives in the modules it calls.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { discover } from './agent/loop.ts';
import { ReplayEngine } from './replay/engine.ts';
import { Catalog } from './catalog/catalog.ts';
import { parseArtifact } from './schema/artifact.ts';
import type { ReplayResult } from './schema/result.ts';

const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR ?? 'artifacts';
const RUNS_DIR = process.env.RUNS_DIR ?? 'runs';
const INTERVENTIONS_DIR = process.env.INTERVENTIONS_DIR ?? 'runs/interventions';
const POLICY_PATH = process.env.POLICY_PATH ?? 'policy.yaml';

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
    artifact.capability.status = 'approved';
    const path = join(ARTIFACTS_DIR, id, `v${artifact.capability.version}.json`);
    writeFileSync(path, JSON.stringify(artifact, null, 2));
    console.log(`Approved ${id} v${artifact.capability.version} — now invocable unattended.`);
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
  case 'catalog':
    cmdCatalog();
    break;
  default:
    console.error(`
Computer-use automation system

  npm run discover -- --goal "<natural language goal>" [--url ...] [--headed]
      One LLM-driven run against the live app. Emits a capability artifact.

  npm run replay -- --capability <id> [--input k=v ...] [--fault <name>] [--headed]
      Deterministic replay. No LLM. Faults: notfound validation permdenied timeout dialog slow

  npm run catalog [-- show <id> | -- approve <id>]
      The agent-facing capability catalog.

  npm run operator
      Operator console for human escalation (separate process).
`);
    process.exit(2);
}
