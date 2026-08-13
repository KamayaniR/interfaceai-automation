/**
 * The agent-facing capability catalog (stretch goal).
 *
 * This closes the loop the brief opens with: "the model discovers, the artifact becomes
 * a reusable capability, deterministic replay is how the AI agent invokes it." Without
 * this layer, an artifact is a file. With it, an artifact is a tool a calling agent can
 * discover by name and invoke with typed arguments.
 *
 * The catalog is a thin projection — it derives tool definitions from the artifacts
 * themselves, so a capability's contract cannot drift from what the agent is told about
 * it. There is no second place to update.
 *
 * It also enforces the approval gate: a `draft` capability is listed and readable, but
 * refused for unattended invocation. An LLM wrote that flow and no human has reviewed
 * it; letting an agent call it unattended against a bank's core system would undo the
 * point of recording it in the first place.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArtifact, type CapabilityArtifact } from '../schema/artifact.ts';

export interface CapabilityToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; pattern?: string }>;
    required: string[];
    additionalProperties: false;
  };
  /** Not part of the tool-calling wire format; metadata for the calling agent. */
  _meta: {
    version: number;
    status: 'draft' | 'approved';
    app: string;
    returns: Record<string, string>;
    outcomes: { code: string; description: string }[];
    invocable: boolean;
  };
}

export class Catalog {
  constructor(private readonly artifactsDir: string) {}

  /** Load every capability at its highest version. */
  list(): CapabilityArtifact[] {
    if (!existsSync(this.artifactsDir)) return [];
    const out: CapabilityArtifact[] = [];

    for (const capDir of readdirSync(this.artifactsDir, { withFileTypes: true })) {
      if (!capDir.isDirectory()) continue;
      const dir = join(this.artifactsDir, capDir.name);
      const versions = readdirSync(dir)
        .filter((f) => /^v\d+\.json$/.test(f))
        .sort((a, b) => Number(b.slice(1, -5)) - Number(a.slice(1, -5)));
      if (!versions.length) continue;
      try {
        out.push(parseArtifact(JSON.parse(readFileSync(join(dir, versions[0]!), 'utf8'))));
      } catch {
        // A malformed artifact must not take the whole catalog down. It simply isn't
        // offered — an agent cannot invoke what the catalog won't vouch for.
      }
    }
    return out;
  }

  get(capabilityId: string, version?: number): CapabilityArtifact | null {
    const dir = join(this.artifactsDir, capabilityId);
    if (!existsSync(dir)) return null;
    const file = version
      ? `v${version}.json`
      : readdirSync(dir)
          .filter((f) => /^v\d+\.json$/.test(f))
          .sort((a, b) => Number(b.slice(1, -5)) - Number(a.slice(1, -5)))[0];
    if (!file || !existsSync(join(dir, file))) return null;
    return parseArtifact(JSON.parse(readFileSync(join(dir, file), 'utf8')));
  }

  /**
   * Project an artifact into a tool definition. Every field here comes from the
   * artifact's own declared contract — nothing is hand-written per capability.
   */
  toToolDef(artifact: CapabilityArtifact): CapabilityToolDef {
    const properties: CapabilityToolDef['input_schema']['properties'] = {};
    const required: string[] = [];

    for (const [name, spec] of Object.entries(artifact.inputs)) {
      properties[name] = {
        type: spec.type,
        description:
          spec.description +
          (spec.sensitivity !== 'public' ? ` (${spec.sensitivity} — redacted in all logs)` : ''),
        pattern: spec.pattern,
      };
      if (spec.required) required.push(name);
    }

    const returns: Record<string, string> = {};
    for (const [name, spec] of Object.entries(artifact.outputs)) {
      returns[name] = `${spec.type} — ${spec.description}`;
    }

    // Tell the caller up front what non-error answers it may get back, so it can
    // branch on them rather than treating everything but success as a failure.
    const outcomeNote = artifact.outcomes.length
      ? `\n\nMay return these business outcomes instead of a result: ` +
        artifact.outcomes.map((o) => `${o.code} (${o.description})`).join('; ') + '.'
      : '';

    const draftNote =
      artifact.capability.status === 'draft'
        ? `\n\nSTATUS: draft — discovered by an LLM and not yet reviewed by a human. Not available for unattended invocation.`
        : '';

    return {
      name: artifact.capability.id.replace(/[^a-zA-Z0-9_-]/g, '_'),
      description: artifact.capability.description + outcomeNote + draftNote,
      input_schema: { type: 'object', properties, required, additionalProperties: false },
      _meta: {
        version: artifact.capability.version,
        status: artifact.capability.status,
        app: `${artifact.app.vendor}/${artifact.app.appId}`,
        returns,
        outcomes: artifact.outcomes.map((o) => ({ code: o.code, description: o.description })),
        invocable: artifact.capability.status === 'approved',
      },
    };
  }

  /** The whole catalog as tool defs — what you would hand a calling agent. */
  toolDefs(): CapabilityToolDef[] {
    return this.list().map((a) => this.toToolDef(a));
  }
}
