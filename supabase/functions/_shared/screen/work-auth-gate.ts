// Stage 0b — the US work-authorisation gate, run after the tech gate and ahead of the cascade.
//
// TEJA'S RULING, 2026-10-24 18:44 IST: "drop everything which need this us auth and set this
// option in system like yes or no". The answer lives in search_preferences.us_work_authorized
// (migration 20261024190000), for the same reason the tech gate's config lives there: no new
// filter_rule_type enum value, no cascade.ts change.
//
// THE RULE, in one line:
//   DROP iff the user answered No AND (every location part is in the US, OR the location holds
//   only arrangement words like "Remote"/"Hybrid" AND the description states a US requirement).
//
// WHY LOCATION FIRST. Measured on the 2535 live passed_filters rows (2026-10-24): 1462 had a
// US-only location, while US-specific requirement text appeared on only ~115 rows. The text is
// the secondary signal, used ONLY when the location says nothing (Remote, Hybrid, empty). An
// UNRECOGNISED place ("Zug", "PL-Warsaw-Lixa C") is not "nothing": it is somewhere, probably
// abroad, so its footer text is not trusted to mean the job is in the US.
//
// WHY TEXT NEVER OVERRIDES A NAMED LOCATION. Roblox prints "United States work authorization"
// boilerplate on its Gurugram and remote jobs; Graphcore's "unable to sponsor" means the UK.
// A job located in India or Europe does not need US authorisation, whatever its footer says.
//
// FAIL-OPEN ON MISSING DATA (CLAUDE.md section 6). An unanswered setting, a placeless location
// with no text signal, and a location part the gate does not recognise all KEEP the job. Only a
// positive US signal drops. A missing answer must never become a rejection.

// The verdict: the same three-outcome shape as the tech gate's, so one reading covers both.
export type WorkAuthVerdict =
  // No objection.
  | { readonly drop: false }
  // No objection, but the setting was never answered, so the gate could not judge.
  | { readonly drop: false; readonly warning: string }
  // Rejected. `code` lands in applications.drop_reason; `reason` is the prose for the run log.
  | { readonly drop: true; readonly code: WorkAuthDropCode; readonly reason: string };

// The single drop_reason this gate writes. A closed literal so no caller invents a spelling.
export type WorkAuthDropCode = "us_work_auth";

// The three job texts the gate reads. Narrow on purpose: nothing else about a job matters here.
export interface WorkAuthJob {
  // Only quoted in the reason prose.
  readonly title: string;
  // The board's location string; the main signal.
  readonly locationRaw: string | null;
  // The JD text; read only when the location names no place.
  readonly description: string | null;
}

// Where one location part points.
type PartClass = "us" | "non_us" | "unknown";

// Separators between DIFFERENT locations in one string ("Seattle, WA; Austin, TX",
// "United States | Canada", "US or Canada"). Commas are NOT here: they separate city, state and
// country inside ONE location ("San Mateo, CA, United States").
const PART_SEPARATOR = /[;|/\n]|\s&\s|\s+(?:and|or)\s+/i;

// Places a US-listed part can be MIXED with that make it not-US-only. Checked BEFORE the US terms,
// so "Toronto, CA" (Canada, not California) and "New York, London" are never read as US-only.
// Only needs places that co-occur with US terms inside one part; anything unlisted is "unknown",
// which also keeps the job. `(?<!new )mexico` so New Mexico stays a US state.
const NON_US = new RegExp(
  "\\b(?:" +
    [
      // India, Teja's own country, and its tech cities.
      "india", "bengaluru", "bangalore", "hyderabad", "pune", "mumbai", "delhi", "gurugram", "gurgaon", "noida", "chennai", "kolkata",
      // Canada, the commonest US pairing ("US | Canada"), and its cities.
      "canada", "toronto", "vancouver", "montreal", "ottawa",
      // The UK and Ireland.
      "uk", "united kingdom", "england", "london", "ireland", "dublin",
      // Continental Europe and the regions boards write.
      "europe", "emea", "eu", "germany", "berlin", "france", "paris", "netherlands", "amsterdam", "spain", "poland",
      // Asia-Pacific and the Americas outside the US.
      "singapore", "australia", "sydney", "japan", "tokyo", "israel", "(?<!new )mexico", "brazil", "latam", "apac",
      // Worldwide remote: open to anyone, anywhere.
      "global", "worldwide", "anywhere", "international",
    ].join("|") +
    ")\\b",
  "i",
);

// Unambiguous US terms, matched case-insensitively: the country, its states and its tech cities.
// Georgia is omitted (also a country); Atlanta covers that state's tech jobs.
const US_PLACE = new RegExp(
  "\\b(?:" +
    [
      // The country, in the spellings boards use.
      "united states", "usa", "u\\.s\\.a\\.?", "u\\.s\\.",
      // State names (Georgia omitted, see above; Washington doubles as D.C.).
      "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "hawaii",
      "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts",
      "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey",
      "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island",
      "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington", "west virginia",
      "wisconsin", "wyoming",
      // Tech cities that appear bare ("San Francisco" alone is 327 live rows).
      "san francisco", "nyc", "seattle", "austin", "boston", "chicago", "los angeles", "san jose", "palo alto",
      "mountain view", "sunnyvale", "san mateo", "redwood city", "menlo park", "santa clara", "san diego", "denver",
      "atlanta", "miami", "bay area", "silicon valley", "brooklyn", "cupertino", "oakland", "berkeley", "pittsburgh",
      "philadelphia", "dallas", "houston", "portland", "salt lake city", "raleigh", "boulder", "ann arbor", "detroit",
      "minneapolis", "phoenix", "nashville", "baltimore", "arlington", "reston", "irvine", "santa monica", "bellevue",
      "redmond", "kirkland", "emeryville", "foster city", "burlingame",
    ].join("|") +
    ")(?![a-z])",
  "i",
);

// US terms that are only safe CASE-SENSITIVELY: "US" (not the pronoun "us"), the bare "SF" and
// "NY" abbreviations, and a two-letter state code after a comma ("Austin, TX").
const US_CODE =
  /\bUS\b|\bSF\b|\bNY\b|,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;

// Requirement wordings that are US-specific by their own words, each measured in the live sample.
// Country-neutral sponsorship phrases ("unable to sponsor", "without sponsorship") are deliberately
// ABSENT: on live rows they meant the UK, Poland, or an export licence.
const US_REQUIREMENT: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  // "authorized / eligible / permitted to work (for any employer) in (the) US / United States".
  { label: "authorized to work in the US", pattern: /\b(?:authori[sz]ed|eligible|permitted) to work (?:for any employer )?in (?:the )?(?:united states|u\.?s\.?a?\.?)(?![a-z])/i },
  // "U.S. citizen", "US citizenship", "United States citizen".
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

// Words that describe HOW a job is done, never WHERE. A location made only of these (plus
// punctuation) names no place, which is the one case the text signal is allowed to decide.
const ARRANGEMENT_WORDS = /\b(?:remote|hybrid|on-?site|in-?office|office|job|n\/a|na|tbd|distributed|multiple|locations?|flexible)\b/gi;

// True when the location names no place: empty, or arrangement words and punctuation only.
function isPlaceless(locationRaw: string | null): boolean {
  // Strip the arrangement words, then every separator and bracket; anything left is a place.
  const rest = (locationRaw ?? "").replace(ARRANGEMENT_WORDS, "").replace(/[\s\-\u2013\u2014,;:|/()\u2022.*]+/g, "");
  // Nothing left: no place was named.
  return rest === "";
}

// Where one location part points. Non-US wins over US inside one part ("New York, London").
function classifyPart(part: string): PartClass {
  // A named non-US place makes the part not-US-only, whatever else it says.
  if (NON_US.test(part)) return "non_us";
  // Any US term, by name or by case-sensitive code.
  if (US_PLACE.test(part) || US_CODE.test(part)) return "us";
  // "Remote", "Hybrid", "Cambridge", "N/A": no place the gate can vouch for.
  return "unknown";
}

// Run the gate over one job.
export function screenUsWorkAuth(job: WorkAuthJob, usWorkAuthorized: boolean | null): WorkAuthVerdict {
  // Authorised: nothing to enforce.
  if (usWorkAuthorized === true) return { drop: false };
  // Unanswered: open, and say so, because an open gate drops nothing and that should be visible.
  if (usWorkAuthorized === null) {
    return { drop: false, warning: "us_work_auth gate open: search_preferences.us_work_authorized is not answered" };
  }

  // The location's separate parts, blanks removed so "Seattle; " is one part, not two.
  const parts = (job.locationRaw ?? "").split(PART_SEPARATOR).map((part) => part.trim()).filter((part) => part !== "");
  // Each part's class.
  const classes = parts.map(classifyPart);

  // LOCATION: every part provably in the US. One non-US or unknown part means the job can be
  // done somewhere US authorisation is not needed, or that we cannot tell; either way, keep.
  if (classes.length > 0 && classes.every((cls) => cls === "us")) {
    // Quote the location so a wrong drop is diagnosable from the run summary.
    return { drop: true, code: "us_work_auth", reason: `location "${job.locationRaw}" is US-only and US work authorization is "No"` };
  }

  // TEXT: only when the location names no place at all. A named place, even one the gate does
  // not recognise, outranks the footer text.
  if (isPlaceless(job.locationRaw)) {
    // The first US-specific requirement the description states, if any.
    const hit = US_REQUIREMENT.find(({ pattern }) => pattern.test(job.description ?? ""));
    // Name the requirement family that matched.
    if (hit !== undefined) {
      return { drop: true, code: "us_work_auth", reason: `JD requires ${hit.label}; location "${job.locationRaw ?? ""}" names no place` };
    }
  }

  // No positive US signal: keep. Missing data is never a rejection.
  return { drop: false };
}
