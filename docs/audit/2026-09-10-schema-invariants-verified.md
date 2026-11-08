# Schema verification — the SQL has now been executed

> **Status 2026-11-08:** Partly superseded. The three invariants still exist in code: `applications_user_job_key` (`supabase/migrations/20260909234700_core_tables.sql:427`), the status transition guard, and RLS on every table. But the schema has grown far past 7 migrations and 15 tables (re-count with `git ls-files supabase/migrations`), and the "two migrations have never run" addendum was closed by the 2026-09-18 push (`docs/audit/2026-09-18-migration-push-result.md`). Current schema: `docs/stack/2026-11-05-database.md`. The body below is the original record, unedited.

**Date:** 2026-09-10, ~18:30 IST
**Verified by:** `applyyy-8c` (Stream 0 — verification + foundation)
**Environment:** local Supabase CLI 2.117.0, `public.ecr.aws/supabase/postgres:17.6.1.167`, Docker Desktop 28.5.1
**Scope:** local only. No `supabase link`, no `supabase db push`, no remote infrastructure of any kind.

## Why this document exists

Before today, all 7 migration files — ~116 KB, 15 tables, a trigger-backed status
transition guard, RLS on every table, and 7 RPCs — had **never been parsed by
Postgres even once**. Every claim about the schema was a claim about SQL *text*.

This file records the first execution, what broke, and which product invariants
are now proven rather than asserted. It is deliberately written so that the
distinction between *proven* and *assumed* survives into next week.

## Result

**All 7 migrations apply cleanly from scratch**, confirmed by a canonical
`supabase db reset` that rebuilt the database from nothing:

| Evidence | Value |
|---|---|
| Public tables created | **15** |
| Rows in `application_status_transitions` | **44** |
| Entries in `supabase_migrations.schema_migrations` | **7** (all of them, in order) |
| Rows left over from earlier manual tests | **0** — so the reset genuinely started from empty |

### One caveat on the `db reset` exit code, because it is a trap

`supabase db reset` **exited 1**, and it would be wrong to read that as a SQL
failure. The error was:

```
{"_tag":"Error","error":{"code":"LegacyHealthCheckTimeoutError",
 "message":"supabase_storage_applyyy container is not ready: unhealthy"}}
```

That is the **storage** container's healthcheck timing out — a sibling service,
downstream of and unrelated to migration application. The migrations had already
succeeded, which is why the ledger holds all 7 versions and the table count is
15. Reading the exit code alone would have produced the exact opposite
conclusion from the truth. See [`../verification-traps.md`](../verification-traps.md).

## The one real failure, and the fix

The first run died at the **4th of 7 files**, which is why nothing in the safety
case had ever been exercised — the guard, the RLS policies and every RPC live in
files 5, 6 and 7.

```
ERROR: functions in index predicate must be marked IMMUTABLE (SQLSTATE 42P17)
At statement: 34
create index company_blocklist_active_idx
  on public.company_blocklist (user_id, company_slug)
  where blocked_until is null or blocked_until > now()
```

### Why Postgres is right to refuse this

An index predicate is evaluated **at write time** and decides, permanently,
whether a row is in the index at all. `now()` is `STABLE`, not `IMMUTABLE` — it
returns a different value in a later transaction. So a row admitted to the index
while it was "still blocked" would **stay in the index forever after its block
expired**, because nothing writes to that row to trigger re-evaluation; the only
thing that changed is the clock. The index would encode a fact that was true
only at the instant it was written, and would then quietly lie.

**The rule: a time comparison belongs in the query, which is re-evaluated on
every execution. It can never live in an index.**

### The fix, and why no replacement index was created

The index was **removed entirely** rather than re-created without its predicate.
The unique constraint declared 8 lines above it,
`company_blocklist_user_slug_key unique (user_id, company_slug)`, already
creates a btree on exactly those two columns — which *is* the Screener's lookup
key. A second index on the same leading columns would cost a write on every
insert and buy no reads. The Screener reads `blocked_until` off the row it just
found and applies the time test itself; this table holds one person's blocked
companies, so that heap fetch is not worth indexing away.

### Follow-through: was this a class of bug or a single instance?

A single instance. Every other partial index across all 7 files uses a
time-invariant predicate (`is null`, `is not null`, or a bare boolean column),
and **zero** CHECK constraints or generated columns use `now()`. Checked rather
than assumed, because "the first failure is usually load-bearing" cuts both ways
— it is also worth confirming it is not the first of twenty.

## The three invariants

Each test is built so that **exactly one mechanism can produce the failure**.
A test that would also pass with the mechanism removed is testing the composite,
not the mechanism — see [`../verification-traps.md`](../verification-traps.md).

### A. `UNIQUE(user_id, job_id)` genuinely refuses a second insert

Constraint #7 ("never submit the same application twice") must be *the database
refusing*, because a code-level check gets bypassed by a race between two
GitHub Actions runs.

```
ERROR:  duplicate key value violates unique constraint "applications_user_job_key"
DETAIL:  Key (user_id, job_id)=(aaaaaaaa-…, b0000001-…) already exists.
```

**Isolation:** the duplicate row carried a fresh `id`, valid foreign keys and the
default status, so it was otherwise perfectly legal and the unique constraint was
the only thing that could reject it.
**Control:** the identical insert shape against a *different* `job_id`
**succeeded** — proving the refusal was the *pair*, not a blanket rejection of
the insert shape.

### B. The transition guard genuinely rejects an illegal jump

```
ERROR:  illegal status transition tailored -> applying (application c0000002-…).
        No such edge in application_status_transitions.
CONTEXT:  PL/pgSQL function applyy_internal.guard_status_transition() line 44 at RAISE
```

**Isolation, and this is the subtle part.** Reading the guard's source first
revealed **three** distinct rejection paths, not one:

| Path | SQLSTATE | Message |
|---|---|---|
| No acting agent set | `42501` | `status change X -> Y refused: no acting agent…` |
| No such edge | `23514` | `illegal status transition X -> Y … No such edge…` |
| Agent not permitted for this edge | `42501` | `agent Z may not perform X -> Y…` |

So "the update failed" would have been a composite result — a bare `UPDATE`
fails with the *no acting agent* error and proves nothing about the edge table.
The test therefore sets `applyy.acting_agent = 'applier'`, the agent that **is**
permitted on the legal edge, which makes both `42501` paths unreachable and
leaves the missing-edge path as the only thing that can fire. The captured
message confirms which one did.

**Control:** the legal edge `approved → applying` — same agent, same target
status, differing *only* in `from_status` — **succeeded**, setting
`status=applying, previous_status=approved`. The illegal row stayed at
`tailored` with `previous_status` still `NULL`. A guard that rejected both would
have proven nothing; a guard that rejects one and admits the other is doing work.

**Supporting facts, read live rather than off the seed file:**
- `approved → applying` is the **only** edge into `applying`
  (`allowed_agents = {applier}`).
- `tailored → applying` returns **0 rows**.
- The seed holds **44 edges** total.

So constraint #15 is **unreachable-by-construction**, not enforced-by-review.

### C. RLS — checked as two separate assertions, deliberately

RLS-enabled and has-a-policy **fail identically from the outside**: a table with
RLS on and zero policies is locked to everyone, a table with RLS off is wide
open, and a query run as the owner distinguishes neither. They are therefore
two assertions against two catalogues, never one "does it work" probe.

| Assertion | Source | Result |
|---|---|---|
| RLS enabled | `pg_class.relrowsecurity` | **15 / 15** |
| At least one policy | `pg_policies` | **15 / 15** |
| **Holes** (RLS off) | — | **0 rows** |
| **Locked** (RLS on, 0 policies) | — | **0 rows** |

`application_events` and `master_profiles` carry 2 policies each; the rest carry 1.

#### OPEN QUESTION, not resolved here

`application_status_transitions` has `relrowsecurity = t` but
**`relforcerowsecurity = f`**, while the other 14 tables have force RLS **on**.
It is the read-only reference seed, so that is *defensible* — but defensible is
not the same as *decided*, and it is the single place the pattern differs.
Recorded as an open question rather than silently resolved either way.

## `FORCE RLS` + `SECURITY DEFINER` — resolved, with a corrected reason

The concern: `application_events` has `force row level security` and its only
INSERT policy is `to authenticated`, while `applyy_internal.log_status_change()`
is `SECURITY DEFINER` and inserts as the function owner. `FORCE RLS` **does**
apply to the table owner — it is bypassed only for superusers and roles holding
`BYPASSRLS` — so if that applied here, every status change would fail because
the guard's sibling trigger could not write its witness row.

**It works, and the reason is not the one previously written down:**

| Role | `rolsuper` | `rolbypassrls` |
|---|---|---|
| `postgres` | **false** | **true** |
| `service_role` | false | **true** |
| `supabase_admin` | true | true |
| `authenticated` | false | false |
| `anon` | false | false |

`postgres` is **not** a superuser. The definer insert succeeds purely because
`postgres` carries `BYPASSRLS`. Proven live: the successful control transition
fired the audit trigger and its witness row landed —
`approved → applying, agent=applier` in `application_events`.

**Therefore:** the migration comment stating the definer "is not subject to this
policy" is *true for this deployment for the wrong stated reason*, and would be
**false** for a plain owner role without `BYPASSRLS` — in which case every status
change would fail. The comment needs correcting to name `BYPASSRLS` rather than
implying owner-or-superuser exemption. Tracked in
[`../PROGRESS.md`](../PROGRESS.md).

## Re-running this

The database is local and disposable, so these tests can be re-run at will:

```bash
# Bring the stack up. First run pulls ~10 images and takes minutes.
supabase start
# Canonical from-scratch application of all 7 migrations. NOTE: may exit 1 on the
# storage container's healthcheck while the SQL itself succeeded — verify with
# the ledger query below rather than trusting the exit code.
supabase db reset
```

```sql
-- Did every migration land? Expect 7 rows.
select version from supabase_migrations.schema_migrations order by version;
-- Two SEPARATE RLS assertions. Never collapse these into one probe.
select c.relname, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' order by c.relname;
-- Holes: RLS off entirely. Expect 0 rows.
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false;
-- Locked: RLS on but no policy, so nobody can read it. Expect 0 rows.
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
   and not exists (select 1 from pg_policies p
                    where p.schemaname = 'public' and p.tablename = c.relname);
```

The full invariant script — setup, both isolation controls, and the guard tests
— is worth promoting into a checked-in `supabase/tests/invariants.sql` so it
stops being a transcript. That path has no assigned owner yet, so it is proposed
rather than done.

## What this does NOT prove

Stated explicitly, because a verification document is most dangerous when it is
read as broader than it is:

- **Nothing is deployed.** This is a local Docker Postgres. The hosted project
  `xynqxekcqizwhtskzqrq` has never received these migrations.
- It does **not** prove the schema loads for a **non-`BYPASSRLS` owner** — see
  above.
- It does **not** exercise the RLS policies **as `authenticated`**. Every query
  here ran as `postgres`, which holds `BYPASSRLS`. "15/15 tables have a policy"
  is a statement about the catalogue, **not** a demonstration that the policies
  scope rows correctly. Proving that needs a session with a real JWT — the next
  verification worth doing.
- It does **not** exercise the 7 RPCs. Their *existence* is confirmed; their
  behaviour is not. Two known runtime defects are already recorded in
  [`../PROGRESS.md`](../PROGRESS.md) (`sweep_stale_claims` double-counting, and
  `bootstrap_user_defaults` never seeding `gemini_key_state`).

## Addendum — the remote, and two migrations that have never run

**19:00 IST. The remote schema is INDEPENDENTLY VERIFIED.** `supabase migration
list` connected and confirmed all seven original migrations present on both
sides: `20260909234500`, `234600`, `234700`, `234800`, `234900`, `235000`,
`235100`. Teja applied them himself with `supabase db push` at 18:45; the local
from-scratch `db reset` recorded above is what made that safe to attempt.

An earlier verification attempt failed with `password authentication failed for
user "postgres"`, and that was **propagation timing on a freshly reset password,
not a wrong credential** — the same value connected minutes later. Recorded
because the message is *accurate* and its most natural reading is *wrong*: it
sends a reader hunting through credential stores for a string that was already
correct. For anything just reconfigured, **retry before diagnosing.**

**Accepted risk, recorded with its expiry condition.** The RLS-as-`authenticated`
proof cannot run locally — Docker is unavailable — so it runs through a deployed
Edge Function that signs in as two app users. That writes test rows **into the
live database**. This is acceptable **only** because that database is empty and
nothing depends on it yet, and it **stops being acceptable the moment real
applications exist**. The test must clean up its own rows, must fail loudly if
cleanup does not complete, and **must never be re-run against a populated
database.**

### Two migrations here have NEVER been parsed by Postgres

`20260910185900_add_keepalive_agent_name.sql` and
`20260910190000_fix_sweep_count_bootstrap_seed_and_blocked_edge.sql` are
local-only, with empty `remote` entries. Docker was stopped before they were
written, so **unlike the seven migrations this document verifies, neither has
ever been executed.** Their first execution will be against the live database —
precisely the condition the rest of this document exists to record escaping.

Both files state it at the top. If Docker is restarted for one thing, it should
be a single `supabase db reset` before that push.

### Comments corrected in place in already-applied migrations

Two false invariants were fixed **in place** in files the remote records as
applied. That is a deliberate, narrow exception to migration immutability:
comments never reached Postgres, so nothing diverges behaviourally, and **leaving
a false invariant written down is worse than the file text differing from what
ran** — a reader treats a written invariant as a guarantee. The corrections are
listed in [`../PROGRESS.md`](../PROGRESS.md); both were verified by query first.
