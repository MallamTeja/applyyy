// The matcher's own Gemini pacer (2026-11-09, docs/status/2026-11-09-matcher-stall.md).
//
// WHY IT EXISTS: the shared client paces every attempt through `defaultGeminiPacer`, whose gap is
// 500 ms. That is up to 120 calls a minute, against a free tier of ~15 RPM shared by all keys (every
// key answered 429 together, so they share one quota). Measured over 11-02..11-09 matcher runs:
// pages that hit 429 ran at a median 18.3 Gemini calls/min (max 26.4), and clean pages at a median
// 7.8. A 10-row page fired its 10 calls back to back, and the drain's 45 s pause sits BETWEEN pages,
// so it never spread them out. The 429s were self-inflicted bursts.
//
// WHY MATCHER-SCOPED and not a new shared default: the shared default also paces interactive
// callers (resume-assist, job-link-intake), where a person waits in the browser. The matcher is the
// batch caller that bursts, so it gets the slow gap; changing the shared default is a separate call.

// The shared pacer class, so the matcher reuses the tested queue/spacing logic instead of a copy.
import { GeminiPacer } from "../_shared/gemini/client.ts";

// Minimum gap between the STARTS of two Gemini attempts from this function: 5 s = at most 12 calls
// a minute. That leaves ~20% headroom under ~15 RPM for other functions spending the same quota
// (tailor, auditor, job-link-intake). A 10-row page then takes ~50 s of spacing plus call time,
// inside the 120 s run budget (_shared/agent/deadline.ts); rows the deadline does not reach stay at
// passed_filters as "left for next run", which is not an error and not a stall.
export const MATCHER_MIN_CALL_GAP_MS = 5_000;

// One instance per isolate (module scope), so a warm isolate serving consecutive drain pages keeps
// spacing across them too, not only within one page.
export const matcherPacer = new GeminiPacer({ minIntervalMs: MATCHER_MIN_CALL_GAP_MS });
