// Tests for stage 0c — the required-language gate (language-gate.ts).
//
// THE CASE THIS ENCODES (Teja, 2026-11-23 20:00 IST): BBHT 5e108a32 "Java Entwickler:in / Java Developer Backend
// (w/m/d)", board location "Homeoffice", a German JD requiring "fließende Deutschkenntnisse (mind. C1)". The
// work-auth gate kept it (no place named anywhere); this gate must drop it, and must keep "German is a plus".

// node:test and strict assert, the runner the functions suite already uses.
import { test } from "node:test";
// Strict, so a verdict object is compared by shape.
import assert from "node:assert/strict";
// The unit under test.
import { screenLanguage } from "./language-gate.ts";

// The user's list as the migration seeds it: English only.
const ENGLISH = ["English"];

// The real JD lines from live row 5e108a32 (jobs.description_raw, read 2026-11-23 20:02 IST), shortened to the
// requirement block plus enough body text to read as German.
const BBHT_JD = [
  "Software entwickeln ohne Agentur-Feeling. Software die funktioniert.",
  "Du möchtest moderne Java-Anwendungen entwickeln aber nicht in einem Umfeld arbeiten, in dem Tickets wichtiger sind als Menschen? Bei uns entwickelst du Backend-Lösungen für Banken und Versicherungen, arbeitest in agilen Teams und hast die Freiheit, technische Entscheidungen aktiv mitzugestalten.",
  "Wir vereinen Business und IT und schaffen Lösungen für unsere Kunden, die sie gerne nutzen und ihnen ermöglichen, sich auf komplexe und wertschöpfende Tätigkeiten zu fokussieren.",
  "Du passt wahrscheinlich gut zu uns wenn du:",
  "mindestens drei Jahre Erfahrung mit Java-Enterprise-Anwendungen und mit Spring, Spring Boot mitbringst,",
  "du dein Wissen gerne mit anderen Kolleg:innen teilst und ggfs. neue Entwickler:innen einarbeiten möchtest,",
  "über fließende Deutschkenntnisse (mind. C1) verfügst.",
].join("\n");

// The named regression: the live row that leaked must drop, by the stated requirement (not only the body test).
test("BBHT 5e108a32: 'fließende Deutschkenntnisse (mind. C1)' drops as language_required", () => {
  // The verdict for the real lines.
  const verdict = screenLanguage(BBHT_JD, ENGLISH);
  // A drop under this gate's own code.
  assert.equal(verdict.drop, true);
  // Narrowed for the field reads below.
  if (!verdict.drop) return;
  // Never work_auth: the orch ruled the two names must not mean one thing.
  assert.equal(verdict.code, "language_required");
  // The stated requirement fired (it quotes the sentence), not the body fallback.
  assert.match(verdict.reason, /requires German.*Deutschkenntnisse/);
});

// The requirement line alone, with no German body around it, still drops.
test("the requirement line alone drops (no body text to lean on)", () => {
  // One sentence only: too short for the body test.
  const verdict = screenLanguage("über fließende Deutschkenntnisse (mind. C1) verfügst.", ENGLISH);
  // Dropped by the stated requirement.
  assert.equal(verdict.drop, true);
});

// English wordings of a German requirement.
for (const line of ["Fluent German is required.", "You are fluent in English and German.", "German (C1) and English (B2).", "Native German speaker.", "C1 German required.", "Verhandlungssichere Deutschkenntnisse.", "Deutsch auf C1-Niveau."]) {
  // Each one drops.
  test(`drops: ${line}`, () => assert.equal(screenLanguage(line, ENGLISH).drop, true));
}

// Other languages via the same patterns.
for (const line of ["Fluency in Japanese is mandatory.", "Business-level French required.", "Native-level Mandarin."]) {
  // Each one drops.
  test(`drops (other language): ${line}`, () => assert.equal(screenLanguage(line, ENGLISH).drop, true));
}

// Softened, basic or market-only mentions KEEP.
for (const line of [
  "Fluent English required; German is a plus.",
  "German language skills are nice to have.",
  "Deutschkenntnisse sind von Vorteil.",
  "Basic German is helpful.",
  "You will support our German customers in fluent English.",
  "Fluent English is required.",
  "Experience with React Native and Chinese market apps.",
]) {
  // Each one keeps.
  test(`keeps: ${line}`, () => assert.equal(screenLanguage(line, ENGLISH).drop, false));
}

// A language on the list is never a reason.
test("German on the spoken list keeps the BBHT JD", () => {
  // The same lines, but the user speaks German.
  assert.equal(screenLanguage(BBHT_JD, ["English", "Deutsch"]).drop, false);
});

// A long German body with no stated level drops by the body test.
test("a mostly-German body with no stated level drops", () => {
  // The BBHT body without its requirement line, repeated to pass the length floor.
  const body = BBHT_JD.split("\n").slice(0, 6).join("\n").repeat(2);
  // The verdict.
  const verdict = screenLanguage(body, ENGLISH);
  // Dropped, naming the body test.
  assert.equal(verdict.drop, true);
  // Narrowed.
  if (!verdict.drop) return;
  // The body reason, not a stated requirement.
  assert.match(verdict.reason, /body is mostly German/);
});

// A long English JD that mentions one German word stays.
test("an English JD with a stray German word keeps", () => {
  // Long English text plus one "und".
  const text = "We are building the future of payments and you will work with our team on the core platform. ".repeat(10) + "Sturm und Drang.";
  // Kept.
  assert.equal(screenLanguage(text, ENGLISH).drop, false);
});

// FAIL-OPEN cases (CLAUDE.md section 6).
test("unset list opens the gate with a warning", () => {
  // Null = never set.
  const verdict = screenLanguage(BBHT_JD, null);
  // Kept, and the warning says why.
  assert.deepEqual(verdict, { drop: false, warning: "language gate open: search_preferences.spoken_languages is not set" });
});
// A list of only typos is treated as unset, never as "speaks nothing".
test("a list that resolves to nothing opens the gate", () => {
  // "Englsh" is not in the table.
  const verdict = screenLanguage(BBHT_JD, ["Englsh"]);
  // Kept.
  assert.equal(verdict.drop, false);
});
// No JD is missing data.
test("null and blank descriptions keep", () => {
  // Null.
  assert.equal(screenLanguage(null, ENGLISH).drop, false);
  // Blank.
  assert.equal(screenLanguage("   ", ENGLISH).drop, false);
});

// ---- 2026-11-23 peer 2 review: false drops found by running real-shaped inputs through the gate ----------------

test("review: 'or', commas, '&' and 'the' never carry a level to an unrelated language (keeps)", () => {
  // Each input dropped before the CONNECTOR was narrowed; each asks for English, not the other language.
  for (const jd of [
    // Either-or: the second language is never required.
    "Fluent in English or French.",
    // A comma ends the requirement; "Polish office" is a place.
    "Proficiency in English, Polish office.",
    // "&" joins a loose list of welcome speakers.
    "native English & Spanish speakers welcome to apply",
    // "the" carried the level two words further.
    "fluency in English the Japanese way",
  ]) {
    // Kept for an English speaker.
    assert.equal(screenLanguage(jd, ENGLISH).drop, false, jd);
  }
  // Control: "and" still joins two REQUIRED languages, so the gate still bites.
  assert.equal(screenLanguage("Fluent in English and German.", ENGLISH).drop, true);
});

test("review: 'Deutsche Bank', 'Deutschland' and 'C2C' are not German requirements (keeps)", () => {
  // Client and place names on Indian contract JDs, plus the US contract type "C2C".
  for (const jd of ["Client: Deutsche Bank / C2C only", "Deutsche Bank, C2 role", "Our office in Deutschland is hybrid.", "Deutschen Telekom project, C2C."]) {
    // None states a German requirement.
    assert.equal(screenLanguage(jd, ENGLISH).drop, false, jd);
  }
  // Control: the stem still reads the real requirement words.
  assert.equal(screenLanguage("Sehr gute Deutschkenntnisse (C1) erforderlich.", ENGLISH).drop, true);
});

test("review: a German imprint footer under a short English JD keeps (only the head is judged)", () => {
  // A plain English body of ~50 words.
  const english = "We are hiring a backend engineer to build our payments platform. You will design APIs, write Java and Spring services, review code with the team and own features from design to production. You have three years of experience with Java, SQL and cloud services and you enjoy working with product people.";
  // A ~90-word German imprint/privacy block, as German employers append to English posts.
  const footer = "Impressum und Datenschutz: Die Firma ist eine Gesellschaft mit Sitz in Berlin. Wir verarbeiten deine Daten nur für die Bewerbung und geben sie nicht an Dritte weiter. Du kannst der Verarbeitung jederzeit widersprechen und die Löschung deiner Daten verlangen. Die Daten werden nach Abschluss des Verfahrens gelöscht, sofern du nicht in eine längere Speicherung eingewilligt hast. Für Fragen zum Datenschutz erreichst du uns per E-Mail, wir sind für dich da und antworten dir bei allen Fragen zu deinen Rechten und zu der Verarbeitung von deinen Daten bei uns.";
  // The English job stays, whatever the footer's language. The block is appended twice (imprint, then privacy notice):
  // over the WHOLE text its stopwords outnumber English's more than 2:1, so only the head window keeps this job.
  assert.equal(screenLanguage(`${english}\n\n${footer}\n\n${footer}`, ENGLISH).drop, false);
});

test("review: a NULL element in spoken_languages is skipped, never a throw", () => {
  // Postgres text[] allows NULL elements; the cast mirrors what a row can carry.
  const list = [null, "English"] as unknown as string[];
  // English still resolves, so a German requirement drops and nothing throws.
  assert.equal(screenLanguage("Fluent German required.", list).drop, true);
  // A list of only NULL resolves to nothing: the gate opens.
  assert.equal(screenLanguage("Fluent German required.", [null] as unknown as string[]).drop, false);
});
