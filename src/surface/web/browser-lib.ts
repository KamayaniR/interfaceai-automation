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
