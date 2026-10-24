// Stage 0b — the work-authorisation gate, run after the tech gate and ahead of the cascade.
//
// TEJA'S RULINGS, 2026-10-24. 18:44 IST: "drop everything which need this us auth and set this
// option in system". 19:13 IST, refining it: "i am ok with us jobs where i can work remotly, the
// jobs which needs visa and all, like i need to do on side or hybrid with us based in us office
// is not ok", and allowed = "indian + remote + india visa free countrys". The list lives in
// search_preferences.work_authorized_countries (migration 20261024190000), for the same reason
// the tech gate's config lives there: no new filter_rule_type enum value, no cascade.ts change.
// "Visa-free" means visa-free WORK: for an Indian citizen, Nepal and Bhutan (treaty).
//
// THE RULE, in one line:
//   DROP iff a list is set AND (every location part names a country outside the list and none
//   says remote, OR no part is in the list AND the JD states a US-specific legal requirement
//   while the US is not on the list).
//
// WHY LOCATION FIRST. Measured on the 2535 live passed_filters rows (2026-10-24): the location
// string is where boards say where the work happens. US-specific requirement text appeared on
// only ~115 rows, and the country-neutral sponsorship wording ("unable to sponsor") meant the
// UK, Poland or an export licence there, so it is not used at all.
//
// WHY jobs.work_arrangement IS NOT READ. Measured the same day: 466 rows carry 'remote' while
// their location names a city, and the JDs disagree (Ramp 32/32 "in-office", Notion 24/25
// "in person", Replit 15/15 "hybrid"). Remote is read from the location text only.
//
// FAIL-OPEN ON MISSING DATA (CLAUDE.md section 6). An unset list, a location part naming no
// country the gate knows, a missing location and a remote part all KEEP the job. Only a
// positive signal drops. A missing answer must never become a rejection.

// The verdict: the same three-outcome shape as the tech gate's, so one reading covers both.
export type WorkAuthVerdict =
  // No objection.
  | { readonly drop: false }
  // No objection, but the config is unset or partly unreadable, which should be visible.
  | { readonly drop: false; readonly warning: string }
  // Rejected. `code` lands in applications.drop_reason; `reason` is the prose for the run log.
  | { readonly drop: true; readonly code: WorkAuthDropCode; readonly reason: string };

// The single drop_reason this gate writes. A closed literal so no caller invents a spelling.
export type WorkAuthDropCode = "work_auth";

// The three job texts the gate reads. Narrow on purpose: nothing else about a job matters here.
export interface WorkAuthJob {
  // Only quoted in the reason prose.
  readonly title: string;
  // The board's location string; the main signal.
  readonly locationRaw: string | null;
  // The JD text; read only for the US-specific requirement phrases.
  readonly description: string | null;
}

// Separators between DIFFERENT locations in one string ("Seattle, WA; Austin, TX",
// "United States | Canada", "SF or Remote"). Commas are NOT here: they separate city, state and
// country inside ONE location. "/" is not here either: "3 days/week" would split a sentence and
// leave an unknown fragment that keeps the job.
const PART_SEPARATOR = /[;|\n]|\s&\s|\s+(?:and|or)\s+/i;

// Words saying the work can be done from anywhere (or anywhere in a region). "Hybrid" is not one.
const REMOTE = /\b(?:remote|work from home|wfh|anywhere|worldwide)\b/i;

// Words joined into one case-insensitive alternation, whole-word on both ends.
const words = (list: readonly string[]): RegExp => new RegExp(`\\b(?:${list.join("|")})(?![a-z])`, "i");

// Every country the 469 distinct live location strings name (2026-10-24), by its own name, its
// common abbreviations and the cities and regions boards write instead of it. Canonical name
// first: it is what work_authorized_countries entries resolve to and what the reason quotes.
// Ambiguous names are left out on purpose ("Cambridge", "Georgia"): an unresolved part keeps
// the job, which is the safe direction.
const COUNTRIES: readonly { readonly name: string; readonly patterns: readonly RegExp[] }[] = [
  // Teja's own country, its cities and states.
  { name: "India", patterns: [words(["india", "ind", "bengaluru", "bangalore", "hyderabad", "pune", "mumbai", "delhi", "ncr", "gurugram", "gurgaon", "noida", "chennai", "kolkata", "lucknow", "gift city", "karnataka", "maharashtra", "haryana", "telangana"])] },
  // Visa-free work for Indians by treaty.
  { name: "Nepal", patterns: [words(["nepal", "kathmandu", "lalitpur", "pokhara"])] },
  // Visa-free work for Indians by treaty.
  { name: "Bhutan", patterns: [words(["bhutan", "thimphu"])] },
  // The US: name, states, tech cities, and case-sensitive codes ("US", "SF", ", TX").
  {
    name: "United States",
    patterns: [
      // Names, states (Georgia omitted: also a country) and cities, case-insensitive.
      words([
        "united states", "usa", "u\\.s\\.a\\.?", "u\\.s\\.",
        "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "hawaii",
        "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts",
        "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey",
        "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
        "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington",
        "west virginia", "wisconsin", "wyoming",
        "san francisco", "nyc", "seattle", "austin", "boston", "chicago", "los angeles", "san jose", "palo alto",
        "mountain view", "sunnyvale", "san mateo", "redwood city", "menlo park", "santa clara", "san diego", "denver",
        "atlanta", "miami", "bay area", "silicon valley", "brooklyn", "cupertino", "oakland", "berkeley", "pittsburgh",
        "philadelphia", "dallas", "houston", "portland", "salt lake city", "raleigh", "boulder", "ann arbor", "detroit",
        "minneapolis", "phoenix", "nashville", "baltimore", "arlington", "reston", "irvine", "santa monica", "bellevue",
        "redmond", "kirkland", "emeryville", "foster city", "burlingame", "stamford", "sacramento", "honolulu",
      ]),
      // Codes only safe case-sensitively: "US" (not "us"), "SF", "NY", and ", XX" state codes.
      /\bUS\b|\bSF\b|\bNY\b|,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/,
    ],
  },
  // Canada; "CAN" and ", BC" only in capitals.
  { name: "Canada", patterns: [words(["canada", "toronto", "vancouver", "montreal", "montréal", "ottawa", "ontario", "quebec", "alberta", "british columbia", "manitoba", "nova scotia", "b\\.c\\."]), /\bCAN\b|,\s*BC\b/] },
  // The UK, its nations and cities.
  { name: "United Kingdom", patterns: [words(["uk", "united kingdom", "england", "scotland", "wales", "northern ireland", "london", "bristol", "belfast", "manchester", "edinburgh"]), /\bGB\b/] },
  // Ireland ("Northern Ireland" is the UK).
  { name: "Ireland", patterns: [/(?<!northern )\bireland\b|\bdublin\b/i] },
  // Continental Europe, one row each, from the live strings.
  { name: "France", patterns: [words(["france", "paris"])] },
  { name: "Germany", patterns: [words(["germany", "ger", "berlin", "munich"])] },
  { name: "Netherlands", patterns: [words(["netherlands", "amsterdam"])] },
  { name: "Spain", patterns: [words(["spain", "madrid", "barcelona"])] },
  { name: "Portugal", patterns: [words(["portugal", "lisbon"])] },
  { name: "Poland", patterns: [words(["poland", "warsaw", "gdańsk", "gdansk", "krakow"])] },
  { name: "Italy", patterns: [words(["italy", "milan"])] },
  { name: "Switzerland", patterns: [words(["switzerland", "zurich", "zug"])] },
  { name: "Austria", patterns: [words(["austria", "vienna"])] },
  { name: "Belgium", patterns: [words(["belgium", "brussels"])] },
  { name: "Luxembourg", patterns: [words(["luxembourg"])] },
  { name: "Denmark", patterns: [words(["denmark", "copenhagen", "aarhus"])] },
  { name: "Sweden", patterns: [words(["sweden", "stockholm"])] },
  { name: "Norway", patterns: [words(["norway", "oslo"])] },
  { name: "Finland", patterns: [words(["finland", "helsinki", "tampere"])] },
  { name: "Iceland", patterns: [words(["iceland", "reykjavík", "reykjavik"])] },
  { name: "Czech Republic", patterns: [words(["czech", "prague"])] },
  { name: "Romania", patterns: [words(["romania", "bucharest"])] },
  { name: "Serbia", patterns: [words(["serbia", "belgrade"])] },
  { name: "Slovenia", patterns: [words(["slovenia", "ljubljana"])] },
  { name: "Lithuania", patterns: [words(["lithuania", "vilnius"])] },
  { name: "Greece", patterns: [words(["greece", "athens"])] },
  { name: "North Macedonia", patterns: [words(["north macedonia", "skopje", "ohrid", "debar"])] },
  { name: "Kosovo", patterns: [words(["kosovo", "pristina"])] },
  // The Middle East.
  { name: "Israel", patterns: [words(["israel", "tel aviv", "kfar saba"])] },
  { name: "United Arab Emirates", patterns: [words(["uae", "united arab emirates", "dubai", "abu dhabi"])] },
  { name: "Qatar", patterns: [words(["qatar", "doha"])] },
  { name: "Saudi Arabia", patterns: [words(["saudi arabia", "ksa", "riyadh"])] },
  // Asia-Pacific.
  { name: "Singapore", patterns: [words(["singapore"])] },
  { name: "Hong Kong", patterns: [words(["hong kong"])] },
  { name: "China", patterns: [words(["china", "beijing", "shanghai"])] },
  { name: "Japan", patterns: [words(["japan", "tokyo"])] },
  { name: "South Korea", patterns: [words(["korea", "seoul"])] },
  { name: "Taiwan", patterns: [words(["taiwan", "taipei"])] },
  { name: "Malaysia", patterns: [words(["malaysia", "kuala lumpur"])] },
  { name: "Philippines", patterns: [words(["philippines", "manila"])] },
  { name: "Vietnam", patterns: [words(["vietnam", "ho chi minh"])] },
  { name: "Australia", patterns: [words(["australia", "sydney", "melbourne"])] },
  { name: "New Zealand", patterns: [words(["new zealand", "auckland"])] },
  // The Americas outside the US and Canada. "(?<!new )" keeps New Mexico in the US.
  { name: "Brazil", patterns: [words(["brazil", "são paulo", "sao paulo"])] },
  { name: "Mexico", patterns: [/(?<!new )\bmexico\b/i, /,\s*MX\b/] },
  // Africa.
  { name: "Mauritius", patterns: [words(["mauritius", "ebene"])] },
];

// Requirement wordings that are US-specific by their own words, each measured in the live sample.
// Country-neutral sponsorship phrases ("unable to sponsor", "without sponsorship") are deliberately
// ABSENT: on live rows they meant the UK, Poland, or an export licence.
const US_REQUIREMENT: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  // "authorized / eligible / permitted to work (for any employer) in (the) US / United States".
  { label: "authorized to work in the US", pattern: /\b(?:authori[sz]ed|eligible|permitted) to work (?:for any employer )?in (?:the )?(?:united states|u\.?s\.?a?\.?)(?![a-z])/i },
  // "U.S. citizen", "US citizenship", "United States citizen". Not "country of citizenship".
  { label: "US citizenship", pattern: /\b(?:u\.?s\.?|united states) citizen(?:s|ship)?\b/i },
  // The ITAR / export-control "U.S. person" definition.
  { label: "US person (export control)", pattern: /\bu\.?s\.? persons?\b/i },
  // ITAR named outright.
  { label: "ITAR", pattern: /\bitar\b/i },
  // A green card is US-only by definition.
  { label: "green card", pattern: /\bgreen card\b/i },
  // A security clearance: never obtainable by a foreign national. Bare "clearance" is not enough
  // (live: "mechanical fit, alignment, clearance").
  { label: "security clearance", pattern: /\bsecurity clearance\b|\bts\/sci\b/i },
];

// Every country a piece of text names, by canonical name. Used for job locations AND for the
// user's own list entries, so "USA" in Settings and "Remote, USA" on a job resolve alike.
function countriesIn(text: string): Set<string> {
  // A Set, because one part can name a country twice ("San Francisco, CA, USA").
  return new Set(COUNTRIES.filter(({ patterns }) => patterns.some((pattern) => pattern.test(text))).map(({ name }) => name));
}

// Run the gate over one job against the user's work-authorised countries.
export function screenWorkAuth(job: WorkAuthJob, authorizedCountries: readonly string[] | null): WorkAuthVerdict {
  // Unset: open, and say so, because an open gate drops nothing and that should be visible.
  if (authorizedCountries === null) {
    return { drop: false, warning: "work_auth gate open: search_preferences.work_authorized_countries is not set" };
  }
  // The user's entries, resolved through the same table the jobs are read with.
  const resolved = authorizedCountries.map((entry) => ({ entry, names: countriesIn(entry) }));
  // The canonical countries the user may work in.
  const authorized = new Set(resolved.flatMap(({ names }) => [...names]));
  // Entries that resolve to nothing are reported: a typo must not silently narrow the list.
  const unknown = resolved.filter(({ names }) => names.size === 0).map(({ entry }) => entry);
  // The warning, if any, travels with whatever verdict follows.
  const warning = unknown.length > 0 ? `work_authorized_countries entries not recognised: ${unknown.join(", ")}` : null;
  // A keep, carrying the warning when there is one.
  const keep = (): WorkAuthVerdict => (warning === null ? { drop: false } : { drop: false, warning });

  // The location's separate parts, blanks removed so "Belfast;" is one part, not two.
  const parts = (job.locationRaw ?? "").split(PART_SEPARATOR).map((part) => part.trim()).filter((part) => part !== "");
  // Each part's countries, read once.
  const partCountries = parts.map(countriesIn);
  // True when some part is in a country the user may work in.
  const anyAuthorized = partCountries.some((names) => [...names].some((name) => authorized.has(name)));

  // LOCATION: drop only when EVERY part is provably elsewhere. A part is provably elsewhere when it
  // names at least one country, none of them authorised, and does not say remote. One remote,
  // authorised or unknown part means the job can be done somewhere allowed, or we cannot tell.
  const everyPartElsewhere =
    parts.length > 0 &&
    parts.every((part, index) => !REMOTE.test(part) && partCountries[index]!.size > 0 && ![...partCountries[index]!].some((name) => authorized.has(name)));
  // Quote the location so a wrong drop is diagnosable from the run summary.
  if (everyPartElsewhere) {
    return { drop: true, code: "work_auth", reason: `location "${job.locationRaw}" is on-site/hybrid outside the work-authorised countries` };
  }

  // TEXT: a JD that legally requires US status, unless the user may work in the US or some
  // location part is in an authorised country (there the footer is boilerplate: Roblox, Gurugram).
  if (!authorized.has("United States") && !anyAuthorized) {
    // The first US-specific requirement the description states, if any.
    const hit = US_REQUIREMENT.find(({ pattern }) => pattern.test(job.description ?? ""));
    // Name the requirement family that matched.
    if (hit !== undefined) {
      return { drop: true, code: "work_auth", reason: `JD requires ${hit.label}; location "${job.locationRaw ?? ""}"` };
    }
  }

  // No positive signal: keep. Missing data is never a rejection.
  return keep();
}
