/**
 * Route memoisation — the last model call removed from the production path.
 *
 * Replay already runs without an LLM. Routing was the one exception: every invocation
 * paid a model call just to decide which capability to run, even when the same request
 * had been answered a hundred times. Caching that decision makes a repeat request fully
 * model-free, and deterministic in the same sense replay is — same request, same route,
 * every time.
 *
 * Two design decisions carry the whole thing.
 *
 * 1. THE KEY IS THE INTENT, NOT THE PROMPT.
 *
 *    "savings balance for member 100442" and "…100443" are different strings and the
 *    same route. Keying on raw text would almost never hit. So the prompt is normalised
 *    first: values matching a declared input's pattern are replaced by a placeholder.
 *
 *        "what is the savings balance for member 100442?"
 *                  ↓
 *        "what is the savings balance for member {memberId}?"
 *
 *    The parameter is re-extracted at lookup time by the same regex that defined it, so
 *    the VALUE is never written to disk — only its shape. That is not incidental: member
 *    numbers are classified `pii`, and a cache full of them would be a quiet second copy
 *    of exactly the data the redactor exists to keep out of files.
 *
 * 2. INVALIDATION IS STRUCTURAL, NOT MANUAL.
 *
 *    A cached route pointing at a capability that has since been revoked, superseded or
 *    re-approved at a different version would do the wrong thing on every repeat — worse
 *    than a one-off mistake, because it is consistent and silent. So every entry is
 *    stamped with a fingerprint of the catalog's resolved state, and any change to that
 *    state invalidates the whole cache at once. It fails closed: a miss costs one model
 *    call, which is what we were paying anyway.
 *
 * The cache short-circuits the PROPOSAL, never the checking. A hit still goes through
 * `applyGuardrails` — approval status, ParamSpec validation, policy — so a route cached
 * while a capability was approved stops working the moment it is not.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CapabilityArtifact } from '../schema/artifact.ts';
import type { ProposedRoute } from './router.ts';

export interface CacheEntry {
  /** The normalised intent this entry answers. Stored for debuggability. */
  intent: string;
  capabilityId: string;
  /** Which declared inputs the placeholders map to, in order of appearance. */
  params: string[];
  hits: number;
  lastUsed: string;
}

interface CacheFile {
  /** Fingerprint of the catalog state these entries were learned against. */
  catalogFingerprint: string;
  entries: Record<string, CacheEntry>;
}

/**
 * Identity of the catalog as the router sees it: which capabilities exist, at which
 * version, with what status and input shape. Anything that would change a routing
 * decision changes this string.
 */
export function catalogFingerprint(artifacts: CapabilityArtifact[]): string {
  const shape = artifacts
    .map((a) =>
      [
        a.capability.id,
        a.capability.version,
        a.capability.status,
        Object.keys(a.inputs).sort().join(','),
      ].join(':'),
    )
    .sort()
    .join('|');
  return createHash('sha256').update(shape).digest('hex').slice(0, 16);
}

export interface NormalisedIntent {
  /** The prompt with parameter values replaced by `{name}` placeholders. */
  intent: string;
  /** Extracted values, keyed by the input they matched. Never persisted. */
  values: Record<string, string>;
}

/**
 * Replace anything in the prompt that looks like a declared input with a placeholder.
 *
 * Longest patterns are tried first so a broad one can't swallow a value a narrower one
 * would have claimed, and each input is matched at most once — two different member
 * numbers in a single prompt is not a case this should silently collapse.
 */
export function normaliseIntent(prompt: string, artifacts: CapabilityArtifact[]): NormalisedIntent {
  let intent = prompt.toLowerCase().replace(/\s+/g, ' ').trim();
  const values: Record<string, string> = {};

  const specs = artifacts
    .flatMap((a) => Object.entries(a.inputs).map(([name, spec]) => ({ name, spec })))
    .filter((s) => s.spec.pattern)
    // A more specific pattern should claim its value before a looser one sees it.
    .sort((a, b) => (b.spec.pattern?.length ?? 0) - (a.spec.pattern?.length ?? 0));

  const claimed = new Set<string>();
  for (const { name, spec } of specs) {
    if (claimed.has(name)) continue;
    // The declared pattern is anchored; strip the anchors to search mid-string.
    const body = spec.pattern!.replace(/^\^/, '').replace(/\$$/, '');
    let re: RegExp;
    try {
      re = new RegExp(`\\b${body}\\b`);
    } catch {
      continue;
    }
    const m = re.exec(intent);
    if (!m) continue;
    values[name] = m[0];
    intent = intent.replace(m[0], `{${name}}`);
    claimed.add(name);
  }

  return { intent, values };
}

export class RouteCache {
  private file: CacheFile;

  constructor(private readonly path: string, fingerprint: string) {
    this.file = { catalogFingerprint: fingerprint, entries: {} };
    if (existsSync(path)) {
      try {
        const loaded = JSON.parse(readFileSync(path, 'utf8')) as CacheFile;
        // Any change to the catalog's resolved shape drops every entry. Cheap, and it
        // is the difference between a stale cache and a silently wrong one.
        if (loaded.catalogFingerprint === fingerprint) this.file = loaded;
      } catch {
        // A corrupt cache is a miss, never an error.
      }
    }
  }

  /**
   * Look up a route for this prompt. Returns a proposal in the same shape the model
   * would have produced, so the caller gates it identically.
   */
  lookup(prompt: string, artifacts: CapabilityArtifact[]): ProposedRoute | null {
    const { intent, values } = normaliseIntent(prompt, artifacts);
    const entry = this.file.entries[intent];
    if (!entry) return null;

    // Every placeholder the entry expects must have been filled by this prompt. A
    // request missing one is not a hit — it is a clarify, and that needs the model's
    // wording, not a cached answer to a different question.
    const inputs: Record<string, string> = {};
    for (const name of entry.params) {
      if (values[name] === undefined) return null;
      inputs[name] = values[name];
    }

    entry.hits += 1;
    entry.lastUsed = new Date().toISOString();
    this.persist();

    return {
      action: 'invoke',
      capabilityId: entry.capabilityId,
      inputs,
      // Not the model's confidence — the confidence that this is the same request as
      // one already answered, which is what an exact intent match means.
      confidence: 1,
      reason: `cached route: this intent was resolved before (${entry.hits} time(s)), no model call needed`,
    };
  }

  /** Remember a successful routing decision. Only `invoke` is worth caching. */
  remember(prompt: string, artifacts: CapabilityArtifact[], route: ProposedRoute): void {
    if (route.action !== 'invoke' || !route.capabilityId) return;
    const { intent, values } = normaliseIntent(prompt, artifacts);

    // Only cache when every input the router used came from a recognised placeholder.
    // If it inferred a value from conversation context or from prose, the intent string
    // does not fully determine the inputs, and caching it would replay the wrong value.
    const used = Object.keys(route.inputs ?? {});
    if (used.some((k) => values[k] === undefined)) return;

    this.file.entries[intent] = {
      intent,
      capabilityId: route.capabilityId,
      params: used,
      hits: 0,
      lastUsed: new Date().toISOString(),
    };
    this.persist();
  }

  get size(): number {
    return Object.keys(this.file.entries).length;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.file, null, 2) + '\n');
  }
}
