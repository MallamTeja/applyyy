# Web latency, database side — 2026-11-08

Peer 2, 16:38–17:05 IST. Read-only investigation. Every plan below came from `EXPLAIN (ANALYZE, BUFFERS)`,
run as the real app user (`set local role authenticated` + `request.jwt.claims` for user `0f4b24da…`)
inside a `begin read only … rollback` transaction, so RLS cost is included and nothing was written.
Peer 1 (applyyy-55) owns the web side; the web changes this points to are in §4.

## TL;DR

1. **The database is not where the time goes.** With warm caches, every web-page query runs in **8–28 ms**.
2. **Each round trip from India to the project costs ~300 ms.** The project is in **ap-southeast-2 (Sydney)**.
   A trivial PostgREST read from Teja's machine, with a warm keep-alive connection, takes **302–304 ms**
   to first byte, and **732 ms** on a fresh connection. Page latency ≈ (serial round trips) × 300 ms + payload.
3. **No index on `applications.status` can help any app query.** `enum_eq` is not leakproof, so under RLS
   Postgres will not use it as an index condition and ignores the column's statistics.
   **So this task ships no index migration** (§3).

## 1. Measurements

### 1a. Network round trip (the dominant cost)

| Call | Time to first byte |
|---|---|
| `GET /rest/v1/application_status_transitions?select=from_status&limit=1` with the anon key, fresh TLS connection | 0.732 s |
| the same, keep-alive, 3 repeats | 0.304 / 0.303 / 0.303 s |
| `GET https://applyyy.vercel.app/` (for comparison) | 0.116 s |

Measured from Teja's machine in India. The DB work behind that call is under 1 ms, so ~300 ms is pure
network plus gateway. An unauthenticated `/rest/v1/` 401 returns in 44 ms, because it is answered at the
edge and never reaches Sydney. That is why it is not used as the baseline.

### 1b. Web-page queries (as `authenticated`, warm)

| # | Page · query | DB time | Plan |
|---|---|---|---|
| W1 | Approval queue (`ApprovalQueuePage.tsx:729`): 16 `awaiting_approval` rows + tailored_profile, audit_findings, jobs.description_raw | **8.1 ms** | Seq Scan applications (35,929 removed) + 16 jobs_pkey lookups |
| W2 | Discovered (`DiscoveredJobsPage.tsx:259`): `dropped_filter` lane, 300 rows + jobs incl. description_raw | **27.7 ms warm** (two repeats: 27.65, 27.91). **650.6 ms cold** (first touch, `dirtied=16`) | Seq Scan + top-N sort + 300 jobs_pkey lookups that detoast description_raw |
| W2-no-desc | same without description_raw | 21.5 ms | — |
| W2c | Discovered lane count (`count: exact, head`) | 8.0 ms | Seq Scan |
| W4 | Manual apply kit notes (`manualApplyData.ts:93`): events with `event_type='note' and detail->>'kind' in (…)` | 8.6 ms | Seq Scan application_events (27,082 removed) |
| W5 | `application_status_counts()` (AppShell, every navigation) | 11.1 ms | function scan |

Production pg_stat for W2 (queryid 2765167175050860812): 204 calls, **mean 249 ms, max 6,201 ms**.
So cold TOAST reads happen in practice. The instance has `shared_buffers` = 224 MB, and the jobs TOAST table
alone is 91 MB (6,474 pglz-compressed descriptions, average 6.4 KB raw). The forced-index run in §2 also shows
`read=338` blocks coming from disk.

### 1c. Table sizes

| Table | Rows | Heap | TOAST | Indexes | Total |
|---|---|---|---|---|---|
| jobs | 35,852 | 39 MB | 94 MB | 9.8 MB | 142 MB |
| applications | 35,712 | 6.6 MB | 1.2 MB | 11 MB | 19 MB |
| application_events | 26,068 | 6.5 MB | 72 kB | 1.8 MB | 8.4 MB |

### 1d. Heaviest app queries in pg_stat_statements (all from edge functions, not pages)

| queryid | Caller | Calls | Mean | Buffers total | Plan problem |
|---|---|---|---|---|---|
| -5558463120734698380 | `email-tracker-intake/replay.ts:220`: `status in (…) order by id`, paged | 194 | 340 ms (max 1,645) | 6.84 M | walks `applications_pkey` in id order and filters 35,856 rows (EXPLAIN: 293 ms, 36,326 buffers) |
| -7272324702105293222 | matcher-shape keyset: `status = $ and id > $ order by id` + jobs incl. description_raw | 30 | 921 ms | 152 k | same pkey walk + detoast |
| 7055968555380228892 | `_shared/screen/supabase-queries.ts:213`: `{count:'exact'}` + jobs(fingerprint, company_slug) | 145 | 444 ms | 266 k | exact count + seq scan |
| 6504323161962258399 | `job:jobs(*)` embed, status filter, created_at desc. **No longer in the code at origin/main** (git grep finds no `jobs(*)`) | 46 | 1,521 ms | 573 k | full jobs row detoast |

These do not block a page directly. They compete for the same 224 MB of cache and the 60 connections.

## 2. Why indexes don't fix this: RLS + a non-leakproof enum

| Check | Result |
|---|---|
| Statistics are correct | `pg_stats` MCV: dropped_filter 0.9947, awaiting_approval 0.00037 (live: 35,751 vs 16) |
| As owner (RLS bypassed): `status='awaiting_approval'` | estimate **13 rows**, Index Scan using applications_user_status_changed_idx |
| As `authenticated`: the same query | estimate **4,519 rows** (= 35,945 / 8 distinct), Seq Scan |
| As `authenticated` with `enable_seqscan=off` | Index Only Scan, but `Index Cond: (user_id = …)` only. `status` stays a **Filter** (35,929 removed, 1,233 ms) |
| `pg_proc.proleakproof` | `enum_eq=false`; `texteq`, `uuid_eq`, `int4eq`, `timestamptz_lt` = true |

Postgres treats a user's clause on an RLS table as possibly leaky unless its operator is leakproof. A
non-leakproof clause cannot become an index condition, and the planner may not read the column's
statistics for it. `status` is an enum, so every `.eq('status', …)` / `.in('status', …)` from the
browser or from an edge function acting as the user seq-scans, or walks the wrong index.
Marking `enum_eq` leakproof needs superuser, which Supabase does not grant. Today this costs
**milliseconds per web query**: applications is only 6.6 MB, so a seq scan takes 4–8 ms. It costs
**hundreds of ms** for the edge keyset queries in §1d.

## 3. Ranked causes and fixes

| Rank | Cause | Where | Measured | Fix | Owner | Expected gain |
|---|---|---|---|---|---|---|
| 1 | ~300 ms per PostgREST round trip (Sydney region, user in India) × serial chains | every page | 302–304 ms warm per call | Fewer serial round trips: run independent reads in parallel; bundle a page's reads into one RPC; stop refetching on every navigation (§4) | peer 1 (web); RPCs need a migration if chosen | ~300 ms per serial hop removed |
| 2 | Project region is far from the user | all | 300 ms vs an estimated ~30–60 ms to ap-south-1 (not measured; no Mumbai project to test against) | Move to ap-south-1 (Mumbai). This needs a new project plus a data, secrets and function migration | Teja's decision | ~250 ms off every call |
| 3 | Cold TOAST reads of `jobs.description_raw` on the Discovered list | `DiscoveredJobsPage.tsx:259` | 650 ms cold vs 28 ms warm per 300-row page; prod mean 249 ms, max 6.2 s | Don't fetch the full description in the list: fetch it on expand, or select a short preview (`left(description_raw,300)` cost 22.7 ms in the same plan) | peer 1 | up to ~600 ms on a cold page, plus ~1.9 MB less JSON per page |
| 4 | Status filters can't use indexes under RLS | edge keyset queries (§1d) and every list | 293 ms (replay query); 4–8 ms per web query | Option A: a `stored` generated `status_text text` column + index, and filter on it (texteq is leakproof). Option B: `security definer` list RPCs with an explicit `where user_id = auth.uid()` (owner plans, real stats) | needs a decision (§5) | edge: ~300 ms → ~1 ms; web: ~5 ms |
| 5 | Exact counts over the 35,751-row dropped lane | Discovered, PipelineDrawer, PipelineRunModal (×~5) | 8 ms each in the DB, but **each costs a 300 ms round trip** | Use the `application_status_counts()` RPC the page already loads, instead of separate HEAD counts | peer 1 | ~300 ms per count removed |

**Migration: none is proposed.** The brief asked for one "with the indexes the evidence supports", and the
evidence supports none: a status index cannot be used under RLS (§2), and the remaining DB time is 8–28 ms
against ~300 ms of network per call. A partial index would have needed `hypopg` to test, which means
`create extension`, a write. I stopped there per the brief. If the orchestrator picks option A or B in
§5, I will write that migration next. Both need web or edge changes before they gain anything.

## 4. Web findings sent to peer 1 (applyyy-55)

Serial round trips per page, from the two query inventories (file:line in each):

1. **AppShell refetches on every route change** (`app/AppShell.tsx:62-75`): `application_status_counts()` plus
   `loadManualApply('badge')`, which is 1 events read, *then* 3 applications reads. That is 2 serial hops,
   ≈ 600 ms, on every navigation, on top of the page's own reads. Discovered (`:145`) and Pipeline (`:193`)
   call `useApplicationCounts` again (a duplicate RPC). Fix: cache the counts and badge (e.g. 30–60 s, or
   invalidate after a write), and share one counts call.
2. **Approval batch approve is N+1 and sequential** (`ApprovalQueuePage.tsx:1127` loop →
   `saveTailoredEdit.ts:128` `confirmFresh` + `:1225` RPC). That is 2 serial round trips per row, ≈ 600 ms/row, so
   10 rows ≈ 6 s. `confirmFresh` also pulls the whole `tailored_profile` just to compare `updated_at`. Fix: select
   `updated_at, status` only, and run rows in parallel (or one batch RPC).
3. **Approval load is 2 serial hops**: the list (`:729`, no limit) → master profiles per version (`:807`).
4. **Manual apply**: `manualApplyData.ts:93` events → 3 parallel applications reads (`:118`, each with
   `tailored_profile`, same rows possibly fetched twice), alongside `leftQueue.ts:189` → `:209` (1000 events with
   `detail`). That is 2 serial hops, and the whole set re-runs after every card move.
5. **Applied**: `AppliedJobsPage.tsx:488` (501 rows + tailored_profile + events.detail + email_events) → `:530`
   kit notes (serial). The set re-runs after every move.
6. **Discovered**: full `description_raw` × 300 rows per page (cause 3), plus a separate exact count.
7. **Settings**: `SearchPreferencesPage.tsx:152` → `:185` are serial and could be parallel;
   `unansweredQuestionsView.ts:243` → `:254` are serial, with an unbounded `.in('id', …)`.
8. **Health**: `useAgentRuns.ts:287` (200 rows), then up to 2 single-row reads per missing agent (`:190`).

## 5. Decisions for the orchestrator / Teja

1. **Region (biggest single lever):** stay in Sydney, or plan a move to ap-south-1. It touches every edge
   function, secret, cron and the Vercel env. It is a project-level migration, not a schema change.
2. **Status filters under RLS:**
   - Option A: a generated `status_text` column. Small migration; every caller must switch its filter to it.
   - Option B: `security definer` RPCs per hot page. They also cut round trips, so they combine with fix 1.
   - Recommendation: **B for the hot pages** (manual apply, approval, AppShell badge). It is the only option that cuts round trips too, and the 300 ms network is what Teja feels. Use A only if the edge keyset queries become a problem.
3. **`email-tracker-intake/replay.ts:220`** walks the pkey (293 ms per page, 6.8 M buffers across 194 calls).
   This is a cheap edge fix: order by `created_at` or filter by `id` ranges. Option A also fixes it.

## Commands to reproduce

- RTT: `curl -s -H "apikey: $ANON" -o /dev/null -w "%{time_starttransfer}\n" "https://xynqxekcqizwhtskzqrq.supabase.co/rest/v1/application_status_transitions?select=from_status&limit=1"` (repeat the URL to measure keep-alive).
- Plans: `begin read only; set local role authenticated; select set_config('request.jwt.claims','{"sub":"0f4b24da-e85b-40bb-8606-c81824493b45","role":"authenticated"}',true); explain (analyze, buffers) <query>; rollback;` via `env -u SUPABASE_ACCESS_TOKEN supabase db query --linked -f <file>`.
- pg_stat: `select queryid, calls, mean_exec_time, query from pg_stat_statements where query like 'WITH pgrst_source AS ( SELECT "public"."applications"%' order by total_exec_time desc`.
