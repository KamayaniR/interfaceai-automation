/**
 * Structured run logging and evidence capture.
 *
 * One JSONL file per run, plus screenshots and DOM snapshots on failure. JSONL because
 * a run log is append-only and machine-greppable; the point of evidence is that someone
 * debugging at 3am can answer "what did it do, and why did it think that was right?"
 * without attaching a debugger.
 *
 * Everything written here passes through the Redactor first. There is no `log.raw()`.
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Redactor } from '../policy/redact.ts';

export interface RunLogEvent {
  type: string;
  detail: Record<string, unknown>;
}

export class RunLogger {
  readonly logPath: string;
  readonly screenshots: string[] = [];
  readonly domSnapshots: string[] = [];

  constructor(
    readonly runDir: string,
    readonly runId: string,
    private readonly redactor: Redactor,
  ) {
    mkdirSync(runDir, { recursive: true });
    this.logPath = join(runDir, 'run.jsonl');
  }

  log(type: string, detail: Record<string, unknown> = {}): void {
    const line = {
      at: new Date().toISOString(),
      runId: this.runId,
      type,
      ...this.redactor.scrubDeep(detail),
    };
    appendFileSync(this.logPath, JSON.stringify(line) + '\n');
  }

  screenshotPath(label: string): string {
    const p = join(this.runDir, `${label}.png`);
    this.screenshots.push(p);
    return p;
  }

  domPath(label: string): string {
    const p = join(this.runDir, `${label}.html`);
    this.domSnapshots.push(p);
    return p;
  }
}
