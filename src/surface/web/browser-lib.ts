/**
 * Browser-side helpers, shared by the perception pass and the target resolver.
 *
 * These are injected as source text rather than imported, because they execute inside
 * the page. Perception and resolution MUST agree on how a role and an accessible name
 * are computed — if they disagree, a target recorded by name during discovery becomes
 * unfindable during replay. Sharing the source is the only way to guarantee that.
 */

export const REF_ATTR = '__cua_ref';
export const TARGET_ATTR = '__cua_target';

export const BROWSER_HELPERS = `
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();

  function isVisible(el) {
    const st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      return 'textbox';
    }
    return 'generic';
  }

  /**
   * Legacy table labelling: the cell to the left, else the header cell above.
   * This is what makes <td>Member Number</td><td><input></td> addressable by name.
   */
  function tableLabel(el) {
    const cell = el.closest('td, th');
    if (!cell) return '';
    let prev = cell.previousElementSibling;
    while (prev) {
      const txt = norm(prev.textContent);
      if (txt && !prev.querySelector('input, select, textarea, button, a')) return txt;
      prev = prev.previousElementSibling;
    }
    const row = cell.parentElement;
    const table = cell.closest('table');
    if (row && table && table.rows) {
      const colIdx = Array.prototype.indexOf.call(row.children, cell);
      const firstRow = table.rows[0];
      if (firstRow && firstRow !== row && firstRow.children[colIdx]) {
        const txt = norm(firstRow.children[colIdx].textContent);
        if (txt) return txt;
      }
    }
    return '';
  }

  function nameOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return norm(aria);

    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const parts = labelledby.split(/\\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => norm(n.textContent));
      if (parts.length) return parts.join(' ');
    }

    if (el.id) {
      const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lbl) return norm(lbl.textContent);
    }

    const wrapping = el.closest('label');
    if (wrapping) return norm(wrapping.textContent);

    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();

    if (tag === 'button' || tag === 'a') {
      const t = norm(el.textContent);
      if (t) return t;
    }
    if (tag === 'input' && (type === 'submit' || type === 'button' || type === 'reset')) {
      const v = el.getAttribute('value');
      if (v) return norm(v);
    }

    const tl = tableLabel(el);
    if (tl) return tl;

    const ph = el.getAttribute('placeholder');
    if (ph) return norm(ph);
    const title = el.getAttribute('title');
    if (title) return norm(title);
    return norm(el.getAttribute('name') || '');
  }

  const CONTROL_SELECTOR = 'input, select, textarea, button, a[href], [role="button"]';

  function allControls() {
    return Array.prototype.slice.call(document.querySelectorAll(CONTROL_SELECTOR))
      .filter((el) => {
        const t = (el.getAttribute('type') || '').toLowerCase();
        return t !== 'hidden' && isVisible(el);
      });
  }

  function fingerprintOf(el) {
    const KEEP = ['name', 'type', 'href'];
    const attrs = {};
    for (const a of KEEP) {
      const v = el.getAttribute(a);
      if (v !== null) attrs[a] = v;
    }
    return {
      tagName: el.tagName.toLowerCase(),
      inputType: el.getAttribute('type') || undefined,
      attrs,
    };
  }
`;

/**
 * Records what a human does while they hold the session.
 *
 * Shipped as SOURCE TEXT, like everything else in this file, and that is load-bearing
 * rather than stylistic. Passing a *function* to `addInitScript` looks equivalent but
 * is not: the bundler rewrites function declarations to preserve their names, and
 * Playwright serialises the function with `.toString()` — so the rewritten body arrives
 * in the browser referencing a helper (`__name`) that exists only in the Node bundle.
 * It throws on the first line and every listener after it is silently never registered.
 * A string is transpiled by nobody and means exactly what it says.
 *
 * Element-level semantics only — never keystrokes, and never the value of a password
 * field. The point is an auditable record of what the operator did, not surveillance.
 */
export const HUMAN_ACTION_RECORDER = `
  (function () {
    function describe(el) {
      var tag = el.tagName ? el.tagName.toLowerCase() : 'node';
      var name = el.getAttribute && (el.getAttribute('name') || el.getAttribute('aria-label'));
      if (!name) name = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
      return tag + (name ? '[' + name + ']' : '');
    }

    function send(kind, detail) {
      if (window.__cuaRecordHumanAction) window.__cuaRecordHumanAction({ kind: kind, detail: detail });
    }

    document.addEventListener('click', function (e) {
      if (e.target) send('click', describe(e.target));
    }, true);

    document.addEventListener('change', function (e) {
      var t = e.target;
      if (!t) return;
      var isSecret = (t.getAttribute && (t.getAttribute('type') || '').toLowerCase()) === 'password';
      send('change', describe(t) + ' = ' + (isSecret ? '[REDACTED]' : (t.value || '').slice(0, 40)));
    }, true);

    window.__cuaListenersReady = true;
  })();
`;
