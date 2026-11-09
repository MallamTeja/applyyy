# Matcher stage stalls and page-cap hits: cause and fix, 2026-11-09 ~17:50 IST

Measured from `agent_runs` (agent `matcher`, 2026-11-02 to 11-09: 212 runs, 1,721 rows read, 342 row errors) and the drain job logs. SELECTs only.

## Error kinds

`error_detail` holds each run's distinct failure messages. These counts are runs mentioning each kind, not row counts.

| Kind | Runs | What it is |
|---|---|---|
| `gemini_call_failed: upstream_unavailable … HTTP 503 Service Unavailable` | 58 | Model overload ("high demand"), per MODEL. `GEMINI_FALLBACK_MODEL` is set live (since 2026-10-09). |
| `gemini_call_failed: rate_limited_all_retries_exhausted` | 43 | 429 on every key tried, so the keys share one quota. |
| `upstream_unavailable … network error: timeout` | 6 | Transport timeout. |
| `matcher_failed: N row moved to failed` | 6 | Rows failed on purpose (2-strike model-answer rule); not a stall. |
| pre-gate drops / sweep survivors / deadline notes | 34 / 4 / 3 | Informational, not errors. |

## The three failed drains

| Drain | Count gate | Matcher pages | Read | Advanced | Errored |
|---|---|---|---|---|---|
| 41475706230 (11-02 15:51) | not logged | 6 | 60 | 24 | 28 |
| 41993784498 (11-05 08:21) | 373 | 9 | 90 | 41 | 49 |
| 42073925051 (11-05 17:22) | 375 | 40 (cap) | 400 | 201 | 198 |

About half of every read errored. At that rate, 40 pages × 10 rows advance about 200 rows, and the queue was larger.

## Root cause: two causes, only one of them ours

### 1. 429s are self-inflicted bursts (FIXED)

Call rate inside a page, computed as `gemini_calls / duration` for each run with ≥ 5 rows:

| Page outcome | Pages | Median calls/page | Median calls/min | Max calls/min |
|---|---|---|---|---|
| clean | 20 | 6 | 7.8 | 22.8 |
| 429 | 33 | 10 | **18.3** | 26.4 |
| 503 | 21 | 9 | 7.0 | 10.7 |

The shared client paces every attempt through `defaultGeminiPacer` (`_shared/gemini/client.ts:93`) with a **500 ms** gap: up to 120 calls/min. Its comment says "safely within 15-60 RPM limits", which is wrong by 8× at the low end.
- A 10-row matcher page therefore fires its calls back to back at 18-26/min, over the ~15 RPM free tier.
- The drain's 45 s pause sits between PAGES, so it never spreads the calls inside one.

### 2. 503s are upstream capacity (NOT ours)

503 pages ran at only 7 calls/min. The model was overloaded independently of our rate, and the fallback model is already configured. No code change fixes that. It is a capacity call for Teja: a different primary or fallback model, or a paid tier.

### Considered and rejected: "the hot loop"

Errored rows do stay at `passed_filters` and are re-read at the head of the next page (`matcher/index.ts:369`, oldest first). But 429 and 503 are global, not tied to a row. Skipping a row that errored this run would only send the next call to another row hitting the same wall, so it would not raise the success rate.

Rows that fail for row-specific reasons (an unreadable model answer) already have the 2-strike rule (`fail-exit.ts`). Measured, not worth a change.

## Fix (uncommitted)

- `supabase/functions/matcher/pacer.ts` (new): `matcherPacer = new GeminiPacer({ minIntervalMs: 5_000 })`.
  - That is at most 12 calls/min, about 20% under the ~15 RPM ceiling, leaving room for other functions on the same quota.
  - A 10-row page then takes ~50 s of spacing plus call time, inside the 120 s run budget.
  - Rows the deadline does not reach stay queued as "left for next run", not as errors.
- `supabase/functions/matcher/index.ts`: passes `pacer: matcherPacer` to `generateGeminiContent`, plus the import.
- The shared default is NOT changed. It also paces interactive callers (resume-assist, job-link-intake), where a person waits. Raising it is a separate decision. The tailor (3 rows/page, several calls each) may deserve the same treatment; it was not measured here.
- `supabase/functions/matcher/pacer.test.ts` (new, 3 tests):
  - the gap allows fewer than 15 calls/min;
  - a 10-call page spans ≥ 9 gaps;
  - `index.ts` actually passes the pacer.
  - Red-on-revert both ways: drop the `pacer:` option, and the "passes matcherPacer" test fails; set the gap to 500 ms, and the "under ~15 RPM" test fails.

Expected effect: the 429 walls should largely disappear. The 503 share remains, and so does the ~50% loss when the model is overloaded; that part is Teja's call.

**Deploy target:** the `matcher` edge function only. No migration and no shared-file change.

## After the fix (matcher deployed from 7fcc6ed at ~12:09 UTC; drain 42612204208, matcher stage 12:25-12:31 UTC)

| Page | Read | Advanced | Errored | Calls | Duration | Calls/min | Errors |
|---|---|---|---|---|---|---|---|
| 1 | 10 | 8 | 1 | 10 | 55 s | 11.0 | 1× 503 |
| 2 | 9 | 6 | 2 | 9 | 86 s | 6.3 | 1× timeout, 1× 429 (0 retries left in a deadline-shortened budget) |
| 3 | 2 | 2 | 0 | 2 | 10 s | 12.3 | none |

- Every page is now at or under 12.3 calls/min. Before the fix, 429 pages ran at a median of 18.3. The spacing does what it was built for.
- Error rate: 3 of 21 (14%), against about 50% in the 11-02 to 11-05 drains. The run drained the queue in 3 pages and went green: `CLEAN: matcher -> tailor -> auditor`.
- **Caveat: 3 pages is a small sample.** The one 429 came on the slowest page (6.3/min), so it was not a burst. A shared quota spent by other callers is the likely cause.
- Re-measure on the next few auto-drains with the same query: `agent_runs` where `agent='matcher'`, `calls/min = gemini_calls / (duration_ms/60000)`, split by error kind.

## Tailor: measured, no pacer needed (2026-11-09)

- **Since 2026-11-01:** 203 tailor runs. 1 run with a 429 (11-04 18:56, a single-row run), 4 with a 503, 5 with network timeouts.
- **Drain 42612050212** (tailor stage, 11:49-12:10 UTC, old 500 ms default pacing): 20 pages × 3 rows, 15 runs logged in the window, 0 with a 429. One 503 and one timeout, each costing 1 row. It drained 55 rows and went green.
- **Why it doesn't burst like the matcher:** 3 rows a page, then the drain's 45 s pause.
- **Decision:** no tailor pacer.
- **Telemetry gap:** the tailor writes `agent_runs.gemini_calls = 0` on all 203 runs, so its calls/min cannot be computed. The 429 count is the evidence used instead. Fixing that counter would let the tailor be measured the same way as the matcher.

## Comment corrected

`_shared/gemini/client.ts:61` used to say the 500 ms default was "safely within 15-60 RPM limits". 500 ms is up to 120 calls/min. The comment now says so, says the short default is kept for interactive callers, and points batch callers to their own pacer (`matcher/pacer.ts`).
