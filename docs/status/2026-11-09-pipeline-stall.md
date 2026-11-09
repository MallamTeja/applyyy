# Pipeline stall before tailoring: 59 `scored` + 9 `passed_filters`, 2026-11-09 ~17:40 IST

Read-only audit. SELECTs and workflow logs only. Every row of the 68 is in exactly one group below.

## Root cause in one paragraph

Nothing on a schedule or trigger moves rows past `passed_filters` or `scored`.
- No workflow with a `cron:` calls the matcher or the tailor.
- No migration wires a `pg_net` call to them.
- The only movers are `postscreen-drain.yml` (`workflow_dispatch` only) and `run-one.yml` (one row).

`postscreen-drain` runs its stages in order: matcher → tailor → auditor. Any stage abort ends the whole run.
- Every full run from 11-02 to 11-05 aborted INSIDE the matcher stage, so its tailor stage never started.
- The only later run (11-07, 42337854468) was `from_stage=auditor`.
- Result: 55 live rows have waited at `scored` for 4-7 days.

| Drain run | Started (UTC) | Result | Where it died |
|---|---|---|---|
| 41466377430 | 11-02 14:54 | failure | matcher |
| 41475706230 | 11-02 15:51 | failure | matcher: `3 consecutive pages advanced 0 rows` (Gemini errors) |
| 41993784498 | 11-05 08:21 | failure | matcher: pages 7-9 `errored=10`, stall abort |
| 42073925051 | 11-05 17:22 | failure | matcher: `ABORT: matcher: page cap 40 reached before the queue emptied` |
| 42337854468 | 11-07 04:18 | success | `from_stage=auditor` only (2 rows) |

Transition edges (live): `passed_filters -> scored` is matcher-only, and `scored -> tailored` is tailor-only. `scored -> dropped_filter` is **human only**, so no agent can clear a dead `scored` row.

## Groups

| # | Cause | Count | Sample ids | Recommendation |
|---|---|---|---|---|
| A | Master re-run on 11-05 15:50 (`awaiting_approval -> passed_filters`, human). Re-scored by the 11-05 17:22 drain, whose matcher stage then hit the page cap, so the tailor never ran. These rows had already been tailored and audited at least once. | 21 (+1 gone, in E) | 060162ca (92), a3b558cc (84), 93f8e874 (83) | **Tailor now** (system path, below). Re-tailoring uses master v27; the stored `master_version` 9/11 is just the old tailor stamp. |
| B | The matcher FAILED them on 11-04 15:14-15:16 (Gemini). A human reset them `failed -> passed_filters` on 11-05 07:42. The 11-05 drains scored them, then aborted in the matcher stage. Never tailored. | 19 (+1 gone) | 7703be0d (82), e811963b (79), 72711ef6 (78) | **Tailor now.** |
| D | Scored once by the 11-02, 11-04 or 11-05 drains (2 events: matcher note + status change). Same abort; never tailored. | 15 (+2 gone) | 17693fcc (78), 800e8d08 (76), dabb8ae2 (72) | **Tailor now.** |
| E | Posting disappeared (`jobs.disappeared_at` set). The tailor's query excludes these (`tailor-batch.ts:110-124`, `posting_disappeared`), and only a human may take `scored -> dropped_filter`, so they would sit at `scored` forever. | 4 | ae6226f2 UiPath (88), eaaf1ffc Tekion (54), fb04ce15 FIS (49), 1e105d85 Barclays (46) | **Drop (human)**, SQL below. |
| F | NEW: the remote-feeds scout (`scout_aggregator`, 11-08 07:50 UTC) inserted them straight at `passed_filters` (screened on insert, 0 events, `master_version` null). Not part of the 11-08 re-tailor batch. | 9 | 5999b66c Adapty "Developer Advocate (Germany)", 56a1b250 ElevenLabs, 4333ab9f MEYA "Junior Market Analyst" | **Run the matcher** (floor 30 decides). Flag: 5999b66c's title says Germany while the location is "Remote". That is the known "unknown location passes" gap; let the matcher or auditor judge it, or a human drops it. |

Counts: A 21 + B 19 + D 15 + E 4 = 59 `scored`; F 9 `passed_filters`. Total 68. All live scored rows score ≥ 45, so all are above the matcher floor of 30.

Evidence was checked on full event paths for every scored row (scratch query, `application_events` status changes in order). Group membership is by path pattern: A has `awaiting_approval>passed_filters(human)@11-05`; B has `failed>passed_filters(human)@11-05`; D has neither.

## Health of the agents the fix depends on

- Tailor `agent_runs`: last 8 all `succeeded` (11-08 12:16 to 11-09 11:21, run-one).
- Matcher: last 5 `succeeded`.
- So the tailor is healthy. It was simply never called over this queue.

## System fix (proposed, not written: file list to the orch first)

One file, `.github/workflows/postscreen-drain.yml`:

1. **Stage isolation.** A stage abort (page cap, stall) ends THAT stage, and the run continues to the next stage. The run still exits red, with every stage's abort listed.
   - Why: a matcher backlog (new scout rows plus Gemini 429s) must not starve rows that are already scored.
   - Today one bad matcher stage cost 55 rows four days.
   - Kill-switch halts (`skipped_disabled`) and non-2xx/contract aborts still end the WHOLE run: those are not backlog problems.
2. **Trigger at the state change:** `on: workflow_run: workflows: [<scout ATS>, <scout remote feeds>] types: [completed]`.
   - Scouts are what create `passed_filters` rows, so the drain starts when they finish. This is GitHub's native chaining, with no agent loop.
3. **Scheduled sweep:** one daily `schedule:` (e.g. `'30 4 * * *'`, after both scouts' crons), as the safety net Teja's "automate, don't hand-dispatch" rule asks for.
   - A scheduled run uses the default `from_stage` and respects the kill switch through the functions themselves.

Cost check: about 64 rows (55 tailor + 9 matcher). The tailor takes 3 rows a page, about 19 pages, with 45 s pauses: roughly 15-25 min, inside its page cap of 90.

## Immediate unblock (orch's call; uses the system's own drain, not a per-row loop)

1. `gh workflow run postscreen-drain.yml --ref main -f from_stage=tailor`. This tailors and audits groups A, B and D (55) first, without the matcher stage that kept aborting.
2. Then `gh workflow run postscreen-drain.yml --ref main -f from_stage=matcher` for group F (9).
3. Group E: a human drop. The 4 statements are in the orch report. Run them as the human path, with no agent key.

Warn Teja before step 1: about 55 rows will arrive at `awaiting_approval` over about 20 min (memory "warn Teja before bulk moves").
