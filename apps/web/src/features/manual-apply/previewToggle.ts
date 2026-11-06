/* The "Resume preview" button's press, as a pure step (Teja, 2026-11-07).
 *
 * It was open-only: pressing it a second time did nothing, so a preview could not be hidden from the
 * button. It is a toggle now. The step takes only what it touches from the card's <details> element, so
 * a test can press it twice on a stand-in without a browser. */

/* The part of the <details> element the step needs. A structural type, not HTMLDetailsElement, so a test
   can pass a plain object. */
export interface PreviewBlock {
  // Whether the preview is showing; assigning it opens or closes the element.
  open: boolean;
  // Brings the block on screen after it opens.
  scrollIntoView: (options: ScrollIntoViewOptions) => void;
}

/* One press: open a closed block (and scroll to it), close an open one. Returns the state it left the
   block in, which the button shows as its label and aria-expanded. A missing block (the card re-rendered
   away) reports `true`, the block's default, so the label never claims "Show" over a preview that is open. */
export function pressPreview(block: PreviewBlock | null): boolean {
  // Nothing to toggle: report the default.
  if (block === null) return true;
  // The new state is the opposite of what the element says now (the source of truth, not a remembered flag).
  const next = !block.open;
  // Applied to the element itself.
  block.open = next;
  // Only showing scrolls; hiding must not move the page under the operator's pointer.
  if (next) block.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  // Reported back for the button's label.
  return next;
}
