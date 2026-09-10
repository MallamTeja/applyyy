// Reads the fillable fields out of a live ATS application form.
//
// Built against a REAL captured Greenhouse form (worker/fixtures/greenhouse/),
// which disproved the obvious design. Modern Greenhouse boards carry NO `name`
// attributes; fields are keyed by `id`, and custom questions get opaque numeric
// ids such as question_36622854002 whose meaning exists only in `aria-label`.
// So identification here is accessibility-tree-driven, exactly as a screen
// reader would do it — which is also the most portable approach across ATS
// vendors and directly serves constraint #12 (no single brittle scraper).
import type { Page } from 'playwright';

/** One fillable control on an application form. */
export interface FormField {
  // The DOM id, used to build a selector when filling. Opaque for custom
  // questions, which is precisely why `label` exists separately.
  readonly id: string;
  // The human-readable question, recovered from the accessibility tree. This is
  // the key the answer bank is looked up by.
  readonly label: string;
  // Normalised control kind. `combobox` covers React-select widgets, which are
  // NOT native <select> elements and cannot be driven by selectOption().
  readonly kind: 'text' | 'email' | 'tel' | 'file' | 'textarea' | 'combobox';
  // Whether leaving this blank blocks submission. Drives the difference between
  // "skip it" and "route the row to blocked_needs_human" (constraint #4).
  readonly required: boolean;
}

export async function extractFields(page: Page): Promise<FormField[]> {
  // The traversal runs inside the browser because label resolution needs the
  // live DOM: aria-labelledby points at other elements, and <label for=...>
  // requires a document-wide lookup that is far cheaper in-page than by
  // round-tripping every candidate element across the CDP boundary.
  return page.evaluate(() => {
    // Every control an applicant could conceivably fill.
    const elements = Array.from(
      document.querySelectorAll<HTMLElement>('input, textarea, select'),
    );

    // Accumulator; built imperatively so unlabelled controls can be skipped
    // outright rather than filtered out of a mapped array afterwards.
    const fields: FormField[] = [];

    for (const element of elements) {
      // Sentinel inputs first. Real Greenhouse forms include aria-hidden,
      // tabindex="-1" inputs carrying the native `required` attribute purely to
      // block browser submit for custom dropdowns. They are not questions.
      // Counted as fields they would look like unanswerable required items and
      // route EVERY application to blocked_needs_human.
      if (element.getAttribute('aria-hidden') === 'true') continue;
      // Hidden and submit-type inputs are machinery, not questions.
      const inputType = (element as HTMLInputElement).type;
      if (inputType === 'hidden' || inputType === 'submit' || inputType === 'button') continue;

      // Label resolution, in the same precedence order a screen reader uses.
      // aria-label is the direct case and covers Greenhouse's custom questions.
      let label = element.getAttribute('aria-label')?.trim() ?? '';
      // aria-labelledby points at one or more other elements whose text forms
      // the label; used by the React-select comboboxes on the real form.
      if (!label) {
        const labelledBy = element.getAttribute('aria-labelledby');
        if (labelledBy) {
          label = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
            .join(' ')
            .trim();
        }
      }
      // Finally the classic <label for="id"> association.
      //
      // `CSS.escape` IS CORRECT HERE AND ONLY HERE — DO NOT "make it
      // consistent" with playwright-page.ts. This line executes INSIDE
      // page.evaluate, i.e. in the browser, where `CSS` is a real global. The
      // two textually identical calls that used to sit in playwright-page.ts
      // ran in NODE, where `CSS` is undefined, and threw ReferenceError on
      // every invocation — the applier's `fill` path had therefore never
      // executed once. Those were replaced with an attribute selector; this one
      // must stay, and the type system cannot tell the two situations apart
      // because nothing marks a callback as running in another runtime.
      if (!label && element.id) {
        label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent?.trim() ?? '';
      }

      // No recoverable label means no way to look up an answer honestly, and a
      // field we cannot name is one we must not guess at (constraint #4). These
      // are dropped rather than emitted blank, so the caller's "can I answer
      // everything?" check is not poisoned by form machinery.
      if (!label) continue;

      // Required markers render as a trailing asterisk inside the label text on
      // real forms; stripping it keeps the answer-bank key stable.
      label = label.replace(/\s*\*\s*$/, '').trim();

      // Normalise the control kind. role="combobox" identifies React-select
      // widgets, which look like text inputs but must be driven by click-and-
      // pick rather than fill() — checked before the tag name for that reason.
      const role = element.getAttribute('role');
      const tag = element.tagName.toLowerCase();
      const kind: FormField['kind'] =
        role === 'combobox' || tag === 'select'
          ? 'combobox'
          : tag === 'textarea'
            ? 'textarea'
            : inputType === 'file'
              ? 'file'
              : inputType === 'email'
                ? 'email'
                : inputType === 'tel'
                  ? 'tel'
                  : 'text';

      // aria-required is what the real form uses; the native attribute is
      // checked too because other ATS vendors mark required-ness that way.
      const required =
        element.getAttribute('aria-required') === 'true' || element.hasAttribute('required');

      // Emit the normalised field.
      fields.push({ id: element.id, label, kind, required });
    }

    return fields;
  });
}
