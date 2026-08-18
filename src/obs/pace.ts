/**
 * Demo pacing — a presentation knob, not a correctness one.
 *
 * Replay runs at machine speed because nothing in it waits for a human: it is the same
 * determinism that makes it cheap and testable. That is exactly wrong for watching. A
 * five-step capability finishes before the eye can follow which field was filled, so the
 * live view looks like the app blinking rather than a system doing something legible.
 *
 * `REPLAY_PACE_MS` inserts deliberate delay in two places, because slowing only one is
 * still unwatchable:
 *
 *   - `slowMo` on the browser, so each click and keystroke is a visible event rather
 *     than a frame that never rendered;
 *   - a pause between steps, so a checkpoint's result is on screen long enough to read
 *     before the next step overwrites it.
 *
 * It is off by default and never read during tests or `npm run verify` — a delay that
 * changed behaviour would be a timing bug waiting to happen, so it only ever adds idle
 * time. It cannot mask a race: waiting longer never turns a failing checkpoint into a
 * passing one, since checkpoints poll to their own timeout regardless.
 */

const clamp = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.min(n, 5000) : 0);

/**
 * Settable rather than constant, because the dashboard chooses per run: the env var is
 * the default for CLI use, and a viewer watching a live session needs to change speed
 * without restarting the server. Read at browser launch, so it applies from the next run
 * onward and never mutates one already in flight.
 */
let current = clamp(Number(process.env.REPLAY_PACE_MS ?? 0));

export function paceMs(): number {
  return current;
}

export function setPaceMs(ms: number): void {
  current = clamp(ms);
}

/** Pause between steps so the previous one stays readable. No-op when pacing is off. */
export async function pace(): Promise<void> {
  if (current > 0) await new Promise((r) => setTimeout(r, current));
}
