/* Target-company catalog, with every board token carrying its own provenance.
 *
 * WHAT THIS FILE CONTROLS. The Scout only polls boards that have been registered
 * on the Watchlist page. Deciding which companies to add is a high-stakes
 * friction point for the operator: each board must be mapped to its exact ATS
 * provider (greenhouse, lever, ashby, workable, smartrecruiters) and its careers token.
 *
 * WHY THE `verification` FIELD EXISTS — READ THIS BEFORE ADDING A ROW.
 *   Until 2026-09-17 every `atsIdentifier` here was the lowercase company name
 *   (`atlassian`, `zomato`, `tcs`) — a name-guessing heuristic presented to the
 *   operator as curated fact. A one-click add for a company whose board does not
 *   exist writes a watchlist row that polls NOTHING, FOREVER, while rendering on
 *   the Watchlist page as coverage. That is this repo's signature bug: missing
 *   data becoming an answer.
 *   The heuristic is not merely unreliable, it is unsound: Razorpay's real
 *   greenhouse token is `razorpaysoftwareprivatelimited` (the registered legal
 *   entity), which no name-derived guess produces, and India-registered companies
 *   commonly use the legal-entity slug.
 *   So `SuggestedCompany.verification` is a REQUIRED discriminated union. There is
 *   no default and no optional boolean: a new row cannot compile without stating
 *   which of the three states it is in, and a reader cannot mistake a guess for a
 *   measurement. See `BoardVerification` below for what each state means.
 *
 * WHAT "VERIFIED" MEANS HERE, EXACTLY.
 *   A live HTTP probe on 2026-09-17 fetched the board, parsed well-shaped JSON and
 *   counted at least one live posting. It verifies the TOKEN and the PROVIDER.
 *   It does NOT verify `location`, `domain`, `category` or `cooldown` — those are
 *   editorial and have never been checked against anything.
 *
 * FOUR CATEGORIES TARGETED FOR INTERNSHIP & FTE ROLES:
 *   1. GCCs (Global Capability Centers) - High engineering bar, massive infrastructure,
 *      structured hiring waves (Target, Fidelity, Walmart Global Tech, Wells Fargo, etc.).
 *   2. Mid-Scale Product MNCs - Deep systems engineering, cloud/data platforms, and
 *      modern stacks (Databricks, Snowflake, Stripe, MongoDB, GitLab, Elastic).
 *   3. High-Growth Startups & Unicorns - Rapid velocity, modern developer tools,
 *      high-concurrency fintech/logistics (Razorpay, CRED, Groww, Paytm, Brex, etc.).
 *   4. Service-Based & Consulting Firms - High volume, enterprise digital transformation,
 *      large developer headcount (Thoughtworks, Nagarro, Persistent, EPAM, TCS, Infosys).
 *
 * COOLDOWN FIELDS ARE OPERATOR GUIDANCE, NOT VERIFIED POLICY.
 *   Companies enforce cooling-off windows after an interview rejection (typically
 *   3 to 12 months) or a resume screening rejection (often none or 3 months).
 *   The numbers below were entered by hand and nothing has ever checked them
 *   against a published policy. Treat them as a prompt to look it up, not as fact.
 */

import type { AtsProvider } from '../../data/contract';

export type CompanyCategory =
  | 'GCC'
  | 'Mid-Scale MNC'
  | 'Startup / Unicorn'
  | 'Service-Based';

export type SupportedAtsProvider =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'workable'
  | 'smartrecruiters';

/* One date for the whole sweep, so a reader can tell at a glance that every
 * `probedOn` below came from the SAME run rather than from rows aged
 * independently. When the next sweep happens it gets its own constant; do not
 * repoint this one, or rows that were never re-probed will silently claim to be
 * fresh. */
export const BOARD_PROBE_DATE_2026_09_17 = '2026-09-17' as const;

/* What we know about where an employer actually recruits, once we have
 * established it is NOT on greenhouse/lever/ashby.
 *
 * Modelled as a union rather than `portal?: string` so that "we have no idea"
 * is a state you must SELECT, not a field you can forget. `confirmed` and
 * `believed` are deliberately different words and must stay that way:
 * `confirmed` means someone loaded the portal and saw the employer's postings;
 * `believed` means it is the strong expectation and nobody has loaded it. */
export type RealPortalKnowledge =
  /* Someone looked and the portal serves this employer's postings. */
  | { readonly confidence: 'confirmed'; readonly portal: string }
  /* Strongly expected from the employer's careers page shape, not yet loaded. */
  | { readonly confidence: 'believed'; readonly portal: string }
  /* No portal established. This is the honest default and there is no
   * `portal` field on it at all, so nobody can half-fill it with a guess. */
  | { readonly confidence: 'unknown' };

/* The provenance of a single board token: the whole point of this file.
 *
 * Three states, closed union, discriminated on `kind`. A `switch` over it that
 * misses an arm fails to compile, which is the property we want — the next
 * person to add a UI affordance for verified boards cannot silently let the
 * other two fall through as "fine". */
export type BoardVerification =
  /* Probed and answered: a real board, real postings, on a stated date. */
  | {
      readonly kind: 'verified';
      /* When, so a stale verification is visible as stale rather than as truth. */
      readonly probedOn: string;
      /* How many live postings the probe counted — the thing that distinguishes
       * "the board exists" from "the board exists and is being used". */
      readonly liveJobCount: number;
      /* What did the verifying, recorded because "verified" with no method
       * behind it is just a stronger-sounding guess. */
      readonly evidence: 'parsed-board-json';
    }
  /* Probed and refuted: no board on greenhouse/lever/ashby under any plausible
   * slug. The row is KEPT rather than deleted — a half-removed catalog is worse
   * than a marked one — but nothing here may be offered as pollable. */
  | {
      readonly kind: 'no-board-found';
      readonly probedOn: string;
      readonly realPortal: RealPortalKnowledge;
    }
  /* Never probed. The token is whatever the original author typed, which for
   * this catalog means the lowercase company name. Not a claim that the board
   * is missing — a claim that NOBODY HAS LOOKED. */
  | { readonly kind: 'unverified' };

/* Shared value for every never-probed row. A single named constant makes the
 * unverified rows greppable and keeps the word "unverified" in front of the
 * reader on the row itself, which a bare `{ kind: 'unverified' }` object literal
 * repeated sixty times would not do any better but would be easier to typo. */
export const UNVERIFIED_TOKEN: BoardVerification = { kind: 'unverified' };

/* Shared value for the common not-found case: probed, absent, and no
 * replacement portal established. Declared once because inventing a portal to
 * fill the gap is exactly the failure this file exists to stop. */
export const NO_BOARD_FOUND_PORTAL_UNKNOWN: BoardVerification = {
  kind: 'no-board-found',
  probedOn: BOARD_PROBE_DATE_2026_09_17,
  realPortal: { confidence: 'unknown' },
};

/* Probed, absent, and Workday is the strong expectation from the employer's
 * careers page — but nobody has loaded the Workday tenant to see postings, so
 * this says `believed` and not `confirmed`. */
export const NO_BOARD_FOUND_WORKDAY_BELIEVED: BoardVerification = {
  kind: 'no-board-found',
  probedOn: BOARD_PROBE_DATE_2026_09_17,
  realPortal: { confidence: 'believed', portal: 'workday' },
};

export interface CompanyCooldown {
  readonly interview: string;
  readonly screening: string;
  readonly notes?: string | undefined;
}

/* Cooldown value for rows added on 2026-09-17. The probe verified board tokens
 * and nothing else, so claiming "6 Months" for a company whose policy nobody
 * read would be fabricating in the same breath as fixing a fabrication. */
export const COOLDOWN_NOT_ON_RECORD: CompanyCooldown = {
  interview: 'Unknown',
  screening: 'Unknown',
  notes: 'No cooldown policy on record; confirm with the employer before reapplying.',
};

export interface SuggestedCompany {
  readonly name: string;
  readonly category: CompanyCategory;
  readonly domain: string;
  readonly location: string;
  readonly atsProvider: AtsProvider;
  readonly atsIdentifier: string; // The board slug
  readonly cooldown: CompanyCooldown;
  /* REQUIRED, deliberately. Every consumer that reads `atsIdentifier` is reading
   * a value whose trustworthiness lives here, and a row author must answer the
   * question rather than inherit a comfortable default. */
  readonly verification: BoardVerification;
}

/* A company whose board we have actually seen respond. Narrowing to this type is
 * the only honest way to say "safe to poll", and it is a TYPE rather than a
 * predicate result so a function can demand one in its signature. */
export type PollableCompany = SuggestedCompany & {
  readonly verification: Extract<BoardVerification, { kind: 'verified' }>;
};

/* Type guard so UI code can narrow instead of re-deriving the rule. Written as a
 * guard rather than a boolean helper because the caller then gets the narrowed
 * type for free and cannot read `probedOn` off an unverified row. */
export function isPollable(company: SuggestedCompany): company is PollableCompany {
  return company.verification.kind === 'verified';
}

export const AVAILABLE_LOCATIONS = [
  'All Locations',
  'Bengaluru',
  'Hyderabad',
  'Pune',
  'Delhi NCR',
  'Mumbai',
  'Remote / Global',
] as const;

export type AvailableLocation = (typeof AVAILABLE_LOCATIONS)[number];

/**
 * Catalog of target employers. `atsProvider` + `atsIdentifier` are TRUSTWORTHY
 * ONLY where `verification.kind === 'verified'`; everywhere else they are a
 * guess or a known-dead token being kept as a record. `location`, `domain`,
 * `category` and `cooldown` are editorial on every row without exception.
 *
 * ONE CONFLICT IN THE SOURCE DATA, RESOLVED AND RECORDED. The 2026-09-17 brief
 * listed some companies (Salesforce, Figma, Snowflake, Postman, Atlassian,
 * BrowserStack, CRED, Groww, Razorpay, PhonePe, Meesho, Zepto, Swiggy, Zomato,
 * Target India, Intuit India and others) BOTH in a probe result table AND in a
 * list of entries it said were never probed. Rule applied here: a probe table
 * carries an observation (a job count, or "not found under any plausible slug")
 * and the "not probed" list carries none, so the probe table wins. Anything in
 * neither is `unverified`. Re-check before treating a `no-board-found` row here
 * as final.
 */
export const CURATED_COMPANIES: readonly SuggestedCompany[] = [
  // =========================================================================
  // 1. GCCs (Global Capability Centers)
  // =========================================================================
  {
    name: 'Target India',
    category: 'GCC',
    domain: 'Retail Tech / Cloud / Supply Chain',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'target',
    cooldown: { interview: '6 Months', screening: 'None / 3 Months' },
    // Probed 2026-09-17 under this and other plausible slugs; no board answered.
    verification: NO_BOARD_FOUND_PORTAL_UNKNOWN,
  },
  {
    name: 'Fidelity Investments',
    category: 'GCC',
    domain: 'FinTech / Enterprise Cloud Platforms',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'fidelity',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Not in either probe table, so nobody has looked: token is still the name.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'Walmart Global Tech',
    category: 'GCC',
    domain: 'Distributed Systems / High-Scale Cloud',
    location: 'Bengaluru',
    atsProvider: 'lever',
    atsIdentifier: 'walmart',
    cooldown: { interview: '6 Months', screening: '3 Months' },
    // Probed 2026-09-17: absent from all three ATSes; replacement portal unknown.
    verification: NO_BOARD_FOUND_PORTAL_UNKNOWN,
  },
  {
    name: "Lowe's India",
    category: 'GCC',
    domain: 'Omnichannel Retail / Cloud Infrastructure',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'lowes',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Never probed; `lowes` is the name-guessing heuristic, not a finding.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'Wells Fargo India',
    category: 'GCC',
    domain: 'Banking Tech / Payments / Security',
    location: 'Hyderabad',
    atsProvider: 'greenhouse',
    atsIdentifier: 'wellsfargo',
    cooldown: { interview: '6 Months', screening: '3 Months' },
    // Never probed.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'PayPal India',
    category: 'GCC',
    domain: 'High-Volume Payments / Anti-Fraud / Distributed Data',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'paypal',
    cooldown: { interview: '6–12 Months', screening: 'None' },
    // Never probed.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'Intuit India',
    category: 'GCC',
    domain: 'Financial SaaS / AI Tax Engines / TurboTax',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'intuit',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Probed 2026-09-17 as "Intuit": no board. Portal explicitly UNKNOWN — the
    // brief named Intuit among the companies where no portal may be assumed.
    verification: NO_BOARD_FOUND_PORTAL_UNKNOWN,
  },
  {
    name: 'Goldman Sachs',
    category: 'GCC',
    domain: 'Algorithmic Trading / Asset Management / Quant Tech',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'goldmansachs',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Probed 2026-09-17: no board on any of the three ATSes.
    verification: NO_BOARD_FOUND_PORTAL_UNKNOWN,
  },
  {
    name: 'JPMorgan Chase',
    category: 'GCC',
    domain: 'Investment Banking Tech / Global Ledger Architecture',
    location: 'Hyderabad',
    atsProvider: 'greenhouse',
    atsIdentifier: 'jpmorganchase',
    cooldown: { interview: '6 Months', screening: '3 Months' },
    // Probed 2026-09-17: no board.
    verification: NO_BOARD_FOUND_PORTAL_UNKNOWN,
  },
  {
    name: 'American Express',
    category: 'GCC',
    domain: 'Risk Decisioning / Distributed Authorization',
    location: 'Delhi NCR',
    atsProvider: 'greenhouse',
    atsIdentifier: 'amex',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Probed 2026-09-17: no board.
    verification: NO_BOARD_FOUND_PORTAL_UNKNOWN,
  },
  {
    name: 'Nike Tech',
    category: 'GCC',
    domain: 'Direct-to-Consumer Cloud / Mobile Commerce',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'nike',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Never probed.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'Boeing India',
    category: 'GCC',
    domain: 'Avionics Systems / Simulation / Flight Analytics',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'boeing',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Never probed.
    verification: UNVERIFIED_TOKEN,
  },

  // =========================================================================
  // 2. Mid-Scale Product MNCs
  // =========================================================================
  {
    name: 'Databricks',
    category: 'Mid-Scale MNC',
    domain: 'Big Data / Apache Spark / Lakehouse AI Platforms',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'databricks',
    cooldown: { interview: '12 Months', screening: '6 Months' },
    // Token happened to be right: 879 live postings parsed on 2026-09-17.
    verification: {
      kind: 'verified',
      probedOn: BOARD_PROBE_DATE_2026_09_17,
      liveJobCount: 879,
      evidence: 'parsed-board-json',
    },
  },
  {
    name: 'Snowflake',
    category: 'Mid-Scale MNC',
    domain: 'Cloud Data Warehousing & SQL Engine Internals',
    location: 'Pune',
    // PROVIDER CORRECTED 2026-09-17: recorded as greenhouse, actually ashby.
    // A wrong provider fails exactly like a wrong token — the poll 404s forever.
    atsProvider: 'ashby',
    atsIdentifier: 'snowflake',
    cooldown: { interview: '6–12 Months', screening: '6 Months' },
    verification: {
      kind: 'verified',
      probedOn: BOARD_PROBE_DATE_2026_09_17,
      liveJobCount: 346,
      evidence: 'parsed-board-json',
    },
  },
  {
    name: 'Atlassian',
    category: 'Mid-Scale MNC',
    domain: 'Developer Collaboration / Jira / Confluence Cloud',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'atlassian',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Probed 2026-09-17: the `atlassian` token was fabricated and no board
    // exists under it or any variant. Portal explicitly UNKNOWN — do not guess.
    verification: NO_BOARD_FOUND_PORTAL_UNKNOWN,
  },
  {
    name: 'MongoDB',
    category: 'Mid-Scale MNC',
    domain: 'Database Internals & Distributed Storage',
    location: 'Delhi NCR',
    atsProvider: 'greenhouse',
    atsIdentifier: 'mongodb',
    cooldown: { interview: '6–12 Months', screening: 'None' },
    // Never probed.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'Stripe',
    category: 'Mid-Scale MNC',
    domain: 'Global Payments & Financial Infrastructure',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'stripe',
    cooldown: { interview: '12 Months', screening: '6 Months' },
    verification: {
      kind: 'verified',
      probedOn: BOARD_PROBE_DATE_2026_09_17,
      liveJobCount: 654,
      evidence: 'parsed-board-json',
    },
  },
  {
    name: 'GitLab',
    category: 'Mid-Scale MNC',
    domain: 'DevOps / Remote Platform / CI/CD Infrastructure',
    location: 'Remote / Global',
    atsProvider: 'greenhouse',
    atsIdentifier: 'gitlab',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Never probed.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'Uber',
    category: 'Mid-Scale MNC',
    domain: 'Mobility / Realtime Geospatial & Routing Systems',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'uber',
    cooldown: { interview: '6–12 Months', screening: 'None' },
    // Probed 2026-09-17: no board on greenhouse/lever/ashby.
    verification: NO_BOARD_FOUND_PORTAL_UNKNOWN,
  },
  {
    name: 'Rubrik',
    category: 'Mid-Scale MNC',
    domain: 'Zero Trust Data Security / Ransomware Recovery',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'rubrik',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Never probed.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'Rippling',
    category: 'Mid-Scale MNC',
    domain: 'Workforce Platform / Unified Directory / Identity',
    location: 'Bengaluru',
    atsProvider: 'lever',
    atsIdentifier: 'rippling',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Never probed.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'Figma',
    category: 'Mid-Scale MNC',
    domain: 'Collaborative Design / WebGL / Canvas Internals',
    location: 'Remote / Global',
    // PROVIDER CORRECTED 2026-09-17: recorded as lever, actually greenhouse.
    atsProvider: 'greenhouse',
    atsIdentifier: 'figma',
    cooldown: { interview: '6–12 Months', screening: 'None' },
    verification: {
      kind: 'verified',
      probedOn: BOARD_PROBE_DATE_2026_09_17,
      liveJobCount: 153,
      evidence: 'parsed-board-json',
    },
  },
  {
    name: 'Notion',
    category: 'Mid-Scale MNC',
    domain: 'Productivity & AI Workspace Architecture',
    location: 'Remote / Global',
    atsProvider: 'lever',
    atsIdentifier: 'notion',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Never probed.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'Salesforce',
    category: 'Mid-Scale MNC',
    domain: 'Enterprise CRM / Hyperforce / Apex Runtime',
    location: 'Hyderabad',
    atsProvider: 'greenhouse',
    atsIdentifier: 'salesforce',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Probed 2026-09-17: no board. Portal explicitly UNKNOWN per the brief.
    verification: NO_BOARD_FOUND_PORTAL_UNKNOWN,
  },
  {
    name: 'Twilio',
    category: 'Mid-Scale MNC',
    domain: 'Telecommunications API / WebRTC / Event-Driven Messaging',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'twilio',
    cooldown: { interview: '6 Months', screening: 'None' },
    verification: {
      kind: 'verified',
      probedOn: BOARD_PROBE_DATE_2026_09_17,
      liveJobCount: 148,
      evidence: 'parsed-board-json',
    },
  },
  {
    name: 'DoorDash',
    category: 'Mid-Scale MNC',
    domain: 'Logistics Dispatch / Matching Algorithms / Kotlin Services',
    location: 'Remote / Global',
    atsProvider: 'greenhouse',
    atsIdentifier: 'doordash',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Never probed.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'Canva',
    category: 'Mid-Scale MNC',
    domain: 'Visual Content Generation / WebAssembly / Cloud Rendering',
    location: 'Remote / Global',
    atsProvider: 'greenhouse',
    atsIdentifier: 'canva',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Probed 2026-09-17: no board on greenhouse/lever/ashby.
    verification: NO_BOARD_FOUND_PORTAL_UNKNOWN,
  },

  /* ---- Added 2026-09-17: boards the probe found and the catalog lacked. ----
   * `location` on these is editorial like every other row — the probe verified
   * the board, never the office. `Remote / Global` is used where the hiring
   * geography was not established, so the location filter under-reports rather
   * than inventing a city. Cooldowns are COOLDOWN_NOT_ON_RECORD for the same
   * reason: fixing a fabrication by adding a new one is not an improvement. */
  {
    name: 'Confluent',
    category: 'Mid-Scale MNC',
    domain: 'Event Streaming / Apache Kafka Cloud Platform',
    location: 'Remote / Global',
    atsProvider: 'ashby',
    atsIdentifier: 'confluent',
    cooldown: COOLDOWN_NOT_ON_RECORD,
    verification: {
      kind: 'verified',
      probedOn: BOARD_PROBE_DATE_2026_09_17,
      liveJobCount: 21,
      evidence: 'parsed-board-json',
    },
  },
  {
    name: 'Okta',
    category: 'Mid-Scale MNC',
    domain: 'Identity & Access Management / SSO Infrastructure',
    location: 'Remote / Global',
    atsProvider: 'greenhouse',
    atsIdentifier: 'okta',
    cooldown: COOLDOWN_NOT_ON_RECORD,
    verification: {
      kind: 'verified',
      probedOn: BOARD_PROBE_DATE_2026_09_17,
      liveJobCount: 322,
      evidence: 'parsed-board-json',
    },
  },
  {
    name: 'Elastic',
    category: 'Mid-Scale MNC',
    domain: 'Search Engine Internals / Observability / Distributed Indexing',
    location: 'Remote / Global',
    atsProvider: 'greenhouse',
    atsIdentifier: 'elastic',
    cooldown: COOLDOWN_NOT_ON_RECORD,
    verification: {
      kind: 'verified',
      probedOn: BOARD_PROBE_DATE_2026_09_17,
      liveJobCount: 360,
      evidence: 'parsed-board-json',
    },
  },
  {
    name: 'Palantir',
    category: 'Mid-Scale MNC',
    domain: 'Data Integration Platforms / Ontology & Decision Systems',
    location: 'Remote / Global',
    atsProvider: 'lever',
    atsIdentifier: 'palantir',
    cooldown: COOLDOWN_NOT_ON_RECORD,
    verification: {
      kind: 'verified',
      probedOn: BOARD_PROBE_DATE_2026_09_17,
      liveJobCount: 313,
      evidence: 'parsed-board-json',
    },
  },
  {
    name: 'Coinbase',
    category: 'Mid-Scale MNC',
    domain: 'Crypto Exchange / Custody & High-Throughput Ledgers',
    location: 'Remote / Global',
    atsProvider: 'greenhouse',
    atsIdentifier: 'coinbase',
    cooldown: COOLDOWN_NOT_ON_RECORD,
    verification: {
      kind: 'verified',
      probedOn: BOARD_PROBE_DATE_2026_09_17,
      liveJobCount: 220,
      evidence: 'parsed-board-json',
    },
  },
  {
    name: 'Microsoft AI',
    // Filed under Mid-Scale MNC because the four-way taxonomy has no bucket for
    // a hyperscaler. Flagged rather than silently distorted: the category is a
    // filter facet, and forcing Microsoft into `GCC` would make the GCC filter
    // mean something different from what its label says.
    category: 'Mid-Scale MNC',
    domain: 'Applied AI Research / Copilot & Model Serving',
    location: 'Remote / Global',
    atsProvider: 'greenhouse',
    // The legal-entity slug, not the brand name — the same shape as Razorpay's,
    // and the single clearest proof that name-guessing cannot produce a token.
    atsIdentifier: 'microsoftcorporation',
    cooldown: COOLDOWN_NOT_ON_RECORD,
    verification: {
      kind: 'verified',
      probedOn: BOARD_PROBE_DATE_2026_09_17,
      liveJobCount: 40,
      evidence: 'parsed-board-json',
    },
  },
  {
    name: 'Airbnb',
    category: 'Mid-Scale MNC',
    domain: 'Marketplace Platform / Trust & Safety / Search Ranking',
    location: 'Remote / Global',
    atsProvider: 'greenhouse',
    atsIdentifier: 'airbnb',
    cooldown: COOLDOWN_NOT_ON_RECORD,
    verification: {
      kind: 'verified',
      probedOn: BOARD_PROBE_DATE_2026_09_17,
      liveJobCount: 163,
      evidence: 'parsed-board-json',
    },
  },
  {
    name: 'UiPath',
    category: 'Mid-Scale MNC',
    domain: 'Robotic Process Automation / Workflow Orchestration',
    location: 'Remote / Global',
    atsProvider: 'ashby',
    atsIdentifier: 'uipath',
    cooldown: COOLDOWN_NOT_ON_RECORD,
    verification: {
      kind: 'verified',
      probedOn: BOARD_PROBE_DATE_2026_09_17,
      liveJobCount: 107,
      evidence: 'parsed-board-json',
    },
  },
  {
    name: 'Dropbox',
    category: 'Mid-Scale MNC',
    domain: 'Distributed Storage / Sync Engine / Content Collaboration',
    location: 'Remote / Global',
    atsProvider: 'greenhouse',
    atsIdentifier: 'dropbox',
    cooldown: COOLDOWN_NOT_ON_RECORD,
    verification: {
      kind: 'verified',
      probedOn: BOARD_PROBE_DATE_2026_09_17,
      liveJobCount: 41,
      evidence: 'parsed-board-json',
    },
  },
  {
    name: 'Checkout.com',
    category: 'Mid-Scale MNC',
    domain: 'Global Payments Processing / Acquiring & Risk',
    location: 'Remote / Global',
    atsProvider: 'ashby',
    // The dot is part of the real token. Left exactly as probed — "tidying" it
    // to `checkoutcom` would recreate the guessing this file exists to end.
    atsIdentifier: 'checkout.com',
    cooldown: COOLDOWN_NOT_ON_RECORD,
    verification: {
      kind: 'verified',
      probedOn: BOARD_PROBE_DATE_2026_09_17,
      liveJobCount: 160,
      evidence: 'parsed-board-json',
    },
  },

  // =========================================================================
  // 3. Fast-Growing Startups & Unicorns
  // =========================================================================
  {
    name: 'Postman',
    category: 'Startup / Unicorn',
    domain: 'API Tooling & Developer Collaboration Platforms',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'postman',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Probed 2026-09-17: no board. Portal explicitly UNKNOWN per the brief.
    verification: NO_BOARD_FOUND_PORTAL_UNKNOWN,
  },
  {
    name: 'Razorpay',
    category: 'Startup / Unicorn',
    domain: 'FinTech / High-Throughput Payment Gateways',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    // TOKEN CORRECTED 2026-09-17: was `razorpay`, a name guess that polls
    // nothing. The real token is the registered legal entity, discoverable only
    // by scraping razorpay.com/jobs — this row is the proof case for the whole
    // `verification` field.
    atsIdentifier: 'razorpaysoftwareprivatelimited',
    cooldown: { interview: '3–6 Months', screening: 'None' },
    verification: {
      kind: 'verified',
      probedOn: BOARD_PROBE_DATE_2026_09_17,
      liveJobCount: 19,
      evidence: 'parsed-board-json',
    },
  },
  {
    name: 'BrowserStack',
    category: 'Startup / Unicorn',
    domain: 'Cloud Testing Infrastructure & Device Farms',
    location: 'Mumbai',
    atsProvider: 'greenhouse',
    atsIdentifier: 'browserstack',
    cooldown: { interview: '3–6 Months', screening: 'None' },
    // Probed 2026-09-17: no board. Workday is BELIEVED, not confirmed — nobody
    // has loaded the tenant, so re-check before building anything on it.
    verification: NO_BOARD_FOUND_WORKDAY_BELIEVED,
  },
  {
    name: 'CRED',
    category: 'Startup / Unicorn',
    domain: 'FinTech / High-Concurrency Architecture & Microservices',
    location: 'Bengaluru',
    atsProvider: 'lever',
    atsIdentifier: 'cred',
    cooldown: { interview: '6 Months', screening: 'None' },
    verification: {
      kind: 'verified',
      probedOn: BOARD_PROBE_DATE_2026_09_17,
      liveJobCount: 11,
      evidence: 'parsed-board-json',
    },
  },
  {
    name: 'Groww',
    category: 'Startup / Unicorn',
    domain: 'WealthTech / Investment Platforms / Stock Broking',
    location: 'Bengaluru',
    // PROVIDER CORRECTED 2026-09-17: recorded as lever, actually greenhouse.
    atsProvider: 'greenhouse',
    atsIdentifier: 'groww',
    cooldown: { interview: '3–6 Months', screening: 'None' },
    verification: {
      kind: 'verified',
      probedOn: BOARD_PROBE_DATE_2026_09_17,
      liveJobCount: 8,
      evidence: 'parsed-board-json',
    },
  },
  {
    name: 'Zepto',
    category: 'Startup / Unicorn',
    domain: 'Quick-Commerce & Hyperlocal Logistics Tech',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'zepto',
    cooldown: { interview: '3 Months', screening: 'None' },
    // Probed 2026-09-17: no board on greenhouse/lever/ashby.
    verification: NO_BOARD_FOUND_PORTAL_UNKNOWN,
  },
  {
    name: 'CleverTap',
    category: 'Startup / Unicorn',
    domain: 'Real-time Analytics & Customer Engagement',
    location: 'Mumbai',
    atsProvider: 'greenhouse',
    atsIdentifier: 'clevertap',
    cooldown: { interview: '3 Months', screening: 'None' },
    // Never probed.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'PhonePe',
    category: 'Startup / Unicorn',
    domain: 'FinTech / UPI Payments & Distributed Storage',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'phonepe',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Probed 2026-09-17: no board on greenhouse/lever/ashby.
    verification: NO_BOARD_FOUND_PORTAL_UNKNOWN,
  },
  {
    name: 'Swiggy',
    category: 'Startup / Unicorn',
    domain: 'On-Demand Delivery / Hyperlocal Routing / Geofencing',
    location: 'Bengaluru',
    atsProvider: 'lever',
    atsIdentifier: 'swiggy',
    cooldown: { interview: '3–6 Months', screening: 'None' },
    // Probed 2026-09-17: no board on greenhouse/lever/ashby.
    verification: NO_BOARD_FOUND_PORTAL_UNKNOWN,
  },
  {
    name: 'Meesho',
    category: 'Startup / Unicorn',
    domain: 'Social Commerce / ML Recommendation Engines',
    location: 'Bengaluru',
    // PROVIDER CORRECTED 2026-09-17: recorded as greenhouse, actually lever.
    atsProvider: 'lever',
    atsIdentifier: 'meesho',
    cooldown: { interview: '3–6 Months', screening: 'None' },
    verification: {
      kind: 'verified',
      probedOn: BOARD_PROBE_DATE_2026_09_17,
      liveJobCount: 49,
      evidence: 'parsed-board-json',
    },
  },
  {
    // Added 2026-09-17 from the probe; Delhi NCR matches the catalog's existing
    // convention of naming the Indian hub an employer recruits into.
    name: 'Paytm',
    category: 'Startup / Unicorn',
    domain: 'FinTech / UPI & Merchant Payment Infrastructure',
    location: 'Delhi NCR',
    atsProvider: 'lever',
    atsIdentifier: 'paytm',
    cooldown: COOLDOWN_NOT_ON_RECORD,
    verification: {
      kind: 'verified',
      probedOn: BOARD_PROBE_DATE_2026_09_17,
      liveJobCount: 204,
      evidence: 'parsed-board-json',
    },
  },
  {
    name: 'Brex',
    category: 'Startup / Unicorn',
    domain: 'Corporate Spend Management / Ledger & Card Issuing',
    location: 'Remote / Global',
    atsProvider: 'greenhouse',
    atsIdentifier: 'brex',
    cooldown: COOLDOWN_NOT_ON_RECORD,
    verification: {
      kind: 'verified',
      probedOn: BOARD_PROBE_DATE_2026_09_17,
      liveJobCount: 261,
      evidence: 'parsed-board-json',
    },
  },
  {
    name: 'Plaid',
    category: 'Startup / Unicorn',
    domain: 'Open Banking APIs / Financial Data Connectivity',
    location: 'Remote / Global',
    atsProvider: 'ashby',
    atsIdentifier: 'plaid',
    cooldown: COOLDOWN_NOT_ON_RECORD,
    verification: {
      kind: 'verified',
      probedOn: BOARD_PROBE_DATE_2026_09_17,
      liveJobCount: 110,
      evidence: 'parsed-board-json',
    },
  },
  {
    name: 'Urban Company',
    category: 'Startup / Unicorn',
    domain: 'Home Services Marketplace / Realtime Provider Matching',
    location: 'Delhi NCR',
    atsProvider: 'greenhouse',
    atsIdentifier: 'urbancompany',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Never probed.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'Zomato',
    category: 'Startup / Unicorn',
    domain: 'Food Delivery & Hyperlocal Inventory Optimization',
    location: 'Delhi NCR',
    atsProvider: 'greenhouse',
    atsIdentifier: 'zomato',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Probed 2026-09-17: no board on greenhouse/lever/ashby.
    verification: NO_BOARD_FOUND_PORTAL_UNKNOWN,
  },
  {
    name: 'Dream11',
    category: 'Startup / Unicorn',
    domain: 'Sports Gaming Tech / Extreme Concurrency Leaderboards',
    location: 'Mumbai',
    atsProvider: 'greenhouse',
    atsIdentifier: 'dream11',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Never probed.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'Licious',
    category: 'Startup / Unicorn',
    domain: 'Direct-to-Consumer Fresh Food Supply Chain Tech',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'licious',
    cooldown: { interview: '3 Months', screening: 'None' },
    // Never probed.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'slice',
    category: 'Startup / Unicorn',
    domain: 'Neo-Banking / Credit Ledger & Embedded Finance',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'slice',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Never probed.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'CoinSwitch',
    category: 'Startup / Unicorn',
    domain: 'Crypto Exchange / High-Throughput Matching Engine',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'coinswitch',
    cooldown: { interview: '3–6 Months', screening: 'None' },
    // Never probed.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'Apna',
    category: 'Startup / Unicorn',
    domain: 'Professional Networking & Job Marketplace',
    location: 'Bengaluru',
    atsProvider: 'lever',
    atsIdentifier: 'apna',
    cooldown: { interview: '3 Months', screening: 'None' },
    // Never probed.
    verification: UNVERIFIED_TOKEN,
  },

  // =========================================================================
  // 4. Service-Based & Consulting Tech Leaders
  // =========================================================================
  {
    name: 'Thoughtworks',
    category: 'Service-Based',
    domain: 'Agile Software Consulting / Evolutionary Architecture',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'thoughtworks',
    cooldown: { interview: '6 Months', screening: 'None' },
    // The name guess happened to match the real token here — which is why a
    // comment saying "looks fine" was never enough; only the probe settles it.
    verification: {
      kind: 'verified',
      probedOn: BOARD_PROBE_DATE_2026_09_17,
      liveJobCount: 40,
      evidence: 'parsed-board-json',
    },
  },
  {
    name: 'Nagarro',
    category: 'Service-Based',
    domain: 'Digital Engineering / Cloud Native Platforms',
    location: 'Delhi NCR',
    atsProvider: 'smartrecruiters',
    atsIdentifier: 'nagarro',
    cooldown: { interview: '3–6 Months', screening: 'None' },
    // Never probed — and note the probe only covered greenhouse/lever/ashby, so
    // smartrecruiters rows could not have been settled by it either way.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'Persistent Systems',
    category: 'Service-Based',
    domain: 'Enterprise Software & Cloud Modernization',
    location: 'Pune',
    atsProvider: 'smartrecruiters',
    atsIdentifier: 'persistentsystems',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Never probed; smartrecruiters was outside the sweep.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'EPAM Systems',
    category: 'Service-Based',
    domain: 'Global Platform Engineering & Product Development',
    location: 'Hyderabad',
    atsProvider: 'greenhouse',
    atsIdentifier: 'epam',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Probed 2026-09-17: no board on greenhouse/lever/ashby.
    verification: NO_BOARD_FOUND_PORTAL_UNKNOWN,
  },
  {
    name: 'LTIMindtree',
    category: 'Service-Based',
    domain: 'Cloud Services / Enterprise Data Platforms',
    location: 'Mumbai',
    atsProvider: 'greenhouse',
    atsIdentifier: 'ltimindtree',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Probed 2026-09-17: no board on greenhouse/lever/ashby.
    verification: NO_BOARD_FOUND_PORTAL_UNKNOWN,
  },
  {
    name: 'GlobalLogic',
    category: 'Service-Based',
    domain: 'Hitachi Digital Product Engineering',
    location: 'Delhi NCR',
    atsProvider: 'greenhouse',
    atsIdentifier: 'globallogic',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Never probed.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'Hexaware',
    category: 'Service-Based',
    domain: 'IT Automation & Legacy Modernization',
    location: 'Mumbai',
    atsProvider: 'smartrecruiters',
    atsIdentifier: 'hexaware',
    cooldown: { interview: '3–6 Months', screening: 'None' },
    // Never probed; smartrecruiters was outside the sweep.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'Cognizant',
    category: 'Service-Based',
    domain: 'Cloud Enterprise Transformation & Healthcare Tech',
    location: 'Bengaluru',
    atsProvider: 'smartrecruiters',
    atsIdentifier: 'cognizant',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Never probed; smartrecruiters was outside the sweep.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'Infosys',
    category: 'Service-Based',
    domain: 'Global IT Services / Finacle Core Banking Platform',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'infosys',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Never probed.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'Tata Consultancy Services',
    category: 'Service-Based',
    domain: 'Enterprise IT / BaNCS Financial Solutions',
    location: 'Mumbai',
    atsProvider: 'greenhouse',
    atsIdentifier: 'tcs',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Never probed. `tcs` is an abbreviation someone typed, not an observation.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'Accenture',
    category: 'Service-Based',
    domain: 'Technology Strategy / Cloud Transformation & AI',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'accenture',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Never probed.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'Capgemini',
    category: 'Service-Based',
    domain: 'Enterprise Cloud Architecture / Engineering & R&D',
    location: 'Pune',
    atsProvider: 'greenhouse',
    atsIdentifier: 'capgemini',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Never probed.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'Tech Mahindra',
    category: 'Service-Based',
    domain: 'Telecom Tech / 5G Enterprise Cloud & Networking',
    location: 'Pune',
    atsProvider: 'smartrecruiters',
    atsIdentifier: 'techmahindra',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Never probed; smartrecruiters was outside the sweep.
    verification: UNVERIFIED_TOKEN,
  },
  {
    name: 'Wipro',
    category: 'Service-Based',
    domain: 'Digital Cloud Infrastructure / Cybersecurity',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'wipro',
    cooldown: { interview: '6 Months', screening: 'None' },
    // Never probed.
    verification: UNVERIFIED_TOKEN,
  },
];

/* Every catalog row whose board actually answered, narrowed to `PollableCompany`
 * so a caller receives the verified-only type rather than having to trust a
 * filter's name. This is what the suggestions modal should eventually offer for
 * one-click add; today it still offers the whole catalog (see the report). */
export const POLLABLE_COMPANIES: readonly PollableCompany[] =
  CURATED_COMPANIES.filter(isPollable);

/* A company the 2026-09-17 sweep looked for and could not find, kept as a record
 * even though it is not in the catalog. Without this, the next person to want
 * one of these names re-derives a token from the company name and lands exactly
 * where we started. */
export interface ProbedAbsentCompany {
  readonly name: string;
  readonly probedOn: string;
  readonly realPortal: RealPortalKnowledge;
  readonly note?: string | undefined;
}

/* Probed 2026-09-17 on greenhouse, lever and ashby under every plausible slug;
 * no board answered for any of these. NOT a claim that the employer is not
 * hiring — only that these three ATSes do not serve it, so adding it to the
 * catalog with a guessed token would create a watchlist row that polls nothing.
 * Portal knowledge is recorded exactly at the strength it was established:
 * `confirmed` = someone loaded the portal and saw postings; `believed` = strong
 * expectation, nobody loaded it; `unknown` = no portal established, do not
 * invent one. */
export const PROBED_ABSENT_COMPANIES: readonly ProbedAbsentCompany[] = [
  /* Workday CONFIRMED for these four: the tenant was loaded and serves them. */
  { name: 'NVIDIA', probedOn: BOARD_PROBE_DATE_2026_09_17, realPortal: { confidence: 'confirmed', portal: 'workday' } },
  { name: 'Intel', probedOn: BOARD_PROBE_DATE_2026_09_17, realPortal: { confidence: 'confirmed', portal: 'workday' } },
  { name: 'Adobe', probedOn: BOARD_PROBE_DATE_2026_09_17, realPortal: { confidence: 'confirmed', portal: 'workday' } },
  { name: 'VMware', probedOn: BOARD_PROBE_DATE_2026_09_17, realPortal: { confidence: 'confirmed', portal: 'workday' } },

  /* Workday BELIEVED, not confirmed — deliberately a weaker word than above. */
  { name: 'CrowdStrike', probedOn: BOARD_PROBE_DATE_2026_09_17, realPortal: { confidence: 'believed', portal: 'workday' } },

  /* Wound down entirely, so there is no portal to find at any strength. Recorded
   * because "no board" and "no company" look identical from a failed probe and
   * only one of them is worth re-checking later. */
  { name: 'Dunzo', probedOn: BOARD_PROBE_DATE_2026_09_17, realPortal: { confidence: 'unknown' }, note: 'Company wound down; dunzo.com resolves to 127.0.0.1.' },

  /* No portal established for any of the rest. Listed flat, with no portal
   * field to half-fill, so the absence of knowledge is itself the record. */
  { name: 'ServiceNow', probedOn: BOARD_PROBE_DATE_2026_09_17, realPortal: { confidence: 'unknown' } },
  { name: 'SAP', probedOn: BOARD_PROBE_DATE_2026_09_17, realPortal: { confidence: 'unknown' } },
  { name: 'Workday', probedOn: BOARD_PROBE_DATE_2026_09_17, realPortal: { confidence: 'unknown' } },
  { name: 'Nutanix', probedOn: BOARD_PROBE_DATE_2026_09_17, realPortal: { confidence: 'unknown' } },
  { name: 'AMD', probedOn: BOARD_PROBE_DATE_2026_09_17, realPortal: { confidence: 'unknown' } },
  { name: 'Qualcomm', probedOn: BOARD_PROBE_DATE_2026_09_17, realPortal: { confidence: 'unknown' } },
  { name: 'Google', probedOn: BOARD_PROBE_DATE_2026_09_17, realPortal: { confidence: 'unknown' } },
  { name: 'Amazon', probedOn: BOARD_PROBE_DATE_2026_09_17, realPortal: { confidence: 'unknown' } },
  { name: 'Apple', probedOn: BOARD_PROBE_DATE_2026_09_17, realPortal: { confidence: 'unknown' } },
  { name: 'Flipkart', probedOn: BOARD_PROBE_DATE_2026_09_17, realPortal: { confidence: 'unknown' } },
  { name: 'HSBC', probedOn: BOARD_PROBE_DATE_2026_09_17, realPortal: { confidence: 'unknown' } },
  { name: 'BlackRock', probedOn: BOARD_PROBE_DATE_2026_09_17, realPortal: { confidence: 'unknown' } },
  { name: 'Morgan Stanley', probedOn: BOARD_PROBE_DATE_2026_09_17, realPortal: { confidence: 'unknown' } },
  { name: 'Turnitin', probedOn: BOARD_PROBE_DATE_2026_09_17, realPortal: { confidence: 'unknown' } },
  { name: 'Chargebee', probedOn: BOARD_PROBE_DATE_2026_09_17, realPortal: { confidence: 'unknown' } },
  { name: 'Juspay', probedOn: BOARD_PROBE_DATE_2026_09_17, realPortal: { confidence: 'unknown' } },
  { name: 'Blinkit', probedOn: BOARD_PROBE_DATE_2026_09_17, realPortal: { confidence: 'unknown' } },
  { name: 'Publicis Sapient', probedOn: BOARD_PROBE_DATE_2026_09_17, realPortal: { confidence: 'unknown' } },
];

/**
 * Filter options for company catalog queries.
 */
export interface FilterCompanyOptions {
  readonly search?: string;
  readonly category?: CompanyCategory | 'all';
  readonly location?: string | 'All Locations';
  readonly atsProvider?: AtsProvider | 'all';
  /* Restrict to boards a probe has actually seen respond. Optional because it is
   * a QUERY preference, not a claim about a row — the required `verification`
   * field is what stops a guess masquerading as fact, and this is only how a
   * caller asks to be shown the safe subset. Defaults to showing everything so
   * the existing modal keeps its current behaviour until someone changes it. */
  readonly pollableOnly?: boolean;
}

/**
 * Pure filter function over a company list.
 */
export function filterCompanies(
  companies: readonly SuggestedCompany[],
  options: FilterCompanyOptions,
): SuggestedCompany[] {
  const query = options.search?.trim().toLowerCase() ?? '';
  const categoryFilter = options.category ?? 'all';
  const locationFilter = options.location ?? 'All Locations';
  const atsFilter = options.atsProvider ?? 'all';
  /* Default false: an unset option must not silently change what existing
   * callers see. Opting IN to safety is the right default here only because the
   * row-level `verification` field, not this flag, is what carries the truth. */
  const pollableOnly = options.pollableOnly ?? false;

  return companies.filter((c) => {
    /* Cheapest discriminating check first, and it uses the shared guard so this
     * filter cannot drift from `POLLABLE_COMPANIES`. */
    if (pollableOnly && !isPollable(c)) {
      return false;
    }
    if (categoryFilter !== 'all' && c.category !== categoryFilter) {
      return false;
    }
    if (locationFilter !== 'All Locations') {
      const targetLoc = locationFilter.toLowerCase();
      const compLoc = c.location.toLowerCase();
      if (!compLoc.includes(targetLoc) && !targetLoc.includes(compLoc)) {
        return false;
      }
    }
    if (atsFilter !== 'all' && c.atsProvider !== atsFilter) {
      return false;
    }
    if (query.length > 0) {
      const matchName = c.name.toLowerCase().includes(query);
      const matchDomain = c.domain.toLowerCase().includes(query);
      const matchSlug = c.atsIdentifier.toLowerCase().includes(query);
      const matchLoc = c.location.toLowerCase().includes(query);
      const matchProvider = c.atsProvider.toLowerCase().includes(query);
      if (!matchName && !matchDomain && !matchSlug && !matchLoc && !matchProvider) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Shuffle and return a balanced, rotating batch of companies grouped by category.
 * Invoked every time the operator hits "Refresh Companies".
 */
export function getRefreshedCompaniesBatch(
  options: {
    readonly location?: string | 'All Locations';
    readonly category?: CompanyCategory | 'all';
    readonly seed?: number;
    readonly countPerCategory?: number;
    /* Threaded through so a caller can rotate only over boards that answer;
     * same default-off reasoning as `filterCompanies`. */
    readonly pollableOnly?: boolean;
  } = {},
): SuggestedCompany[] {
  const {
    location = 'All Locations',
    category = 'all',
    seed = Date.now(),
    countPerCategory = 4,
    pollableOnly = false,
  } = options;

  const eligible = filterCompanies(CURATED_COMPANIES, {
    location,
    category,
    pollableOnly,
  });

  const categories: readonly CompanyCategory[] =
    category === 'all'
      ? ['GCC', 'Mid-Scale MNC', 'Startup / Unicorn', 'Service-Based']
      : [category];

  const result: SuggestedCompany[] = [];

  // Pseudo-random deterministic rotation based on seed
  for (const cat of categories) {
    const inCat = eligible.filter((c) => c.category === cat);
    if (inCat.length === 0) continue;

    // Deterministic pseudo-shuffle
    const shuffled = [...inCat].sort((a, b) => {
      const hashA = Math.sin(seed + a.name.charCodeAt(0)) * 10000;
      const hashB = Math.sin(seed + b.name.charCodeAt(0)) * 10000;
      return (hashA - Math.floor(hashA)) - (hashB - Math.floor(hashB));
    });

    result.push(...shuffled.slice(0, countPerCategory));
  }

  return result.length > 0 ? result : eligible.slice(0, 16);
}

/**
 * Dynamic search & lookup:
 * 1. Checks the catalog first — those rows at least carry a `verification`
 *    state, so the caller can tell a measured token from a guessed one.
 * 2. If nothing matches, SYNTHESIZES a candidate by lowercasing the query into
 *    a slug. That slug is a GUESS and is returned marked `unverified`, never
 *    "discovered" — this is the same name-guessing heuristic the 2026-09-17
 *    probe refuted for a large share of the catalog, so anything built on top of
 *    this result must check `verification.kind` before treating it as pollable.
 */
export function searchOrDiscoverCompany(
  query: string,
  location: string = 'All Locations',
): SuggestedCompany[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return getRefreshedCompaniesBatch({ location });
  }

  // 1. Check existing matches
  const matches = filterCompanies(CURATED_COMPANIES, {
    search: trimmed,
    location,
  });

  if (matches.length > 0) {
    return matches;
  }

  // 2. Synthesize dynamic company entry with ATS discovery
  const cleanSlug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 40);

  const fallbackLoc = location !== 'All Locations' ? location : 'Bengaluru';

  const synthesized: SuggestedCompany = {
    name: trimmed,
    category: 'Startup / Unicorn',
    domain: 'Software Engineering / Cloud Services',
    location: fallbackLoc,
    atsProvider: 'greenhouse',
    atsIdentifier: cleanSlug || trimmed.toLowerCase().replace(/[^a-z0-9]/g, ''),
    cooldown: { interview: '6 Months', screening: 'None' },
    /* Unverified by construction: nothing here was fetched. The required field
     * means this row cannot be built without admitting that. */
    verification: UNVERIFIED_TOKEN,
  };

  return [synthesized];
}

/**
 * Look up cooldown guidance (interview and screening cool-off windows) for any
 * employer by company name or slug. Returns hand-entered editorial values that
 * no probe or published policy has ever confirmed — see the file header.
 */
export function getCompanyCooldownInfo(companyName: string): CompanyCooldown | null {
  if (!companyName || typeof companyName !== 'string') return null;
  const q = companyName.trim().toLowerCase();

  const exact = CURATED_COMPANIES.find(
    (c) =>
      c.name.toLowerCase() === q ||
      c.atsIdentifier.toLowerCase() === q ||
      q.includes(c.atsIdentifier.toLowerCase()) ||
      c.name.toLowerCase().includes(q),
  );

  return exact ? exact.cooldown : null;
}
