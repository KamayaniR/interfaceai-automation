/**
 * Perception pass: turn one frame's DOM into the numbered element index the model sees.
 *
 * The model is shown lines like:
 *
 *     [12] textbox "Member Number"        (frame: content)
 *     [13] button  "Search"               (frame: content)
 *
 * and acts by ref. It never sees — and therefore cannot invent — a CSS selector. The
 * durable locator is synthesised later, by the recorder, from these same descriptors.
 */

import { BROWSER_HELPERS, REF_ATTR } from './browser-lib.ts';

export interface RawElement {
  ref: number;
  role: string;
  name: string;
  value?: string;
  tagName: string;
  inputType?: string;
  attrs: Record<string, string>;
  formIndex: number;
  controlIndex: number;
  labelHint?: string;
  disabled: boolean;
}

export interface RawIndex {
  elements: RawElement[];
  nextRef: number;
  text: string;
}

/** Source of the in-page perception function. Returns a RawIndex. */
export function buildIndexScript(startRef: number): string {
  return `(() => {
    ${BROWSER_HELPERS}
    const REF_ATTR = ${JSON.stringify(REF_ATTR)};
    let nextRef = ${startRef};

    const forms = Array.prototype.slice.call(document.querySelectorAll('form'));
    const out = [];

    for (const el of allControls()) {
      const ref = nextRef++;
      el.setAttribute(REF_ATTR, String(ref));

      const form = el.closest('form');
      const formIndex = form ? forms.indexOf(form) : -1;
      const scope = form || document;
      const siblings = Array.prototype.slice.call(scope.querySelectorAll(CONTROL_SELECTOR));

      // A password field's value is never read into the index. Nothing downstream —
      // log, artifact or model context — can leak what it can never see.
      const isPassword = (el.getAttribute('type') || '').toLowerCase() === 'password';

      out.push({
        ref,
        role: roleOf(el),
        name: nameOf(el),
        value: !isPassword && el.value !== undefined ? String(el.value) : undefined,
        tagName: el.tagName.toLowerCase(),
        inputType: el.getAttribute('type') || undefined,
        attrs: fingerprintOf(el).attrs,
        formIndex,
        controlIndex: siblings.indexOf(el),
        labelHint: tableLabel(el) || undefined,
        disabled: !!el.disabled,
      });
    }

    // Labelled read-only values are part of the interface too.
    //
    // A control-only index is a real gap: in these screens the thing the caller
    // actually WANTS — a balance, a status, an account number — is plain text in a
    // table cell, not an input. Without a ref for it, a model can see the value in the
    // page text and have no way to point at it. (It cost a discovery run: the model
    // spent 20 steps probing for a ref that did not exist.) Screen readers expose
    // static text for exactly this reason.
    for (const cell of Array.prototype.slice.call(document.querySelectorAll('td, th'))) {
      if (!isVisible(cell)) continue;
      if (cell.querySelector(CONTROL_SELECTOR)) continue;   // it's a container, not a value
      const value = norm(cell.textContent);
      if (!value || value.length > 200) continue;           // not a field value
      const label = tableLabel(cell);
      if (!label) continue;                                 // unlabelled text is page chrome

      const ref = nextRef++;
      cell.setAttribute(REF_ATTR, String(ref));
      out.push({
        ref,
        role: 'text',
        name: label,
        value,
        tagName: cell.tagName.toLowerCase(),
        inputType: undefined,
        attrs: {},
        formIndex: -1,
        controlIndex: -1,
        labelHint: label,
        disabled: false,
      });
    }

    return {
      elements: out,
      nextRef,
      text: norm(document.body ? document.body.innerText : ''),
    };
  })()`;
}

/** Render the index as the compact text block the model actually reads. */
export function renderIndex(
  elements: { ref: number; role: string; name: string; value?: string; framePath: string[]; disabled: boolean }[],
): string {
  if (elements.length === 0) return '(no interactive controls found)';
  return elements
    .map((e) => {
      const frame = e.framePath.length ? `  (frame: ${e.framePath.join(' > ')})` : '';
      const val = e.value ? `  value="${e.value}"` : '';
      const dis = e.disabled ? '  [disabled]' : '';
      return `[${e.ref}] ${e.role.padEnd(9)} "${e.name}"${val}${dis}${frame}`;
    })
    .join('\n');
}
