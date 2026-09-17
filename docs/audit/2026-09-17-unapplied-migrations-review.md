# Unapplied migrations — pre-apply review

**Date:** 2026-09-17 · **Author:** `applyyy-5c` · **Target:** the live Supabase project
`xynqxekcqizwhtskzqrq` (Postgres 17.6.1, `aws-0-ap-southeast-2`)

**Read this before you run anything against the live database.** Nothing in this repo
type-checks SQL, Docker is off, and there is no local rehearsal. A careful read is the
only verification step these two files get, so this document *is* the gate.

**Files reviewed:**

- `supabase/migrations/20260917124500_fix_bootstrap_filter_rule_seed_columns.sql`
- `supabase/migrations/20260917130000_guard_application_status_on_insert.sql`

**Method:** every claim each migration makes about the schema was re-derived from the
migration files in filename order, not from the commit message and not from
`PROJECT_PLAN.md`. Where I could not settle something from the repo, it is in
[§7](#7-what-i-could-not-determine) with the query that would settle it. I did not run
anything against the live database — remote authorisation is yours to exercise
(`docs/PROGRESS.md:644`), and a peer session cannot grant it.

---

## Verdicts

| Migration | Verdict | Confidence |
|---|---|---|
| `20260917124500_fix_bootstrap_filter_rule_seed_columns.sql` | **APPLY WITH THIS CAVEAT** — the SQL is correct and safe; its *backfill may be a complete no-op*, and the repo's own record says that is the likely outcome. See [§1.3](#13-existing-rows--the-loud-part). | High on the SQL. **Low** on the effect. |
| `20260917130000_guard_application_status_on_insert.sql` | **SAFE TO APPLY.** Allowlist verified against the real enum and all five insert sites; no bypass path found in SQL. | High. |

**Order: `124500` first, then `130000`.** That is filename order and the CLI enforces it
anyway. They are independent — see [§3](#3-interdependence).

**But neither is the real decision.** Read [§0](#0-read-this-first-you-are-probably-applying-seven-migrations-not-two) before you type the command.

---

## 0. Read this first: you are probably applying SEVEN migrations, not two

The brief for this review called these "the two unapplied migrations." The repo's own
records say the unapplied backlog is larger, and `supabase db push` applies **all** of it
in one go.

The last recorded observation of remote state is
[`docs/architecture/graph-engineering.md:259-264`](../architecture/graph-engineering.md#L259-L264),
which reports a `supabase migration list` run against live at **11:46 on 2026-09-11**
(the file's last commit is `98b28bd`, 2026-09-11 12:09 — so "11:46" is that day, not
today; I initially misread it as today's and it is worth stating that it is not).

It found: applied through `20260910212600`, unapplied = `20260910220800` and
`20260911114300`. Consistent — at that moment those were the only two files past
`20260910212600`.

Since then, five more migration files were committed and **nothing in the repo records a
`db push` after 2026-09-11 11:46**. Git first-commit dates:

| Migration | First committed | Applied? |
|---|---|---|
| `20260910220800_create_private_storage_buckets` | 2026-09-10 22:11 | **No** (per the 09-11 listing) |
| `20260911114300_add_resume_sha256_to_applications` | 2026-09-11 11:59 | **No** (per the 09-11 listing) |
| `20260911235500_add_linkedin_post_discovery_source` | 2026-09-12 00:12 | Unknown — no record |
| `20260912001500_gemini_key_pool_cycle_randomization` | 2026-09-12 00:12 | Unknown — no record |
| `20260912120000_update_search_preferences_and_employment_types` | 2026-09-12 11:24 | Unknown — no record |
| `20260917124500_fix_bootstrap_filter_rule_seed_columns` | 2026-09-17 12:46 | No |
| `20260917130000_guard_application_status_on_insert` | 2026-09-17 13:00 | No |

**Consequences you need to hold in your head:**

1. **`db push` will apply up to seven files. I reviewed two of them.** The other five
   are unreviewed by me. Two of them (`20260911235500`, `20260912120000`) contain
   `alter type ... add value`, which this repo has already been bitten by — see
   `20260910185900_add_keepalive_agent_name.sql:5-19` for the recorded trap. Neither uses
   its new value in the same file, so both look fine, but that is a glance, not a review.
2. **`20260912001500` is the migration that *introduces* the `evaluation_order` break.**
   If it is unapplied, then the break `124500` describes as "LIVE" is not live yet — both
   files will apply in the same push, seconds apart, and the broken function is never
   called in between. `124500`'s framing is stale, its SQL is not. No action needed;
   just do not go looking for damage that was never done.
3. **`supabase migration list` is the only thing that settles this.** Run it first. See
   [§4](#4-the-exact-command).

---

## 1. `20260917124500_fix_bootstrap_filter_rule_seed_columns.sql`

### 1.1 Ordering — does everything it references exist at that point?

**Yes. Verified object by object**, walking the migrations in filename order. This is the
exact class of bug the file repairs, so it is the exact bug it could reintroduce.

| Referenced | Exists at | Note |
|---|---|---|
| `public.filter_rules.sort_order` | `20260909234800_supporting_tables.sql:229` | `smallint not null default 100`. The real column — confirmed. |
| `public.filter_rules.config` | `20260909234800_supporting_tables.sql:225` | `jsonb not null default '{}'` |
| `filter_rules_user_type_key unique (user_id, rule_type)` | `20260909234800_supporting_tables.sql:235` | The `on conflict (user_id, rule_type)` target. Present. |
| `public.system_settings.user_id` **primary key** | `20260909234700_core_tables.sql:27` | The `on conflict (user_id)` target. Present. |
| `public.search_preferences.user_id` **primary key** | `20260909234800_supporting_tables.sql:176` | Present. |
| `public.gemini_key_state primary key (user_id, key_index)` | `20260909234800_supporting_tables.sql:158` | Present. |
| `public.filter_rule_type` | `20260909234500_enums.sql:225-241` | Exactly nine values. |
| `public.pacific_today()` | `20260909234600_helpers.sql:37` | Used by column defaults on both seeded tables. |

**The nine-element array matches the enum exactly** — nine values, no extras, nothing
missing. I checked both directions. And no later migration extends `filter_rule_type`
(the only three `alter type ... add value` statements in the repo target `agent_name`,
`discovery_source` and `employment_type`).

**The bug it claims to fix is real.** `20260912001500:157` reads
`insert into public.filter_rules (user_id, rule_type, evaluation_order)`. There is no such
column. plpgsql does not validate SQL at `create` time, so this raises `42703` at *call*
time, not at deploy time — which is why it shipped.

**A trap `124500` avoids and deserves credit for:** the later `20260912120000` migration
adds three columns to `search_preferences` (`work_arrangements`, `max_salary`,
`compensation_types`). All three are nullable or carry defaults, so the bare
`insert into public.search_preferences (user_id)` still works after that migration lands.
Had any of them been `not null` with no default, this backfill would fail. It does not.

### 1.2 Idempotence

**Safe to re-run.** Every statement is either `create or replace` or carries
`on conflict ... do nothing`:

- the function is `create or replace` — replaces cleanly;
- all four backfill inserts are `on conflict do nothing` against a real unique
  constraint (each verified in the table above).

Re-running produces zero writes and no error. This matters because the Supabase migration
runner retries.

**One subtlety worth knowing:** `on conflict do nothing` also means this migration will
**never correct a row that already exists and is wrong.** That is deliberate and the file
says so at `:161-163` and `:245-251`. It is the right call — but see §1.3, because it
interacts with a population the file mis-describes.

### 1.3 Existing rows — the loud part

> **This is the finding to read twice. The migration can run perfectly, report success,
> and change nothing at all — and the repo's own records say that is the likely outcome.**

The backfill is four statements of the shape
`insert into ... select ... from auth.users`. **Its entire effect is proportional to the
number of rows in `auth.users`.** If that table is empty, all four insert zero rows and
the migration is a pure no-op on data.

`docs/PROGRESS.md:70` states plainly: **"There is no Supabase Auth user yet."**

If that is still true, applying `124500` fixes the *function* (real, necessary, latent)
and backfills *nobody*. You will see "Finished supabase db push", and
`select count(*) from public.filter_rules` will still be `0`.

**Second, compounding fact: the migration's population model is counterfactual.**
`124500:177-191` describes "population A" (bootstrapped after the break, no rows) and
"population B" (bootstrapped before, rows correct). Neither exists. The repo records that
`bootstrap_user_defaults()` **has never been called at all**:

- `supabase/functions/_shared/agent/loop.test.ts:77` — *"The CURRENT state of the live
  database: `bootstrap_user_defaults()` never called."*
- `supabase/functions/_shared/agent/kill-switch.test.ts:54` — *"`bootstrap_user_defaults()`
  has not been called. This is the CURRENT state of the live database, so it is
  production behaviour and not a hypothetical."*
- `docs/PROGRESS.md:65` — *"`gemini_key_state` is empty on the remote."*

The SQL is unaffected — `on conflict do nothing` reaches the correct action whether the
rows exist or not. But the *reasoning* in the comment block is wrong, and the reason it
matters is that it sets a false expectation of what you will see afterwards. This is a
correct citation carrying a wrong conclusion, which is the nastier kind.

**Third, and the one with an ongoing cost: nothing calls
`bootstrap_user_defaults()` automatically.** I grepped every RPC call site in
`apps/web/src`, `worker/src` and `supabase/functions`. The complete list is
`claim_gemini_key`, `report_gemini_result`, `advance_application_status`,
`claim_applications`, `release_application_claim`, `sweep_stale_claims`. **`bootstrap_user_defaults`
is not among them**, and there is no trigger on `auth.users`.
`packages/shared-types/SCHEMA_CONTRACT.md:571` confirms it is a manual step: *"Call
`bootstrap_user_defaults()` once per account."*

So the post-apply state is:

- **users who exist at apply time** → seeded by the backfill;
- **users who sign up after** → seeded by the fixed function, *but only when somebody
  remembers to call it.*

That gap is not this migration's job to close, but you should know it is open.

**What it does NOT do, and this is good news:** seeding `system_settings` uses the column
defaults, and `system_enabled` defaults to `false` (`core_tables.sql:32-40`). **Applying
this migration turns nothing on.** No risk of the pipeline starting to submit.

### 1.4 Transaction boundary

**One unit per file, and the repo has the evidence rather than my memory of the CLI.**
`20260910185900_add_keepalive_agent_name.sql:5-11` records it as a finding:

> *"`alter type ... add value` is special: even where Postgres permits it inside a
> transaction block (12+), THE NEW VALUE CANNOT BE USED UNTIL THAT TRANSACTION COMMITS.
> **The Supabase CLI wraps each migration**, so a single file that both adds the value and
> then inserts a row using it would fail on the insert — and fail *after* the type change,
> leaving a partially-applied migration."*

So for `124500`: the function replacement and all four backfill inserts commit together or
not at all. A failure anywhere leaves the database exactly as it was, and the migration
unrecorded in the ledger. That is the behaviour you want, and it is the same mechanism
that caused the original damage (three tables rolling back on one bad column) now working
in your favour.

Across files it is *not* one unit — see [§6](#6-if-it-half-applies).

### 1.5 RLS and privilege

**No widening.** The function keeps `set search_path = ''` and is **not** `security
definer` — same as the version it replaces. Its only privilege-relevant behaviour is the
`auth.uid() is null` guard at `:100-103`, which is retained verbatim.

**One thing I checked because `force row level security` is on every one of these tables**
(`core_tables.sql:82`, `supporting_tables.sql:161,201,239` — *the owner is subject to
policies too*): the backfill runs as the migration role, not as an authenticated user. If
that role lacked RLS bypass, the inserts would **raise** `42501` — loudly, not silently.
The genuinely silent failure mode is the *read*: if the migration role cannot
`select from auth.users`, RLS returns zero rows with no error and the backfill quietly
does nothing. Supabase's `postgres` role can read `auth.users`, and `20260912001500:166-168`
already uses the identical `select ... from auth.users` shape — but note that precedent
proves the *syntax* works, not that it *returned rows*. The query in
[§5](#5-what-you-should-see-afterwards) distinguishes the two.

### 1.6 The restored `config` seed — verified against both predecessors

The file claims `20260912001500` dropped a `config` value that both earlier definitions
had. **Confirmed, in both:**

- `20260909235100_queue_and_pool_functions.sql:447-459` — `case when v_rule = 'staleness'
  then '{"treat_unknown_posted_at_as_fresh": false}'::jsonb else '{}'::jsonb end`
- `20260910190000_fix_sweep_count_bootstrap_seed_and_blocked_edge.sql:221-234` — identical

And absent from `20260912001500`, which inserts only three columns. The restoration is
regression repair, correctly characterised.

**The inversion argument is sound and worth understanding**, because it is this repo's
signature defect in SQL form: a reader doing `config->>'treat_unknown_posted_at_as_fresh'`
against `{}` gets **NULL, not false**. In a boolean context NULL is not true — so
whether it fails open depends entirely on how the reader is written. Seeding the explicit
`false` removes the question rather than answering it.

**The cost ordering is also verified consistent between the two code paths**, which is a
real risk the file avoided: the function's loop yields `title_blocklist=10 … per_company_weekly_cap=90`,
and the backfill's `with ordinality` yields `ord*10` = `10 … 90` over the same array.
They agree exactly. Had they disagreed, a backfilled user and a bootstrapped user would
have had different cascades with no error anywhere.

### 1.7 Minor: a justification that no longer holds

`124500:245-251` declines to force `sort_order` on existing rows partly because doing so
*"would OVERWRITE any ordering a real user had deliberately tuned on the settings page."*

Per `CLAUDE.md` §8, **the Filters page cannot write at all** — `filtersStore.ts:232`
upserts `is_enabled` where the column is `enabled`. So no user has tuned anything. The
conclusion (don't force) is still correct and still the conservative choice; only the
stated reason is over-generous to the current UI. **No change needed.** Flagged so the
comment is not later cited as evidence the settings page works.

---

## 2. `20260917130000_guard_application_status_on_insert.sql`

### 2.1 The hole it closes is real

**Verified.** `20260909234900_status_transition_guard.sql:266-268`:

```sql
create trigger guard_status_transition
  before update on public.applications
  for each row execute function applyy_internal.guard_status_transition();
```

`before update` only. I grepped every trigger in the repo: **there is no INSERT trigger on
`public.applications`**, and no name collision with `guard_status_insert`. An inserted row
has therefore traversed no edge and consulted no `allowed_agents`. The hole is exactly as
described.

### 2.2 The allowlist, checked against the enum and the transition table — not the commit message

The guard permits `discovered`, `passed_filters`, `dropped_filter`. Against
`public.application_status` (`20260909234500_enums.sql:28-70`, 20+ values) these three are
the only pre-gate statuses any code writes at insert time. **All five insert sites
verified by reading the code, not the comment:**

| Site | Status written | In allowlist? |
|---|---|---|
| `worker/src/cli/scout.ts:312` | `'discovered'` (screener-unavailable fallback) | ✅ |
| `worker/src/cli/scout.ts` → `plan.inserts` | `passed_filters` / `dropped_filter` | ✅ |
| `supabase/functions/scout-ats/index.ts:400` | `'discovered'` (same fallback) | ✅ |
| `supabase/functions/scout-ats/index.ts` → `plan.inserts` | `passed_filters` / `dropped_filter` | ✅ |
| `worker/src/cli/scout-remote.ts:345` | `'discovered'` | ✅ |
| `apps/web/src/data/discoveryService.ts:360` | `'discovered'` | ✅ |
| `apps/web/src/data/discoveryService.ts:506` | `'discovered'` | ✅ |
| `core_tables.sql:313` column default | `'discovered'` | ✅ |

`plan.inserts` originates at `supabase/functions/_shared/screen/screen-batch.ts:188,202,207`
and writes only `dropped_filter` and `passed_filters`, matching the
`ScreenedInsertStatus` union at `:44`.

**`deduped` is correctly excluded.** I checked specifically, because it is the one
pre-gate status *not* in the allowlist. Nothing inserts it — the only writer is a
transition (`DiscoveredJobsPage.tsx:243`, `{ to: 'deduped', agent: 'normalizer' }`), which
goes through `advance_application_status` and therefore the UPDATE guard. Confirms the
repo's standing note that nothing ever writes `deduped`.

**The migration's defence of `'discovered'` is correct and load-bearing.** Refusing it
would break both screened scouts on their transient-failure fallback path — a guard that
fires hardest exactly when the database is already struggling. Good reasoning; I tried to
break it and could not.

### 2.3 The adversarial question: is there any other write path in?

I looked for all of the shapes the brief named.

| Bypass shape | Finding |
|---|---|
| `insert into public.applications` in any migration | **Zero.** Grepped all 17 files. The migration's own claim holds. |
| A `security definer` function that inserts | **None.** Only two `security definer` functions exist in the entire schema — `guard_status_transition` (`:187`) and `log_status_change` (`:277`), both triggers, both on the UPDATE path. `log_status_change` inserts into `application_events`, not `applications`. |
| An RPC that inserts | **None.** Every `applications` write in `queue_and_pool_functions.sql` is an `update` (`:73`, `:129`, `:183`, `:235`). `advance_application_status` is `security invoker` and updates. |
| **Service-role path** | Present (edge functions), **and it does not matter** — the service-role key bypasses *RLS*, not *triggers*. A `BEFORE INSERT` trigger fires for every role. This is the strongest property of putting the control here instead of in a policy. |
| **Upsert whose `ON CONFLICT` becomes an UPDATE** | **Checked, and the claim holds.** Every `applications` upsert uses `ignoreDuplicates: true` → `ON CONFLICT DO NOTHING`: `discoveryService.ts:366,508`, `scout-ats/index.ts:406`, `scout.ts:318`, `scout-remote.ts:353`. The `ignoreDuplicates: false` call sites (`scout.ts:260`, `scout-ats:337`, `scout-remote:324`, `discoveryService:341`) are all on **`jobs`**, keyed `user_id,fingerprint` — a different table. So no `applications` upsert degrades into an UPDATE. |
| `COPY FROM` | **Covered.** `COPY` fires `BEFORE INSERT` row triggers. |
| PostgREST direct insert from the browser | **Covered** — this is the main thing the trigger buys you over the TypeScript union. |

**Residual, honestly stated:** a `BEFORE INSERT` trigger can still be bypassed by
`ALTER TABLE ... DISABLE TRIGGER`, by `session_replication_role = 'replica'`, and by a
`pg_restore`. All require elevated privilege you would have to exercise deliberately.
That is the normal limit of a trigger-based control, not a defect in this one.

### 2.4 The `ON CONFLICT` argument is correct, and it is the best thing in the file

The comment at `:72-86` argues the trigger must judge `new.status` alone, because
`BEFORE INSERT` fires **before** conflict detection — so on every re-poll it runs for
`(user_id, job_id)` pairs that already exist, including ones sitting at `approved`. A
"smarter" version that consulted the stored row would refuse routine re-polling of your
most advanced applications.

**This is correct Postgres semantics** and it is the non-obvious trap that would have made
this migration actively harmful. Given §2.3 confirms every `applications` upsert is
`DO NOTHING`, the scenario it describes is not hypothetical — it is the daily path.

### 2.5 RLS and privilege — including the one that looks like a problem and is not

**`security invoker` is the right choice and it does not break.** This deserves spelling
out because it looks alarming: `20260909234600_helpers.sql:21` runs
`revoke all on schema applyy_internal from public`, so `authenticated` has no `USAGE` on
the schema holding this function. The reflex is "then a `security invoker` trigger
function there cannot fire for a browser user."

It fires. Two independent reasons:

1. Postgres checks `EXECUTE` on a trigger function at **`CREATE TRIGGER`** time, not at
   fire time; the function is then invoked by OID, with no schema name resolution.
2. **There is a live precedent in this exact shape.** `applyy_internal.set_updated_at()`
   (`helpers.sql:60`) is `security invoker`, lives in the same revoked schema, and is
   attached `before update on public.applications` at `core_tables.sql:443-445`. Every
   status change any agent has ever made fired it as `authenticated`.

So the migration's reasoning at `:60-64` — definer would grant privileges the function has
no use for, and an unused privilege on a trigger reachable from every insert is surface
with no upside — is sound, and carries no hidden cost. `set search_path = ''` is set; the
body resolves nothing by name (enum comparison and `RAISE` only).

**This is the one item where I would most welcome a smoke test**, since I am reasoning
about privilege semantics without a database. [§5](#5-what-you-should-see-afterwards)
gives a test that proves it in one statement with no cleanup.

### 2.6 Idempotence

**Safe to re-run.** `drop trigger if exists` precedes `create trigger` (`:115`), which is
the correct workaround for `create or replace trigger` not existing, and the function is
`create or replace`. The comment explaining *why* the drop is there (so the file can be
rehearsed against a throwaway local Postgres) is exactly the kind of note that stops
someone "simplifying" it away.

### 2.7 The NULL branch — checked, because this is where the repo's signature bug lives

`:94-100` argues there is deliberately no null handling, because
`null not in (...)` evaluates to **NULL, not true**, so the `if` does not fire and the
column's `NOT NULL` constraint rejects the row a moment later with a clearer error.

**This is correct**, and it is the one place in these two files where the
"permissiveness of the reader" pattern could have bitten. It is worth being precise about
why it is safe here rather than merely lucky: a NULL-returning guard *failing open* is the
classic bug, and it fails open here too — it just falls through to a `NOT NULL` constraint
that catches it. The protection is the constraint, not the trigger. That is fine because
the constraint is unconditional, but it means the trigger alone is not sufficient and the
comment is right to explain it rather than add a dead branch.

### 2.8 Minor: one stale citation

`130000:39-41` lists `scout-remote.ts:343` among live insert sites. `CLAUDE.md` §5 records
that `scout-remote.ts` has **no production caller** — it was cited as production filtering
earlier today and that claim was retracted. Harmless here (it writes `'discovered'`, which
is allowlisted either way), but it is a stale citation inside a file arguing from an
"exhaustive search". Not worth an edit on its own.

### 2.9 Does the guard actually buy what it claims?

The brief asked, given that `advance_application_status` takes `p_agent` as an unverified
caller-supplied string and `set_config`s it — so the UPDATE guard validates a *claimed*
identity, and a browser can name itself `'applier'`.

**Yes, and the two are independent.** That gap lets a caller pick *which* edge it is
allowed to walk. This trigger stops a caller from **skipping the graph entirely** by being
born past the gate. Closing the insert hole does not close the `p_agent` hole, and the
`p_agent` hole does not make closing this one pointless — before `130000`, an attacker or
a buggy module did not need to impersonate anyone at all. Constraint 15 ("never submit
without human approval") remains reachable via the `p_agent` gap; it is no longer reachable
via a plain INSERT. That is a real, partial improvement, correctly scoped.

---

## 3. Interdependence

**None in either direction.** They touch disjoint objects:

- `124500` → `public.bootstrap_user_defaults()`, plus rows in `system_settings`,
  `search_preferences`, `filter_rules`, `gemini_key_state`.
- `130000` → `applyy_internal.guard_status_insert()` and a trigger on
  `public.applications`.

No shared table, no shared function, no ordering constraint between them.

**If you apply only one:**

- **`124500` alone** → the insert hole stays open. Status quo; nothing gets worse.
- **`130000` alone** → the bootstrap stays broken. Status quo; nothing gets worse. The new
  trigger constrains only statuses no current code writes at insert, so it cannot break
  the scouts.

**Recommended order — filename order, `124500` then `130000`** — which is what the CLI
does anyway. The only reason to prefer it is that `124500` has the larger blast radius
(it writes rows), so if you are going to stop and look at something, stop after that one.

---

## 4. The exact command

**There is a documented, working, non-Docker path, and you have used it before.**
`docs/PROGRESS.md:44-46` records you running `supabase db push` yourself against
`xynqxekcqizwhtskzqrq`. `db push` connects to the remote database over the network;
Docker is needed only for `supabase start`, `db reset` and `db diff` (which uses a local
shadow database). Your no-Docker rule does not block this.

State confirmed on disk: project linked (`supabase/.temp/project-ref` →
`xynqxekcqizwhtskzqrq`), CLI `2.117.0` at `/c/Users/tejam/tools/supabase/supabase`,
remote Postgres `17.6.1.166`.

### Step 1 — find out what is actually unapplied (do not skip this)

```bash
supabase migration list
```

This is the only thing that settles §0. Compare the **Remote** column against the
seventeen files in `supabase/migrations/`. **If it lists more than the two `20260917…`
files as unapplied, stop and read those files before pushing** — a push applies all of
them.

### Step 2 — capture a baseline BEFORE you apply

The `124500` bug is proof that a migration can run clean and leave you broken. A count
taken only afterwards cannot tell "seeded 18 rows" from "was already 18". Take it first.

```sql
-- BASELINE. Run this BEFORE the push and keep the output. Every number below should
-- either grow or stay 0 for a reason you can name -- "it changed" is the only evidence
-- that separates a real apply from a green no-op.
select
  -- THE DETERMINING NUMBER for migration 124500. Its entire backfill is
  -- `insert ... select ... from auth.users`, so if this is 0 the backfill inserts
  -- nothing and the migration is a no-op that reports success. docs/PROGRESS.md:70
  -- says this is 0; if it still is, expect every count below to stay 0 too.
  (select count(*) from auth.users)                  as auth_users,
  -- The kill-switch row. claim_gemini_key() fails closed without it, which is why a
  -- missing row presents as an idle pipeline rather than an error.
  (select count(*) from public.system_settings)      as system_settings,
  (select count(*) from public.search_preferences)   as search_preferences,
  -- Expect 9 per user after the backfill. This is the table the whole migration is about.
  (select count(*) from public.filter_rules)         as filter_rules,
  -- Expect 20 per user.
  (select count(*) from public.gemini_key_state)     as gemini_keys;
```

### Step 3 — apply

```bash
supabase db push
```

`--dry-run` was tried on 2026-09-11 and was blocked with no local DB connection
(`.remember/today-2026-09-11.done.md:8`), so do not count on it.

---

## 5. What you should see afterwards

**"Applied without error" is not evidence.** Four checks, in order of what they prove.

### 5.1 The ledger moved

```bash
supabase migration list
```

`20260917124500` and `20260917130000` must now show in the **Remote** column.

### 5.2 Did the backfill do anything? (migration 124500)

Re-run the §4 Step 2 baseline query and diff it. Then, per user:

```sql
-- PER-ACCOUNT COMPLETENESS. A total count can hide a half-seeded user; this cannot.
-- Run it against every row in auth.users, because "some users are fine" is the state
-- this migration exists to end.
select
  u.id,
  u.email,
  -- Expect 1. Zero here means the pipeline still fails closed for this account.
  (select count(*) from public.system_settings   s where s.user_id = u.id) as settings,
  -- Expect 1.
  (select count(*) from public.search_preferences p where p.user_id = u.id) as prefs,
  -- Expect exactly 9 -- one per filter_rule_type enum value. 0 means the backfill did
  -- not reach this user; anything between 1 and 8 would mean a partial seed, which
  -- the on-conflict clauses should make impossible and would be worth reporting.
  (select count(*) from public.filter_rules      f where f.user_id = u.id) as rules,
  -- Expect 20, matching the twenty Gemini API keys.
  (select count(*) from public.gemini_key_state  k where k.user_id = u.id) as keys
from auth.users u;
```

> **If `auth_users` is 0:** the migration applied correctly and repaired nobody, because
> there was nobody to repair. That is a *pass*, not a failure — but it means the fix is
> entirely latent and you have changed nothing observable. **Do not read the green output
> as "filter rules now exist."**

### 5.3 The two silent regressions are actually gone (migration 124500)

These are the checks that matter most, because both regressions were invisible to every
test. Skip §5.2 if you like; do not skip this.

```sql
-- THE COLD-START POLICY. This is the value 20260912001500 silently dropped: an untrusted
-- posted_at must FAIL the freshness check, not bypass it. It must read 'false' -- the
-- string. A NULL here means the rule seeded with `{}` and the policy is INVERTED, which
-- is the exact failure the restoration exists to prevent and produces no error anywhere.
select user_id, config ->> 'treat_unknown_posted_at_as_fresh' as cold_start, sort_order
  from public.filter_rules
 where rule_type = 'staleness';

-- THE COST ORDERING. Must read title_blocklist=10 first and per_company_weekly_cap=90
-- last. If experience_ceiling sits at 10, the enum_range ordering survived: same verdicts,
-- strictly worse economics, and nothing else in the system will ever complain about it.
select rule_type, sort_order
  from public.filter_rules
 where user_id = (select id from auth.users limit 1)
 order by sort_order;
```

Expected ordering: `title_blocklist, employment_type, location_allowlist,
company_blocklist, experience_ceiling, degree_mismatch, staleness, already_applied,
per_company_weekly_cap` at `10 … 90`.

### 5.4 The trigger exists AND fires (migration 130000)

Existence first — necessary, not sufficient:

```sql
-- Both guards must be present and enabled. tgenabled must be 'O' (origin); 'D' means
-- disabled, which is a trigger that exists and protects nothing.
select tgname, tgenabled
  from pg_trigger
 where tgrelid = 'public.applications'::regclass
   and not tgisinternal;
```

Expect `guard_status_transition` and `guard_status_insert`, both `O`.

**Then prove it guards something — green proves the trigger exists, red proves it works:**

```sql
-- THE RED TEST. Wrapped in a transaction that is always rolled back, so it writes
-- nothing whatever the outcome. Deliberately uses junk UUIDs: a BEFORE INSERT trigger
-- fires before foreign-key checks (RI is implemented as AFTER triggers), so the guard
-- gets first refusal and no real job row is needed.
begin;
insert into public.applications (user_id, job_id, status)
values (gen_random_uuid(), gen_random_uuid(), 'approved');
rollback;
```

**Required outcome: SQLSTATE `42501`**, with the message *"application may not be INSERTED
at status approved"*.

- A **foreign-key** error instead → the trigger did **not** fire. Investigate before
  trusting the gate.
- **Success** → the approval gate is open. Stop and report.

This also settles §2.5 empirically: if it raises our error, a `security invoker` function
in the revoked `applyy_internal` schema fires correctly.

---

## 6. If it half-applies

**Within one file you cannot half-apply.** The CLI wraps each migration in a transaction
(`20260910185900:5-11`), so a file either commits completely or leaves no trace and is not
recorded in the ledger.

**Across files you can.** `db push` applies them in order and stops at the first failure.
Earlier files are committed; the failing one is rolled back; later ones never run.

**Recovery:**

1. **Do not re-run blindly.** `supabase migration list` first — it tells you exactly where
   it stopped.
2. **Both of these files are safely re-runnable** (§1.2, §2.6), so a second `db push`
   after fixing the failing file is fine. The CLI skips already-recorded ones.
3. **If the ledger and reality disagree** — a file that clearly applied but is not
   recorded, or vice versa — use `supabase migration repair --status applied <version>`
   (or `--status reverted`) to correct the ledger. **Do not** hand-edit
   `supabase_migrations.schema_migrations`.
4. **If `124500` itself fails**, nothing was written: no function replacement, no
   backfill. The database is exactly as it was and `bootstrap_user_defaults()` is still
   broken. No cleanup.
5. **If `130000` fails after the function was created but before the trigger** — not
   possible within the transaction, but if the ledger says otherwise, check §5.4's
   `pg_trigger` query. A function with no trigger is inert and harmless; just re-push.
6. **There is no undo.** Neither file has a down migration and this repo does not write
   them. Reversing `130000` is `drop trigger guard_status_insert on public.applications;`
   — which reopens the hole. Reversing `124500`'s backfill would mean deleting seeded
   rows, which you should not do; re-running the fixed function is the forward fix.

---

## 7. What I could not determine

Stated plainly, because you are running these blind and an overconfident SAFE is worse
than an honest gap.

| # | Unresolved | Why it matters | What settles it |
|---|---|---|---|
| 1 | **Which migrations are actually applied on remote.** Last record is 2026-09-11 11:46. | `db push` may apply seven files, five of which I did not review. | `supabase migration list` |
| 2 | **How many rows are in `auth.users`.** `docs/PROGRESS.md:70` says zero; that note is several days old. | This single number decides whether `124500`'s backfill does anything at all. | `select count(*) from auth.users;` |
| 3 | **Whether the migration role can read `auth.users`.** I reason it can (Supabase `postgres`, plus the `20260912001500:166` precedent), but that precedent would look identical if it had returned zero rows. | A silent zero-row read makes the backfill a no-op that reports success. | §5.2 — compare against the §4 baseline. |
| 4 | **Whether a `security invoker` trigger function in the revoked `applyy_internal` schema fires for `authenticated`.** I am confident (Postgres checks `EXECUTE` at `CREATE TRIGGER`; `set_updated_at` is a live precedent in the identical shape) but I could not execute SQL. | If wrong, **every** insert into `applications` fails — a full pipeline outage. | §5.4's red test. |
| 5 | **The other five unapplied migrations.** Unreviewed. Two contain `alter type ... add value`; neither uses the new value in the same file, which is the documented trap, but that is a glance. | They ship in the same push. | A review, if §1 of `supabase migration list` shows them unapplied. |

**Confidence summary.** High that neither file corrupts data, breaks an existing code path,
or widens privilege. High that `130000`'s allowlist is correct and has no SQL-side bypass.
**Low that `124500` will visibly change anything**, and that is a property of the
database's current state, not of the migration.

---

## 8. Defects found

**No blocking defects. No SQL requires correction, and I have proposed no edits to either
file.** Both are correct, idempotent, transactional and well-commented — including the
"why it exists" comment a migration needs to stop someone simplifying it back into the bug
it fixed. Both carry that generously.

What I found is three **comment-level** issues. None changes behaviour; all three could
mislead a later reader, which in this repo is how stale claims get trusted.

| # | File:line | Issue | Suggested action |
|---|---|---|---|
| 1 | `124500:177-191`, `:245-251` | The population A / B model is counterfactual — `bootstrap_user_defaults()` has never been called, so neither population exists. The SQL reaches the right action for the wrong reason, and the comment sets a false expectation of what you will see post-apply. | Amend the comment after applying, when the real state is known. **Not worth blocking on.** |
| 2 | `124500:249-251` | Cites protecting "ordering a real user deliberately tuned on the settings page"; the Filters page cannot write (`filtersStore.ts:232` upserts `is_enabled`, column is `enabled`). | Leave the behaviour. Do not let this line be cited as evidence the settings page works. |
| 3 | `130000:39-41` | Lists `scout-remote.ts:343` as a live insert site; `CLAUDE.md` §5 records it as having no production caller. | Harmless — it writes `'discovered'`, allowlisted regardless. Note only. |

**One operational gap, outside both files and not theirs to close:** nothing calls
`bootstrap_user_defaults()` automatically — not the web app, not a trigger on `auth.users`.
After `124500` lands, any *new* signup still gets no rows until someone invokes the RPC by
hand. Worth a ticket.

---

## Appendix — what was checked and how

Every schema claim was re-derived from the migration files in filename order. Everything
below was read, not assumed:

- all 17 files in `supabase/migrations/` (targeted reads; enums, both guard files and all
  three prior `bootstrap_user_defaults` definitions in full)
- repo-wide greps for: `insert into public.applications`, `security definer`,
  `force row level security`, `alter type`, `revoke`/`grant`, `ignoreDuplicates`,
  `deduped`, `bootstrap_user_defaults`, every `.rpc(` call site
- all five `applications` insert sites, read in context rather than trusted from the
  migration's own enumeration
- `git log --diff-filter=A` on every migration, to date the apply backlog
- `supabase/config.toml` (PostgREST exposes `public` only — `applyy_internal` is not
  reachable over the API), `supabase/.temp/` link state

**Not done:** no connection to the live database, no `supabase` command, no local Postgres,
no Docker. `pnpm install` and root `pnpm run typecheck` were deliberately avoided
(the latter rewrites `pnpm-lock.yaml`).
