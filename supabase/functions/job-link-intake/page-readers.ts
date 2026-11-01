// job-link-intake — reading a job page that one plain fetch cannot: LinkedIn's and X's public
// no-login endpoints, and the headless-browser render service.
//
// WHY THIS FILE EXISTS (Teja, 2026-11-01): the web panel has no paste box any more, so a link
// must be read from the link alone. A plain fetch of a LinkedIn job or an X post returns a login
// wall or a JS shell, and some careers pages need JavaScript or sit behind a bot check (CI ingest
// run 41294502085: 4 of 21 links came back needs_text). Each reader here closes one of those gaps.
//
// Pure module behind injected fetchers, so `node --test` covers every branch.

// Page-to-text and the two text bounds the whole intake shares.
import { MAX_SOURCE_CHARS, MIN_JOB_TEXT_CHARS, pageText } from "./extract.ts";

// A page fetch through the SSRF guard (fetchPublicPage), the shape of IntakeDeps.fetchPage.
export type FetchPage = (url: string) => Promise<{ ok: true; html: string } | { ok: false; reason: string }>;
// What any reader yields: readable text, or the reason it could not be read (shown to the human).
export type ReadText = { ok: true; text: string } | { ok: false; reason: string };

// A host is `site` or one of its subdomains (www., in., mobile.); root dot stripped like isBlockedHost.
function onSite(url: URL, site: string): boolean {
  // Lower-cased once; a trailing root dot names the same host.
  const host = url.hostname.replace(/\.+$/, "").toLowerCase();
  // Exact apex, or a real subdomain (".site" suffix, so "evillinkedin.com" never matches).
  return host === site || host.endsWith(`.${site}`);
}

// LinkedIn's public guest job fragment for a job link, or null when the link is not one.
// Recognised: /jobs/view/<id>, /jobs/view/<title-slug>-<id> (the form search engines show), and
// any linkedin.com URL carrying currentJobId=<id> (search and collection pages).
export function linkedInGuestUrl(url: URL): string | null {
  // Only LinkedIn's own hosts; the id below means nothing anywhere else.
  if (!onSite(url, "linkedin.com")) return null;
  // The path form; the id is the digits after the last hyphen of the segment, or the whole segment.
  const fromPath = /^\/jobs\/view\/(?:[^/]*-)?(\d{1,20})\/?$/.exec(url.pathname)?.[1];
  // The query form, used by the search page's right-hand pane.
  const fromQuery = url.searchParams.get("currentJobId");
  // The path wins; the query is read only when the path has none.
  const id = fromPath ?? fromQuery;
  // Digits only, bounded (§6): the id is spliced into a URL, so anything else is refused, not encoded.
  if (id === null || !/^\d{1,20}$/.test(id)) return null;
  // The endpoint LinkedIn's own logged-out job page loads its content from.
  return `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`;
}

// X's public oEmbed URL for a post link, or null when the link is not a post.
export function xOembedUrl(url: URL): string | null {
  // x.com and the old twitter.com name serve the same posts.
  if (!onSite(url, "x.com") && !onSite(url, "twitter.com")) return null;
  // /<handle>/status/<id>: handles are 1-15 word characters; the id is digits.
  const m = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})(?:\/|$)/.exec(url.pathname);
  // A profile, a search or anything else is not one post.
  if (m === null) return null;
  // Rebuilt from the two validated parts, so the pasted query string never reaches the request.
  const post = `https://x.com/${m[1]}/status/${m[2]}`;
  // publish.twitter.com 301s to publish.x.com (curl, 2026-11-01), so the hop is skipped.
  // omit_script: no widget JS in the answer; dnt: X's do-not-track flag for the embed.
  return `https://publish.x.com/oembed?url=${encodeURIComponent(post)}&omit_script=true&dnt=true`;
}

// The post's text and its first outbound link, from an oEmbed answer. Positive shape only (§6):
// a JSON object whose `html` is a string; anything else is a failure with a reason, never "".
export function parseOembed(body: string): { ok: true; text: string; link: string | null } | { ok: false; reason: string } {
  // The answer, untyped until checked.
  let data: unknown;
  // A parse failure is the answer, not an exception to propagate.
  try {
    // oEmbed is JSON.
    data = JSON.parse(body);
  } catch {
    // An HTML error page or a truncated answer.
    return { ok: false, reason: "the post preview was not JSON" };
  }
  // The one field read: the embed markup holding the post's text.
  const html = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>)["html"] : undefined;
  // No markup, no post.
  if (typeof html !== "string") return { ok: false, reason: "the post preview had no text" };
  // Every href in the post, entity-decoded the one way oEmbed encodes them.
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => (m[1] ?? "").replace(/&amp;/g, "&"));
  // The first link leaving X: hashtags, mentions and the post's own permalink stay on x.com/twitter.com.
  // t.co counts as outbound: it is X's shortener for exactly the links a job post points at.
  const link = hrefs.find((h) => URL.canParse(h) && !onSite(new URL(h), "x.com") && !onSite(new URL(h), "twitter.com")) ?? null;
  // Markup to text; an empty post is "", which the caller measures against MIN_JOB_TEXT_CHARS.
  return { ok: true, text: pageText(html) ?? "", link };
}

// Read a link through its site's public endpoint. Null when no adapter claims the link, so the
// caller falls straight to the plain fetch.
export async function readSite(url: URL, fetchPage: FetchPage): Promise<ReadText | null> {
  // LinkedIn job: the guest fragment is ordinary HTML, so pageText reads it like any page.
  const linkedIn = linkedInGuestUrl(url);
  // Claimed by the LinkedIn adapter.
  if (linkedIn !== null) {
    // Through the SSRF guard like every other fetch here.
    const page = await fetchPage(linkedIn);
    // Not found, rate-limited (it answered curl 429 on 2026-11-01) or blocked: named.
    if (!page.ok) return { ok: false, reason: `LinkedIn's public job page: ${page.reason}` };
    // The fragment's text; the caller measures it.
    return { ok: true, text: pageText(page.html) ?? "" };
  }
  // X post: oEmbed hands back the post's text with no login.
  const oembed = xOembedUrl(url);
  // No adapter for this site.
  if (oembed === null) return null;
  // Through the SSRF guard; its manual redirect handling covers a moved endpoint too.
  const page = await fetchPage(oembed);
  // Deleted post, protected account, or X down: named.
  if (!page.ok) return { ok: false, reason: `X's post preview: ${page.reason}` };
  // Shape-checked before any of it is used.
  const post = parseOembed(page.html);
  // A malformed preview is a failure, never an empty post.
  if (!post.ok) return post;
  // A post long enough to be the job, or one with nowhere else to look, is the answer.
  if (post.text.length >= MIN_JOB_TEXT_CHARS || post.link === null) return { ok: true, text: post.text };
  // A short "we're hiring, see link" post: follow its first outbound link ONCE (one level only;
  // fetchPublicPage follows the t.co redirect by hand and re-checks every hop).
  const linked = await fetchPage(post.link);
  // The post's text is still worth keeping; the caller decides whether it is enough.
  if (!linked.ok) return { ok: true, text: post.text };
  // Post first (it names the role), then the page it links to, capped like every source text.
  return { ok: true, text: `${post.text}\n\n${pageText(linked.html) ?? ""}`.trim().slice(0, MAX_SOURCE_CHARS) };
}

// The render service: a Vercel function that opens the page in a headless browser and returns its
// visible text (contract agreed 2026-11-01 with the worker building api/render-job-page).
export const RENDER_URL = "https://applyyy.vercel.app/api/render-job-page";
// The renderer stops itself at ~45 s; 60 s covers its cold start and still leaves the request
// most of its 150 s Edge Function wall clock (_shared/agent/deadline.ts).
export const RENDER_TIMEOUT_MS = 60_000;
// The POST, injected: index.ts passes global fetch, tests answer with canned Responses.
export type RenderFetch = (url: string, init: RequestInit) => Promise<Response>;

// Ask the render service for a page's visible text, as the caller. `authorization` is the
// caller's own "Bearer <jwt>" header, already verified by authorizeCaller; the renderer checks it
// again, so a request that did not come through our gate cannot spend a browser.
export async function renderPage(url: string, authorization: string, fetchFn: RenderFetch): Promise<ReadText> {
  // The response, once one arrives.
  let res: Response;
  // A network failure or the timeout is a failed rung, never a throw out of the ladder.
  try {
    // One POST; the body carries only the already-validated https link. redirect "error": this
    // request carries Teja's JWT, so a 307/308 from a future redirect rule or deployment
    // protection must fail the rung, never re-send the token to wherever Location points
    // (security review, 2026-11-01).
    res = await fetchFn(RENDER_URL, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ url }), redirect: "error", signal: AbortSignal.timeout(RENDER_TIMEOUT_MS) });
  } catch (err) {
    // AbortSignal.timeout rejects with a TimeoutError; anything else is the network.
    return { ok: false, reason: err instanceof Error && err.name === "TimeoutError" ? "the browser took too long" : "the browser service could not be reached" };
  }
  // The body, untyped until checked; an unparseable one is read as "no fields".
  const data: unknown = await res.json().catch(() => null);
  // Loose view for the field checks; a non-object has none of the fields.
  const b = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  // POSITIVE shape (§6): 200 AND status 'ok' AND text a string. Anything else is a failure, so a
  // 200 that lost its text can never become an empty "page".
  if (res.status === 200 && b["status"] === "ok" && typeof b["text"] === "string") return { ok: true, text: b["text"].trim().slice(0, MAX_SOURCE_CHARS) };
  // The renderer's own reason when it gave one (bounded: it reaches the human verbatim), else the HTTP status.
  const why = typeof b["message"] === "string" && b["message"].trim() !== "" ? b["message"].trim().slice(0, 200) : `HTTP ${res.status}`;
  // Named as the browser's failure, so the human can tell it from the plain fetch's.
  return { ok: false, reason: `the browser could not open it: ${why}` };
}
