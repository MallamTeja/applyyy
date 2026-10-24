/* Only ever produce an href for a URL we have proved is http(s).
 *
 * EVERY <a href> THAT RENDERS A STORED URL GOES THROUGH THIS. `apply_url` reaches us
 * from a job board and profile links from a parsed resume, so both are untrusted. A
 * string beginning `javascript:` in an href executes on click (React 18 renders it,
 * with only a dev-console warning), and `data:` can carry a whole document; both
 * defeat rel="noopener" entirely, because the navigation never leaves the page.
 *
 * WHY THE URL CONSTRUCTOR AND NOT A REGEX: parsing and allowlisting the two schemes we
 * want is the check that cannot be fooled by casing, whitespace or percent-encoding
 * the way a substring test can. The ingest side holds the same two schemes
 * (supabase/functions/_shared/ats/types.ts readHttpUrl); this is the second layer,
 * for rows stored before that check existed or written by another path.
 *
 * Returns undefined rather than a sanitised string, because undefined is what JSX
 * `href` accepts as "no link": the anchor renders as plain text instead of a link to
 * somewhere we did not intend. Moved here from DiffView.tsx (where it was
 * `safeHttpUrl`) on 2026-10-24 so every call site shares one rule. */
export function safeHref(raw: string | null | undefined): string | undefined {
  /* Nothing to validate. Not an error - most rows have a URL, some do not. */
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  /* The constructor throws on anything that is not an absolute URL. */
  try {
    /* Parsed once; the protocol is read off the normalised form. */
    const parsed = new URL(raw.trim());
    /* The allowlist. Anything else - javascript:, data:, file:, blob: - is
       refused rather than escaped, because there is no safe rendering of a
       scheme this app has no reason to open. */
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
  } catch {
    /* Unparseable, including a relative path. Treated exactly like an unsafe scheme. */
    return undefined;
  }
}
