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
  // The human-meaningful name of the WRAPPER this control sits inside, when
  // that wrapper is a role="group". Deliberately NOT merged into `label`: the
  // accessible name of Greenhouse's file input genuinely IS "Attach" — accname
  // says so, and `label` stays correct — but "Attach" is a useless answer-bank
  // key and BOTH uploads on the real form share it. Every answer-bank key in
  // the system would become downstream of that merge forever, so the better key
  // gets its own field and the caller decides which one to look up by.
  readonly groupLabel?: string;
  // The wrapper's own aria-required. Greenhouse puts aria-required="true" on
  // the upload group, never on the <input type="file"> inside it, so `required`
  // reads false for a resume box that genuinely blocks submission. Separate for
  // the same reason as groupLabel: `required` is the truth about the CONTROL,
  // this is the truth about the GROUP, and folding one into the other would
  // silently change what every existing caller means by `required`.
  readonly groupRequired?: boolean;
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

    // How far up the ancestor chain a role="group" wrapper may sit before it
    // stops counting as THIS control's group. See the walk further down for why
    // a bound is needed at all; 8 clears Greenhouse's five-level file-upload
    // nesting with room for a vendor inserting another wrapper div, and stops
    // well short of a page-level landmark that wraps the whole form.
    const GROUP_ANCESTOR_LIMIT = 8;

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

      // GROUP METADATA — strictly additive. Nothing above this point changes.
      //
      // THE DEFECT THIS ANSWERS: on the real capture BOTH file inputs report
      // label 'Attach' (from <label class="visually-hidden" for="resume">) and
      // required false, because the human-meaningful "Resume/CV" text AND the
      // aria-required="true" both live on a <div role="group"> five levels
      // above the input. The walk above never left the control element, so the
      // mandatory resume box was indistinguishable from the optional cover
      // letter box — same label, same required, different obligation.

      // Nearest ancestor carrying role="group". Written as an explicit walk
      // rather than element.closest('[role="group"]') because closest() always
      // searches to <html> and offers no way to stop early, and stopping early
      // is the entire point of the next few lines.
      let group: HTMLElement | null = null;
      // Start at the parent: a control is never its own group.
      let ancestor: HTMLElement | null = element.parentElement;
      // THE BOUND. An unbounded walk reaches <html>, so a page that wraps the
      // whole form in role="group" would stamp one section heading onto all 22
      // fields — collapsing 22 distinct answer-bank keys into a single key and
      // making the bank return the wrong stored answer rather than no answer,
      // which is the failure mode constraint #3 exists to prevent. A group
      // eight levels up is a page landmark, not this field's group.
      for (let depth = 0; ancestor !== null && depth < GROUP_ANCESTOR_LIMIT; depth += 1) {
        // Nearest wins and the walk stops there: an inner group is more
        // specific than an outer one, exactly as a screen reader treats nested
        // groups. Continuing past it would let an outer section override the
        // wrapper that actually describes this control.
        if (ancestor.getAttribute('role') === 'group') {
          group = ancestor;
          break;
        }
        // Step up one level, spending one unit of the bound.
        ancestor = ancestor.parentElement;
      }

      // Declared undefined and assigned only when the group genuinely supplies
      // them, so "no group said anything" stays distinguishable from "the group
      // said false" — under exactOptionalPropertyTypes those are different
      // types, and conflating them would have `groupRequired: false` assert
      // something no markup ever claimed.
      let groupLabel: string | undefined;
      let groupRequired: boolean | undefined;

      if (group !== null) {
        // aria-labelledby AND NOTHING ELSE — the single most dangerous mistake
        // available in this file is adding an aria-describedby fallback here.
        // On this very form aria-describedby resolves to
        // "first_name-description first_name-error first_name-help", so a
        // describedby fallback would splice VALIDATION TEXT into the key. The
        // key would then change the instant a submit failed, and the answer
        // bank would quietly stop matching answers it had already stored — a
        // defect invisible to any test run that never triggers an error state.
        const groupLabelledBy = group.getAttribute('aria-labelledby');
        if (groupLabelledBy) {
          // Same multi-id resolution the control-level branch uses above: one
          // aria-labelledby may name several elements whose text concatenates.
          const resolved = groupLabelledBy
            .split(/\s+/)
            .map((labelId) => document.getElementById(labelId)?.textContent?.trim() ?? '')
            .join(' ')
            .trim()
            // Identical trailing-asterisk strip to `label`'s, because the group
            // heading renders as Resume/CV<span class="required">*</span> and a
            // key carrying the required marker would fail to match the same
            // question on a board that marks required-ness any other way.
            .replace(/\s*\*\s*$/, '')
            .trim();
          // Emitted only when it actually resolved to text: an aria-labelledby
          // pointing at an id that is not in the document must produce no key
          // at all rather than an empty-string key that matches everything.
          if (resolved) groupLabel = resolved;
        }

        // Only when the group actually declares it. A group with no
        // aria-required has said nothing, and emitting `false` there would be
        // an assertion the markup does not support. The native `required`
        // attribute is deliberately NOT checked the way it is for the control:
        // it is invalid on a <div role="group">, so honouring it would invent a
        // signal no ATS emits and no fixture can ever confirm.
        if (group.hasAttribute('aria-required')) {
          groupRequired = group.getAttribute('aria-required') === 'true';
        }
      }

      // Emit the normalised field. The two group properties are spread in
      // conditionally rather than assigned undefined, because
      // exactOptionalPropertyTypes makes `{ groupLabel: undefined }` a type
      // error against `groupLabel?: string` — and because an absent key is the
      // honest encoding of "this control has no group to speak for it".
      fields.push({
        id: element.id,
        label,
        kind,
        required,
        ...(groupLabel === undefined ? {} : { groupLabel }),
        ...(groupRequired === undefined ? {} : { groupRequired }),
      });

    }

    return fields;
  });
}
