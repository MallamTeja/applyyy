#!/usr/bin/env node
// Tailor golden-set eval runner (tailor plan §6, 2026-11-21). Scores tailorings against what Teja actually wanted.
//
// THE DATA IS PERSONAL AND NEVER ENTERS THE REPO. It is read at runtime from the folder given by --data or the env var
// APPLYY_EVAL_DATA (today: the 2026-11-18 "keep7" handoff folder outside the repo). That folder holds:
//   retailor5/appN-ideal.json     33 hand-built ideal resumes (names, grouped skills); 26 carry the application id
//   retailor5/master.json         the master (v47) the ideals were built from
//   tailor-analysis/tailored.json 108 live rows: tailor_refs (the tailor's own output) + tailored_profile (post-chat)
//   tailor-analysis/masters.json  every master version, so each row is resolved through ITS version
//
// Three sets are scored, each answering one question:
//   A  ideals     the tailor's output vs Teja's 33 ideals (26 matched by app id): skills recall/precision/order + rules
//   B  chat       the tailor's output vs what Teja's chat edits ended at (rows with chat turns): skills recall/precision
//   C  all        every row's tailor output against the rules alone, plus the real validator (provenance)
//   I  ideals-self the ideals themselves against the rules: a sanity check that the rules match the target
//
// Gate: --min-recall <0..1> (set A mean recall) and --min-rules <0..1> (set C mean rule pass rate); below either,
// exit 1. --candidates <file> scores a NEW run instead of the stored tailor_refs: a JSON object
// { "<application id>": { "master_version": 47, "tailor_refs": <TailoredProfile> } } (master_version optional = latest).
// --json prints the machine-readable result instead of the tables.
//
// Node 24 imports the .ts scorer directly (type stripping); the scorer is pure and reads no files itself.

// File reads and paths.
import { readFileSync, readdirSync, existsSync } from "node:fs";
// Joins the data folder with its known layout.
import { join } from "node:path";
// The pure scorer and its adapters.
import { aggregate, fromIdeal, fromResolved, fromTailorRefs, scoreResume } from "../supabase/functions/_shared/tailor/eval/score.ts";
// The real validator, for the provenance column (e1f4b520's rules: sources, kept metrics, title allow-list).
import { validateTailoredProfile } from "../supabase/functions/_shared/tailor/validator.ts";

// --- arguments -------------------------------------------------------------------------------------------------

// "--name value" pairs and bare "--flag"s.
function readArgs(argv) {
  // Collected options.
  const out = {};
  // Walk the argument list.
  for (let i = 0; i < argv.length; i += 1) {
    // Only "--" options are recognised.
    if (!argv[i].startsWith("--")) continue;
    // The option name.
    const key = argv[i].slice(2);
    // The next token is its value unless it is another option or missing.
    const next = argv[i + 1];
    // A flag, or a valued option.
    if (next === undefined || next.startsWith("--")) out[key] = true;
    // Valued: consume it.
    else { out[key] = next; i += 1; }
  }
  // Parsed.
  return out;
}

// Parsed once.
const args = readArgs(process.argv.slice(2));
// The data folder: the argument wins over the env var; nothing has a default, so no personal path is in this file.
const DATA = args.data ?? process.env.APPLYY_EVAL_DATA;
// No folder: say how to give one.
if (typeof DATA !== "string" || !existsSync(DATA)) {
  // Plain instruction, exit 2 (a usage error, distinct from a failed gate).
  console.error("usage: node scripts/tailor-golden-eval.mjs --data <eval folder> [--min-recall 0.6] [--min-rules 0.8] [--candidates file.json] [--json]\n(or set APPLYY_EVAL_DATA)");
  // Usage error.
  process.exit(2);
}

// A threshold argument as a number in [0, 1], or null when not given; anything else is a usage error (§6: no coercion).
function threshold(name) {
  // Not given.
  if (args[name] === undefined) return null;
  // Parsed strictly.
  const value = Number(args[name]);
  // A real fraction, or stop.
  if (typeof args[name] !== "string" || args[name].trim() === "" || !Number.isFinite(value) || value < 0 || value > 1) {
    // Named.
    console.error(`--${name} must be a number from 0 to 1, got ${JSON.stringify(args[name])}`);
    // Usage error.
    process.exit(2);
  }
  // The fraction.
  return value;
}

// The two gates.
const MIN_RECALL = threshold("min-recall");
// The rules gate.
const MIN_RULES = threshold("min-rules");

// --- data ------------------------------------------------------------------------------------------------------

// A JSON file; the exported query files wrap their rows as { boundary, warning, rows } (untrusted-data framing).
function readJson(path) {
  // Parsed.
  const value = JSON.parse(readFileSync(path, "utf8"));
  // The rows when wrapped, the value otherwise.
  return value !== null && typeof value === "object" && Array.isArray(value.rows) ? value.rows : value;
}

// Every master version, by number.
const masters = new Map(readJson(join(DATA, "tailor-analysis", "masters.json")).map((row) => [row.version, row.profile]));
// The newest version, for candidates that do not name one.
const latestVersion = Math.max(...masters.keys());
// The 108 live rows.
const rows = readJson(join(DATA, "tailor-analysis", "tailored.json"));
// Rows by application id.
const rowById = new Map(rows.map((row) => [row.id, row]));
// The master the ideals were built from.
const idealMaster = readJson(join(DATA, "retailor5", "master.json")).profile;
// The ideal files, in app-number order.
const idealFiles = readdirSync(join(DATA, "retailor5")).filter((name) => /^app\d+-ideal\.json$/.test(name)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
// Optional new run to score in place of the stored tailor output.
const candidates = typeof args.candidates === "string" ? readJson(args.candidates) : {};

// A candidate run scores ONLY its own rows: a job the new tailor refused or errored on must not be filled in with the
// stored (old) output, which would mix the "before" into the "after". Without candidates, every row is scored.
const candidateRun = Object.keys(candidates).length > 0;

// The tailoring to score for a row: its candidate in a candidate run (null = not produced), else the stored output.
function tailoringFor(row) {
  // A candidate for this application.
  const candidate = candidates[row.id];
  // Given: its own version, else the latest.
  if (candidate !== undefined) return { refs: candidate.tailor_refs, version: candidate.master_version ?? latestVersion };
  // A candidate run without one for this row: nothing to score.
  if (candidateRun) return { refs: null, version: row.master_version };
  // Stored: the row's own version.
  return { refs: row.tailor_refs, version: row.master_version };
}

// Runs the real validator; a throw counts as a failure with its message, never as a pass.
function provenance(refs, master, version) {
  // Guarded: a malformed stored row must not stop the whole eval.
  try {
    // The shipped validator.
    const result = validateTailoredProfile(refs, master, version);
    // Pass, or the distinct violation kinds.
    return result.ok ? { ok: true, kinds: [] } : { ok: false, kinds: [...new Set(result.violations.map((v) => v.kind))] };
  } catch (error) {
    // Named.
    return { ok: false, kinds: [`threw: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

// Scores one row's tailor output, optionally against a target skill list.
function scoreRow(row, target) {
  // The tailoring and its version.
  const { refs, version } = tailoringFor(row);
  // Its master.
  const master = masters.get(version);
  // A row whose master is missing cannot be scored; reported, not guessed.
  if (master === undefined || refs === null || refs === undefined) return null;
  // Normalised.
  const resume = fromTailorRefs(refs, master);
  // Scored.
  const score = scoreResume(resume, { jd: row.jd ?? "", jobTitle: row.title ?? null, master, ...(target === undefined ? {} : { target }) });
  // With provenance.
  return { id: row.id, company: row.company_name ?? "?", score, provenance: provenance(refs, master, version) };
}

// --- the three sets ----------------------------------------------------------------------------------------------

// A: the ideals with an application id.
const setA = [];
// I: the ideals themselves against the rules.
const setI = [];
// Ideals with no matching row (no app id, or an id not in tailored.json): counted, never matched by guesswork.
const unmatched = [];
// In a candidate run: matched ideals the new tailor produced nothing for (refused or errored).
const uncovered = [];
// Each ideal file.
for (const file of idealFiles) {
  // Parsed.
  const ideal = readJson(join(DATA, "retailor5", file));
  // Normalised.
  const idealResume = fromIdeal(ideal);
  // Its live row.
  const row = typeof ideal.app_id === "string" ? rowById.get(ideal.app_id) : undefined;
  // No row: the ideal is still checked against the rules, with the master it was built from and no JD.
  if (row === undefined) {
    // Recorded.
    unmatched.push(file);
    // Rules only.
    setI.push({ id: file, company: "(no app id)", score: scoreResume(idealResume, { jd: "", jobTitle: null, master: idealMaster }), provenance: null });
    // Next.
    continue;
  }
  // The ideal against the rules, with its JD.
  setI.push({ id: file, company: row.company_name ?? "?", score: scoreResume(idealResume, { jd: row.jd ?? "", jobTitle: row.title ?? null, master: idealMaster }), provenance: null });
  // The tailor output against the ideal's skills.
  const scored = scoreRow(row, idealResume.skills);
  // Kept when scorable; in a candidate run, a matched ideal with no candidate is counted as not covered.
  if (scored !== null) setA.push({ ...scored, id: file });
  // Named, so coverage is part of the result rather than a silent shrink of n.
  else if (candidateRun) uncovered.push(file);
}
// B: rows Teja edited in chat, target = the post-chat skills.
const setB = rows.filter((row) => Number(row.chat_turns) > 0).map((row) => scoreRow(row, fromResolved(row.tailored_profile).skills)).filter((entry) => entry !== null);
// C: every row, rules and provenance only.
const setC = rows.map((row) => scoreRow(row)).filter((entry) => entry !== null);

// --- output ------------------------------------------------------------------------------------------------------

// A fraction as a percentage, or "-" when undefined.
const pct = (value) => (value === null || value === undefined ? "-" : `${Math.round(value * 100)}%`);

// One set's aggregate plus its provenance pass rate.
function summarise(set) {
  // The scorer's aggregate.
  const agg = aggregate(set.map((entry) => entry.score));
  // Entries the validator ran on.
  const checked = set.filter((entry) => entry.provenance !== null);
  // Their pass rate, or null.
  const provenancePass = checked.length === 0 ? null : checked.filter((entry) => entry.provenance.ok).length / checked.length;
  // Violation kinds across the set, counted.
  const violationKinds = {};
  // Counted.
  for (const entry of checked) for (const kind of entry.provenance.kinds) violationKinds[kind] = (violationKinds[kind] ?? 0) + 1;
  // Together.
  return { ...agg, provenancePass, violationKinds };
}

// Every set's summary.
const result = { A_ideals: summarise(setA), B_chat: summarise(setB), C_all: summarise(setC), I_ideals_self: summarise(setI), unmatchedIdeals: unmatched, uncoveredIdeals: uncovered };

// Machine output, or tables.
if (args.json === true) console.log(JSON.stringify(result, null, 2));
// Tables.
else {
  // Set A, one line per ideal.
  console.log("A  tailor output vs ideal (skills + rules)");
  // Header.
  console.log(["ideal", "company", "recall", "prec", "order", "rules", "prov", "failed rules"].join("\t"));
  // Each row.
  for (const entry of setA) console.log([entry.id.replace("-ideal.json", ""), entry.company.slice(0, 18), pct(entry.score.skills?.recall), pct(entry.score.skills?.precision), pct(entry.score.skills?.order), pct(entry.score.rulePassRate), entry.provenance.ok ? "ok" : "FAIL", entry.score.failedRules.join(",")].join("\t"));
  // The aggregates.
  console.log("\nAGGREGATES");
  // One line per set.
  for (const [name, summary] of Object.entries(result).filter(([key]) => key !== "unmatchedIdeals" && key !== "uncoveredIdeals")) {
    // The headline numbers.
    console.log(`${name.padEnd(14)} n=${String(summary.n).padStart(3)}  recall ${pct(summary.meanRecall).padStart(4)}  precision ${pct(summary.meanPrecision).padStart(4)}  order ${pct(summary.meanOrder).padStart(4)}  rules ${pct(summary.meanRulePassRate).padStart(4)}  all-rules ${pct(summary.allRulesPassRate).padStart(4)}  provenance ${pct(summary.provenancePass).padStart(4)}`);
    // Which rules fail most.
    console.log(`${"".padEnd(14)} rule failures: ${JSON.stringify(summary.ruleFailures)}`);
    // Which validator kinds, when the validator ran.
    if (Object.keys(summary.violationKinds).length > 0) console.log(`${"".padEnd(14)} validator kinds: ${JSON.stringify(summary.violationKinds)}`);
  }
  // What could not be matched.
  console.log(`\nideals with no matching row (rules only): ${unmatched.length}`);
  // In a candidate run, what the new tailor did not produce.
  if (candidateRun) console.log(`matched ideals with no candidate (refused or errored): ${uncovered.length}${uncovered.length > 0 ? ` (${uncovered.map((f) => f.replace("-ideal.json", "")).join(", ")})` : ""}`);
}

// The gates.
const failures = [];
// Recall on set A.
if (MIN_RECALL !== null && (result.A_ideals.meanRecall ?? 0) < MIN_RECALL) failures.push(`A mean recall ${pct(result.A_ideals.meanRecall)} < ${pct(MIN_RECALL)}`);
// Rules on set C.
if (MIN_RULES !== null && result.C_all.meanRulePassRate < MIN_RULES) failures.push(`C mean rule pass ${pct(result.C_all.meanRulePassRate)} < ${pct(MIN_RULES)}`);
// Any failed gate: exit 1, named.
if (failures.length > 0) {
  // On stderr, so --json stays parseable.
  console.error(`GATE FAILED: ${failures.join("; ")}`);
  // Non-zero for CI.
  process.exit(1);
}
