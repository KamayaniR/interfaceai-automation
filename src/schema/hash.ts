/**
 * Content addressing for artifacts.
 *
 * The problem this solves: `status: "approved"` is a mutable field living inside the
 * very document it approves. Nothing stops someone editing a step and leaving the
 * status alone, and the artifact would still replay — against a bank's core system —
 * claiming a human had signed it off.
 *
 * A content hash makes approval bind to *content* rather than to a version number.
 * Replay refuses to run an artifact whose recorded hash doesn't match what's on disk,
 * so tampering is detected before a browser is ever launched rather than discovered in
 * an audit six months later.
 *
 * The hash deliberately excludes `provenance.contentHash` itself (you cannot hash a
 * document that contains its own hash) and is computed over a canonical serialisation,
 * so key ordering and whitespace can't change it.
 */

import { createHash } from 'node:crypto';
import type { CapabilityArtifact } from './artifact.ts';

/**
 * Deterministic JSON: keys sorted at every level. Two artifacts that differ only in
 * key order are the same artifact, and must hash identically — otherwise a formatter
 * or a re-serialisation would look like tampering.
 */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalise((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** sha256 over the artifact with its own hash field removed. */
export function computeContentHash(artifact: CapabilityArtifact): string {
  const { contentHash: _omit, ...provenance } = artifact.provenance as Record<string, unknown>;
  const subject = { ...artifact, provenance };
  return 'sha256:' + createHash('sha256').update(JSON.stringify(canonicalise(subject))).digest('hex').slice(0, 32);
}

export type HashVerdict =
  | { state: 'match' }
  /** Older artifacts predate content addressing. Not an error — but reported. */
  | { state: 'absent' }
  | { state: 'mismatch'; recorded: string; actual: string };

export function verifyContentHash(artifact: CapabilityArtifact): HashVerdict {
  const recorded = (artifact.provenance as Record<string, unknown>).contentHash as string | undefined;
  if (!recorded) return { state: 'absent' };
  const actual = computeContentHash(artifact);
  return actual === recorded ? { state: 'match' } : { state: 'mismatch', recorded, actual };
}
