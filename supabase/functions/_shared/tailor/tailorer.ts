// THE TAILOR RUNNER — one job in, one verdict out.
//
// This is the piece `_shared/tailor/` was missing. `prompt.ts` builds the call and
// `validator.ts` judges the answer, but nothing joined them, which is why this tree had
// zero non-test importers while looking complete. Deliberately the same shape as
// `../match/scorer.ts`: a factory taking a model seam plus the trusted half of the
// inputs, returning a function over one posting.
//
// PURE OF EVERYTHING EXCEPT THE MODEL. No database, no clock, no Gemini import. The
// `callLlm` seam is what keeps this unit testable with no key pool and no network, and
// it is also what lets this module run under `node --test` at all: `../gemini/` is
// Deno-only (`jsr:` imports, `Deno.env`), so importing it here would make these tests
// unrunnable outside Deno. Persisting the verdict is `persist.ts`'s job; deciding it is
// this file's.
//
// An earlier version of this comment also cited three open `exactOptionalPropertyTypes`
// errors in `../gemini/client.ts` as a reason to stay clear. Those were closed by
// `db98d6e` on 2026-09-18, mid-build. The seam is not why they mattered and the reason
// above stands on its own — recorded rather than silently deleted, because a rationale
// that quietly loses one of its two legs is worth knowing about.
//
// THE DISTINCTION THIS MODULE EXISTS TO HOLD: a model that DID NOT ANSWER and a model
// that answered DISHONESTLY are different events.
//   - did not answer (prose instead of JSON, or JSON of the wrong shape) -> THROW.
//     Nothing was judged, so there is no verdict; reporting one would invent it.
//   - answered dishonestly (a ref that resolves to nothing, a stale pin) -> RETURN a
//     refusal carrying its violations, because that IS a verdict and `validator.ts:70`
//     requires it reach the dashboard "rather than lose them in a stack trace".
// Collapsing either into the other is §5's pattern: malformed data becoming an answer.

// The prompt assembly that fences untrusted posting text out of the instruction region.
import { buildTailorPrompt, type TailorPrompt } from "./prompt.ts";
// The honesty gate. The ONLY constructor of a `ResolvedResume`, per its own header.
import { validateTailoredProfile, type TailorViolation } from "./validator.ts";
// The posting's skill terms, deterministic and vocabulary-gated, for selected_jd_keywords.
import { extractJdKeywords } from "./jd-keywords.ts";
// The contract, reached through this stream's single re-export module. Nothing here
// redefines one of these — a redefined type does not fail, it drifts.
import type { MasterProfile, ResolvedResume, TailoredProfile } from "../contracts/shared-types.ts";

// What a model call looks like from here: a prompt in, raw response text out.
//
// RETURNS A STRING, NOT A PARSED OBJECT, for the same reason `scorer.ts` does — the
// real transport hands back text, and parsing it is a failure surface that belongs
// under test. A seam typed as returning a clean object would quietly move the riskiest
// step outside the boundary being tested.
export type TailorLlmCaller = (prompt: TailorPrompt) => Promise<string>;

// The trusted half of the inputs, supplied once when the tailorer is built rather than
// per call: they do not vary between postings in a run, and threading them through
// every call site would invite a caller to vary them by accident.
export interface TailorDeps {
  // How to reach the model. Injected; see the header.
  readonly callLlm: TailorLlmCaller;
  // Teja's own versioned profile. TRUSTED — the only candidate text allowed to reach
  // the instruction region.
  readonly master: MasterProfile;
  // The pinned version the model must echo back, so a tailoring computed against a
  // different snapshot is detectable rather than silently rendered.
  readonly masterVersion: number;
}

// The untrusted half: everything scraped from the posting, named so the trust boundary
// is visible in the type rather than remembered by the caller.
export interface TailorJobInput {
  // UNTRUSTED. Scraped.
  readonly jobTitle: string;
  // UNTRUSTED. Scraped.
  readonly company: string;
  // UNTRUSTED. Scraped.
  readonly jobDescription: string;
}

// The verdict. A discriminated union rather than a nullable resume, so a caller cannot
// reach for `.resume` without first deciding what to do about a refusal — and so the
// violations have somewhere to live other than a thrown stack.
export type TailorOutcome =
  // Safe to persist and hand onward to the Auditor.
  // `refs` is the raw ref-based output the resume was resolved from. Carried so it can
  // be persisted to `tailor_refs`: the Auditor's summary-ref check (audit/detector.ts:503)
  // reads that column, and nothing wrote it, so the check could never fire.
  // `jdKeywords` is the posting's skill terms (jd-keywords.ts), carried ON the verdict so
  // persist.ts writes them in the same statement as the resume they were measured against.
  | { readonly kind: "tailored"; readonly resume: ResolvedResume; readonly refs: TailoredProfile; readonly jdKeywords: readonly string[] }
  // Never persisted as a profile; the reasons go to the dashboard and the row fails.
  | { readonly kind: "refused"; readonly violations: readonly TailorViolation[] };

// One posting in, one verdict out. Named so call sites read as a noun.
export type Tailorer = (input: TailorJobInput) => Promise<TailorOutcome>;

// Narrow `unknown` to a plain object without asserting anything about its fields.
function isRecord(value: unknown): value is Record<string, unknown> {
  // Arrays are objects to `typeof`, and null is too; both must be excluded before any
  // property access below can be trusted.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Every element of the five ref-plus-bullets sections has the same shape, so it is
// checked once here rather than five times inconsistently.
function hasRefAndBullets(value: unknown): boolean {
  // A node without a `ref` names nothing, and the validator would index `undefined`.
  if (!isRecord(value) || typeof value.ref !== "string") return false;
  // `bullets` is walked directly by the validator; a missing array crashes it.
  return Array.isArray(value.bullets);
}

// The arrays the parser refuses to go without. EXPORTED so the structural test can hold
// `TAILOR_RESPONSE_SCHEMA.required` against this exact tuple: the parser demanded the
// two award arrays while the schema never offered them, so with structured output every
// live call threw "no achievements array". One constant, read by both, ends that class.
export const TAILOR_REQUIRED_ARRAY_KEYS = [
  // Bare refs, no bullets.
  "skills",
  // Bullet-bearing parents from here down; the second parser loop walks these.
  "experience",
  // Projects.
  "projects",
  // Qualifications.
  "education",
  // Awards.
  "achievements",
  // Credentials.
  "certifications",
] as const;

// THE SHAPE CHECK, and the reason it lives in this file rather than in the validator.
//
// `validateTailoredProfile` takes a `TailoredProfile` and TRUSTS that type — it walks
// `tailored.skills` (validator.ts:489), `tailored.achievements` (:646) and
// `tailored.certifications` (:688) with no runtime guard. Types are erased at runtime,
// so handing it raw `JSON.parse` output would surface a bad model response as a
// TypeError from inside the honesty checker: our bug's stack trace for their mistake.
//
// §5's rule, applied literally: validate the SHAPE you expect. This asks "is this the
// object I was promised", never "did the parser give up".
function parseTailoredProfile(raw: string): TailoredProfile {
  // Declared outside the try so the thrown message below can stay about SHAPE, not
  // about syntax, once parsing has succeeded.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A model that returned prose has not tailored anything. Rethrown with our own
    // message because `JSON.parse`'s mentions a character offset into text the caller
    // never sees.
    throw new Error("Tailor response was not JSON");
  }

  // Everything below is a claim the validator would otherwise make on our behalf by
  // crashing. Each one is a property the validator dereferences unconditionally.
  if (!isRecord(parsed)) throw new Error("Tailor response was not a JSON object");
  // The pin the validator compares against; a non-number would compare unequal forever.
  if (typeof parsed.master_version !== "number") throw new Error("Tailor response has no numeric master_version");
  // Drives which sections render, and is iterated.
  if (!Array.isArray(parsed.section_order)) throw new Error("Tailor response has no section_order array");
  // Required arrays, possibly empty — the contract makes them required precisely so an
  // omission cannot be mistaken for a deliberate empty selection.
  // Iterates the exported tuple rather than a local list, so the structural test checks
  // the very keys this loop demands and the two cannot drift apart again.
  for (const key of TAILOR_REQUIRED_ARRAY_KEYS) {
    // Checked by name so the error says which one, rather than "malformed response".
    if (!Array.isArray(parsed[key])) throw new Error(`Tailor response has no ${key} array`);
  }
  // The five sections whose elements carry nested bullets the validator walks. `skills`
  // is excluded deliberately: a `TailoredSkill` is a bare ref with no bullets at all.
  for (const key of TAILOR_REQUIRED_ARRAY_KEYS) {
    // Skipped by name, not by a second hand-kept list that could drift from the first.
    if (key === "skills") continue;
    // `as unknown[]` is safe: the loop above already proved each of these is an array.
    if (!(parsed[key] as unknown[]).every(hasRefAndBullets)) {
      throw new Error(`Tailor response has a malformed entry in ${key}`);
    }
  }
  // Summary is nullable, so only a non-null value has a shape to check — and it is the
  // one place the model emits free prose, which the validator checks against its refs.
  // The schema leaves `summary` optional, so a schema-valid response may OMIT it — and
  // the validator dereferences any non-null summary, so `undefined` would crash it.
  // Omission and null mean the same thing here (no paragraph), so normalise to null.
  if (parsed.summary === undefined) parsed.summary = null;
  // Only a present, non-null summary has a shape left to check.
  if (parsed.summary !== null) {
    if (!isRecord(parsed.summary) || typeof parsed.summary.text !== "string" || !Array.isArray(parsed.summary.refs)) {
      throw new Error("Tailor response has a malformed summary");
    }
  }

  // Every field the validator touches has now been checked to exist and be the right
  // kind. The assertion is earned by the lines above, not assumed.
  return parsed as unknown as TailoredProfile;
}

// Build a tailorer bound to one model and one pinned master profile.
export function createTailorer(deps: TailorDeps): Tailorer {
  // Closes over the trusted inputs so each call supplies only the untrusted posting.
  return async function tailor(input: TailorJobInput): Promise<TailorOutcome> {
    // Assemble with the scraped fields fenced. Only the master and the pin reach the
    // instruction region; the posting goes to the untrusted region as text.
    const prompt = buildTailorPrompt({
      master: deps.master,
      masterVersion: deps.masterVersion,
      jobTitle: input.jobTitle,
      company: input.company,
      jobDescription: input.jobDescription,
    });

    // The one impure step. Everything before and after it is a pure function.
    const raw = await deps.callLlm(prompt);

    // Throws on prose or a wrong-shaped object — see the header on why that is not a
    // refusal. Deliberately before the validator, so the validator only ever sees the
    // type it was written against.
    const tailored = parseTailoredProfile(raw);

    // The honesty gate. This is the only call in the codebase that can produce a
    // `ResolvedResume`, which is what makes "the renderer cannot resolve a ref even by
    // accident" a property of the code rather than a promise.
    const validation = validateTailoredProfile(tailored, deps.master, deps.masterVersion);

    // A refusal is DATA, not an exception: the violations are the dashboard's content
    // and the reason the row will be failed with something a human can act on.
    if (!validation.ok) return { kind: "refused", violations: validation.violations };

    // Clean. The resume is safe to persist and to hand to the Auditor, when one exists.
    // `tailored` is the parsed model output that passed validation — the refs, unresolved.
    // `jdKeywords` comes from the SAME posting the model was given, never re-read later,
    // so the keywords and the resume can never describe two different versions of a job.
    return { kind: "tailored", resume: validation.resume, refs: tailored, jdKeywords: extractJdKeywords(input.jobDescription) };
  };
}
