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
