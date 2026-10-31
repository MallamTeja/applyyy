// THE SCORE THRESHOLD — decides whether a scored job continues to the Tailor or stops here.
//
// WHY THIS EXISTS: before it, the Matcher advanced EVERY scored row to `scored`, and the
// Tailor takes every `scored` row. A 5/100 fit was tailored, audited and queued for Teja
// exactly like a 90 — one Gemini tailor call per row across the whole passed_filters
// backlog, and an approval queue too long to review. The edge `passed_filters ->
// dropped_filter` already allowed the `matcher` agent; nothing used it.
//
// PURE BY DESIGN: no database, no clock. The Matcher calls it and performs the move, so
// every boundary below is testable without a network (score-threshold.test.ts).
//
// NAMED `score-threshold`, not `gate`, because `_shared/eval/gate.ts` (the Matcher's eval
// CI gate) already exists and matcher/index.ts imports both: one name, two meanings.

// The band function, imported rather than re-implemented so the threshold and the rubric
// can never disagree about which band a score is in.
import { bandForScore, type FitBand } from "./rubric.ts";

// THE THRESHOLD: 45, the floor of the `moderate` band (rubric.ts:63). That band is the one
// rubric.ts:61 names "THE HUMAN-REVIEW BAND" — §P3 routes it to Teja rather than deciding
// for him — so everything at or above it must reach the approval queue, and only the
// `weak` (30-44, "probably skip") and `poor` ("skip") bands stop here.
//
// A NAMED CONSTANT, NOT A SETTING, because no min-score field exists anywhere today
// (checked live 2026-10-05: search_preferences, system_settings and filter_rules have
// none), and adding one is a migration this change was told not to make. It SHOULD become
// a per-user setting; until then, changing it is a reviewed edit pinned by score-threshold.test.ts.
//
// Restated as a number rather than read from rubric.ts's table because that table is
// module-private. score-threshold.test.ts pins 45 explicitly AND checks the 44/45 rows
// against bandForScore, so a band retune that moves the moderate floor fails a test.
export const MATCH_ADVANCE_FLOOR = 45;

// The three outcomes as a closed union, so the caller must handle the refusal case and
// cannot collapse it into a boolean that treats "unreadable" like "low".
export type ScoreThresholdDecision =
  // Continue to the Tailor: passed_filters -> scored.
  | { readonly kind: "advance"; readonly score: number; readonly band: FitBand }
  // Stop here: passed_filters -> dropped_filter, with the reason the dashboard shows.
  | { readonly kind: "drop"; readonly score: number; readonly band: FitBand; readonly reason: string }
  // Not a score at all: no status move, and a reason for the run's failures list.
  | { readonly kind: "invalid"; readonly reason: string };

// Decide what happens to a row given the score the scorer produced.
//
// `unknown` on purpose: the value crosses a boundary (an LLM response, parsed), so the
// type cannot be trusted and the SHAPE is validated here instead of assumed.
// True when a human picked this job by pasting its link (job-link-intake tags discovered_via
// with 'manual'). Shape-checked: anything but an array holding that exact value is "not picked",
// so a missing or malformed column can never wave a scouted row past the floor.
export function isHumanPicked(discoveredVia: unknown): boolean {
  // Array first, so a string "manual" (a mis-typed embed) does not count.
  return Array.isArray(discoveredVia) && discoveredVia.includes("manual");
}

// humanPicked (2026-10-31): a job the human chose by link is never dropped for a low score; the
// floor exists to choose FOR the human among scouted jobs. The score is still validated and
// written, so the approval card shows the fit honestly. Defaults false: every other caller unchanged.
export function decideScoreThreshold(score: unknown, humanPicked = false): ScoreThresholdDecision {
  // A score must be a number; a numeric string means something upstream mis-parsed.
  if (typeof score !== "number") {
    // `String()` keeps null/undefined readable in the failure entry.
    return { kind: "invalid", reason: `invalid_match_score:not_a_number(${String(score)})` };
  }
  // INTEGER, NOT JUST FINITE. weightedTotal rounds, so the scorer only ever emits integers;
  // this also rejects NaN and Infinity, and catches a 0-1 fraction (0.82) on the wrong
  // scale, which would otherwise read as a near-zero score and be dropped silently.
  if (!Number.isInteger(score)) {
    // Reported, never guessed at: rescaling 0.82 to 82 would be inventing an answer.
    return { kind: "invalid", reason: `invalid_match_score:not_an_integer(${score})` };
  }
  // The 0-100 scale; applications.match_score has the same CHECK, so failing here keeps
  // the number from ever being written.
  if (score < 0 || score > 100) {
    // Out of range is a scorer defect, not a low fit.
    return { kind: "invalid", reason: `invalid_match_score:out_of_range(${score})` };
  }
  // Banded by the rubric's own function, so the band in the event matches the dashboard.
  const band = bandForScore(score);
  // `>=` because the floor itself belongs to the human-review band (rubric.ts:63).
  if (score >= MATCH_ADVANCE_FLOOR || humanPicked) {
    // Reviewable or better: on to the Tailor.
    return { kind: "advance", score, band };
  }
  // Below the floor: dropped with a BARE code, like the screener's `tech_gate`, so a
  // group-by on drop_reason counts one reason, not one value per score. The score and band
  // travel in the event's p_detail, which is where per-row numbers belong.
  return { kind: "drop", score, band, reason: "match_below_threshold" };
}
