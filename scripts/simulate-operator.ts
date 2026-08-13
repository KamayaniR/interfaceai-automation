/**
 * Stands in for a human operator during the escalation demo.
 *
 * It attaches to the SAME live browser session the automation was using, over the CDP
 * endpoint the headed surface exposes — not a fresh browser, which is the whole point of
 * the handoff. Every click and edit it makes is a real DOM event on the real page, so it
 * exercises the actual recording path rather than injecting fake entries into the log.
 *
 * A person clicking in the visible window produces identical results; this exists so the
 * scenario can be captured reproducibly into /evidence/.
 */

import { chromium } from 'playwright';

const CDP = process.env.CDP_URL ?? 'http://localhost:9222';

const browser = await chromium.connectOverCDP(CDP);
const context = browser.contexts()[0];
if (!context) throw new Error('no browser context found at ' + CDP);

const page = context.pages()[0];
if (!page) throw new Error('no page found at ' + CDP);

// Find the frame holding the sub-account form.
const frame = page.frames().find((f) => f.url().includes('/subaccount')) ?? page.mainFrame();

console.log('operator attached to the live session:', page.url());

// What a real operator would do before approving an irreversible step: check the form,
// and correct the opening deposit.
const deposit = frame.locator('input[name="ctl_09"]');
if (await deposit.count()) {
  await deposit.click();
  await deposit.fill('25.00');
  await deposit.blur();
  console.log('operator set the initial deposit to 25.00');
}

const type = frame.locator('select[name="ctl_07"]');
if (await type.count()) {
  await type.selectOption('S3');
  console.log('operator changed the account type to S3 (Holiday Club)');
}

await browser.close();
console.log('operator finished — hand control back via the console');
