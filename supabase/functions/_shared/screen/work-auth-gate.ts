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
// TEJA'S RULINGS, 2026-11-04, REVERSING THE 10-24 REMOTE HALF. 18:26 IST: "i dont need country
// lokced remote except indain remote jobs", then "i want remote jobs with no country lock too".
// He had read "remote" as "work from India for a US company"; "Remote - US" means "must live and
// be authorised in the US", which no visa reaches. So a remote part that NAMES places outside the
// list now counts as elsewhere, under search_preferences.remote_location_policy
// 'unlocked_or_authorized' (migration 20261104193000, the default). 'any' keeps the 10-24
// behaviour and is one Settings choice away. Unclear locations ("In-Office", "2 Locations") are
// KEPT (same day) unless the JD's own "Location:" line names only places outside the list.
//
// THE RULE, in one line:
//   DROP iff a list is set AND (every location part names a place outside the list and, under
//   'any', none says remote; OR the board location names no place and the JD's location line
//   names only places outside the list; OR no part is in the list AND the JD states a
//   US-specific legal requirement while the US is not on the list).
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
// country the gate knows, a missing location and a remote part that names no place all KEEP the
// job (under 'any', every remote part). Only a positive signal drops. A missing answer must never
// become a rejection.

// The HTML stripper the ATS adapters use, so the JD's location line is read from plain text with
// its paragraph breaks kept (they are what end the line).
import { stripHtml } from "../ats/types.ts";

// What a remote location part means (search_preferences.remote_location_policy, 2026-11-04).
// A CLOSED UNION, never a boolean: the column holds exactly these two literals (CHECK constraint),
// and a third reading must not compile.
export type RemoteLocationPolicy =
  // Teja's 11-04 default: remote is kept when it names no place or a place on the list.
  | "unlocked_or_authorized"
  // The 10-24 behaviour: any part that says remote is kept, wherever it is locked to.
  | "any";

// The two literals, for the one mapper that reads the column (context.ts) to check shape against.
export const REMOTE_LOCATION_POLICIES: readonly RemoteLocationPolicy[] = ["unlocked_or_authorized", "any"];

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
// "Home based" added 2026-11-04: Canonical-style boards write "Home based - EMEA" for remote.
const REMOTE = /\b(?:remote|work from home|wfh|anywhere|worldwide|home[- ]?based)\b/i;

// Words joined into one case-insensitive alternation, whole-word on both ends.
const words = (list: readonly string[]): RegExp => new RegExp(`\\b(?:${list.join("|")})(?![a-z])`, "i");

// Arabic-script aliases, matched as a plain alternation. `\b` cannot be used: in a JS regex without the
// `u` flag it is ASCII-only, so it never fires between Arabic letters (2026-11-06: the first live Arabic
// location, Dubai). A trailing "not another Arabic letter" check stands in for the word end, so "مصر"
// (Egypt) does not match inside "مصرف" (bank). No leading check: Arabic glues prefixes onto words
// ("بالكويت" = in Kuwait), and a leading check would miss exactly those. Bare "عمان" is left out on purpose:
// it spells both Oman and Amman, and an unresolved part keeps the job, which is the safe direction.
// The `u` flag makes \p{L} available: ANY letter after the alias (alef wasla U+0671, Persian yeh and keheh, Latin)
// means the alias is only the front of a longer word, which the narrower range [ء-ي] missed (review, 2026-11-07).
const arabic = (list: readonly string[]): RegExp => new RegExp(`(?:${list.join("|")})(?!\\p{L})`, "u");

// Every country the 469 distinct live location strings name (2026-10-24), by its own name, its
// common abbreviations and the cities and regions boards write instead of it. Canonical name
// first: it is what work_authorized_countries entries resolve to and what the reason quotes.
// Ambiguous names are left out on purpose ("Cambridge", "Georgia"): an unresolved part keeps
// the job, which is the safe direction.
const COUNTRIES: readonly { readonly name: string; readonly patterns: readonly RegExp[] }[] = [
  // Teja's own country, its cities and states.
  // 2026-11-05: every state/UT name and the major cities, so an Indian state code that is also a
  // US/UK one ("Raipur, CT", "Leh, LA", "Dehradun, UK") resolves to India too, and a part naming
  // India is authorised. Left out on purpose: "punjab" and "kashmir" (Pakistan has them too) and
  // "salem" (also US towns): an unresolved part keeps the job anyway.
  { name: "India", patterns: [words([
    "india", "ind", "bengaluru", "bangalore", "hyderabad", "pune", "mumbai", "delhi", "ncr", "gurugram", "gurgaon", "noida", "chennai", "kolkata", "lucknow", "gift city", "karnataka", "maharashtra", "haryana", "telangana",
    // States and union territories by name.
    "andhra pradesh", "arunachal pradesh", "assam", "bihar", "chhattisgarh", "goa", "gujarat", "himachal pradesh", "jharkhand", "kerala",
    "madhya pradesh", "manipur", "meghalaya", "mizoram", "nagaland", "odisha", "orissa", "rajasthan", "sikkim", "tamil nadu", "tripura",
    "uttar pradesh", "uttarakhand", "west bengal", "ladakh", "jammu", "chandigarh", "puducherry", "pondicherry", "lakshadweep", "andaman",
    // Cities: state capitals and the tech and metro hubs boards write.
    "raipur", "bhilai", "leh", "kargil", "dehradun", "haridwar", "srinagar", "shimla", "gandhinagar", "ahmedabad", "vadodara", "surat",
    "jaipur", "jodhpur", "udaipur", "bhopal", "indore", "patna", "ranchi", "bhubaneswar", "guwahati", "kochi", "cochin", "thiruvananthapuram",
    "trivandrum", "coimbatore", "madurai", "mysuru", "mysore", "mangaluru", "mangalore", "visakhapatnam", "vizag", "vijayawada", "warangal",
    "nagpur", "nashik", "thane", "navi mumbai", "panaji", "mohali", "ludhiana", "amritsar", "kanpur", "varanasi", "agra", "faridabad",
  ])] },
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
        // 2026-11-04 gaps: lower-case "sf" (7 live rows; "sf" is no English word, so case-insensitive
        // is safe) and Alpharetta, which resolves "Alpharetta, Georgia" without naming the
        // ambiguous state.
        "sf", "alpharetta",
      ]),
      // Codes only safe case-sensitively: "US" (not "us"), "SF", "NY", and ", XX" state codes.
      // AR, GA, IN, MN, OR, TN and UT are left out: they are also Indian codes (Arunachal, Goa,
      // India itself, Manipur, Odisha, Tamil Nadu, Uttarakhand), so "Coimbatore, TN" or
      // "Jaipur, IN" would resolve to the US and drop. Without them such a part is unknown and
      // kept; a US city in those states is kept too unless its name is in the list above.
      /\bUS\b|\bSF\b|\bNY\b|,\s*(?:AL|AK|AZ|CA|CO|CT|DE|FL|HI|ID|IL|IA|KS|KY|LA|ME|MD|MA|MI|MS|MO|MT|NE|NV|NH|NJ|NM|NC|ND|OH|OK|PA|RI|SC|SD|TX|VT|VA|WA|WV|WI|WY|DC)\b/,
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
  // Malmö and Gothenburg added 2026-11-04 (13 live "Malmö" rows passed).
  { name: "Sweden", patterns: [words(["sweden", "stockholm", "malmö", "malmo", "gothenburg", "göteborg"])] },
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
  // Arabic: Dubai, Abu Dhabi (two spellings), the Emirates (two spellings), Sharjah.
  { name: "United Arab Emirates", patterns: [words(["uae", "united arab emirates", "dubai", "abu dhabi", "sharjah"]), arabic(["دبي", "أبوظبي", "ابوظبي", "الإمارات", "الامارات", "الشارقة"])] },
  // Arabic: Qatar, Doha.
  { name: "Qatar", patterns: [words(["qatar", "doha"]), arabic(["قطر", "الدوحة"])] },
  // Arabic: Saudi Arabia (the Kingdom's own word), Riyadh, Jeddah.
  { name: "Saudi Arabia", patterns: [words(["saudi arabia", "ksa", "riyadh", "jeddah"]), arabic(["السعودية", "الرياض", "جدة"])] },
  // Added 2026-11-06 (live leak: Scale AI "Kuwait City, Kuwait" passed because Kuwait had no row). Each with
  // its capital, in Latin and Arabic, so a board that writes only the city is still resolved.
  { name: "Kuwait", patterns: [words(["kuwait", "kuwait city"]), arabic(["الكويت"])] },
  // Bahrain.
  { name: "Bahrain", patterns: [words(["bahrain", "manama"]), arabic(["البحرين", "المنامة"])] },
  // Oman. "Roman" cannot match: words() puts \b before "oman".
  { name: "Oman", patterns: [words(["oman", "muscat", "salalah"]), arabic(["سلطنة عمان", "مسقط"])] },
  // Jordan: by its capital only. Bare "Jordan" is also a US surname and place name.
  { name: "Jordan", patterns: [words(["amman", "hashemite kingdom of jordan"]), arabic(["الأردن", "الاردن"])] },
  // Lebanon.
  { name: "Lebanon", patterns: [words(["lebanon", "beirut"]), arabic(["لبنان", "بيروت"])] },
  // Iraq.
  { name: "Iraq", patterns: [words(["iraq", "baghdad"]), arabic(["العراق", "بغداد"])] },
  // Egypt (MENA; EMEA boards list it).
  { name: "Egypt", patterns: [words(["egypt", "cairo"]), arabic(["مصر", "القاهرة"])] },
  // Turkey, in both spellings boards use ("türkiye" listed with and without the diacritic).
  { name: "Turkey", patterns: [words(["turkey", "türkiye", "turkiye", "istanbul", "ankara"]), arabic(["تركيا"])] },
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
  // Added 2026-11-04 (7 live "Bangkok" rows passed). Visa-free for Indian tourists, not for work.
  { name: "Thailand", patterns: [words(["thailand", "bangkok"])] },
  { name: "Australia", patterns: [words(["australia", "sydney", "melbourne"])] },
  { name: "New Zealand", patterns: [words(["new zealand", "auckland"])] },
  // The Americas outside the US and Canada. "(?<!new )" keeps New Mexico in the US.
  { name: "Brazil", patterns: [words(["brazil", "são paulo", "sao paulo"])] },
  { name: "Mexico", patterns: [/(?<!new )\bmexico\b/i, /,\s*MX\b/] },
  // Added 2026-11-04: Thoughtworks graduate roles in Santiago and Quito reached the queue.
  { name: "Chile", patterns: [words(["chile"])] },
  // Same source.
  { name: "Ecuador", patterns: [words(["ecuador", "quito"])] },
  // Africa.
  { name: "Mauritius", patterns: [words(["mauritius", "ebene"])] },
];

// Requirement wordings that are US-specific by their own words, each measured in the live sample.
// Country-neutral sponsorship phrases ("unable to sponsor", "without sponsorship") are deliberately
// ABSENT: on live rows they meant the UK, Poland, or an export licence.
//
// EVERY entry drops a REMOTE job too. Teja named ITAR, U.S. person, citizenship and clearance on
// 2026-10-24; asked on 2026-10-25 about the 14 live remote rows that drop only on "authorized to
// work in the US" / green card, he ruled "Drop those 14". So "Remote, USA" is kept unless its JD
// states one of these.
// ponytail: no negation handling, so "we do not require a security clearance" drops (0 live hits on
// 2026-10-25); add a negation window before the match if one shows up in a run summary.
const US_REQUIREMENT: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  // "authorized / eligible / permitted to work (for any employer) in (the) US / United States".
  { label: "authorized to work in the US", pattern: /\b(?:authori[sz]ed|eligible|permitted) to work (?:for any employer )?in (?:the )?(?:united states|u\.?s\.?a?\.?)(?![a-z])/i },
  // A green card is US-only by definition.
  { label: "green card", pattern: /\bgreen card\b/i },
  // "U.S. citizen", "US citizenship", "United States citizen". Not "country of citizenship".
  { label: "US citizenship", pattern: /\b(?:u\.?s\.?|united states) citizen(?:s|ship)?\b/i },
  // The ITAR / export-control "U.S. person" definition.
  { label: "US person (export control)", pattern: /\bu\.?s\.? persons?\b/i },
  // ITAR named outright.
  { label: "ITAR", pattern: /\bitar\b/i },
  // A security clearance: never obtainable by a foreign national. Bare "clearance" is not enough
  // (live: "mechanical fit, alignment, clearance").
  { label: "security clearance", pattern: /\bsecurity clearance\b|\bts\/sci\b/i },
];

// Member lists for the regions below, by canonical name from COUNTRIES. A region resolves to its
// members, so "Remote, EU" is outside Teja's list and inside a list that holds Germany.
const EUROPE = [
  // The UK and Ireland.
  "United Kingdom", "Ireland",
  // Every continental row in COUNTRIES.
  "France", "Germany", "Netherlands", "Spain", "Portugal", "Poland", "Italy", "Switzerland", "Austria", "Belgium",
  "Luxembourg", "Denmark", "Sweden", "Norway", "Finland", "Iceland", "Czech Republic", "Romania", "Serbia", "Slovenia",
  "Lithuania", "Greece", "North Macedonia", "Kosovo",
];
// The Middle East rows.
// 2026-11-06: every row added above joins, or "Remote, Middle East" would resolve to fewer countries than exist.
const MIDDLE_EAST = ["Israel", "United Arab Emirates", "Qatar", "Saudi Arabia", "Kuwait", "Bahrain", "Oman", "Jordan", "Lebanon", "Iraq", "Egypt", "Turkey"];
// North America.
const NORTH_AMERICA = ["United States", "Canada", "Mexico"];
// Latin America rows.
const LATIN_AMERICA = ["Mexico", "Brazil", "Chile", "Ecuador"];

// Regions boards write instead of a country (2026-11-04: "EMEA", "Europe", "Middle East",
// "North America", "Remote, EU" all passed as unknown). APAC and "Asia" are deliberately ABSENT:
// they contain India, so leaving them unknown keeps the job, which is the right answer for Teja
// and the safe one for anyone else.
const REGIONS: readonly { readonly patterns: readonly RegExp[]; readonly members: readonly string[] }[] = [
  // Europe and the EU ("Southern Europe" matches too).
  { patterns: [words(["europe", "european union", "eu"])], members: EUROPE },
  // EMEA: Europe, the Middle East and the African row the table has.
  { patterns: [words(["emea"])], members: [...EUROPE, ...MIDDLE_EAST, "Mauritius"] },
  // The Middle East.
  { patterns: [words(["middle east", "mena"])], members: MIDDLE_EAST },
  // North America.
  { patterns: [words(["north america"])], members: NORTH_AMERICA },
  // The whole Americas ("AMER" is MongoDB's spelling).
  { patterns: [words(["americas", "amer"])], members: [...NORTH_AMERICA, ...LATIN_AMERICA] },
  // Latin America.
  { patterns: [words(["latam", "latin america", "south america"])], members: LATIN_AMERICA },
];

// Every country a piece of text names, by canonical name, regions expanded to their members.
// Used for job locations AND for the user's own list entries, so "USA" in Settings and
// "Remote, USA" on a job resolve alike.
function countriesIn(text: string): Set<string> {
  // A Set, because one part can name a country twice ("San Francisco, CA, USA").
  const named = new Set(COUNTRIES.filter(({ patterns }) => patterns.some((pattern) => pattern.test(text))).map(({ name }) => name));
  // Each region the text names adds all its members.
  for (const region of REGIONS) {
    // Members join the set; a region never removes anything.
    if (region.patterns.some((pattern) => pattern.test(text))) for (const member of region.members) named.add(member);
  }
  // The places this text names.
  return named;
}

// The JD's own location line, for a board location that names no place ("In-Office", "Hybrid",
// "2 Locations", null). Live Cloudflare JDs write "Available Locations: Lisbon, or London",
// "Position Location: Austin, TX | Lisbon, Portugal", or "Available Locations Austin, US" with no
// colon. The label must OPEN a line (stripHtml turns each <p> into one), so "Relocation:",
// "Headquarters location: San Francisco" and "Interview location:" never read as where the job
// is (code review, 2026-11-04). A label word (available/position/job/office/work) or a colon is
// required. The capture runs to the line end.
const JD_LOCATION_LINE = /^\s*(?:(?:available|position|job|office|work)\s+locations?\b\s*:?|locations?\s*:)\s*(.+)$/im;

// A real location list fits well inside this. A longer "line" means prose ran into it (a JD with no
// paragraph breaks), and judging that text could drop on a country named in passing, so it is
// treated as no line at all (fail-open). Long enough for seven cities with countries.
const JD_LOCATION_MAX_CHARS = 300;

// Read the JD's location line, or null when the JD has none (or none that is plainly a list).
function jdLocationLine(description: string | null): string | null {
  // Plain text with line breaks, so the capture ends where the paragraph ends.
  const text = stripHtml(description) ?? "";
  // The first line that opens with a location label.
  const match = text.match(JD_LOCATION_LINE);
  // No such line.
  if (match === null) return null;
  // The list itself, trimmed.
  const line = match[1]!.trim();
  // Too short to name a place, or too long to be only a list: no line.
  return line.length >= 2 && line.length <= JD_LOCATION_MAX_CHARS ? line : null;
}

// Run the gate over one job against the user's work-authorised countries.
// `remotePolicy` is REQUIRED, not optional with a default: every caller must say which reading
// of remote it applies, so a forgotten argument cannot silently restore the 10-24 behaviour.
export function screenWorkAuth(
  job: WorkAuthJob,
  authorizedCountries: readonly string[] | null,
  remotePolicy: RemoteLocationPolicy,
): WorkAuthVerdict {
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
  // NOTHING resolved (Settings is free text, so ["Inida"] is one slip away): an empty set would read
  // as "authorised nowhere" and drop every on-site job, India included. Treat it as never set
  // (section 6). A PARTIAL typo (["Inida", "Nepal"]) still narrows the list; the warning names it.
  if (authorized.size === 0) {
    return { drop: false, warning: `work_auth gate open: no work_authorized_countries entry recognised (${authorizedCountries.join(", ")})` };
  }

  // A location string split into its separate parts, blanks removed so "Belfast;" is one part.
  const splitParts = (text: string): string[] => text.split(PART_SEPARATOR).map((part) => part.trim()).filter((part) => part !== "");
  // A part is provably elsewhere when it names at least one place, none of them authorised, and
  // (under 'any' only) does not say remote. Under 'unlocked_or_authorized' a remote part that
  // names places is judged by those places, which is Teja's 11-04 "no country-locked remote".
  // Each part's places, resolved once: countriesIn runs ~70 regexes, and one part is asked about
  // up to three times below (code review, 2026-11-04).
  const placesOf = new Map<string, Set<string>>();
  // The cached lookup.
  const places = (part: string): Set<string> => {
    // Resolve on first ask.
    if (!placesOf.has(part)) placesOf.set(part, countriesIn(part));
    // Always set by now.
    return placesOf.get(part)!;
  };
  const isElsewhere = (part: string): boolean => {
    // The places this part names.
    const names = places(part);
    // No place named: unknown, or a bare "Remote". Never provably elsewhere.
    if (names.size === 0) return false;
    // One authorised place makes the part reachable.
    if ([...names].some((name) => authorized.has(name))) return false;
    // Elsewhere, unless the old policy treats every remote part as reachable.
    return remotePolicy === "unlocked_or_authorized" || !REMOTE.test(part);
  };

  // The board location's parts.
  const parts = splitParts(job.locationRaw ?? "");
  // True when some part is in a country the user may work in.
  const anyAuthorized = parts.some((part) => [...places(part)].some((name) => authorized.has(name)));

  // LOCATION: drop only when EVERY part is provably elsewhere. One remote-and-open, authorised or
  // unknown part means the job can be done somewhere allowed, or we cannot tell.
  if (parts.length > 0 && parts.every(isElsewhere)) {
    // Say which kind of lock matched, so the run summary reads truthfully.
    const kind = parts.some((part) => REMOTE.test(part)) ? "remote, locked to places" : "on-site/hybrid";
    // Quote the location so a wrong drop is diagnosable from the run summary.
    return { drop: true, code: "work_auth", reason: `location "${job.locationRaw}" is ${kind} outside the work-authorised countries` };
  }

  // JD LOCATION LINE: only when the board location names no place at all and does not say
  // remote. A bare "Remote" is open by Teja's ruling, so its JD is not second-guessed, and a board
  // location that names any place has already decided above.
  const boardNamesNothing = parts.every((part) => places(part).size === 0 && !REMOTE.test(part));
  // The JD's own line, read only in that case.
  const line = boardNamesNothing ? jdLocationLine(job.description) : null;
  // Drop only when every part of the line is provably elsewhere, exactly as for the board string.
  if (line !== null) {
    // The line's parts.
    const lineParts = splitParts(line);
    // The same all-parts test.
    if (lineParts.length > 0 && lineParts.every(isElsewhere)) {
      // Quote both, since the board string alone would not explain the drop.
      return { drop: true, code: "work_auth", reason: `JD location "${line}" is outside the work-authorised countries (board location "${job.locationRaw ?? ""}")` };
    }
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
