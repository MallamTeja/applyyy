// THE POSTING AS TEXT — what every edge reader of jobs.description_raw sees (N1, 2026-11-07).
//
// WHY: some boards' rows are stored as raw HTML (live row 76280e87, CircuitHub via Arbeitnow:
// `<h2>…</h2><p style="min-height:1.5em">…` plus a footer link), or with numeric entities (Workday's
// "7&#43; years"). The adapters strip at the feed boundary, but rows already stored are still
// HTML, and the readers (the tailor and matcher prompts, the JD keywords, the auditor's dropped-
// keyword check, the screen gates) read them as stored. So each reader goes through here.
//
// REUSE, NOT A SECOND STRIPPER: stripHtml (_shared/ats/types.ts) is the one used by six adapters.
// This only adds the fallback below.
//
// THE FALLBACK (CLAUDE.md §6): stripHtml returns null for a body that is all markup. Missing data
// must not become an answer, so a stored body is never turned into "no posting" here: it comes back
// as stored. Null stays null.

// The adapters' stripper: one-pass entity decode, block tags to newlines, tags dropped.
import { stripHtml } from "../ats/types.ts";

// The stored description as plain text; the stored value itself if stripping leaves nothing.
export function postingText(raw: string | null): string | null {
  // stripHtml keeps null as null; `?? raw` restores a body that stripped to nothing.
  return stripHtml(raw) ?? raw;
}
