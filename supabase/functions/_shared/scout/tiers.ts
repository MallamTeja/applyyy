// Tiered Scout Job Discovery & Provenance Tagging Engine
//
// DISCOVERY TIERS (PROJECT PRIORITY ORDER):
//   Tier 1 (Highest Priority)  — Direct Career Pages (ATS APIs: greenhouse, lever, ashby)
//                                Tag: discovery_source = 'company_career_page' or provider
//   Tier 2 (Secondary Priority) — LinkedIn Posts & Feeds (Founder & Recruiter hiring posts)
//                                Tag: discovery_source = 'linkedin_post' or 'linkedin' with { type: 'post' }
//   Tier 3 (Tertiary Priority)  — Portals & Aggregators (LinkedIn Job Portal, Naukri, Adzuna, Jooble)
//                                Tag: discovery_source = 'naukri' | 'linkedin' | 'adzuna' | 'jooble'

import type {
  AtsProvider,
  DiscoverySource,
  EmploymentType,
  JobInsert,
  JobSourceRef,
  Untrusted,
  WorkArrangement,
} from "../contracts/shared-types.ts";
import { jobFingerprint } from "../normalize/fingerprint.ts";
import { extractPostedAt, type PostedAtContext } from "../normalize/posted-at.ts";
// Apply-URL resolution. Its own module because the host check is a distinct concern with
// its own adversarial test suite, and because the next aggregator source needs it too.
import { resolveApplyUrl } from "./apply-url.ts";

export type DiscoveryTier = 1 | 2 | 3;

export interface TierClassification {
  readonly tier: DiscoveryTier;
  readonly canonicalSource: DiscoverySource;
  readonly badgeLabel: string;
  readonly badgeIcon: string;
  readonly pillTheme: "career-page" | "linkedin-post" | "portal";
}

/** Classify any discovery source and source_ref into its prioritized discovery tier. */
export function classifyDiscoveryTier(
  source: DiscoverySource | string,
  sourceRef?: Partial<JobSourceRef> | null,
  atsProvider?: AtsProvider | string | null,
): TierClassification {
  const meta = sourceRef?.metadata as Record<string, unknown> | undefined;

  // Tier 2: LinkedIn Posts & Feeds (Founder & Recruiter hiring posts, not the job board)
  if (
    source === "linkedin_post" ||
    (source === "linkedin" && meta?.type === "post") ||
    sourceRef?.provider === "linkedin_post" ||
    (typeof sourceRef?.url === "string" &&
      (sourceRef.url.includes("/feed/update/") || sourceRef.url.includes("/posts/")))
  ) {
    const author = typeof meta?.author === "string" && meta.author.trim().length > 0
      ? meta.author.trim()
      : "Hiring Lead";
    return {
      tier: 2,
      canonicalSource: "linkedin_post",
      badgeLabel: `💬 LinkedIn Post (${author})`,
      badgeIcon: "💬",
      pillTheme: "linkedin-post",
    };
  }

  // Tier 1: Direct Career Pages (ATS APIs: Greenhouse, Lever, Ashby, etc.)
  if (
    source === "company_career_page" ||
    source === "greenhouse" ||
    source === "lever" ||
    source === "ashby" ||
    source === "workable" ||
    source === "smartrecruiters" ||
    sourceRef?.provider === "company_career_page" ||
    (meta?.tier === 1)
  ) {
    const providerName =
      (atsProvider && atsProvider !== "unknown" && atsProvider !== "other")
        ? formatProviderName(atsProvider)
        : (source && source !== "company_career_page" && source !== "unknown")
          ? formatProviderName(source)
          : "Direct";

    return {
      tier: 1,
      canonicalSource: "company_career_page",
      badgeLabel: `🏢 Career Page · ${providerName}`,
      badgeIcon: "🏢",
      pillTheme: "career-page",
    };
  }

  // Tier 3: Portals & Aggregators (LinkedIn Job Board, Naukri, Adzuna, Jooble)
  const isLinkedInPortal = source === "linkedin" && meta?.type !== "post";
  let portalName = "Portal";
  if (isLinkedInPortal) {
    return {
      tier: 3,
      canonicalSource: "linkedin",
      badgeLabel: "🌐 LinkedIn Jobs",
      badgeIcon: "🌐",
      pillTheme: "portal",
    };
  }

  if (source === "naukri" || sourceRef?.provider === "naukri") {
    portalName = "Naukri";
  } else if (source === "adzuna" || sourceRef?.provider === "adzuna") {
    portalName = "Adzuna";
  } else if (source === "jooble" || sourceRef?.provider === "jooble") {
    portalName = "Jooble";
  } else if (source === "manual" || sourceRef?.provider === "manual") {
    portalName = "Manual";
  } else {
    portalName = formatProviderName(source);
  }

  return {
    tier: 3,
    canonicalSource: (source as DiscoverySource) || "other",
    badgeLabel: `🌐 Portal · ${portalName}`,
    badgeIcon: "🌐",
    pillTheme: "portal",
  };
}

function formatProviderName(val: string): string {
  if (!val) return "Direct";
  const cleaned = val.replace(/_/g, " ").trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// -----------------------------------------------------------------------------
// Tier 2: LinkedIn Hiring Post Parser
// -----------------------------------------------------------------------------

export interface LinkedInPostInput {
  readonly postUrl: string;
  readonly postText: string;
  readonly authorName?: string;
  readonly authorRole?: "founder" | "recruiter" | "hiring_lead" | string;
  readonly companyName?: string;
  readonly extractedApplyUrl?: string;
  readonly postedAt?: Date | string;
}

export interface ParsedHiringPost {
  readonly title: string;
  readonly companyName: string;
  readonly companySlug: string;
  readonly applyUrl: string;
  // FALSE when `applyUrl` is the post permalink rather than a verified ATS link, because
  // nothing trustworthy was found in the post. A consumer must route these to a human
  // instead of presenting them as somewhere to apply — an unverified link is a lead, not
  // an application target.
  readonly applyUrlVerified: boolean;
  readonly descriptionRaw: string;
  readonly locationRaw: string | null;
  readonly employmentType: EmploymentType;
  readonly workArrangement: WorkArrangement;
  readonly authorName: string;
  readonly postedAt: Date;
}

/**
 * Parses public LinkedIn founder & recruiter hiring posts (e.g. "We're hiring a Frontend Engineer",
 * "DM me resume", or direct ATS apply links).
 */
export function parseLinkedInHiringPost(input: LinkedInPostInput): ParsedHiringPost {
  const text = input.postText.trim();
  const title = extractTitleFromPost(text);
  const company = input.companyName || extractCompanyFromPost(text, input.authorName) || "Startup / Stealth";
  const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  // THE POST BODY CHOOSES NOTHING. This previously took the first http(s) string anywhere
  // in the text, which handed the destination to whoever wrote the post. Resolution now
  // validates the scheme and the host by URL PARSING (not string inspection, which a
  // userinfo trick defeats), prefers the first TRUSTED link over merely the first link,
  // and falls back to the permalink marked unverified rather than promoting an untrusted
  // candidate.
  const resolvedApplyUrl = resolveApplyUrl({
    // Our own structured extraction outranks prose, but is still validated, not exempted.
    ...(input.extractedApplyUrl === undefined ? {} : { structuredUrl: input.extractedApplyUrl }),
    postText: text,
    // The permalink is truthful about where the sighting came from, so it is the honest
    // last resort — but it is not an apply URL, which is what `verified: false` records.
    fallbackUrl: input.postUrl,
  });

  const workArrangement: WorkArrangement = text.toLowerCase().includes("remote")
    ? "remote"
    : text.toLowerCase().includes("hybrid")
      ? "hybrid"
      : text.toLowerCase().includes("onsite") || text.toLowerCase().includes("in office")
        ? "onsite"
        : "unknown";

  const employmentType: EmploymentType = text.toLowerCase().includes("intern")
    ? "internship"
    : text.toLowerCase().includes("contract")
      ? "contract"
      : text.toLowerCase().includes("part-time") || text.toLowerCase().includes("part time")
        ? "part_time"
        : "full_time";

  const postedDate = input.postedAt instanceof Date
    ? input.postedAt
    : typeof input.postedAt === "string"
      ? new Date(input.postedAt)
      : new Date();

  return {
    title,
    companyName: company,
    companySlug: slug,
    applyUrl: resolvedApplyUrl.url,
    applyUrlVerified: resolvedApplyUrl.verified,
    descriptionRaw: text,
    locationRaw: extractLocationFromPost(text),
    employmentType,
    workArrangement,
    authorName: input.authorName || "Hiring Lead",
    postedAt: isNaN(postedDate.getTime()) ? new Date() : postedDate,
  };
}

function extractTitleFromPost(text: string): string {
  // Common hiring phrases on LinkedIn: "We're hiring a <Role>", "Looking for a <Role>", "Hiring: <Role>"
  const patterns = [
    // Handles ASCII apostrophe (U+0027), left single quote (U+2018), right single quote (U+2019)
    /(?:we(?:['\u2018\u2019]re|\s+are)\s+hiring(?:\s+for)?(?:\s+an?|\s+the)?)\s+([A-Za-z0-9\s/+#.-]{3,45}?)(?:[.,!\n]|\s+to\b|\s+who\b|\s+with\b|\s+in\b|\s+at\b)/i,
    /(?:looking for(?:\s+an?|\s+the)?)\s+([A-Za-z0-9\s/+#.-]{3,45}?)(?:[.,!\n]|\s+to\b|\s+who\b|\s+with\b|\s+in\b|\s+at\b)/i,
    /(?:hiring(?:\s*:|\s*-))\s*([A-Za-z0-9\s/+#.-]{3,45}?)(?:[.,!\n]|\s+in\b|\s+at\b)/i,
    /(?:open role(?:\s*:|\s+-)?)\s*([A-Za-z0-9\s/+#.-]{3,45}?)(?:[.,!\n]|\s+in\b|\s+at\b)/i,
  ];

  for (const pat of patterns) {
    const m = text.match(pat);
    if (m && m[1] && m[1].trim().length > 0) {
      return m[1].trim();
    }
  }

  return "Software Engineer";
}

function extractCompanyFromPost(text: string, authorName?: string): string | null {
  const atPattern = /(?:at|join|joining)\s+([A-Z][A-Za-z0-9&.\s]{1,30}?)(?:[.,!\n]|\s+team|\s+family|\s+as|\s+in\b|\s+for\b)/;
  const m = text.match(atPattern);
  if (m && m[1] && m[1].trim().length > 1) {
    return m[1].trim();
  }
  if (authorName) {
    const authorTeam = `${authorName}'s Team`;
    return authorTeam;
  }
  return null;
}

function extractLocationFromPost(text: string): string | null {
  const locPattern = /(?:in|based in|location:)\s+([A-Za-z\s,]{3,30}?)(?:[.,!\n]|\s+or|\s+with)/i;
  const m = text.match(locPattern);
  return m && m[1] ? m[1].trim() : null;
}

/**
 * Builds a database row for a Tier 2 LinkedIn hiring post with proper provenance tagging.
 */
export async function buildTier2LinkedInPostJob(
  parsed: ParsedHiringPost,
  context: { now: Date; firstSeenAt: Date },
): Promise<JobInsert> {
  const fingerprint = await jobFingerprint({
    company: parsed.companyName,
    title: parsed.title,
    location: parsed.locationRaw ?? undefined,
  });

  const sourceRef: JobSourceRef = {
    provider: "linkedin_post",
    url: parsed.applyUrl as Untrusted,
    ats_job_id: null,
    first_seen_at: context.firstSeenAt.toISOString(),
    last_seen_at: context.now.toISOString(),
    metadata: {
      tier: 2,
      type: "post",
      author: parsed.authorName,
      parsed_from: "linkedin_hiring_post",
    },
  };

  return {
    fingerprint,
    title: parsed.title as Untrusted,
    company_name: parsed.companyName as Untrusted,
    company_slug: parsed.companySlug,
    location_raw: parsed.locationRaw as Untrusted | null,
    locations: [],
    work_arrangement: parsed.workArrangement,
    employment_type: parsed.employmentType,
    description_raw: parsed.descriptionRaw as Untrusted,
    apply_url: parsed.applyUrl as Untrusted,
    ats_provider: "unknown",
    ats_job_id: null,
    discovered_via: ["linkedin_post"],
    source_refs: [sourceRef],
    posted_at: parsed.postedAt.toISOString(),
    posted_at_source: "exact",
    raw_payload: {
      tier: 2,
      author: parsed.authorName,
      post_text: parsed.descriptionRaw,
      url: parsed.applyUrl,
    },
  };
}

// -----------------------------------------------------------------------------
// Tier 3: Portals & Aggregators Job Builder
// -----------------------------------------------------------------------------

export interface AggregatorJobInput {
  readonly portal: "naukri" | "linkedin" | "adzuna" | "jooble";
  readonly title: string;
  readonly companyName: string;
  readonly companySlug?: string;
  readonly applyUrl: string;
  readonly portalJobId?: string | null;
  readonly descriptionRaw?: string | null;
  readonly locationRaw?: string | null;
  readonly employmentType?: EmploymentType;
  readonly workArrangement?: WorkArrangement;
  readonly postedAt?: Date | string;
}

export async function buildTier3AggregatorJob(
  input: AggregatorJobInput,
  context: { now: Date; firstSeenAt: Date },
): Promise<JobInsert> {
  const company = input.companyName.trim();
  const slug = input.companySlug || company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const fingerprint = await jobFingerprint({
    company,
    title: input.title,
    location: input.locationRaw ?? undefined,
  });

  const postedDate = input.postedAt instanceof Date
    ? input.postedAt
    : typeof input.postedAt === "string"
      ? new Date(input.postedAt)
      : context.now;

  const sourceRef: JobSourceRef = {
    provider: input.portal,
    url: input.applyUrl as Untrusted,
    ats_job_id: input.portalJobId ?? null,
    first_seen_at: context.firstSeenAt.toISOString(),
    last_seen_at: context.now.toISOString(),
    metadata: {
      tier: 3,
      portal: input.portal,
    },
  };

  return {
    fingerprint,
    title: input.title as Untrusted,
    company_name: company as Untrusted,
    company_slug: slug,
    location_raw: (input.locationRaw ?? null) as Untrusted | null,
    locations: [],
    work_arrangement: input.workArrangement ?? "unknown",
    employment_type: input.employmentType ?? "full_time",
    description_raw: (input.descriptionRaw ?? null) as Untrusted | null,
    apply_url: input.applyUrl as Untrusted,
    ats_provider: "unknown",
    ats_job_id: input.portalJobId ?? null,
    discovered_via: [input.portal],
    source_refs: [sourceRef],
    posted_at: isNaN(postedDate.getTime()) ? context.now.toISOString() : postedDate.toISOString(),
    posted_at_source: "derived",
    raw_payload: {
      tier: 3,
      portal: input.portal,
      portal_job_id: input.portalJobId,
      url: input.applyUrl,
    },
  };
}
