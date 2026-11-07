// The remote-job feeds (RemoteOK, Jobicy, Arbeitnow): where they live, how their JSON
// becomes a posting, and how a posting becomes a jobs row.
//
// PURE: no client, no fetch, no env. That is what lets worker/test/remote-feeds.test.ts
// pin the safety rules by value, since cli/scout-remote.ts runs main() on import.
//
// WHY THIS FILE EXISTS (2026-10-24). scout-remote.ts used to build rows inline and wrote
// them with none of the safety the ATS scout has: apply_url was stored unchecked (a
// `javascript:` URL from a feed would be saved and later rendered), every row carried
// posted_at_source 'unknown' (which FAILS the screener's staleness rule, so every remote
// job would have been dropped once screened), and an unparseable date threw away the
// whole feed. Each of those is decided here now, once, and tested.

// The shared apply-URL and text readers, so remote rows pass the same http(s) gate as ATS rows (d153a2a).
import { readHttpUrl, readString, stripHtml } from '../../../supabase/functions/_shared/ats/types.ts';
// The same canonical fingerprint the ATS scout uses, so a posting seen on both dedupes to one job.
import { jobFingerprint } from '../../../supabase/functions/_shared/normalize/fingerprint.ts';
// Types for the row this module emits.
import type { AtsProvider, EmploymentType, JobInsert, JobSourceRef } from '../../../packages/shared-types/src/tables.ts';
// THE shared freshness policy, the same one the ATS scout's toJobInsert uses ('remote_feed' variant).
import { extractPostedAt } from '../../../supabase/functions/_shared/normalize/posted-at.ts';
// The persist path's unit: a row plus how to rebuild it against a stored first sighting.
import type { PreparedJob } from './persist-jobs.ts';

// Which feed a posting came from; recorded in source_refs so a bad feed can be traced.
export type RemoteFeed = 'remoteok' | 'jobicy' | 'arbeitnow';

// Every feed's URL, in one place so the tests can assert the filter each one carries.
export const REMOTE_FEED_URLS: Readonly<Record<RemoteFeed, string>> = {
  // FETCH-ALL by Teja's ruling (2026-10-24): one request for the ~100 newest jobs. Poster
  // tags are lossy, and the screener drops non-tech rows for free. (`?tag=dev` is ignored.)
  remoteok: 'https://remoteok.com/api',
  // industry=dev filters at the source: unfiltered Jobicy is mostly call-centre and ad-rater roles.
  jobicy: 'https://jobicy.com/api/v2/remote-jobs?count=50&industry=dev',
  // One page of the board; remote-only rows are kept by the parser below.
  arbeitnow: 'https://www.arbeitnow.com/api/job-board-api',
};

// One posting as a feed described it, after shape checks. Everything here is UNTRUSTED text.
export interface RemoteJob {
  // Job title as posted.
  readonly title: string;
  // Hiring company as posted.
  readonly company: string;
  // Free-text location, defaulted per feed exactly as before so fingerprints stay stable.
  readonly location: string;
  // The apply URL, already proven http(s) by readHttpUrl.
  readonly applyUrl: string;
  // Description HTML or text; stored inert like every description_raw.
  readonly description: string;
  // Which feed returned it.
  readonly feed: RemoteFeed;
  // Salary bounds when the feed gave positive numbers, else null.
  readonly salaryMin: number | null;
  readonly salaryMax: number | null;
  // Currency the feed states, or its documented default.
  readonly salaryCurrency: string;
  // The feed's raw publish value (ISO string or epoch); judged by extractPostedAt's remote_feed branch.
  readonly published: unknown;
}

// What a parse returned: the usable postings, and how many items were refused and why it matters.
export interface RemoteParse {
  // Postings with a title, a company and a safe apply URL.
  readonly jobs: RemoteJob[];
  // Items dropped for a missing title/company or a non-http(s) apply URL. Counted, never silent.
  readonly refused: number;
}

// A record, or null: feed items are untrusted JSON and a string or null item must not throw.
function asRecord(value: unknown): Record<string, unknown> | null {
  // Arrays are objects too; an array where an item belongs is not a posting.
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// A positive finite salary number, or null. Number('') is 0 and Number(null) is 0 (§6),
// so zero and negatives are treated as "not stated" rather than as a real salary of 0.
function salary(value: unknown): number | null {
  // Strings like "120000" are common in these feeds, so convert before checking.
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  // Only a real positive amount is a salary.
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Repairs text a feed DOUBLE-ENCODED (UTF-8 bytes read as Latin-1, then UTF-8 encoded again),
// and returns anything else unchanged.
//
// WHY (2026-11-07). RemoteOK's JSON carries the mojibake itself, as escapes: the bytes on the
// wire for the Dubai posting's location are `\u00d8\u00af\u00d8\u00a8...`, i.e. the JSON string
// IS "Ø¯Ø¨..." and res.json() decoded it correctly, once. So the fix belongs here, at the feed
// boundary, not in the fetch. Unrepaired, the work-auth gate read "Ø¯Ø¨Ù..." as no known
// country and let a UAE-only job (row 0cccc73a) through. One fetch on 2026-11-07: all 87
// non-ASCII text fields in RemoteOK's 100 items were mojibake, none genuine.
//
// NEVER GUESSES (§6: a lenient decode must not become an answer). It repairs only when all
// three hold, else the input comes back untouched:
//   (i)   a mojibake signature is present: some char in U+0080..U+00FF;
//   (ii)  every char is <= U+00FF, so reading the string as Latin-1 bytes loses nothing;
//   (iii) those bytes are STRICT UTF-8 (a fatal decoder refuses instead of inserting U+FFFD).
// A correct "Zürich" fails (iii) (a lone 0xFC byte is not UTF-8), so real Latin-1 text survives.
export function repairDoubleEncodedUtf8(text: string): string {
  // (i) Pure ASCII cannot be mojibake, and is by far the common case, so it returns first.
  if (!/[\u0080-\u00ff]/.test(text)) return text;
  // (ii) A char above U+00FF has no Latin-1 byte, so the string was not built from one; leave it.
  if (/[^\u0000-\u00ff]/.test(text)) return text;
  // Each char IS one byte now (proven by (ii)), so this is the lossless Latin-1 encoding.
  const bytes = Uint8Array.from(text, (ch) => ch.charCodeAt(0));
  // A fatal decoder THROWS on malformed input; the default one would quietly emit U+FFFD.
  // Strict UTF-8 is a bijection, so a decode that succeeds IS the exact inverse of the corruption:
  // no round-trip re-encode is needed to prove (iii).
  try {
    // ignoreBOM keeps a leading EF BB BF as U+FEFF instead of silently dropping those three bytes.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    // (iii) failed: these were real Latin-1 chars, not UTF-8 bytes in disguise.
    return text;
  }
}

// A read string, repaired when double-encoded; null stays null so the caller's defaults still apply.
function repaired(value: string | null): string | null {
  // Absent stays absent; a repair never invents text.
  return value === null ? null : repairDoubleEncodedUtf8(value);
}

// Arbeitnow's link-back footer, the last line of every description once tags are gone:
// "Find Jobs in Germany on Arbeitnow". Anchored to the END so the same words mid-text survive.
// Starts with the LITERAL "Find " and every quantifier is bounded, so it cannot backtrack polynomially
// (peer 2's ReDoS finding, 2026-11-07: a leading /\s*-*\s*/ took 7.6 s on 50k dashes). The dash rule
// before it (job 3f73f9cc ended "...request to: -----Find more English Speaking Jobs in France on
// Arbeitnow") is trimmed by a plain loop in stripArbeitnowFooter, never by a regex.
const ARBEITNOW_FOOTER = /Find [^\n]{1,80} on Arbeitnow\s*$/;

// The text without a trailing Arbeitnow footer and the dashes/whitespace glued in front of it.
function stripArbeitnowFooter(text: string): string {
  // Where the footer starts, or no footer at all.
  const match = ARBEITNOW_FOOTER.exec(text);
  // Nothing to remove.
  if (match === null) return text;
  // Walk back over the dash rule and whitespace before the footer: linear, one char at a time.
  let end = match.index;
  // A dash or any whitespace (including the newline that separates it) belongs to the footer.
  while (end > 0 && /[\s-]/.test(text[end - 1]!)) end -= 1;
  // Everything before that run is the description.
  return text.slice(0, end);
}

// A feed description as clean text: HTML to line-broken text, entities decoded, footer gone (N1,
// 2026-11-07: 129 Arbeitnow and 52 RemoteOK rows stored HTML, which fed the matcher and tailor).
// Uses the ATS adapters' own stripHtml, so every board's description reads the same way.
function cleanDescription(raw: string | null): string {
  // No description is the feed's old default, unchanged.
  if (raw === null) return '';
  // Mojibake repaired FIRST: decoding entities can add chars above U+00FF (&mdash; is —),
  // and the repair refuses any string holding one, so the other order would skip it.
  const repairedRaw = repairDoubleEncodedUtf8(raw);
  // Tags out, block ends as newlines, entities decoded once; null when no text was left.
  const text = stripHtml(repairedRaw);
  // §6: markup that strips to nothing is NOT "no description". Keep the raw text and say so,
  // so a malformed body stays visible instead of passing silently as an empty one.
  if (text === null) {
    // One line per such posting; the scout's log is where a human would look.
    console.warn(`[remote-feeds] description stripped to nothing; kept raw (${repairedRaw.length} chars)`);
    // The raw text, as before this change.
    return repairedRaw;
  }
  // The footer off the end; a description that was only the footer becomes empty, which it is.
  return stripArbeitnowFooter(text);
}

// Builds one RemoteJob from one item, or null when it cannot be a safe posting.
function toRemoteJob(
  // The raw feed item.
  item: unknown,
  // Which feed it came from.
  feed: RemoteFeed,
  // The field names this feed uses, so one function serves all three shapes.
  keys: { title: string; company: string; location: string; locationDefault: string; urls: readonly string[]; description: readonly string[]; published: string; salaryMin?: string; salaryMax?: string; currency?: string; currencyDefault: string },
): RemoteJob | null {
  // Not an object: nothing to read.
  const record = asRecord(item);
  // Refused, and counted by the caller.
  if (record === null) return null;
  // Trimmed, non-empty strings only (readString's rule, shared with the ATS adapters), repaired
  // when the feed double-encoded them ("â" for an en dash in RemoteOK titles, 2026-11-07).
  const title = repaired(readString(record, keys.title));
  // Same rule for the company ("Sothebyâs" in the same fetch).
  const company = repaired(readString(record, keys.company));
  // THE SAFETY GATE: only an absolute http(s) URL is storable; a javascript:/data: one is absent.
  const applyUrl = readHttpUrl(record, ...keys.urls);
  // A posting nobody can identify or apply to is not a row.
  if (title === null || company === null || applyUrl === null) return null;
  // The posting, every field read through a checked path.
  return {
    title,
    company,
    // The feed's own default when blank, unchanged from the old inline code (fingerprint stability).
    // Repaired first: the work-auth gate reads this, and mojibake Arabic names no country (row 0cccc73a).
    location: repaired(readString(record, keys.location)) ?? keys.locationDefault,
    applyUrl,
    // Excerpt-or-full fallbacks in the order each feed is richest; empty when it gave none.
    // Repaired and stripped to text: the work-auth gate, the matcher and the tailor read it.
    description: cleanDescription(readString(record, ...keys.description)),
    feed,
    // Absent salary fields read as null.
    salaryMin: keys.salaryMin === undefined ? null : salary(record[keys.salaryMin]),
    salaryMax: keys.salaryMax === undefined ? null : salary(record[keys.salaryMax]),
    // Stated currency, else the feed's default.
    salaryCurrency: (keys.currency === undefined ? null : readString(record, keys.currency)) ?? keys.currencyDefault,
    // Judged later by extractPostedAt; kept raw so this parse never throws on a bad date.
    published: record[keys.published],
  };
}

// Runs a list of items through toRemoteJob, counting refusals.
function collect(items: readonly unknown[], build: (item: unknown) => RemoteJob | null): RemoteParse {
  // Kept postings.
  const jobs: RemoteJob[] = [];
  // Refused items.
  let refused = 0;
  // One pass; order preserved so logs read in feed order.
  for (const item of items) {
    // Built or refused.
    const job = build(item);
    // Tallied either way.
    if (job === null) refused += 1;
    else jobs.push(job);
  }
  // Both, so the caller can log how much each feed lost.
  return { jobs, refused };
}

// RemoteOK: a JSON array whose FIRST element is a legal notice, not a job.
export function parseRemoteOK(body: unknown): RemoteParse {
  // Anything but an array is a malformed response: no postings, nothing refused.
  if (!Array.isArray(body)) return { jobs: [], refused: 0 };
  // Skip the legal-notice element.
  return collect(body.slice(1), (item) => toRemoteJob(item, 'remoteok', {
    // RemoteOK's field names.
    title: 'position', company: 'company', location: 'location', locationDefault: 'Worldwide Remote',
    // apply_url first, the listing page second; readHttpUrl falls through an unsafe first one.
    urls: ['apply_url', 'url'], description: ['description'], published: 'date',
    salaryMin: 'salary_min', salaryMax: 'salary_max', currencyDefault: 'USD',
  }));
}

// Jobicy: { jobs: [...] }.
export function parseJobicy(body: unknown): RemoteParse {
  // The envelope must be an object with a jobs array.
  const jobs = asRecord(body)?.['jobs'];
  // Malformed envelope: no postings.
  if (!Array.isArray(jobs)) return { jobs: [], refused: 0 };
  // Jobicy's field names.
  return collect(jobs, (item) => toRemoteJob(item, 'jobicy', {
    title: 'jobTitle', company: 'companyName', location: 'jobGeo', locationDefault: 'Remote',
    urls: ['url'], description: ['jobExcerpt', 'jobDescription'], published: 'pubDate',
    salaryMin: 'annualSalaryMin', salaryMax: 'annualSalaryMax', currency: 'salaryCurrency', currencyDefault: 'USD',
  }));
}

// Arbeitnow: { data: [...] }, where only `remote: true` rows are remote jobs.
export function parseArbeitnow(body: unknown): RemoteParse {
  // The envelope must be an object with a data array.
  const data = asRecord(body)?.['data'];
  // Malformed envelope: no postings.
  if (!Array.isArray(data)) return { jobs: [], refused: 0 };
  // On-site rows are out of scope for a REMOTE scout; filtered before the count, as before.
  const remote = data.filter((item) => asRecord(item)?.['remote'] === true);
  // Arbeitnow's field names.
  return collect(remote, (item) => toRemoteJob(item, 'arbeitnow', {
    title: 'title', company: 'company_name', location: 'location', locationDefault: 'Remote (Europe/Global)',
    urls: ['url'], description: ['description'], published: 'created_at', currencyDefault: 'EUR',
  }));
}

// Which ATS would submit this posting, from its apply URL's host. 'other' when none matches.
function detectAtsProvider(url: string): AtsProvider {
  // Lower-cased once so the host checks ignore casing.
  const lower = url.toLowerCase();
  // Each known ATS host, as before.
  if (lower.includes('greenhouse.io') || lower.includes('gh_jid=')) return 'greenhouse';
  if (lower.includes('lever.co')) return 'lever';
  if (lower.includes('ashbyhq.com')) return 'ashby';
  if (lower.includes('workable.com')) return 'workable';
  if (lower.includes('smartrecruiters.com')) return 'smartrecruiters';
  // No recognised host: the generic path.
  return 'other';
}

// Employment type from title words; 'unknown' when the title does not say (the screener decides).
function detectEmploymentType(title: string): EmploymentType {
  // Lower-cased once.
  const lower = title.toLowerCase();
  // Same word lists as before, so rows already stored classify the same way.
  if (lower.includes('intern') || lower.includes('co-op') || lower.includes('trainee')) return 'internship';
  if (lower.includes('contract') || lower.includes('freelance')) return 'contract';
  if (lower.includes('part-time') || lower.includes('part time')) return 'part_time';
  if (lower.includes('full-time') || lower.includes('full time') || lower.includes('permanent')) return 'full_time';
  // The title did not say.
  return 'unknown';
}

// URL-safe company slug, as before: the blocklist and weekly cap join on it.
function slugify(name: string): string {
  // Lower-case, collapse non-alphanumerics to dashes, trim edge dashes.
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// The jobs row for one remote posting, as seen first at `firstSeenAt`.
async function remoteRow(job: RemoteJob, now: Date, firstSeenAt: Date): Promise<JobInsert & { first_seen_at: string }> {
  // Same identity as the ATS scout, so one posting on two sources is one job.
  const fingerprint = await jobFingerprint({ company: job.company, title: job.title, location: job.location });
  // Which ATS the apply URL points at.
  const atsProvider = detectAtsProvider(job.applyUrl);
  // The shared extractor. isFirstPollOfBoard is FALSE on purpose: a feed lists only its newest
  // postings, so "first seen" is sound, and the cold-start guard's `unknown` would FAIL the
  // screener's staleness rule for every undated remote job (the bug the old CLI shipped).
  const { postedAt: posted_at, postedAtSource: posted_at_source } = extractPostedAt({ source: "remote_feed", published: job.published }, { now, firstSeenAt, isFirstPollOfBoard: false });
  // The per-source sighting record.
  const sourceRef: JobSourceRef = {
    // These feeds are not ATS vendors; 'other' is the honest discovery source.
    provider: 'other',
    // The checked apply URL.
    url: job.applyUrl,
    // Stated, not omitted: these feeds expose no vendor posting id, and a missing id and an
    // unrecorded id look identical downstream in dedupe.
    ats_job_id: null,
    // First and last sighting on this source.
    first_seen_at: firstSeenAt.toISOString(),
    last_seen_at: now.toISOString(),
    // Tier 3 aggregator, with the feed name so a bad feed can be traced.
    metadata: { tier: 3, type: 'web_remote_aggregator', source_name: job.feed, ats_provider: atsProvider },
  };
  // The row, field for field as the old inline code built it, except the three fixes in the header.
  return {
    // The dedupe key; user_id is left to its auth.uid() default so the session decides the owner.
    fingerprint,
    // UNTRUSTED title, read and trimmed by the parser.
    title: job.title,
    // The company as the feed spelled it; remote feeds have no watchlist spelling to prefer.
    company_name: job.company,
    // What the blocklist and the weekly cap join on.
    company_slug: slugify(job.company),
    // Kept verbatim, so a location parse bug is diagnosable against what arrived.
    location_raw: job.location,
    // Every row here is remote by construction (the feeds list remote jobs only).
    locations: ['Remote'],
    // Same fact, in the column the screener's arrangement rule reads.
    work_arrangement: 'remote',
    // From the title; 'unknown' leaves the decision to the screener.
    employment_type: detectEmploymentType(job.title),
    // UNTRUSTED; stored inert.
    description_raw: job.description,
    // Proven http(s) by the parser.
    apply_url: job.applyUrl,
    // Which adapter would submit it.
    ats_provider: atsProvider,
    // Where it was found, distinct from where it is applied to.
    discovered_via: ['other'],
    // The sighting record built above.
    source_refs: [sourceRef],
    // A real date as `exact`, else our sighting as `derived`: decided by the shared extractor.
    posted_at,
    // Its confidence, from the same call; never `unknown` here (see the context below).
    posted_at_source,
    // Salary bounds when the feed stated positive numbers; the salary gate reads them.
    salary_min: job.salaryMin,
    salary_max: job.salaryMax,
    // The stated or default currency, so a bound is never compared across currencies blind.
    salary_currency: job.salaryCurrency,
    // persistJobBatch strips this on a refresh, so a re-sighting never rewrites it.
    first_seen_at: firstSeenAt.toISOString(),
  };
}

// The persist path's unit for one posting: the first-sighting row, and a rebuild against
// a STORED first sighting so a re-seen undated posting keeps its original derived date.
export async function remotePreparedJob(job: RemoteJob, now: Date): Promise<PreparedJob> {
  // First sighting is now.
  const row = await remoteRow(job, now, now);
  // The rebuild closes over the posting, like the ATS scout's toJobInsert hook.
  return { row, rebuild: (firstSeenAt: Date) => remoteRow(job, now, firstSeenAt) };
}
