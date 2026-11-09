# Gemini call rates: tailor, matcher and the new meters (2026-11-09, measured 22:52 IST)

Peer 3, task 2 for orchestrator applyyy-f2. Read-only: live SELECTs through
`env -u SUPABASE_ACCESS_TOKEN supabase db query --linked`. All times are IST.

## Answers

| # | Question | Answer |
|---|---|---|
| 1 | Is tailor `gemini_calls` > 0 after e99b758? | **Yes. The meter works.** The only tailor run after 18:23 (18:33:03) recorded `gemini_calls = 2`, and `gemini_usage` shows exactly 2 `ok` attempts in that run's window. All 7 tailor runs from 18:01 to 18:09 recorded 0 while `gemini_usage` logged their attempts, which is the pre-fix bug. |
| 2 | Tailor and matcher calls/min, plus 429/503 since 18:00 | **Matcher:** 12.16 average, 12.31 peak per run. **Tailor:** 7.84, from one run. **Since 18:00:** 0×429 and 5×503 (all tailor, the last at 18:07). **Since 00:00:** 1×429 (matcher 17:59), 4×503 matcher and 16×503 tailor. The sample is tiny: 2 matcher runs and 1 tailor run, each with 2 calls. |
| 3 | Do job-link-intake and resume-assist rows exist after 3a8d8ae? | **resume_assist: yes.** 10 runs with 10 calls since 22:34:40, matching 10 `gemini_usage` attempts one for one. The 2 earlier resume-assist attempts (from 20:42) came before the meter deploy. **job_link_intake: no rows yet.** That is not evidence of a broken meter: the last job-link-intake Gemini attempt of any kind was 2026-11-05 13:04, so nobody has pasted a link since the deploy. It gets its first proof on the next pasted link. |
| 4 | Is any run near the Gemini RPM limit? | **No.** Today's busiest key+model minute is **2 attempts** (key 10, `gemini-3.5-flash-lite`, 17:59). That is also the minute of today's only 429, so that 429 was not caused by our volume on that key. The busiest single agent-minute across all keys is 6 (matcher). The per-run "12 calls/min" comes from 2-call bursts over about 10 s, not a sustained rate. |

**The drain has NOT run since the 9 rows were moved back at 22:44.** The latest tailor run is 18:33:03 and the latest matcher run is 18:32:50. `applications` holds 9 rows at `passed_filters` and 0 at `scored` or `tailored`. There is no fresh tailor data yet. I did not extrapolate.

## Queries (each number above comes from these)

```sql
-- Q1: runs since e99b758 (committed 18:23 IST)
select agent, count(*) runs, sum(gemini_calls) calls, count(*) filter (where gemini_calls>0) runs_gt0
from agent_runs where agent in ('tailor','matcher') and started_at >= '2026-11-09 18:23+05:30' group by 1;
-- -> matcher 1 run / 2 calls (18:32), tailor 1 run / 2 calls (18:33)

-- Q1b: the last 8 tailor runs (18:01-18:09 all gemini_calls = 0, 18:33 = 2)
select started_at, status, rows_in, rows_out, gemini_calls, duration_ms from agent_runs
where agent='tailor' order by started_at desc limit 8;

-- Q1c: cross-check the 18:33 run against the per-attempt log -> 2 x ok
select outcome, count(*) from gemini_usage where agent='tailor'
and created_at between '2026-11-09 18:33:00+05:30' and '2026-11-09 18:33:30+05:30' group by 1;

-- Q2a: outcomes since 18:00 -> matcher 4 ok; resume-assist 12 ok; tailor 18 ok + 5 x 503
select agent, outcome, count(*) from gemini_usage where created_at >= '2026-11-09 18:00+05:30' group by 1,2;

-- Q2b: calls/min = sum(gemini_calls) / active minutes (sum duration_ms), metered runs since 18:00
select agent, count(*) runs,
  round(sum(gemini_calls)::numeric / nullif(sum(duration_ms),0) * 60000, 2) avg_cpm,
  round(max(gemini_calls::numeric / nullif(duration_ms,0) * 60000), 2) peak_run_cpm
from agent_runs where agent in ('tailor','matcher') and started_at >= '2026-11-09 18:00+05:30'
and gemini_calls > 0 group by 1;
-- -> matcher 2 runs 12.16 / 12.31; tailor 1 run 7.84 / 7.84

-- Q2d: matcher runs since 17:00: 11.00 (10 calls), 6.25 (9), 12.31 (2), 12.00 (2)
select started_at, gemini_calls, duration_ms, round(gemini_calls::numeric/duration_ms*60000,2) cpm
from agent_runs where agent='matcher' and started_at >= '2026-11-09 17:00+05:30' and gemini_calls>0 order by 1;

-- Q4b: 429/503 since 00:00 -> matcher 1 x 429 (17:59), 4 x 503 (to 17:58); tailor 16 x 503 (to 18:07)
select agent, outcome, count(*), max(created_at) from gemini_usage
where created_at >= '2026-11-09 00:00+05:30' and outcome in ('429','503') group by 1,2;

-- Q4: busiest key+model minute today -> 2 (key 10, gemini-3.5-flash-lite, 17:59)
select key_index, model, m, n from (select key_index, model, date_trunc('minute', created_at) m, count(*) n
from gemini_usage where created_at >= '2026-11-09 00:00+05:30' group by 1,2,3) t order by n desc limit 5;

-- Q2c: busiest agent-minute today, all keys -> matcher 6, tailor 5, resume-assist 2
select agent, max(n) from (select agent, date_trunc('minute', created_at) m, count(*) n
from gemini_usage where created_at >= '2026-11-09 00:00+05:30' group by 1,2) t group by 1;

-- Q3: new identities -> resume_assist 10 runs / 10 calls (last 22:46); job_link_intake none
select agent, count(*), sum(gemini_calls), max(started_at) from agent_runs
where agent::text in ('job_link_intake','resume_assist') group by 1;
-- Q3c: job-link-intake attempts ever -> 2, last 2026-11-05 13:04
select count(*), max(created_at) from gemini_usage where agent='job-link-intake';

-- Q5: drain backlog -> 9 passed_filters, 0 scored, 0 tailored
select status, count(*) from applications where status in ('passed_filters','scored','tailored') group by 1;
```

## Notes
- **Why both tables:** `agent_runs.gemini_calls` counts calls per run, which is the formula's input. `gemini_usage` holds one row per attempt with an `outcome`, which is the only source of 429/503 counts and of per-key minutes. The two reconcile exactly wherever both exist (the tailor 18:33 run: 2 = 2; resume_assist: 10 = 10).
- **Tailor 503s:** they come from model overload, not our rate (memory: 503 "high demand" is per model, not per key). All 16 503s fell between 18:00 and 18:07, inside the drain burst.
- **Re-measure** after the drain tailors the 9 rows: re-run Q1b, Q2b and Q4b. One run is not a rate.
