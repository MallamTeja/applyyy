// Stage 0c — the required-language gate: a JD that REQUIRES fluency in a language the user does not speak drops.
//
// WHY IT EXISTS (Teja, 2026-11-23 20:00 IST: "rm the most recent java job because it needs germany ... make filter
// which removes it"). BBHT 5e108a32, "Java Entwickler:in / Java Developer Backend (w/m/d)", board location
// "Homeoffice", a JD written wholly in German that asks for "fließende Deutschkenntnisse (mind. C1)". The work-auth
// gate kept it, correctly by its own rules: "Homeoffice" names no place, and the JD names no country. What made the
// job impossible was the LANGUAGE, so the orch ruled (2026-11-23 ~20:05) a separate gate with its own drop code
// rather than stretching `work_auth` until its name meant two things (CLAUDE.md, naming).
//
// THE RULE, in one line:
//   DROP iff the user's spoken languages are set AND (a sentence REQUIRES fluency in a language not on the list, and
//   that sentence does not soften it to "a plus"; OR the JD body is mostly written in a language not on the list).
//
// FAIL-OPEN ON MISSING DATA (CLAUDE.md section 6): no list, a list that resolves to nothing, no JD, a language the
// table does not know, a soft "German is a plus" and a short JD all KEEP. Only a positive signal drops.
//
// LOCATION IS NEVER READ. This gate judges words in the JD, not where the job is, so it never drops an
// India-eligible or unknown-location row on location grounds (the 11-05 ruling stays the work-auth gate's).
//
// Browser-safe like work-auth-gate.ts: no Deno APIs, no npm:/jsr:/node: imports.

// The HTML stripper the ATS adapters use, so sentences are read from plain text with paragraph breaks kept.
import { stripHtml } from "../ats/types.ts";

// The single drop_reason this gate writes. A closed literal so no caller invents a spelling. applications.drop_reason
// is free text (no CHECK constraint, verified live 2026-11-23), so a new code needs no migration.
export type LanguageDropCode = "language_required";

// The verdict, the same three-outcome shape as the tech and work-auth gates, so one reading covers all three.
export type LanguageVerdict =
  // No objection.
  | { readonly drop: false }
  // No objection, but the list is unset or partly unreadable, which should be visible in the run summary.
  | { readonly drop: false; readonly warning: string }
  // Rejected. `code` lands in applications.drop_reason; `reason` quotes the JD so a wrong drop is diagnosable.
  | { readonly drop: true; readonly code: LanguageDropCode; readonly reason: string };

// One language the gate can recognise: its canonical name (what the list resolves to and the reason quotes), the
// names a JD or a Settings entry uses for it, and the common words that mark a body written in it.
interface LanguageEntry {
  // Canonical English name.
  readonly name: string;
  // Lower-case spellings, English and native, matched as whole words (a native form may be a word STEM, see `stem`).
  readonly aliases: readonly string[];
  // True when the native alias is a stem glued to more letters ("Deutschkenntnisse", "Deutsch-"): no word end then.
  readonly stem?: boolean;
  // Endings a stem must NOT run on into, because those words are names, not the language (2026-11-23 review:
  // "Deutsche Bank", "Deutschland", "Deutsche Telekom" read as German; a client line on an Indian contract JD).
  readonly stemNot?: string;
  // Function words common in this language and rare in English; empty when body detection is not attempted.
  readonly stopwords: readonly string[];
}

// The languages the gate knows. English is here so an entry "English" resolves, and its stopwords are the baseline
// the body test compares against. Body detection is limited to Latin-script languages whose function words are
// distinctive; the rest are judged by a stated requirement only. A language absent from this table is never judged.
const LANGUAGES: readonly LanguageEntry[] = [
  // The baseline: an English body is never "foreign", and English stopwords are what the body test compares with.
  { name: "English", aliases: ["english", "englisch"], stopwords: ["the", "and", "of", "to", "with", "for", "you", "we", "our", "is", "are", "will", "your", "in", "on"] },
  // The measured case (BBHT). "deutsch" is a stem: "Deutschkenntnisse", "Deutsch-", "deutschsprachig".
  // "Deutsche"/"Deutschen" (an adjective before a noun: Bank, Telekom, Sprache) and "Deutschland" are excluded: the
  // safe direction, since a real German requirement says "Deutschkenntnisse"/"Deutsch" and the body test remains.
  { name: "German", aliases: ["german", "deutsch"], stem: true, stemNot: "(?:en?|land)(?!\\p{L})", stopwords: ["und", "der", "die", "das", "mit", "für", "wir", "du", "sie", "ist", "nicht", "auf", "ein", "eine", "zu", "von", "bei", "uns", "dich", "dein", "deine", "oder", "werden", "sind"] },
  // French. Stopwords skip "de"/"la" (Spanish and Dutch share them).
  { name: "French", aliases: ["french", "français", "francais"], stopwords: ["et", "les", "des", "pour", "vous", "nous", "avec", "une", "est", "dans", "sur", "aux", "votre", "nos", "être"] },
  // Spanish.
  { name: "Spanish", aliases: ["spanish", "español", "espanol", "castellano"], stopwords: ["y", "los", "las", "para", "con", "una", "que", "del", "por", "nuestro", "nuestra", "tu", "es", "somos"] },
  // Dutch.
  { name: "Dutch", aliases: ["dutch", "nederlands"], stopwords: ["het", "een", "en", "van", "voor", "met", "wij", "jij", "je", "zijn", "onze", "naar", "ook", "niet"] },
  // Portuguese. "no" is left out: it is an English word.
  { name: "Portuguese", aliases: ["portuguese", "português", "portugues"], stopwords: ["os", "uma", "para", "com", "você", "nosso", "nossa", "não", "são", "das", "dos", "na", "em"] },
  // Italian.
  { name: "Italian", aliases: ["italian", "italiano"], stopwords: ["il", "della", "per", "con", "siamo", "sono", "nostro", "nostra", "che", "gli", "lavoro"] },
  // The rest are judged only by a stated requirement ("fluent Japanese"), never by body detection.
  { name: "Polish", aliases: ["polish", "polski"], stopwords: [] },
  { name: "Swedish", aliases: ["swedish", "svenska"], stopwords: [] },
  { name: "Danish", aliases: ["danish", "dansk"], stopwords: [] },
  { name: "Norwegian", aliases: ["norwegian", "norsk"], stopwords: [] },
  { name: "Finnish", aliases: ["finnish", "suomi"], stopwords: [] },
  { name: "Czech", aliases: ["czech"], stopwords: [] },
  { name: "Hungarian", aliases: ["hungarian"], stopwords: [] },
  { name: "Romanian", aliases: ["romanian"], stopwords: [] },
  { name: "Greek", aliases: ["greek"], stopwords: [] },
  { name: "Turkish", aliases: ["turkish"], stopwords: [] },
  { name: "Russian", aliases: ["russian"], stopwords: [] },
  { name: "Ukrainian", aliases: ["ukrainian"], stopwords: [] },
  { name: "Hebrew", aliases: ["hebrew"], stopwords: [] },
  { name: "Arabic", aliases: ["arabic"], stopwords: [] },
  { name: "Japanese", aliases: ["japanese"], stopwords: [] },
  { name: "Korean", aliases: ["korean"], stopwords: [] },
  // One entry: a JD writes "Mandarin", "Chinese" or "Cantonese" for the same hiring need.
  { name: "Chinese", aliases: ["chinese", "mandarin", "cantonese"], stopwords: [] },
  // Indian languages, so a user entry "Telugu" resolves and a JD requiring one the user lacks is judged like any other.
  { name: "Hindi", aliases: ["hindi"], stopwords: [] },
  { name: "Telugu", aliases: ["telugu"], stopwords: [] },
  { name: "Tamil", aliases: ["tamil"], stopwords: [] },
  { name: "Kannada", aliases: ["kannada"], stopwords: [] },
  { name: "Malayalam", aliases: ["malayalam"], stopwords: [] },
  { name: "Marathi", aliases: ["marathi"], stopwords: [] },
  { name: "Bengali", aliases: ["bengali", "bangla"], stopwords: [] },
];

// A letter of any script: \b is ASCII-only without the `u` flag, and "français" or "für" must still be whole words.
const NOT_LETTER_AFTER = "(?!\\p{L})";
// The same check before a word.
const NOT_LETTER_BEFORE = "(?<!\\p{L})";

// The alias alternation for one language, whole-word unless the entry is a stem.
const aliasSource = (entry: LanguageEntry): string =>
  // A stem may run on into more letters ("Deutschkenntnisse"); a plain alias may not ("germane" is not German).
  `${NOT_LETTER_BEFORE}(?:${entry.aliases.join("|")})${entry.stem === true ? `${entry.stemNot === undefined ? "" : `(?!${entry.stemNot})`}\\p{L}*` : NOT_LETTER_AFTER}`;

// Words that make a stated level a REQUIREMENT of fluency, in English. "Basic", "conversational" and "some" are absent
// on purpose: they ask for less than fluency, so they never drop.
const FLUENCY = "(?:fluent|fluency|fluently|native|proficient|proficiency|business[- ]level|business[- ]fluent|full professional|excellent command|strong command|mother tongue|c1|c2)";
// Words that may sit between the level and the language ("fluent in English and German", "native-level spoken German").
// NARROWED 2026-11-23 (peer 2 review): "or", ",", "&", "/" and "the" are gone. With them a level walked across a list
// to an unrelated language ("Fluent in English or French", "Proficiency in English, Polish office", "native English &
// Spanish speakers welcome" all dropped). "or" never requires the second language; the others join loose lists. "and"
// and "english" stay, so "fluent in English and German" (both required) still drops.
const CONNECTOR = "(?:in|of|level|-level|speaker|spoken|written|and|verbal|command|english)";
// German-language fluency words (the BBHT JD: "fließende Deutschkenntnisse (mind. C1)").
const FLUENCY_DE = "(?:fließend|fliessend|verhandlungssicher|sehr gut|exzellent|ausgezeichnet|muttersprachlich|perfekt)\\p{L}*";

// The patterns that state a requirement of fluency in one language. All case-insensitive, Unicode-aware.
function requirementPatterns(entry: LanguageEntry): RegExp[] {
  // The language itself.
  const lang = aliasSource(entry);
  // The list, built fresh per language (the table is small and this runs once per module load).
  const patterns = [
    // Level first: "fluent German", "fluency in English and German", "native German speaker", "C1 German".
    // "React Native" is a framework, not a level ("React Native and Chinese market apps" must keep), hence the lookbehind.
    new RegExp(`(?<!react[\\s-])${NOT_LETTER_BEFORE}${FLUENCY}${NOT_LETTER_AFTER}(?:\\s*${CONNECTOR}){0,4}\\s*${lang}`, "iu"),
    // Language first: "German (C1)", "German: fluent", "German language fluency", "German C1 required".
    new RegExp(`${lang}\\s*(?:language\\s*)?(?:skills\\s*)?[(:\\-–]?\\s*(?:at\\s+)?(?:level\\s+)?(?:min(?:imum)?\\s*)?${FLUENCY}${NOT_LETTER_AFTER}`, "iu"),
  ];
  // German's own wording, read only for the German entry: "fließende Deutschkenntnisse", "Deutsch auf C1-Niveau".
  if (entry.name === "German") {
    // Level first, up to two words between ("sehr gute Deutsch- und Englischkenntnisse").
    patterns.push(new RegExp(`${NOT_LETTER_BEFORE}${FLUENCY_DE}\\s+(?:\\S+\\s+){0,2}?${lang}`, "iu"));
    // Language first, up to three words between ("Deutschkenntnisse (mind C1)", "Deutsch auf C1-Niveau").
    // "c1|c2" must end there (2026-11-23): "C2C" (a US contract type) is not the C2 level.
    patterns.push(new RegExp(`${lang}\\s*[(:\\-–]?\\s*(?:\\S+\\s+){0,3}?(?:mind(?:estens)?\\s*)?(?:c[12](?![\\p{L}\\p{N}])|${FLUENCY_DE}|muttersprach\\p{L}*)`, "iu"));
  }
  // Every way this language can be required.
  return patterns;
}

// Each language with its patterns, compiled once.
const REQUIREMENTS = LANGUAGES.map((entry) => ({ name: entry.name, patterns: requirementPatterns(entry) }));

// A sentence that softens a language to a nice-to-have. Then the sentence never drops, even with "fluent" in it
// ("Fluent English required; German is a plus"): the safe direction when one sentence mixes both.
const SOFT = /(?<!\p{L})(?:plus|nice[- ]to[- ]have|bonus|advantage\p{L}*|prefer\p{L}*|desir\p{L}*|beneficial|ideally|helpful|optional|not required|asset)(?!\p{L})|von vorteil|wünschenswert|wuenschenswert|idealerweise|gerne gesehen/iu;

// Abbreviations whose full stop is not a sentence end ("mind. C1", "z. B."); the dot is dropped before splitting.
const ABBREVIATIONS = /(?<!\p{L})(mind|min|ca|bzw|z\. ?b|e\.g|i\.e|etc)\./giu;

// Plain text cut into sentences: line breaks, or a full stop / ! / ? followed by space.
function sentencesOf(text: string): string[] {
  // Abbreviation dots out first, so "(mind. C1)" stays in its sentence.
  const cleaned = text.replace(ABBREVIATIONS, "$1");
  // Split, trim, and drop the empties.
  return cleaned.split(/\n|[.!?](?=\s)/).map((sentence) => sentence.trim()).filter((sentence) => sentence !== "");
}

// The fewest words a body needs before its language is judged: a short JD is too little text to tell.
const BODY_MIN_WORDS = 80;
// A foreign language "dominates" when its stopwords outnumber English's by this factor.
const BODY_DOMINANCE = 2;
// And reach at least this count, so a stray "und" in a long English JD never counts.
const BODY_MIN_HITS = 15;
// Only the first this-many words are judged (2026-11-23): enough for a body (BBHT's German starts at word 1), too few
// for a trailing footer to decide. Must stay >= BODY_MIN_WORDS, or no body would ever be judged.
const BODY_HEAD_WORDS = 120;

// The language the body is mostly written in, by stopword counts, or null for English / too short / unclear.
function bodyLanguage(text: string): { readonly name: string; readonly hits: number; readonly english: number } | null {
  // Lower-case words of any script, the HEAD only (2026-11-23 review): a JD states its language at the top, while an
  // imprint, privacy or benefits footer in another language sits at the bottom and outweighed a short English body.
  const tokens = (text.toLowerCase().match(/\p{L}+/gu) ?? []).slice(0, BODY_HEAD_WORDS);
  // Too short to judge.
  if (tokens.length < BODY_MIN_WORDS) return null;
  // Stopword hits per language.
  const counts = LANGUAGES.filter((entry) => entry.stopwords.length > 0).map((entry) => {
    // A Set for the lookup.
    const set = new Set(entry.stopwords);
    // How many tokens are this language's function words.
    return { name: entry.name, hits: tokens.filter((token) => set.has(token)).length };
  });
  // English's count is the baseline.
  const english = counts.find((count) => count.name === "English")?.hits ?? 0;
  // The strongest non-English language.
  const best = counts.filter((count) => count.name !== "English").sort((a, b) => b.hits - a.hits)[0];
  // Dominant and frequent enough, or no verdict.
  return best !== undefined && best.hits >= BODY_MIN_HITS && best.hits > BODY_DOMINANCE * english ? { ...best, english } : null;
}

// Resolve one Settings entry ("Deutsch", "english", "Telugu") to a canonical name, or null when the table lacks it.
function resolveLanguage(entry: string): string | null {
  // A NULL element of the text[] (Postgres allows one) is no answer, never a throw that stops the whole batch (2026-11-23).
  if (typeof entry !== "string") return null;
  // Compared lower-case and trimmed.
  const key = entry.trim().toLowerCase();
  // The first table row whose name or alias equals the entry.
  return LANGUAGES.find((language) => language.name.toLowerCase() === key || language.aliases.includes(key))?.name ?? null;
}

// Run the gate over one JD against the languages the user speaks. `knownLanguages` is REQUIRED: null is the explicit
// "never set", which opens the gate and warns, so no caller can forget it and silently switch the gate off.
export function screenLanguage(description: string | null, knownLanguages: readonly string[] | null): LanguageVerdict {
  // Unset: open, and say so.
  // Any non-array (null, or undefined from a caller or fixture built before 2026-11-23) is "never set": the gate opens,
  // never throws on `.map` and stops a whole screening batch (CLAUDE.md section 6: missing data is not an answer).
  if (!Array.isArray(knownLanguages)) return { drop: false, warning: "language gate open: search_preferences.spoken_languages is not set" };
  // The entries, each resolved through the table.
  const resolved = knownLanguages.map((entry) => ({ entry, name: resolveLanguage(entry) }));
  // The canonical languages the user speaks.
  const known = new Set(resolved.flatMap(({ name }) => (name === null ? [] : [name])));
  // Entries the table lacks are named, so a typo never silently narrows the list.
  const unknown = resolved.filter(({ name }) => name === null).map(({ entry }) => entry);
  // The warning, if any, travels with whatever verdict follows.
  const warning = unknown.length > 0 ? `spoken_languages entries not recognised: ${unknown.join(", ")}` : null;
  // NOTHING resolved: an empty set would read as "speaks nothing" and drop every JD naming a language. Treat as unset.
  if (known.size === 0) return { drop: false, warning: `language gate open: no spoken_languages entry recognised (${knownLanguages.join(", ")})` };
  // A keep, carrying the warning when there is one.
  const keep = (): LanguageVerdict => (warning === null ? { drop: false } : { drop: false, warning });
  // Plain text; no JD means nothing to judge.
  const text = stripHtml(description);
  // Missing data is never a drop.
  if (text === null || text.trim() === "") return keep();

  // STATED REQUIREMENT: the first non-soft sentence that requires a language the user lacks.
  for (const sentence of sentencesOf(text)) {
    // A softened sentence never drops.
    if (SOFT.test(sentence)) continue;
    // Each language the user does not speak.
    for (const { name, patterns } of REQUIREMENTS) {
      // Known languages are never a reason.
      if (known.has(name)) continue;
      // Required here: drop, quoting the sentence (capped, so one run-on JD cannot flood the run summary).
      if (patterns.some((pattern) => pattern.test(sentence))) {
        return { drop: true, code: "language_required", reason: `JD requires ${name}, not in spoken_languages: "${sentence.slice(0, 200)}"` };
      }
    }
  }

  // BODY LANGUAGE: a JD written mostly in a language the user lacks, even with no stated level.
  const body = bodyLanguage(text);
  // Dominant and not spoken: drop, with the counts so a wrong drop is diagnosable.
  if (body !== null && !known.has(body.name)) {
    return { drop: true, code: "language_required", reason: `JD body is mostly ${body.name} (${body.hits} ${body.name} vs ${body.english} English function words), not in spoken_languages` };
  }

  // No positive signal: keep.
  return keep();
}
