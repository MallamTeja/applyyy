/**
 * applyy — HTML escaping for resume text.
 *
 * This is a SECURITY boundary, not a formatting nicety. Every string this
 * package renders has passed through the Tailor, which reworded it from a job
 * description — and PROJECT_PLAN section 17 says job descriptions are untrusted
 * input. A JD carrying `<script>` or `"` reaches this function as bullet text.
 *
 * Escaping here rather than at the call site is deliberate: the renderer builds
 * HTML with template literals, so a single un-escaped interpolation anywhere is
 * an injection. Funnelling every interpolation through one function makes the
 * unsafe path the one you have to write on purpose.
 */

/**
 * Replace the five characters that can change the meaning of surrounding markup.
 *
 * Returns a string that is safe in both element content and double-quoted
 * attribute values, so callers never have to ask which context they are in.
 */
export function escapeHtml(raw: string): string {
  return (
    raw
      // Ampersand MUST be first. Replacing it after the others would re-escape
      // the ampersands this function itself just introduced, turning `<` into
      // `&amp;lt;` and printing the literal text `&lt;` on the resume.
      .replace(/&/g, '&amp;')
      // Angle brackets are what actually promote text into markup.
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // Double quote would close an attribute value; relevant because link URLs
      // are interpolated into href="...".
      .replace(/"/g, '&quot;')
      // Single quote is escaped too so the output stays safe if a consumer ever
      // switches to single-quoted attributes.
      .replace(/'/g, '&#39;')
  );
}

/**
 * Allow-list a URL before it becomes an `href`.
 *
 * A tailored profile can carry a portfolio or GitHub link, and `javascript:` in
 * an href executes when clicked in the React approval preview — which is the one
 * place a human deliberately opens the untrusted-derived document. Escaping the
 * quotes alone would not stop that, because the payload needs no quotes.
 *
 * Anything not plainly http(s) or mailto collapses to '#': a dead link on a
 * resume is a cosmetic bug, an executable one is a vulnerability.
 */
export function safeHref(url: string): string {
  // Lower-case and trim before testing, because `JavaScript:` and leading
  // whitespace both defeat a naive prefix check.
  const normalised = url.trim().toLowerCase();
  // Explicit allow-list. A deny-list of dangerous schemes would need updating
  // every time a new URL scheme is invented; an allow-list never does.
  const permitted = normalised.startsWith('http://') || normalised.startsWith('https://') || normalised.startsWith('mailto:');
  // Escape even the permitted URL — a valid https URL can still contain a quote.
  return permitted ? escapeHtml(url.trim()) : '#';
}
