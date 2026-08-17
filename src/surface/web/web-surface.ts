/**
 * The web implementation of Surface, driven by Playwright.
 *
 * Playwright is used as a *driver* — it clicks, types and waits — but it is never the
 * source of truth for targeting. We do not hand it CSS selectors from the artifact.
 * Resolution happens through the accessibility-derived ladder in resolve-target.ts,
 * which tags the winning element; only then does Playwright act on it, so we still get
 * its actionability checks, auto-waiting and trusted input events.
 *
 * That split is what keeps the design portable. A desktop surface would swap Playwright
 * for UIAutomation and reuse everything above this file unchanged.
 */

import { PACE_MS } from '../../obs/pace.ts';
import { chromium, type Browser, type BrowserContext, type Page, type Frame } from 'playwright';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Surface, Observation, ObservedElement, ActResult, ControlHolder } from '../surface.ts';
import { ControlDeniedError } from '../surface.ts';
import type { Action, TargetRef, RiskClass } from '../../schema/artifact.ts';
import { buildIndexScript, type RawIndex } from './a11y-index.ts';
import { resolveTarget, describeFailure } from './resolve-target.ts';
import { TARGET_ATTR, REF_ATTR, HUMAN_ACTION_RECORDER } from './browser-lib.ts';
import { Policy } from '../../policy/policy.ts';
import type { SessionControl } from '../../escalation/broker.ts';

export interface WebSurfaceOptions {
  headed: boolean;
  policy: Policy;
  control: SessionControl;
  /** Emitted for the run log; lets the engine record what the surface did and why. */
  onEvent?: (event: { type: string; detail: Record<string, unknown> }) => void;
  /** CDP port for operator attachment when headed. */
  cdpPort?: number;
  /**
   * Receives JPEG frames (base64) from the live page. Set by a viewer that wants to
   * watch the actual session rather than a copy of the app — the distinction matters,
   * because a second browser pointed at the same URL is a different session with
   * different cookies, and during an escalation that would mislead an operator into
   * thinking they were driving the run.
   */
  onFrame?: (frame: string) => void;
}

/** Blocked by policy, as opposed to failing for an app reason. */
export class PolicyBlockedError extends Error {
  constructor(public readonly reason: string) {
    super(`blocked by policy: ${reason}`);
    this.name = 'PolicyBlockedError';
  }
}

/** The action requires a human decision before it may proceed. */
export class ConfirmationRequiredError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'ConfirmationRequiredError';
  }
}

export class WebSurface implements Surface {
  readonly kind = 'web';

  private browser!: Browser;
  private context!: BrowserContext;
  private page!: Page;
  /** Maps an ephemeral perception ref back to the frame it was found in. */
  private refFrames = new Map<number, Frame>();
  private lastObservation: Observation | null = null;

  private constructor(private readonly opts: WebSurfaceOptions) {}

  static async launch(opts: WebSurfaceOptions): Promise<WebSurface> {
    const s = new WebSurface(opts);
    // When headed, expose a CDP endpoint. That is what lets an operator surface attach
    // to THIS live session rather than opening a second browser — the whole point of
    // the handoff. It is also how scripts/simulate-operator.ts stands in for a human
    // without faking anything: its clicks are real DOM events on the real page.
    s.browser = await chromium.launch({
      headless: !opts.headed,
      // Demo pacing only; 0 in tests and in production. See obs/pace.ts.
      slowMo: PACE_MS,
      args: opts.headed ? [`--remote-debugging-port=${opts.cdpPort ?? 9222}`] : [],
    });
    s.context = await s.browser.newContext({ viewport: { width: 1280, height: 900 } });
    s.page = await s.context.newPage();
    await s.installHumanActionRecorder();
    if (opts.onFrame) await s.startScreencast(opts.onFrame);
    return s;
  }

  // -------------------------------------------------------------------------
  // Control token — the escalation invariant
  // -------------------------------------------------------------------------

  getControl(): ControlHolder {
    return this.opts.control.current;
  }

  setControl(holder: ControlHolder): void {
    if (holder === 'human') this.opts.control.cedeToHuman();
    else if (holder === 'automation') this.opts.control.returnToAutomation();
    else this.opts.control.suspend();
    this.opts.onEvent?.({ type: 'control.transfer', detail: { holder } });
  }

  /**
   * Called before every action. This is the invariant: automation physically cannot
   * act while a human holds the session.
   */
  private assertAutomationHasControl(): void {
    const holder = this.opts.control.current;
    if (holder !== 'automation') throw new ControlDeniedError(holder);
  }

  /**
   * While a human drives, capture what they do. Not a keylogger — element-level
   * semantics only, so the handoff is auditable and could later inform a revised
   * artifact ("the operator always has to tick this box first").
   */
  private async installHumanActionRecorder(): Promise<void> {
    await this.context.exposeBinding('__cuaRecordHumanAction', (_src, payload: unknown) => {
      const p = payload as { kind: string; detail: string };
      this.opts.control.recordHumanAction({
        at: new Date().toISOString(),
        kind: p.kind,
        detail: p.detail,
      });
    });

    await this.context.addInitScript({ content: HUMAN_ACTION_RECORDER });
  }

  /**
   * Stream the live page over CDP.
   *
   * Read-only by design. Watching is safe; acting is not, because the control token
   * says who may act and a viewer that could click would route around it. Taking over
   * still means driving the headed window, which is the same session either way.
   */
  private async startScreencast(onFrame: (frame: string) => void): Promise<void> {
    try {
      const cdp = await this.context.newCDPSession(this.page);
      await cdp.send('Page.enable');
      cdp.on('Page.screencastFrame', async (f: { data: string; sessionId: number }) => {
        onFrame(f.data);
        // Must ack or Chrome stops sending.
        await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      });
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 70,
        // Match the browser viewport (1280x900) rather than downscaling — the pane
        // scales it down in CSS, which looks far better than upscaling a small capture.
        maxWidth: 1280,
        maxHeight: 900,
        everyNthFrame: 1,
      });
    } catch {
      // A viewer is a convenience. If the screencast can't start, the run continues.
    }
  }

  // -------------------------------------------------------------------------
  // Perception
  // -------------------------------------------------------------------------

  /** Depth-first walk of the frame tree, yielding [frame, framePath] pairs. */
  private walkFrames(): { frame: Frame; path: string[] }[] {
    const out: { frame: Frame; path: string[] }[] = [];
    const visit = (frame: Frame, path: string[]) => {
      out.push({ frame, path });
      for (const child of frame.childFrames()) {
        visit(child, [...path, child.name() || 'frame']);
      }
    };
    visit(this.page.mainFrame(), []);
    return out;
  }

  async perceive(): Promise<Observation> {
    // Perception is a read. It deliberately does NOT assert the control token — the
    // operator console needs to screenshot and describe a live session that a human
    // currently holds.
    const elements: ObservedElement[] = [];
    const text: { framePath: string[]; content: string }[] = [];
    this.refFrames.clear();

    let nextRef = 1;
    for (const { frame, path } of this.walkFrames()) {
      let raw: RawIndex;
      try {
        raw = (await frame.evaluate(buildIndexScript(nextRef))) as RawIndex;
      } catch {
        // A frame can navigate out from under us mid-walk. Skip it rather than
        // failing the whole observation.
        continue;
      }
      nextRef = raw.nextRef;

      for (const el of raw.elements) {
        this.refFrames.set(el.ref, frame);
        elements.push({ ...el, framePath: path });
      }
      if (raw.text) text.push({ framePath: path, content: raw.text });
    }

    const obs: Observation = {
      url: this.page.url(),
      title: await this.page.title().catch(() => ''),
      elements,
      text,
      capturedAt: new Date().toISOString(),
    };
    this.lastObservation = obs;
    return obs;
  }

  /** All visible text across every frame — used by checkpoints and condition matchers. */
  async allText(): Promise<string> {
    const obs = await this.perceive();
    return obs.text.map((t) => t.content).join('\n');
  }

  get currentUrl(): string {
    return this.page.url();
  }

  // -------------------------------------------------------------------------
  // Acting
  // -------------------------------------------------------------------------

  /**
   * `humanApproved` is set only after an operator has actually taken control of this
   * session, seen the step, and resumed. It satisfies a `confirm` verdict for that one
   * retry — without it, the retry after a handoff would hit the same gate and escalate
   * forever.
   *
   * It deliberately does NOT satisfy `block` or `escalate`. A blocked action is outside
   * the allowlist entirely, and `escalate` (the discovery profile's treatment of
   * irreversible steps) means "a model may never run this", which no in-band approval
   * should be able to override.
   */
  private gate(action: Action, risk: RiskClass, humanApproved = false): void {
    this.assertAutomationHasControl();
    const verdict = this.opts.policy.checkAction(action, risk);
    this.opts.onEvent?.({
      type: 'policy.check',
      detail: { action: action.kind, risk, decision: verdict.decision, humanApproved },
    });
    if (verdict.decision === 'block') throw new PolicyBlockedError(verdict.reason);
    if (verdict.decision === 'confirm' && humanApproved) return;
    if (verdict.decision === 'confirm' || verdict.decision === 'escalate') {
      throw new ConfirmationRequiredError(verdict.reason);
    }
  }

  /** Discovery path: act on an element the model referenced by ref. */
  async actByRef(action: Action, ref: number | null, risk: RiskClass = 'safe'): Promise<ActResult> {
    this.gate(action, risk);

    if (action.kind === 'navigate') return this.doNavigate(action.url);

    if (ref === null) return { ok: false, error: 'action requires an element ref but none was given' };
    const frame = this.refFrames.get(ref);
    if (!frame) return { ok: false, error: `ref ${ref} is not from the current observation` };

    const locator = frame.locator(`[${REF_ATTR}="${ref}"]`);
    return this.performOn(frame, locator, action);
  }

  /** Replay path: act on an element resolved through the durable TargetRef ladder. */
  async actByTarget(
    action: Action,
    target: TargetRef | null,
    risk: RiskClass = 'safe',
    humanApproved = false,
  ): Promise<ActResult> {
    this.gate(action, risk, humanApproved);

    if (action.kind === 'navigate') return this.doNavigate(action.url);

    if (!target) return { ok: false, error: 'action requires a target but none was recorded' };

    const frame = this.findFrame(target.framePath);
    if (!frame) {
      return { ok: false, error: `frame [${target.framePath.join(' > ')}] not found on the page` };
    }

    const outcome = await resolveTarget(frame, target);
    if (!outcome.found) {
      return { ok: false, error: describeFailure(target, outcome) };
    }

    const locator = frame.locator(`[${TARGET_ATTR}="1"]`);
    const result = await this.performOn(frame, locator, action);
    return {
      ...result,
      resolution: {
        candidateIndex: outcome.candidateIndex,
        strategy: outcome.strategy,
        fingerprintMismatch: outcome.fingerprintMismatch,
      },
    };
  }

  private findFrame(path: string[]): Frame | null {
    for (const { frame, path: p } of this.walkFrames()) {
      if (p.length === path.length && p.every((seg, i) => seg === path[i])) return frame;
    }
    return null;
  }

  private async doNavigate(url: string): Promise<ActResult> {
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `navigation to ${url} failed: ${(err as Error).message}` };
    }
  }

  /**
   * Wait for the frame that was acted on to finish navigating.
   *
   * Subtle and important in a frameset: waiting on the PAGE's load state is useless
   * here, because the page is the frameset document and it is already loaded. A click
   * inside a child frame navigates only that frame, so the wait has to be on the frame
   * itself. Getting this wrong makes the caller inspect the previous document, which
   * shows up as an exceptional condition being "missed" and then rediscovered by a
   * checkpoint timeout — a real failure mode that costs a full timeout per step.
   */
  private async settle(frame: Frame, urlBefore: string): Promise<void> {
    // Wait for the document to actually be replaced, not just for a load state.
    // `click()` returns as soon as the click dispatches; the navigation it triggers may
    // not have STARTED yet, so an immediate waitForLoadState sees the *old* document
    // sitting there fully loaded and returns instantly. Polling the frame URL is the
    // reliable signal that we are looking at the next page.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && frame.url() === urlBefore) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await frame.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
  }

  private async performOn(
    frame: Frame,
    locator: import('playwright').Locator,
    action: Action,
  ): Promise<ActResult> {
    const urlBefore = frame.url();
    try {
      switch (action.kind) {
        case 'click':
          await locator.click({ timeout: 10_000 });
          await this.settle(frame, urlBefore);
          return { ok: true };

        case 'type':
          if (action.clearFirst) await locator.fill('', { timeout: 10_000 });
          await locator.fill(action.value, { timeout: 10_000 });
          return { ok: true };

        case 'select':
          await locator.selectOption(action.value, { timeout: 10_000 });
          return { ok: true };

        case 'press':
          await locator.press(action.key, { timeout: 10_000 });
          await this.settle(frame, urlBefore);
          return { ok: true };

        case 'extract': {
          const raw =
            action.from === 'value'
              ? ((await locator.inputValue({ timeout: 10_000 })) ?? '')
              : ((await locator.textContent({ timeout: 10_000 })) ?? '');
          const cleaned = raw.replace(/\s+/g, ' ').trim();
          if (!action.pattern) return { ok: true, extracted: cleaned };
          const m = new RegExp(action.pattern).exec(cleaned);
          if (!m) {
            return {
              ok: false,
              error: `extract pattern /${action.pattern}/ did not match observed text "${cleaned}"`,
            };
          }
          return { ok: true, extracted: m[1] ?? m[0] };
        }

        case 'assert':
          return { ok: (await locator.count()) === 1 };

        default:
          return { ok: false, error: `unsupported action kind` };
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message.split('\n')[0] };
    }
  }

  // -------------------------------------------------------------------------
  // Evidence
  // -------------------------------------------------------------------------

  async screenshot(path: string): Promise<void> {
    mkdirSync(dirname(path), { recursive: true });
    await this.page.screenshot({ path, fullPage: true }).catch(() => {});
  }

  async snapshotDom(path: string): Promise<void> {
    mkdirSync(dirname(path), { recursive: true });
    const parts: string[] = [];
    for (const { frame, path: p } of this.walkFrames()) {
      const html = await frame.content().catch(() => '');
      parts.push(`<!-- frame: ${p.join(' > ') || '(main)'} -->\n${html}`);
    }
    writeFileSync(path, parts.join('\n\n'));
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
  }

  /** Escape hatch used only by the operator console to point a human at the session. */
  get rawPage(): Page {
    return this.page;
  }
}
