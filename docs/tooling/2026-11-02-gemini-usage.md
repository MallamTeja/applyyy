# Gemini usage log (`gemini_usage`), 2026-11-02

> **Status 2026-11-08:** Current. The migration is applied and the table is live: `public.gemini_usage` holds rows from 2026-11-04 onward, with no `unknown` agent rows (checked 2026-11-08 with `select agent, count(*) from public.gemini_usage group by 1`). The writer is `recordUsage` in `supabase/functions/_shared/gemini/client.ts` (1000 ms write timeout at `USAGE_WRITE_TIMEOUT_MS`). The deploy-order section is history: that deploy is done. The body below is the original record, unedited.

Gap W41. Teja asked on 2026-11-02 at 21:14 IST: "fix the gap … logging both the call count and the token counts."

## What records it

- **Table:** `public.gemini_usage`, created by migration `20261104200000_gemini_usage_log.sql`. It is append-only: triggers forbid update and delete, RLS limits each user to their own rows, and `authenticated` holds only `select` and `insert`.
- **Writer:** `supabase/functions/_shared/gemini/client.ts`, in `callGeminiWithFailover`, through `recordUsage`. The client writes one row per **attempt**, right after the attempt that `claim_gemini_key()` counted. So `count(*)` equals the number the quota counts. A 429, a 503 and a timeout each spent a request, so each one gets a row too.
- **Agent name:** read from `Deno.mainModule`. Live, that is `.../source/supabase/functions/<slug>/index.ts`. If the path does not match, the agent is `unknown`. No caller passes its own name.
- **Outcome:** one of `ok`, `invalid_json`, `timeout`, `network_error`, or the 3-digit HTTP status. A safety-blocked empty 200 still counts as `ok`, because it was billed.
- **Tokens:** copied from Google's `usageMetadata` (`promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, `totalTokenCount`). A value is **NULL** when Google sent no usable count. It is never zero.
- **Failure mode:** a usage write that fails, throws, or takes longer than 1000 ms is dropped, and the client logs `console.warn("[gemini-usage] usage row not written ...")`. The Gemini call itself always goes through. Search the function logs for `gemini-usage` to count the lost rows.

## Read it

The day is the **Pacific** day, because the Gemini quota (`requests_today`, `pacific_today()`) resets at Pacific midnight. For IST days, replace `'America/Los_Angeles'` with `'Asia/Kolkata'`. Change `7` to set N, the number of days.

```sql
-- Calls and tokens per Pacific day, agent and key, for the last N (= 7) days.
select (u.created_at at time zone 'America/Los_Angeles')::date as quota_day,
       u.agent,
       u.key_index,
       count(*)                                              as calls,
       count(*) filter (where u.outcome = 'ok')              as ok_calls,
       count(*) filter (where u.outcome <> 'ok')             as failed_calls,
       sum(u.prompt_tokens)                                  as prompt_tokens,
       sum(u.output_tokens)                                  as output_tokens,
       sum(u.thoughts_tokens)                                as thoughts_tokens,
       sum(u.total_tokens)                                   as total_tokens,
       count(*) filter (where u.outcome = 'ok' and u.total_tokens is null) as ok_without_counts
  from public.gemini_usage u
 where u.created_at >= now() - make_interval(days => 7)
 group by 1, 2, 3
 order by 1 desc, 2, 3;
```

To get a total per agent, drop `u.key_index` from the select list and the `group by`.

### Check the log against the quota

```sql
-- Rows logged today vs requests the pool counted today (both Pacific).
-- Logged should equal claimed for any day that started after the deploy.
select (select count(*) from public.gemini_usage
         where (created_at at time zone 'America/Los_Angeles')::date = public.pacific_today()) as logged,
       (select coalesce(sum(requests_today), 0) from public.gemini_key_state
         where quota_date = public.pacific_today()) as claimed;
```

If `logged < claimed`, the gap is lost rows (look for the `gemini-usage` warnings) or functions still running pre-deploy code. Also check that `agent = 'unknown'` stays at 0. A non-zero count means the runtime's `Deno.mainModule` path has changed shape.

## Deploy order

1. `db push` the migration (dry-run first; it must list only `20261104200000_gemini_usage_log.sql` plus anything else expected).
2. Then deploy the Gemini functions: `matcher`, `tailor`, `cover-letter`, `follow-up`, `interview-prep`, `referral`, `resume-assist`, `scout-web`, `job-link-intake`.

Code deployed before the migration does not break. Each of its writes comes back as a PostgREST `{ error }` because the table is not there yet. The client logs a warning, and the Gemini call carries on.
