# Runbook: a bulk revive into `passed_filters` is followed by the pre-gate sweep

> **Status 2026-11-08:** Current. The commands still work as written: `.github/workflows/pregate-sweep.yml` takes `dry_count_only` (line 21) and calls `matcher?mode=pregate_only` (`supabase/functions/matcher/index.ts:199`). The auditor re-gate named below is `supabase/functions/auditor/pregate.ts`, which reuses `firstPreGateDrop` from `supabase/functions/matcher/tech-pregate.ts`.
> The body below is the original record, unedited.

Written 2026-11-06 (P1 #7). Rule for whoever moves rows back into Ready to tailor in bulk.

## The rule

Any bulk move of rows INTO `passed_filters` (a back-fill, a master-change re-run, a retro undo)
is followed, in the same session, by the matcher's Gemini-free pre-gate sweep:

```
gh workflow run pregate-sweep.yml --ref main -f dry_count_only=true    # read the plan first
gh workflow run pregate-sweep.yml --ref main                           # then the real sweep
```

It runs `matcher?mode=pregate_only` over every `passed_filters` row with today's gates (tech
gate + excluded keywords, work-auth, experience ceiling) and drops what they reject, with no
Gemini call. Rows the gates keep stay where they are. It is a live write: the orchestrator runs
it, with Teja's yes (CLAUDE.md §2).

## Why

Screening happens when a scout INSERTS a row. A row moved later by
`advance_application_status` (agent `human`) skips every gate, and a gate added after the
insert never sees it.

On 2026-11-05 the Workday back-fill wrote 348 descriptions and moved those rows
`failed → passed_filters` as `human`. They had been inserted on 11-04 with no description,
before the experience ceiling existed (`b93a936`, 11-04 20:06 IST) and before Teja added
`II`/`III`/`IV` to his excluded keywords (11-04 14:03 UTC). On 11-06 Teja found "Data Scientist
III", "Software Engineer II" and "Software QA Engineer (8 to 12 yrs)" in Ready to tailor.
Measured 00:10 IST: today's pre-gate would drop 71 open `passed_filters` rows, all revived
unscreened.

## What the sweep does NOT cover

- Rows already at `scored` or later. The sweep reads `passed_filters` only. Those rows meet the
  auditor's re-gate (`394d9ed`) before they reach a human, but only after a tailor run has been
  spent on them.
- Rows the gates themselves miss. Fix those in the gate, never with a score cutoff (Teja,
  2026-11-05). The 11-06 fixes: `stripHtml` decodes numeric entities (`&#43;` hid "7+ years" in
  67 open rows), and the experience parser reads bare year ranges in titles ("4 to 8yrs").

## Check it worked

The sweep log prints per page `dropped=… by_code=… survivors=… gemini_calls=0`. Then:

```sql
select drop_reason, count(*) from applications
where status = 'dropped_filter' and status_changed_at > now() - interval '1 hour' group by 1;
```
