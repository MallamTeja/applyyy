// The adapter registry, and the ONE shared function that turns any adapter's output
// into a database row.
//
// WHY `toJobInsert` LIVES HERE AND NOT IN EACH ADAPTER — this is the load-bearing
// decision of the whole `ats/` directory. Constraint #12 wants three independent
// adapters, and independence is genuinely right for FIELD EXTRACTION: Greenhouse
// renaming a key must not break Lever. But independence is exactly wrong for
// FINGERPRINTING and FRESHNESS. If each adapter built its own fingerprint, three
// adapters would drift into three dedupe behaviours, and the same job found on
// Greenhouse and Lever would become two rows — which is the precise failure
// `UNIQUE(user_id, fingerprint)` exists to prevent.
//
// So the split is: what the boards disagree about is per-adapter; what the system
// must agree with itself about is here. An adapter is structurally incapable of
// producing a `JobInsert` — it returns a `ParsedPosting`, and only this module can
// finish the job.

// The three shipped adapters.
import { ashbyAdapter } from "./ashby.ts";
import { greenhouseAdapter } from "./greenhouse.ts";
import { leverAdapter } from "./lever.ts";
// The adapter contract.
import type { AtsAdapter, ParsedPosting } from "./types.ts";
// The shared dedupe primitive. Async because it hashes.
import { jobFingerprint } from "../normalize/fingerprint.ts";
// The shared freshness policy, including the §13 cold-start guard.
import { extractPostedAt, type PostedAtContext } from "../normalize/posted-at.ts";
// Row shapes from the schema owner. Never redefined.
import type { AtsProvider, Json, JobInsert, JobSourceRef } from "../contracts/shared-types.ts";

// Every adapter this build knows about, keyed by the provider it submits to.
//
// PHASE 2 IS ONE LINE HERE. Adding Workable or SmartRecruiters means writing one file
// that satisfies `AtsAdapter` and adding one entry below — the Scout does not change,
// `toJobInsert` does not change, and no existing adapter is touched. That is the
// extensibility the interface was designed for, stated as a fact about this table
// rather than as an aspiration in a comment somewhere else.
const ADAPTERS: ReadonlyMap<AtsProvider, AtsAdapter> = new Map([
  // Greenhouse: `updated_at` only, so its dates can never be `exact`.
  ["greenhouse" as AtsProvider, greenhouseAdapter],
  // Lever: genuine `createdAt`, top-level array response.
  ["lever" as AtsProvider, leverAdapter],
  // Ashby: genuine publication date, and the only board exposing unlisted postings.
  ["ashby" as AtsProvider, ashbyAdapter],
]);

// Look up the adapter for a watchlist row's provider.
//
// Returns null rather than throwing for a provider we have no adapter for. That is a
// real state, not a bug: `company_watchlist.ats_provider` is an enum that already
// contains `workable` and `smartrecruiters` (Phase 2) and `unknown`, so a row can
// legitimately name a board this build cannot poll. The Scout records it and moves on
// rather than crashing the poll and taking the other boards down with it.
export function getAdapter(provider: AtsProvider): AtsAdapter | null {
  return ADAPTERS.get(provider) ?? null;
}

// Which providers this build can actually poll. Used by the Scout to select watchlist
// rows, so a board it cannot handle is never claimed in the first place.
export function supportedProviders(): readonly AtsProvider[] {
  return [...ADAPTERS.keys()];
}

// Everything `toJobInsert` needs that a posting cannot know about itself.
export interface JobInsertContext {
  // The employer name, from the WATCHLIST ROW rather than from the posting.
  //
  // WHY NOT FROM THE POSTING: Greenhouse's board response does not reliably carry the
  // company name at all — the board token IS the company. Taking it from the watchlist
  // means one authoritative spelling per employer, which is also what makes the
  // fingerprint stable: if the name came from the posting, a board that started
  // writing "Zomato Ltd" instead of "Zomato" would re-fingerprint its entire catalogue
  // overnight and every job would look new.
  readonly companyName: string;
  // The normalised slug the blocklist and the per-company weekly cap join on. Also
  // from the watchlist row, for the same stability reason.
  readonly companySlug: string;
  // The scout run's clock, injected rather than read, so "3 days ago" is testable.
  readonly now: Date;
  // When our system first observed this posting. For a new posting this is `now`.
  readonly firstSeenAt: Date;
  // THE COLD-START FLAG (§13). True on a board's very first poll, when `first_seen_at`
  // lies because the entire back catalogue arrives looking brand new. Read from
  // `company_watchlist.first_seen_at_is_trustworthy`, which is a GENERATED column
  // (`poll_count >= 1`) precisely so no caller has to remember to work it out.
  readonly isFirstPollOfBoard: boolean;
}

// Turn one parsed posting into a row ready for insert.
//
// Async because fingerprinting hashes. Everything else here is pure.
export async function toJobInsert(
  posting: ParsedPosting,
  adapter: AtsAdapter,
  context: JobInsertContext,
): Promise<JobInsert> {
  // THE SHARED FINGERPRINT. Company and title always; location when the board gave
  // one. NOTE WHAT IS ABSENT: `atsJobId`. Req ids are per-board, so including one
  // would give the same job three different fingerprints and defeat the cross-source
  // dedupe this function exists to guarantee. `JobIdentity` carries a `reqId` field
  // ONLY to document that it is deliberately ignored.
  const fingerprint = await jobFingerprint({
    company: context.companyName,
    title: posting.title,
    // `?? undefined` rather than passing null: the identity type uses optional
    // properties, and `exactOptionalPropertyTypes` makes those two different things.
    location: posting.locationRaw ?? undefined,
  });

  // THE SHARED FRESHNESS POLICY. The adapter chose the union member; this decides what
  // confidence that earns, applies the cold-start guard, and falls back to
  // `first_seen_at` when the board gave nothing usable.
  const freshnessContext: PostedAtContext = {
    now: context.now,
    firstSeenAt: context.firstSeenAt,
    isFirstPollOfBoard: context.isFirstPollOfBoard,
  };
  // Date and confidence, always as a pair — a date without its confidence is worthless
  // here, which is why the extractor refuses to return one alone.
  const { postedAt, postedAtSource } = extractPostedAt(posting.postedAtInput, freshnessContext);

  // The per-source sighting record. An array of these is what powers the reposted-job
  // signal: a gap between `last_seen_at` and today on a board we trust means the
  // posting vanished, and its return is a STRONGER hiring signal than a fresh posting.
  const sourceRef: JobSourceRef = {
    // Which board this sighting came from.
    provider: adapter.discoverySource,
    // The URL as that source gave it. UNTRUSTED.
    url: posting.applyUrl,
    // That board's own id, which IS meaningful per-source even though it is excluded
    // from the fingerprint.
    ats_job_id: posting.atsJobId,
    // First and last sighting on THIS source. Equal on a first sighting; the Normalizer
    // advances `last_seen_at` on subsequent polls.
    first_seen_at: context.firstSeenAt.toISOString(),
    last_seen_at: context.now.toISOString(),
    metadata: {
      tier: 1,
      type: "career_page",
      ats_provider: adapter.provider,
    },
  };

  // The row.
  return {
    // The dedupe key. `user_id` is deliberately absent — the column defaults to
    // `auth.uid()`, so the signed-in session decides the owner and a caller cannot
    // nominate someone else's account.
    fingerprint,
    // UNTRUSTED, straight from the board.
    title: posting.title,
    // Authoritative spelling, from the watchlist.
    company_name: context.companyName,
    // What the blocklist and weekly cap join on.
    company_slug: context.companySlug,
    // UNTRUSTED, kept verbatim so a parse bug is diagnosable against what arrived.
    location_raw: posting.locationRaw,
    // Parsed locations are left EMPTY here on purpose. Splitting "Bengaluru, India"
    // into allowlist-matchable tokens is the Normalizer's job, not the Scout's — it
    // needs the user's allowlist to know which distinctions matter, and duplicating
    // that logic per adapter is exactly the drift this module exists to prevent.
    locations: [],
    // Onsite / hybrid / remote, from structure where the board offered it.
    work_arrangement: posting.workArrangement,
    // Internship / full-time / unknown.
    employment_type: posting.employmentType,
    // UNTRUSTED AND THE HIGHEST-RISK VALUE IN THE SYSTEM. Stored inert; fenced before
    // it ever reaches Gemini (constraints #9, #17).
    description_raw: posting.descriptionRaw,
    // THE CANONICAL SUBMIT TARGET, decided once, here.
    apply_url: posting.applyUrl,
    // Which Playwright adapter submits it. Distinct from `discovered_via` below —
    // a Greenhouse job is routinely discovered through an aggregator, and conflating
    // the two would make "which adapter submits this?" unanswerable.
    ats_provider: adapter.provider,
    // The board's own id.
    ats_job_id: posting.atsJobId,
    // Where it was found. One entry now; the Normalizer merges more as other sources
    // report the same fingerprint.
    discovered_via: [adapter.discoverySource],
    // Per-source detail behind that array.
    source_refs: [sourceRef],
    // NOT NULL by schema: absence is carried by the confidence below, never by a null
    // date, so no consumer has to handle two representations of "we don't know".
    posted_at: postedAt,
    // How much to believe it. `unknown` here has EXACTLY ONE CAUSE — the cold-start
    // guard — and NEVER means a parse failure; every degraded input resolved to
    // `derived` inside the extractor. A reader who assumes otherwise writes the wrong
    // filter, which is why it is restated at the point of write.
    posted_at_source: postedAtSource,
    // The board's raw JSON, so a parser bug can be re-run over history without
    // re-polling a board that may have moved on. UNTRUSTED.
    //
    // Cast to `Json` rather than to `JobInsert["raw_payload"]`: the column is an
    // OPTIONAL property, so indexing its type under `exactOptionalPropertyTypes`
    // yields `Json | null | undefined`, and assigning a possibly-undefined value to a
    // property we are explicitly setting is exactly what that flag exists to reject.
    // The value itself is genuinely JSON — it was `JSON.parse`d out of the response.
    raw_payload: posting.rawPayload as Json,
  };
}
