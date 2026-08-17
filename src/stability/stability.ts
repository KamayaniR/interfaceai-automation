/**
 * Stability measurement: replay a capability N times and report whether it behaves
 * the same way every time.
 *
 * The definition matters, and the obvious one is wrong. Stability is **not** "how often
 * did it succeed" — a capability invoked with a member number that doesn't exist should
 * return MEMBER_NOT_FOUND every single time, and that is perfectly stable behaviour. A
 * score built on success rate would mark it broken.
 *
 * So stability here means CONSISTENCY: given the same inputs, does the capability land
 * in the same result bucket every run? Mixed buckets are the real signal — a capability
 * that succeeds nine times and hard-fails once is flaky in a way that will page someone
 * at 3am, and it is exactly what a single manual test run cannot see.
 *
 * The second signal is drift. Every replay reports which rung of the locator ladder
 * carried each step. Runs that all succeed but keep falling to a fallback strategy are
 * a capability living on borrowed time — the preferred locators have already stopped
 * matching, and nobody has noticed because the result is still green.
 *
 * Where the score lives is deliberate too: NOT inside the artifact. An artifact is a
 * contract that a human approved and whose content hash is fixed; a stability score is
 * an observation about it, measured later, and it changes every time you measure again.
 * Writing it into the artifact would both break the hash and conflate what a capability
 * promises with how it happened to behave on Tuesday.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import type { CapabilityArtifact } from '../schema/artifact.ts';
import type { ReplayResult } from '../schema/result.ts';
import { ReplayEngine } from '../replay/engine.ts';

export const StabilityReport = z.object({
  capabilityId: z.string(),
  capabilityVersion: z.number().int(),
  /** The exact inputs measured against — a score is only meaningful for these. */
  inputs: z.record(z.string()),
  runs: z.number().int().positive(),
  measuredAt: z.string(),

  /**
   * Result buckets keyed by outcome, e.g. `success`, `business_outcome:MEMBER_NOT_FOUND`,
   * `failure:hard`. One bucket = deterministic. More than one = flaky.
   */
  buckets: z.record(z.number().int()),

  /** Steps that ever resolved on something other than the preferred locator. */
  drift: z.array(z.object({
    stepId: z.string(),
    occurrences: z.number().int(),
    worstRung: z.number().int(),
    note: z.string(),
  })),

  durationMs: z.object({ min: z.number(), median: z.number(), max: z.number() }),

  /**
   * `stable`   — every run landed in the same bucket, no drift
   * `degraded` — consistent results, but locators are falling back
   * `flaky`    — the same inputs produced different classes of result
   */
  verdict: z.enum(['stable', 'degraded', 'flaky']),
  summary: z.string(),
});
export type StabilityReport = z.infer<typeof StabilityReport>;

/** The bucket a single result falls into. This is the equivalence class we measure. */
function bucketOf(result: ReplayResult): string {
  switch (result.status) {
    case 'success':
      return 'success';
    case 'business_outcome':
      return `business_outcome:${result.outcome.code}`;
    case 'failure':
      return `failure:${result.failure.class}`;
  }
}

export interface MeasureOptions {
  artifact: CapabilityArtifact;
  inputs: Record<string, string>;
  runs: number;
  policyPath: string;
  runsDir: string;
  interventionsDir: string;
  onProgress?: (n: number, total: number, bucket: string) => void;
}

export async function measureStability(opts: MeasureOptions): Promise<StabilityReport> {
  const buckets: Record<string, number> = {};
  const durations: number[] = [];
  const driftByStep = new Map<string, { occurrences: number; worstRung: number; note: string }>();

  for (let i = 0; i < opts.runs; i++) {
    const engine = new ReplayEngine({
      artifact: opts.artifact,
      inputs: opts.inputs,
      policyPath: opts.policyPath,
      headed: false,
      runsDir: opts.runsDir,
      interventionsDir: opts.interventionsDir,
      // A measurement run must never block waiting for a human. If a capability
      // escalates, that IS the finding — record it and move on.
      escalationTimeoutMs: 1,
    });

    const result = await engine.run();
    const bucket = bucketOf(result);
    buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    durations.push(result.durationMs);

    for (const d of result.drift) {
      const prev = driftByStep.get(d.stepId);
      driftByStep.set(d.stepId, {
        occurrences: (prev?.occurrences ?? 0) + 1,
        worstRung: Math.max(prev?.worstRung ?? 0, d.candidateIndex),
        note: d.note,
      });
    }

    opts.onProgress?.(i + 1, opts.runs, bucket);
  }

  durations.sort((a, b) => a - b);
  const drift = [...driftByStep.entries()].map(([stepId, d]) => ({ stepId, ...d }));

  const distinct = Object.keys(buckets).length;
  const verdict: StabilityReport['verdict'] =
    distinct > 1 ? 'flaky' : drift.length > 0 ? 'degraded' : 'stable';

  const dominant = Object.entries(buckets).sort((a, b) => b[1] - a[1])[0]!;
  const summary =
    verdict === 'flaky'
      ? `the same inputs produced ${distinct} different classes of result: ` +
        Object.entries(buckets).map(([b, n]) => `${b} ×${n}`).join(', ')
      : verdict === 'degraded'
      ? `consistently ${dominant[0]} across ${opts.runs} runs, but ${drift.length} step(s) resolved on a fallback locator — the preferred targeting has already stopped matching`
      : `consistently ${dominant[0]} across ${opts.runs} runs, every step on its preferred locator`;

  return {
    capabilityId: opts.artifact.capability.id,
    capabilityVersion: opts.artifact.capability.version,
    inputs: opts.inputs,
    runs: opts.runs,
    measuredAt: new Date().toISOString(),
    buckets,
    drift,
    durationMs: {
      min: durations[0] ?? 0,
      median: durations[Math.floor(durations.length / 2)] ?? 0,
      max: durations[durations.length - 1] ?? 0,
    },
    verdict,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Persistence — derived, beside the artifact rather than inside it
// ---------------------------------------------------------------------------

export function reportPath(dir: string, capabilityId: string, version: number): string {
  return join(dir, capabilityId, `v${version}.json`);
}

export function saveReport(dir: string, report: StabilityReport): string {
  const path = reportPath(dir, report.capabilityId, report.capabilityVersion);
  mkdirSync(join(dir, report.capabilityId), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  return path;
}

export function loadReport(dir: string, capabilityId: string, version: number): StabilityReport | null {
  const path = reportPath(dir, capabilityId, version);
  if (!existsSync(path)) return null;
  try {
    return StabilityReport.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Whether a measured capability should be promoted for unattended use.
 *
 * Deliberately advisory rather than automatic: a human still approves. The point is
 * that they approve against evidence instead of a hunch — "12/12 consistent, no drift"
 * is a different decision from "3 of 12 fell to a fallback locator".
 */
export function promotionAdvice(report: StabilityReport | null): { ok: boolean; note: string } {
  if (!report) {
    return {
      ok: false,
      note: 'never measured — run `npm run stability` before approving for unattended use',
    };
  }
  if (report.verdict === 'flaky') {
    return { ok: false, note: `flaky: ${report.summary}` };
  }
  if (report.verdict === 'degraded') {
    return { ok: false, note: `degraded: ${report.summary}` };
  }
  return { ok: true, note: `stable across ${report.runs} runs with ${JSON.stringify(report.inputs)}` };
}
