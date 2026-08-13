/**
 * Guardrails.
 *
 * The design decision that matters here is placement, not content: this is enforced
 * inside `Surface.act()`, which is the single choke point every action passes through.
 * Discovery and replay cannot diverge, and no future code path can "forget" to check,
 * because there is no other way to reach the browser.
 *
 * The second decision is that discovery runs under a stricter profile than replay.
 * During discovery an LLM is choosing actions from a page it has never seen; giving it
 * the ability to irreversibly move money is not a risk worth taking for the sake of
 * autonomy. It records the irreversible step and escalates instead. Replay executes a
 * flow that a human has read and approved, so it may perform that step — behind a
 * confirmation.
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { Action, RiskClass } from '../schema/artifact.ts';

export type RiskDisposition = 'allow' | 'confirm' | 'escalate' | 'block';
export type ProfileName = 'discovery' | 'replay';

export interface PolicyConfig {
  allowlist: { origins: string[]; paths: string[] };
  profiles: Record<ProfileName, {
    allowedActions: string[];
    risk: Record<RiskClass, RiskDisposition>;
  }>;
  redaction: {
    patterns: { name: string; regex: string; flags?: string }[];
    secretEnvVars: string[];
  };
}

export type PolicyVerdict =
  | { decision: 'allow' }
  | { decision: 'confirm'; reason: string }
  | { decision: 'escalate'; reason: string }
  | { decision: 'block'; reason: string };

export class Policy {
  constructor(
    private readonly config: PolicyConfig,
    private readonly profile: ProfileName,
  ) {}

  static load(path: string, profile: ProfileName): Policy {
    const config = parseYaml(readFileSync(path, 'utf8')) as PolicyConfig;
    return new Policy(config, profile);
  }

  get redactionConfig() {
    return this.config.redaction;
  }

  /** Is this URL inside the allowlist? Checked before any navigation. */
  checkUrl(url: string): PolicyVerdict {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { decision: 'block', reason: `malformed URL: ${url}` };
    }

    const origin = `${parsed.protocol}//${parsed.host}`;
    if (!this.config.allowlist.origins.includes(origin)) {
      return {
        decision: 'block',
        reason: `origin ${origin} is not in the allowlist (permitted: ${this.config.allowlist.origins.join(', ')})`,
      };
    }

    const paths = this.config.allowlist.paths;
    if (paths.length > 0 && !paths.some((p) => new RegExp(p).test(parsed.pathname))) {
      return { decision: 'block', reason: `path ${parsed.pathname} is not in the allowlist` };
    }

    return { decision: 'allow' };
  }

  /**
   * The full check applied to every action. Order matters: the action kind is checked
   * before the risk class, so a disallowed action type is blocked outright rather than
   * being escalated to a human who would then have to reject it manually.
   */
  checkAction(action: Action, risk: RiskClass): PolicyVerdict {
    const profile = this.config.profiles[this.profile];

    if (!profile.allowedActions.includes(action.kind)) {
      return {
        decision: 'block',
        reason: `action "${action.kind}" is not permitted under the ${this.profile} profile`,
      };
    }

    if (action.kind === 'navigate') {
      const urlVerdict = this.checkUrl(action.url);
      if (urlVerdict.decision !== 'allow') return urlVerdict;
    }

    const disposition = profile.risk[risk];
    if (disposition === 'allow') return { decision: 'allow' };

    const reason =
      `step is classified "${risk}" and the ${this.profile} profile requires "${disposition}" for that class`;
    return { decision: disposition, reason } as PolicyVerdict;
  }
}
