/**
 * Redaction.
 *
 * This is regulated financial data, so the rule is that sensitive values never reach
 * durable storage in the first place — not that they are cleaned up afterwards. Three
 * layers, deliberately overlapping:
 *
 *  1. Structural. The artifact records parameter NAMES and SHAPES, never values. A
 *     capability says "takes a memberId matching ^\d{6}$", not "takes 100442". This is
 *     enforced by the schema itself, not by this file.
 *  2. Declared. `ParamSpec.sensitivity` marks a parameter pii or secret; anything
 *     marked is masked wherever it appears in logs and results.
 *  3. Pattern-based. A regex sweep for SSNs, card numbers and bearer tokens catches
 *     values nobody remembered to declare — the case that actually causes incidents.
 *
 * Secrets from the environment are never passed through here at all. They go from
 * `process.env` into the browser and are excluded from the perception index at source
 * (password fields are read as `undefined`), so there is no code path that could log
 * them.
 */

import type { ParamSpec } from '../schema/artifact.ts';

export class Redactor {
  private readonly patterns: { name: string; re: RegExp }[];
  private readonly secrets: string[];

  constructor(config: { patterns: { name: string; regex: string; flags?: string }[]; secretEnvVars: string[] }) {
    // `flags` is explicit because JS has no inline (?i) syntax; a pattern that needs
    // case-insensitivity declares it rather than silently not matching.
    this.patterns = config.patterns.map((p) => ({
      name: p.name,
      re: new RegExp(p.regex, p.flags ?? 'g'),
    }));
    // Snapshot the live values of declared secret env vars so we can scrub them if
    // they ever appear in a string, whatever route they took to get there.
    this.secrets = config.secretEnvVars
      .map((k) => process.env[k])
      .filter((v): v is string => !!v && v.length >= 4);
  }

  /** Mask a single value, preserving enough shape to be debuggable. */
  static mask(value: string, sensitivity: 'public' | 'pii' | 'secret'): string {
    if (sensitivity === 'public') return value;
    if (sensitivity === 'secret') return '[REDACTED]';
    // PII keeps its length and last two characters — enough to correlate two log lines
    // as being about the same record without disclosing the record.
    if (value.length <= 2) return '*'.repeat(value.length);
    return '*'.repeat(value.length - 2) + value.slice(-2);
  }

  /** Sweep an arbitrary string for known-sensitive patterns and live secret values. */
  scrub(text: string): string {
    let out = text;
    for (const secret of this.secrets) {
      out = out.split(secret).join('[REDACTED]');
    }
    for (const { name, re } of this.patterns) {
      out = out.replace(re, `[REDACTED:${name}]`);
    }
    return out;
  }

  /** Redact a set of capability inputs according to their declared sensitivity. */
  redactInputs(
    inputs: Record<string, unknown>,
    specs: Record<string, ParamSpec>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(inputs)) {
      const spec = specs[key];
      // Unknown parameters are treated as PII. Failing closed is the only safe default
      // when the classification is missing.
      const sensitivity = spec?.sensitivity ?? 'pii';
      out[key] = typeof value === 'string' ? Redactor.mask(value, sensitivity) : value;
    }
    return out;
  }

  /** Deep-scrub an object destined for a log file. */
  scrubDeep<T>(value: T): T {
    if (typeof value === 'string') return this.scrub(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => this.scrubDeep(v)) as unknown as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.scrubDeep(v);
      return out as T;
    }
    return value;
  }
}
