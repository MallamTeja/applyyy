# Jobs tombstone space policy — 2026-11-05

P0 from `docs/handoff/2026-11-05-1440-pending-tasks.md`. The database was 514 MB against the 500 MB Free
Plan quota; past it, Supabase makes the project read-only. Rulings this implements: Teja 15:27 (tombstone,
never a row delete) and 15:31 (scheduled about weekly, small batches, counts logged, never touches
non-dropped rows).

## Design

- **Marker:** `jobs.tombstoned_at timestamptz`. Non-null means the payload was purged and the row is in the
  needs_refetch state. The text is ABSENT, never an empty string.
- **Kept:** the slim row. That is id, fingerprint, ats_job_id, apply_url, company, title, locations,
  first/last_seen, disappeared_at, plus `description_hash` (a sha256 of the purged text, filled at tombstone
  time). The verdict stays in `applications.drop_reason`.
- **Dropped:** `description_raw` and `raw_payload`, set to NULL.
- **Re-fill guard (edge 1):** a `BEFORE UPDATE` trigger, `jobs_keep_tombstone_slim`. While `tombstoned_at`
  stays set, it forces both heavy columns back to NULL. A `CHECK jobs_tombstone_is_slim` makes a fat
  tombstone unrepresentable. To revive, a writer clears `tombstoned_at` in the same UPDATE.
- **Worker:** `public.tombstone_dropped_jobs(p_min_age_days, p_batch_size)`. It is security invoker and
  runs one bounded batch per call, oldest verdict first, using `SKIP LOCKED`.
  - The one-time back-fill runs it as `postgres` (all rows).
  - The weekly schedule runs it as the app user (RLS scopes it to that user).

**Why the guard is a DB trigger and not `_shared/screen/upsert-plan.ts`:** the planner is pure and cannot
see stored state. Three writers in three files re-send the payload:

- `scout-ats/index.ts:558-568`
- `worker/src/scout/persist-jobs.ts:151-159`
- `job-link-intake/index.ts:140`

One trigger covers all three, and any future writer, without editing any of them.

**Grace window N = 7 days**, measured on 2026-11-05 19:35 IST:

| Dropped verdicts older than | 3 d    | 7 d    | 14 d   |
|-----------------------------|--------|--------|--------|
| Rows                        | 31,410 | 22,945 | 10,690 |

- Dropped jobs averaged 5,344 B (`raw_payload`) + 3,754 B (`description_raw`) per row in a 5% sample
  (`pg_column_size`, compressed).
- At 7 days, about 209 MB of live payload goes.
- The drop rate is about 500-1,000 per day. The 7,587 spike on 11-01 was the coverage expansion. A weekly
  run with N = 7 therefore leaves at most about 14 days of payload, roughly 100 MB, in steady state.
- Why not 3 days: the last week of drops is the set Teja would audit for false drops, and 7 days already
  clears the quota with about 300 MB to spare.

## Edge cases

| # | Case | Handling | Test |
|---|------|----------|------|
| 1 | Re-discovery re-fills the payload | The trigger nulls both heavy columns while `tombstoned_at` stays set; the CHECK backs it up | `edge 1: …` ×3 in `supabase/functions/_shared/screen/jobs-tombstone.test.ts` |
| 2 | Repost under a new id or with changed text | Fingerprint = company + title + location (`_shared/normalize/fingerprint.ts:124`), so a different posting gets a new row and is screened as new | (existing fingerprint tests) |
| 3 | A blank description passes a gate | Purged to NULL, never `''`. The only edge out of `dropped_filter` is the human paste, which lands at `passed_filters`, and the matcher's usable-job gate (`planTailorBatch`) refuses NULL as `missing_description` | `edge 3: …` ×2 |
| 4 | Pasted link of a tombstoned job | job-link-intake re-fetches the page (`handler.ts:472`), but its write does not clear the marker. The trigger therefore discards the text and the revived row fails closed at the matcher. **Fix: the one-line diff below** | — |
| 5 | Readers of the payload | Recon found no reader of `dropped_filter` rows that breaks on NULL. ApprovalQueuePage reads only `awaiting_approval`; `discoveredList` reads only the discovered and passed lanes | — |
| 6 | Liveness / disappeared marking | Uses fingerprint, ids and `last_seen_at` only (`_shared/scout/liveness.ts`). The trigger leaves those columns alone | — |
| 7 | Prevention at insert | Rows are inserted before screening, so the insert cannot know the verdict. The weekly schedule bounds growth instead (commit 2) | — |
| 8 | Delete old tombstones | Not done: the row delete is ruled out (Teja 15:27). A slim row is about 1 KB of heap | — |
| 9 | lz4 TOAST compression | Skipped: it applies to new writes only, and tombstones hold no TOAST | — |

### Edge 4 diff (not in this commit: `job-link-intake` is not owned here)

`supabase/functions/job-link-intake/index.ts:140`, inside `tagManual`:

```diff
-      const { error } = await db.from("jobs").update({ discovered_via: discoveredVia, disappeared_at: null, ...(descriptionRaw !== null ? { description_raw: descriptionRaw } : {}) }).eq("id", jobId);
+      const { error } = await db.from("jobs").update({ discovered_via: discoveredVia, disappeared_at: null, ...(descriptionRaw !== null ? { description_raw: descriptionRaw, tombstoned_at: null } : {}) }).eq("id", jobId);
```

**Deploy order:** this function ships AFTER the migration. Sent earlier, PostgREST rejects the unknown
column and every paste fails.

## Apply runbook (orchestrator only, with Teja's yes)

1. **Migration.** Work from a clean worktree pinned to the commit SHA (CLAUDE.md §3).
   - Run `supabase db push --dry-run`. It must list exactly `20261105200000_jobs_tombstone.sql`; it was the
     only local-only migration at 19:45 IST.
   - Then run `supabase db push`.
2. **Schema check.** This is read-only:
   ```sql
   select (select count(*) from information_schema.columns where table_name='jobs' and column_name='tombstoned_at') as col,
          (select count(*) from pg_trigger where tgname='jobs_keep_tombstone_slim') as trg,
          (select count(*) from pg_constraint where conname='jobs_tombstone_is_slim') as chk;  -- expect 1,1,1
   ```
3. **Back-fill.** This is a live write. Repeat until it returns 0; expect about 5 calls of 5,000 for about
   23,000 rows:
   ```sql
   select public.tombstone_dropped_jobs(7, 5000) as tombstoned;
   ```
   If a call hits the 2-minute timeout, it rolls back on its own. Retry with `2000`.
4. **Back-fill check:**
   ```sql
   select count(*) filter (where tombstoned_at is not null) as tombstones,
          count(*) filter (where tombstoned_at is not null and (raw_payload is not null or description_raw is not null)) as fat  -- expect 0
   from public.jobs;
   ```
5. **VACUUM FULL.** This shrinks the reported size; a plain vacuum only makes the space reusable. Run each
   statement as a **separate** CLI call, because VACUUM cannot run inside a transaction block:
   1. `alter role postgres set statement_timeout = '15min';`
   2. `vacuum (full, analyze) public.jobs;`, in a NEW call so the new session picks the setting up.
   3. `alter role postgres reset statement_timeout;`. **Always run this, even if step 2 fails.**

   **If step 2 still cancels at 2 minutes** (the pooler reused an old session): run
   `psql "<direct db url>" -c "set statement_timeout = 0" -c "vacuum (full, analyze) public.jobs"`.
   Separate `-c` flags are not wrapped in one transaction.

   **Lock:** VACUUM FULL holds ACCESS EXCLUSIVE on `jobs` while it copies about 150 MB, which takes
   seconds to about a minute. Run it outside a scout run.
6. **Expected sizes** (estimate, ±30 MB):
   - `jobs`: 473 MB → about 150 MB. That is 37 heap + 10 indexes + about 100 MB of payload on the roughly
     11,400 rows that keep it.
   - `pg_database_size`: 514 MB → about **190 MB**.
   - Check with `select pg_size_pretty(pg_database_size(current_database()));`.
7. **Live proof of edge 1, after the next scout run.** This is read-only:
   ```sql
   select count(*) as resighted_tombstones_still_slim from public.jobs
   where tombstoned_at is not null and last_seen_at > tombstoned_at
     and raw_payload is null and description_raw is null;  -- > 0 proves re-sightings stayed slim
   ```
