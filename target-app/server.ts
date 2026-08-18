/**
 * MERIDIAN CU — "CoreVue 7.2" back-office console.
 *
 * A deliberately hostile stand-in for the real thing. This is not a straw man: every
 * unpleasant property here was chosen because it appears in the legacy applications
 * the brief describes, and because it breaks a naive automation approach.
 *
 *   - Frameset layout. Content lives in a child frame, so any target that doesn't
 *     record which frame it's in is not reproducible.
 *   - Table-based layout with nested tables for alignment.
 *   - No <label for>. Label and input are sibling <td>s and nothing links them.
 *   - No test ids, no semantic classes. Control names are `f_01`, `ctl_07`.
 *   - Server-rendered, full page reloads, session cookie.
 *
 * It also injects faults on demand. Waiting for a real session timeout to happen by
 * luck is not a test strategy — `?_fault=timeout` makes the exceptional path a
 * first-class, reproducible thing we can put in /evidence/.
 */

import express from 'express';
import type { Request, Response } from 'express';

const app = express();
const PORT = Number(process.env.TARGET_APP_PORT ?? 3100);

app.use(express.urlencoded({ extended: false }));

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

interface Member {
  id: string;
  name: string;
  status: string;
  savings: string;
  checking: string;
  /** Simulates a member whose record this operator's role can't open. */
  restricted?: boolean;
}

const MEMBERS: Record<string, Member> = {
  '100442': { id: '100442', name: 'ALVAREZ, ROSA M', status: 'ACTIVE', savings: '4,182.55', checking: '912.03' },
  '100443': { id: '100443', name: 'OKONKWO, DANIEL', status: 'ACTIVE', savings: '17,420.00', checking: '2,004.18' },
  '100501': { id: '100501', name: 'REDACTED HOLDINGS LLC', status: 'ACTIVE', savings: '0.00', checking: '0.00', restricted: true },
};

/** In-memory sessions. A real core would use the mainframe's session table. */
const sessions = new Set<string>();

/** Faults are sticky per-session so a redirect chain keeps the injected condition. */
const stickyFaults = new Map<string, string>();

/**
 * The session-expiry fault fires EXACTLY ONCE, on the member-lookup request.
 *
 * That is both realistic and necessary. Realistic: a session expires at one moment
 * mid-flow, not on every request. Necessary: a fault that re-fires forever makes
 * re-authentication recovery impossible by construction, so it would test nothing.
 */
let sessionExpiryBudget = 0;
/**
 * How many times the app will 500 before healing. One, so a single bounded retry rides
 * it out — the transient case, which is what a 500 usually is. Armed at sign-on, like
 * the expiry budget, so the recovery is reachable on demand rather than by luck.
 *
 * `apperror-hard` arms a budget larger than any artifact's `maxAttempts`, which is how
 * the OTHER half of the taxonomy — an app that stays broken, i.e. `recovery_exhausted`
 * — is reproducible too. Same condition, opposite disposition, decided by evidence.
 */
let appErrorBudget = 0;
/** Once it has fired, it never re-arms — otherwise the recovery's own re-login would
 *  re-trigger it and the retry could never converge. Resets on server restart. */
let sessionExpiryFired = false;

// ---------------------------------------------------------------------------
// Fault injection
// ---------------------------------------------------------------------------

type Fault =
  | 'notfound' | 'validation' | 'permdenied' | 'timeout' | 'dialog' | 'slow'
  | 'apperror' | 'apperror-hard' | '';

function faultFor(req: Request): Fault {
  const q = String(req.query._fault ?? '');
  if (q) return q as Fault;
  const sid = req.headers.cookie?.match(/cvsid=([^;]+)/)?.[1];
  if (sid && stickyFaults.has(sid)) return stickyFaults.get(sid) as Fault;
  return '';
}

/** Preserve an injected fault across the app's own redirects and form posts. */
function carry(req: Request, path: string): string {
  const f = String(req.query._fault ?? '');
  return f ? `${path}${path.includes('?') ? '&' : '?'}_fault=${f}` : path;
}

// ---------------------------------------------------------------------------
// Chrome — the deliberately unhelpful markup
// ---------------------------------------------------------------------------

const STYLE = `
  body { font-family: Verdana, Geneva, sans-serif; font-size: 11px; background: #d4d0c8; margin: 0; }
  table { border-collapse: collapse; }
  .hdr { background: #003366; color: #fff; padding: 6px 10px; font-weight: bold; font-size: 12px; }
  .panel { background: #fff; border: 2px inset #d4d0c8; margin: 8px; padding: 0; }
  .panel td { padding: 4px 8px; }
  .lbl { background: #ececec; font-weight: bold; white-space: nowrap; }
  .err { color: #a00; font-weight: bold; padding: 6px 10px; background: #ffe8e8; border: 1px solid #a00; margin: 8px; }
  .ok { color: #060; font-weight: bold; }
  input[type=text], input[type=password] { border: 1px inset #808080; font-family: inherit; font-size: 11px; }
  input[type=submit] { font-family: inherit; font-size: 11px; padding: 1px 10px; }
  a { color: #003366; }
`;

/** Note: no <main>, no landmarks, no headings hierarchy. Tables all the way down. */
function chrome(title: string, body: string): string {
  return `<!doctype html>
<html><head><title>${title}</title><style>${STYLE}</style></head>
<body>
<table width="100%" cellspacing="0"><tr><td class="hdr">CoreVue 7.2 &nbsp;&mdash;&nbsp; ${title}</td></tr></table>
${body}
</body></html>`;
}

function requireSession(req: Request, res: Response): boolean {
  const sid = req.headers.cookie?.match(/cvsid=([^;]+)/)?.[1];
  const fault = faultFor(req);

  // Session/timeout expiry: the classic legacy behaviour — silently bounce to login
  // mid-flow, losing whatever the operator was doing. Scoped to the lookup request so
  // it lands in the middle of the flow rather than at sign-on.
  if (fault === 'timeout' && sid && sessions.has(sid) && req.path === '/member' && sessionExpiryBudget > 0) {
    sessionExpiryBudget = 0;
    sessionExpiryFired = true;
    sessions.delete(sid);
    res.redirect(carry(req, '/login?expired=1'));
    return false;
  }
  if (!sid || !sessions.has(sid)) {
    res.redirect(carry(req, '/login?expired=1'));
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Frameset entry point. Automation must descend into the `content` frame. */
app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html>
<html><head><title>CoreVue 7.2</title></head>
<frameset rows="46,*" frameborder="1" border="1">
  <frame name="nav" src="${carry(req, '/nav')}" scrolling="no">
  <frame name="content" src="${carry(req, '/login')}">
</frameset>
</html>`);
});

app.get('/nav', (req, res) => {
  res.type('html').send(`<!doctype html>
<html><head><style>${STYLE}</style></head><body style="background:#003366">
<table width="100%"><tr>
  <td class="hdr">MERIDIAN CU &nbsp;|&nbsp; CoreVue 7.2</td>
  <td class="hdr" align="right">
    <a href="${carry(req, '/search')}" target="content" style="color:#cfe2ff">Member Lookup</a>
  </td>
</tr></table>
</body></html>`);
});

// --- Login -----------------------------------------------------------------

app.get('/login', (req, res) => {
  const expired = req.query.expired
    ? `<div class="err">Your session has expired. Please sign in again.</div>`
    : '';
  res.type('html').send(chrome('Sign On', `
${expired}
<div class="panel"><table cellspacing="0">
  <tr><td colspan="2"><b>Operator Sign On</b></td></tr>
  <tr>
    <td class="lbl">Operator ID</td>
    <td><input type="text" name="f_01" size="18"></td>
  </tr>
  <tr>
    <td class="lbl">Password</td>
    <td><input type="password" name="f_02" size="18"></td>
  </tr>
  <tr><td colspan="2" align="right">
    <form method="post" action="${carry(req, '/login')}" id="frm">
      <input type="submit" value="Sign On">
    </form>
  </td></tr>
</table></div>
<script>
  // Legacy quirk: the inputs live outside the form and are copied in on submit.
  // Nothing about this markup is automation-friendly, which is the point.
  document.getElementById('frm').addEventListener('submit', function(e){
    var f = e.target;
    [['f_01'],['f_02']].forEach(function(p){
      var src = document.getElementsByName(p[0])[0];
      var h = document.createElement('input');
      h.type='hidden'; h.name=p[0]; h.value=src.value; f.appendChild(h);
    });
  });
</script>
`));
});

app.post('/login', (req, res) => {
  const sid = Math.random().toString(36).slice(2);
  sessions.add(sid);
  const f = String(req.query._fault ?? '');
  if (f && f !== 'timeout') stickyFaults.set(sid, f);
  // Arm a single expiry on the first sign-on only. The recovery re-signs-on, and by
  // then the budget is spent, so the retry can actually succeed.
  if (f === 'timeout' && !sessionExpiryFired) sessionExpiryBudget = 1;
  if (f === 'apperror') appErrorBudget = 1;
  if (f === 'apperror-hard') appErrorBudget = 99;
  res.setHeader('Set-Cookie', `cvsid=${sid}; Path=/`);
  res.redirect(carry(req, '/search'));
});

// --- Member search ---------------------------------------------------------

app.get('/search', (req, res) => {
  if (!requireSession(req, res)) return;
  const msg = String(req.query.msg ?? '');
  const banner = msg === 'notfound'
    ? `<div class="err">No member record found matching that number.</div>`
    : msg === 'invalid'
    ? `<div class="err">Member Number must be exactly 6 digits.</div>`
    : '';

  res.type('html').send(chrome('Member Lookup', `
${banner}
<form method="get" action="${carry(req, '/member')}">
${String(req.query._fault ?? '') ? `<input type="hidden" name="_fault" value="${req.query._fault}">` : ''}
<div class="panel"><table cellspacing="0">
  <tr><td colspan="2"><b>Member Lookup</b></td></tr>
  <tr>
    <!-- No <label for>. The only link between these two cells is that they're adjacent. -->
    <td class="lbl">Member Number</td>
    <td><input type="text" name="f_mbr" size="14" maxlength="6"></td>
  </tr>
  <tr><td colspan="2" align="right"><input type="submit" value="Search"></td></tr>
</table></div>
</form>
`));
});

// --- Member detail ---------------------------------------------------------

app.get('/member', async (req, res) => {
  if (!requireSession(req, res)) return;
  const fault = faultFor(req);
  const raw = String(req.query.f_mbr ?? '').trim();

  // Transient slowness. Bounded recovery (wait/retry) should ride this out.
  if (fault === 'slow') await new Promise((r) => setTimeout(r, 6000));

  // The app itself falling over: a 500 with a stack-trace page, the way a real legacy
  // system fails. Distinct from every condition above, because those are the app WORKING
  // and telling you something. This one is the app broken right now, so the correct
  // response is bounded retry — and, unlike the others, the same request may well
  // succeed a moment later. `appErrorBudget` makes that true, so recovery is possible
  // by construction rather than only in theory.
  if ((fault === 'apperror' || fault === 'apperror-hard') && appErrorBudget > 0) {
    appErrorBudget -= 1;
    return res.status(500).type('html').send(chrome('Server Error', `
<div class="err">HTTP 500 — Internal Server Error<br><br>
CoreVue.Data.SqlSessionException: connection reset by peer<br>
&nbsp;&nbsp;at CoreVue.Member.DetailController.Load(String memberNo)<br>
&nbsp;&nbsp;at CoreVue.Web.Dispatcher.Invoke(HttpContext ctx)<br><br>
Reference: ERR-7731-A. If this persists, contact the CoreVue administrator.</div>
`));
  }

  // Field-level validation error — a business condition, not a crash.
  if (fault === 'validation' || (raw && !/^\d{6}$/.test(raw))) {
    return res.redirect(carry(req, '/search?msg=invalid'));
  }

  const member = MEMBERS[raw];

  // "Record not found" — a legitimate ANSWER the caller needs, not a failure.
  if (fault === 'notfound' || !member) {
    return res.redirect(carry(req, '/search?msg=notfound'));
  }

  // Permission denial — a hard stop. The operator's role can't open this record.
  if (fault === 'permdenied' || member.restricted) {
    return res.type('html').send(chrome('Access Denied', `
<div class="err">SEC-0412: You are not authorized to view this member record.
Contact your security administrator.</div>
`));
  }

  // An unexpected interstitial the operator has to dismiss before the real screen.
  // `_ack` is how the dismissal sticks — without honouring it the interstitial would
  // reappear forever and no recovery could ever clear it.
  if (fault === 'dialog' && !req.query._ack) {
    return res.type('html').send(chrome('Notice', `
<div class="panel"><table cellspacing="0">
  <tr><td><b>System Notice</b></td></tr>
  <tr><td>Scheduled maintenance window begins at 23:00 ET. Unsaved work will be lost.</td></tr>
  <tr><td align="right">
    <a href="${carry(req, `/member?f_mbr=${raw}&_ack=1`)}">Acknowledge</a>
  </td></tr>
</table></div>
`));
  }

  res.type('html').send(chrome('Member Detail', `
<div class="panel"><table cellspacing="0" width="520">
  <tr><td colspan="2"><b>Member Detail</b></td></tr>
  <tr><td class="lbl">Member Number</td><td>${member.id}</td></tr>
  <tr><td class="lbl">Name</td><td>${member.name}</td></tr>
  <tr><td class="lbl">Status</td><td class="ok">${member.status}</td></tr>
</table></div>

<div class="panel"><table cellspacing="0" width="520">
  <tr><td colspan="2"><b>Share Accounts</b></td></tr>
  <!-- Balances rendered as bare text in a table cell: no id, no class, no data-* -->
  <tr><td class="lbl">Savings (S1) Current Balance</td><td>$${member.savings}</td></tr>
  <tr><td class="lbl">Checking (D1) Current Balance</td><td>$${member.checking}</td></tr>
</table></div>

<div class="panel"><table cellspacing="0" width="520">
  <tr><td><a href="${carry(req, `/subaccount?f_mbr=${member.id}`)}">Open New Sub-Account</a></td></tr>
</table></div>
`));
});

// --- Sub-account creation (irreversible) -----------------------------------

app.get('/subaccount', (req, res) => {
  if (!requireSession(req, res)) return;
  const mbr = String(req.query.f_mbr ?? '');
  res.type('html').send(chrome('Open Sub-Account', `
<form method="post" action="${carry(req, '/subaccount')}">
<input type="hidden" name="f_mbr" value="${mbr}">
<div class="panel"><table cellspacing="0" width="520">
  <tr><td colspan="2"><b>Open New Sub-Account</b> &mdash; Member ${mbr}</td></tr>
  <tr><td class="lbl">Account Type</td><td>
    <select name="ctl_07">
      <option value="S2">S2 - Secondary Savings</option>
      <option value="S3">S3 - Holiday Club</option>
    </select>
  </td></tr>
  <tr><td class="lbl">Initial Deposit</td><td><input type="text" name="ctl_09" size="12" value="0.00"></td></tr>
  <tr><td colspan="2" align="right">
    <input type="submit" value="Create Account">
  </td></tr>
</table></div>
</form>
`));
});

app.post('/subaccount', (req, res) => {
  if (!requireSession(req, res)) return;
  const mbr = String(req.body.f_mbr ?? '');
  const type = String(req.body.ctl_07 ?? 'S2');
  const acct = `${mbr}-${type}`;
  res.type('html').send(chrome('Confirmation', `
<div class="panel"><table cellspacing="0" width="520">
  <tr><td colspan="2"><b>Sub-Account Created</b></td></tr>
  <tr><td class="lbl">New Account Number</td><td class="ok">${acct}</td></tr>
  <tr><td class="lbl">Member Number</td><td>${mbr}</td></tr>
  <tr><td colspan="2">Account opened successfully.</td></tr>
</table></div>
`));
});

app.listen(PORT, () => {
  console.log(`CoreVue 7.2 (target app) listening on http://localhost:${PORT}`);
  console.log(`Faults: ?_fault=notfound|validation|permdenied|timeout|dialog|slow`);
});
