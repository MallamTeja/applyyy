// Choosing an apply URL from an untrusted LinkedIn post — constraint #9, trust boundary.
//
// THE PROBLEM THIS REPLACES. Tier-2 discovery previously took the first http(s) string
// appearing anywhere in a post body and used it as the apply link. The post body is
// written by a stranger, so that handed the destination to the poster: a tracking
// redirect, a shortener, an unrelated blog linked in the intro line, or a look-alike
// domain all read identically to a real Greenhouse link through a bare regex.
//
// WHY THIS IS A SHARPER EXPOSURE THAN THE UPSTREAM EQUIVALENT. Upstream verifies ATS hosts
// too, but its check guards a drafting step a human is supervising, where somebody has
// read the posting. Ours guards an unattended path: extract, store, render. Nobody reads
// the post before Teja sees the link.
//
// ITS OWN MODULE RATHER THAN A HELPER INSIDE tiers.ts, for two reasons. It is a distinct
// concern with distinct failure modes, so it earns a co-located test file of its own under
// this directory's one-concern-per-file convention. And the next aggregator source will
// need the same host check — a validator that already exists is one nobody reimplements
// slightly differently.
//
// THE CHECK IS DONE BY URL PARSING, NEVER BY STRING INSPECTION. That distinction is the
// whole defence: `https://greenhouse.io@evil.com/jobs/1` CONTAINS the string "greenhouse.io"
// while its actual host is evil.com, because everything before the `@` is userinfo. Only a
// parser knows that; `includes()` does not.

// The public hosts an application can legitimately be submitted through.
//
// THESE ARE THE PUBLIC JOB-BOARD APEXES, NOT THE API HOSTS. `ats/greenhouse.ts` holds
// `boards-api.greenhouse.io` and `ats/lever.ts` holds `api.lever.co` — those are where we
// POLL, which is a different question from where a CANDIDATE APPLIES (`boards.greenhouse.io`,
// `jobs.lever.co`). Importing the adapters' constants would have looked like reuse and been
// wrong, so the list is stated here rather than borrowed.
//
// Apexes only. Subdomains are accepted by the suffix rule below, so adding every known
// board subdomain would be noise that goes stale.
export const ATS_APPLY_APEXES: readonly string[] = [
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "workable.com",
  "smartrecruiters.com",
  // Workday ships under two registrable domains depending on tenant vintage.
  "myworkdayjobs.com",
  "workday.com",
];

// Is this hostname one we are willing to send an application to?
//
// EXACT MATCH OR DOT-ANCHORED SUFFIX, and both halves are load-bearing:
//   - the exact match accepts `greenhouse.io` itself
//   - the `"." + apex` suffix accepts `boards.greenhouse.io` while REJECTING
//     `evil-greenhouse.io`, because that host does not end with `.greenhouse.io`
// A substring test would accept both look-alikes and is the usual way this is written
// wrong. A bare `endsWith(apex)` without the dot accepts `evil-greenhouse.io` too.
export function isTrustedApplyHost(hostname: string): boolean {
  // Hosts are case-insensitive; a mixed-case host must not slip past a lowercase list.
  const host = hostname.trim().toLowerCase();
  return ATS_APPLY_APEXES.some((apex) => host === apex || host.endsWith(`.${apex}`));
}

// Parse a candidate string into a URL we are willing to use, or null.
//
// Returns null rather than throwing because an unparseable string in a post body is
// expected input, not an exceptional event.
function parseTrustedUrl(candidate: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    // Not a URL at all.
    return null;
  }
  // SCHEME FIRST. `javascript:`, `data:` and `file:` all parse successfully, and a check
  // that only looked at the host would accept them.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // Then the host, via the parser's own view of it — see the header on userinfo.
  if (!isTrustedApplyHost(parsed.hostname)) return null;
  return parsed;
}

// Pull every http(s)-looking run out of free text, cleaned of trailing punctuation.
//
// THE GREEDY MATCH IS THE BUG THIS FIXES. `[^\s]+` runs to the next whitespace, so a link
// ending a sentence swallows the full stop and the stored URL 404s — a failure that
// presents as a dead job posting rather than as a parsing bug. Closing brackets and quotes
// are stripped for the same reason. A trailing SLASH is deliberately kept: it is part of
// the path, not punctuation.
function extractCandidateUrls(text: string): readonly string[] {
  const matches = text.match(/https?:\/\/[^\s]+/gi);
  if (matches === null) return [];
  return matches.map((raw) => raw.replace(/[.,;:!?)\]}>'"]+$/, ""));
}

// What we decided, and why.
export interface ApplyUrlResolution {
  // The URL to store.
  readonly url: string;
  // TRUE only when the URL is on a known ATS apex. FALSE means "this is the best we have,
  // and it is not an apply link" — the dashboard should route it to a human rather than
  // presenting it as somewhere to apply.
  readonly verified: boolean;
  // Why this URL was chosen, so an unexpected link is diagnosable without re-reading the
  // post. A verdict with no stated cause cannot be reviewed.
  readonly reason: string;
}

// The inputs to the decision.
export interface ApplyUrlInput {
  // Our own structured extraction, when we have one. Trusted more than prose, but still
  // validated — see below.
  readonly structuredUrl?: string;
  // UNTRUSTED. The post body as written by a stranger.
  readonly postText: string;
  // A known-good URL to fall back to, normally the post permalink itself.
  readonly fallbackUrl: string;
}

// Decide which URL to treat as the apply target.
//
// PREFERENCE ORDER, AND THE REASONING BEHIND IT:
//   1. Our structured extraction, when it validates.
//   2. The FIRST TRUSTED URL in the body — not the first URL. Posters routinely link a
//      blog or company page before the apply link, so "first" and "trusted" are different
//      questions and the old code conflated them.
//   3. The fallback permalink, marked UNVERIFIED.
//
// IT NEVER INVENTS AND NEVER GUESSES. When nothing trustworthy is present it says so in
// the result rather than promoting the best-looking untrusted candidate — which is the
// same rule the salary gate and the rubric follow: missing data must not become an answer.
export function resolveApplyUrl(input: ApplyUrlInput): ApplyUrlResolution {
  // 1. The structured field, validated on the same terms as anything else. It comes from
  // our own extraction rather than from prose, but it was still read off a hostile page,
  // so it earns priority — not exemption.
  if (input.structuredUrl !== undefined && input.structuredUrl.trim() !== "") {
    const structured = parseTrustedUrl(input.structuredUrl.trim());
    if (structured !== null) {
      return { url: structured.toString(), verified: true, reason: "structured apply URL on a known ATS host" };
    }
  }

  // 2. The first TRUSTED url in the body, skipping untrusted ones rather than stopping at
  // them.
  for (const candidate of extractCandidateUrls(input.postText)) {
    const parsed = parseTrustedUrl(candidate);
    if (parsed !== null) {
      return { url: parsed.toString(), verified: true, reason: `apply URL found in post body on ${parsed.hostname}` };
    }
  }

  // 3. Nothing trustworthy. The permalink is truthful — it is where the sighting came from
  // — but it is NOT an apply URL, and saying so is the whole point of this branch.
  return {
    url: input.fallbackUrl,
    verified: false,
    reason: "no trusted ATS apply URL in the post; falling back to the post permalink, which needs a human to confirm",
  };
}
