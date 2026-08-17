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

const raw = Number(process.env.REPLAY_PACE_MS ?? 0);

/** Milliseconds of deliberate slowdown. 0 disables it entirely. */
export const PACE_MS = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 5000) : 0;

/** Pause between steps so the previous one stays readable. No-op when pacing is off. */
export async function pace(): Promise<void> {
  if (PACE_MS > 0) await new Promise((r) => setTimeout(r, PACE_MS));
}
