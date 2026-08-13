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
