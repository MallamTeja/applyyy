// The Matcher scorer — the seam that composes prompt assembly, the model, and the rubric.
//
// THIS MODULE MAKES NO NETWORK CALL AND IMPORTS NO GEMINI CODE. The model arrives as an
// injected function. That is the same decision `eval/gate.ts` makes, and copying it buys
// three things that are easy to undervalue until they are missing:
//
//   1. Every branch here is testable without quota, including the error paths — which are
//      the branches most likely to be wrong and least likely to be exercised live.
//   2. The scorer cannot be coupled to the Gemini key pool, which currently has a live
//      production defect (`claim_gemini_key()` returning NULL forever). A module that
//      does not import it cannot be broken by it.
//   3. `_shared/gemini/client.ts` stays GENERIC. If the job-posting-specific fencing lived
//      in the client, every future caller would inherit a job-board-shaped assumption it
//      may not want, and the next person adding a non-posting Gemini call would have to
//      reason about why the client sanitises something that was never untrusted.
//
// CONFORMS TO THE EXISTING `Scorer` SEAM rather than defining a parallel one. `eval/
// gate.ts` already declares `Scorer = (evalCase: EvalCase) => Promise<MatchScore>` and
// calls it "THE INJECTION SEAM". Matching it exactly means this scorer is directly
// runnable by `runEvalGate` the day Teja finishes his ~20 hand-labels, with no adapter in
// between — which is the entire payoff of conforming instead of inventing.

// The case and result shapes from the eval gate. Never redefined: a redefined type does
// not fail, it drifts.
import type { EvalCase, MatchScore, Scorer } from "../eval/gate.ts";
// The prompt assembly that keeps untrusted posting text out of the instruction region.
import { buildScorerPrompt, type ScorerPrompt } from "./prompt.ts";
export type { ScorerPrompt } from "./prompt.ts";
// The weighting, banding and validation.
import { weightedTotal, type DimensionScores } from "./rubric.ts";
// The posting as text, the one helper every edge reader of description_raw shares (N1).
import { postingText } from "../tailor/posting-text.ts";

// What a model call looks like from here: a prompt in, raw response text out.
//
// RETURNS A STRING, NOT A PARSED OBJECT, DELIBERATELY. The real transport hands back text
// and parsing it is a failure surface that belongs under test. A seam typed as returning
// a clean object would quietly move the riskiest step outside the boundary being tested.
export type LlmCaller = (prompt: ScorerPrompt) => Promise<string>;

// The trusted half of the inputs, supplied once when the scorer is built rather than per
// call — it does not vary between postings within a run, and threading it through every
// call site would invite a caller to vary it by accident.
export interface ScorerDeps {
  // How to reach the model. Injected; see the header.
  readonly callLlm: LlmCaller;
  // Our own master profile, rendered. TRUSTED — this is the only candidate-specific text
  // permitted in the instruction region.
  readonly candidateProfile: string;
  // Which master version this judgement is made against, so a stale score is detectable
  // rather than silently trusted when the profile later changes.
  readonly masterVersion: number;
}

// Narrow `unknown` to a plain object without asserting anything about its fields.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Build a scorer bound to one model and one candidate profile.
export function createScorer(deps: ScorerDeps): Scorer {
  return async function score(evalCase: EvalCase): Promise<MatchScore> {
    // The frozen posting as it was captured. Reading through `job_snapshot` rather than a
    // live row is what makes an eval case a regression test rather than a moving target.
    const snapshot = evalCase.job_snapshot;

    // Assemble with the untrusted fields fenced. All four scraped fields go to the
    // untrusted region; only the profile and a version number reach the instructions.
    const prompt = buildScorerPrompt({
      jobTitle: snapshot.title,
      company: snapshot.company_name,
      // As TEXT (N1, 2026-11-07): stored rows may be raw HTML, pure token cost and noise to the model.
      jobDescription: postingText(snapshot.description_raw),
      locationRaw: snapshot.location_raw,
      candidateProfile: deps.candidateProfile,
      masterVersion: deps.masterVersion,
    });

    // The one call. Everything before and after it is pure.
    const raw = await deps.callLlm(prompt);

    // PARSE FAILURES ARE ERRORS, NOT ZEROS. A model that returns prose instead of JSON has
    // not scored the job, and the only honest report of that is a throw. Swallowing it
    // into a default would manufacture a fit score out of a transport failure.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // The raw text is deliberately NOT interpolated into this message: it is
      // model-authored and may itself echo a hostile posting, and error strings get logged
      // and rendered in places that do not escape.
      throw new Error("match scorer: could not parse the model response as JSON");
    }

    // VALID JSON OF THE WRONG SHAPE IS THE SNEAKIER FAILURE. `[1,2,3]` parses cleanly, and
    // a careless implementation would read four `undefined`s off it and score zero — a
    // confident-looking number derived from nothing.
    if (!isRecord(parsed)) {
      throw new Error("match scorer: the model response was not a JSON object");
    }

    // Hand the dimensions to the rubric WITHOUT pre-filling anything. The rubric raises on
    // missing, null, non-finite and out-of-range values, and routing validation through it
    // rather than duplicating the checks here means there is exactly one definition of a
    // valid score. `weightedTotal` is doing the validating; this cast only gets it there.
    const dimensions = parsed as unknown as DimensionScores;

    // Raises if any dimension is absent or outside the scale. Deliberately NOT wrapped in
    // a try/catch — the caller must see why, and the dimension name is in the message.
    const total = weightedTotal(dimensions);

    // The justification. Required by the schema, but a model can still omit it, and an
    // empty string is more honest than inventing prose that reads like a judgement.
    const reasoning = typeof parsed["reasoning"] === "string" ? parsed["reasoning"] : "";

    // CARRIED VERBATIM, NOT SANITISED. This field may quote the posting, so it is
    // untrusted on the way out as well as in — but stripping it here would make the stored
    // reasoning disagree with what the model actually said, which is the same argument the
    // ATS adapters use for storing descriptions unmodified. The obligation sits with
    // whoever renders it: escape on display, never feed it into a control-flow decision.
    return { score: total, reasoning };
  };
}
