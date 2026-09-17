# Unapplied migrations — pre-apply review

**Date:** 2026-09-17 · **Author:** `applyyy-5c` · **Target:** the live Supabase project
`xynqxekcqizwhtskzqrq` (Postgres 17.6.1, `aws-0-ap-southeast-2`)

**Read this before you run anything against the live database.** Nothing in this repo
type-checks SQL, Docker is off, and there is no local rehearsal. A careful read is the
only verification step these two files get, so this document *is* the gate.

---

# THE HEADLINE

> **All seven pending migrations are safe to apply, in one `supabase db push`, in
> filename order. No file needs a SQL change. The risk is not inside any of them — it is
> that the FIRST file is the only one that can plausibly fail, and if it does, none of
> the other six apply, including the two that matter.**

That first file is `20260910220800_create_private_storage_buckets.sql`. It writes four
`create policy` statements against `storage.objects`, a table this project does not own,
and it is the only file in the backlog with no re-run guard on its main statements. Its own
comment claims re-running is safe; **that claim is false** ([§3.1](#31-20260910220800_create_private_storage_bucketssql)).
Nothing about it is wrong — it just has the highest chance of stopping the push, and it is
standing in front of everything else.

One sentence for the decision: **run it, but run `supabase migration list` first
([§4](#4-the-runbook)), and if the push dies, check which file it died on before retrying.**

---

**Files reviewed — all seven pending migrations:**

| # | File | Reviewed in |
|---|---|---|
| 1 | `20260910220800_create_private_storage_buckets.sql` | [§3.1](#31-20260910220800_create_private_storage_bucketssql) |
| 2 | `20260911114300_add_resume_sha256_to_applications.sql` | [§3.2](#32-20260911114300_add_resume_sha256_to_applicationssql) |
| 3 | `20260911235500_add_linkedin_post_discovery_source.sql` | [§3.3](#33-20260911235500_add_linkedin_post_discovery_sourcesql) |
| 4 | `20260912001500_gemini_key_pool_cycle_randomization.sql` | [§3.4](#34-20260912001500_gemini_key_pool_cycle_randomizationsql) |
| 5 | `20260912120000_update_search_preferences_and_employment_types.sql` | [§3.5](#35-20260912120000_update_search_preferences_and_employment_typessql) |
| 6 | `20260917124500_fix_bootstrap_filter_rule_seed_columns.sql` | [§1](#1-20260917124500_fix_bootstrap_filter_rule_seed_columnssql) |
| 7 | `20260917130000_guard_application_status_on_insert.sql` | [§2](#2-20260917130000_guard_application_status_on_insertsql) |

**Method:** every claim each migration makes about the schema was re-derived from the
migration files in filename order, not from the commit message and not from
`PROJECT_PLAN.md`. Where I could not settle something from the repo, it is in
[§7](#7-what-i-could-not-determine) with the query that would settle it. I did not run
anything against the live database — remote authorisation is yours to exercise
(`docs/PROGRESS.md:644`), and a peer session cannot grant it.

---

## Verdicts

| # | Migration | Verdict | Confidence |
|---|---|---|---|
| 1 | `20260910220800` storage buckets | **APPLY — and watch this one.** Correct SQL, but the only file in the backlog that cannot be re-run, and it gates the other six. | High on correctness. **Medium** on whether it applies cleanly. |
| 2 | `20260911114300` resume_sha256 | **SAFE TO APPLY.** Nullable column + shape check. Not re-runnable, same caveat, much lower exposure. | High. |
| 3 | `20260911235500` linkedin_post | **SAFE TO APPLY.** One idempotent `add value`, not consumed anywhere. | High. |
| 4 | `20260912001500` key pool | **APPLY ONLY AS PART OF THE FULL SET.** Installs the `evaluation_order` break that file 6 repairs. Safe in a complete push; leaves you broken if the push stops here. | High. |
| 5 | `20260912120000` search prefs | **SAFE TO APPLY.** Enum value not consumed in-file; the array default uses values committed in migration 1. | High. |
| 6 | `20260917124500` bootstrap fix | **APPLY WITH THIS CAVEAT** — the SQL is correct and safe; its *backfill may be a complete no-op*, and the repo's own record says that is the likely outcome. See [§1.3](#13-existing-rows--the-loud-part). | High on the SQL. **Low** on the effect. |
| 7 | `20260917130000` INSERT guard | **SAFE TO APPLY.** Allowlist verified against the real enum and all five insert sites; no bypass path found in SQL. | High. |

**Order: filename order, and the CLI enforces it.** You do not choose the order and you
cannot easily apply a subset — `db push` applies everything pending. That is precisely why
all seven needed reviewing rather than two.

**Read [§0](#0-the-whole-push-what-one-command-actually-does) before you type the command.**

---

## 0. The whole push: what one command actually does

You will type one command. It will apply **seven** files, in order, each in its own
transaction. This section is the view no per-file read gives you.

### 0.1 How the backlog was established

The last recorded observation of remote state is
[`docs/architecture/graph-engineering.md:259-264`](../architecture/graph-engineering.md#L259-L264),
reporting a `supabase migration list` run against live at **11:46 on 2026-09-11** (the
file's last commit is `98b28bd`, 2026-09-11 12:09 — so "11:46" is that day, not today; I
misread it as today's on first pass and it is worth stating plainly that it is not).

It found: applied through `20260910212600`; unapplied = `20260910220800` and
`20260911114300`. Consistent — at that moment those were the only two files past
`20260910212600`.

An earlier and *superseded* observation in [`docs/PROGRESS.md:243-260`](../PROGRESS.md#L243-L260)
confirms the seven original migrations present on both sides, and separately records
`20260910185900` and `20260910190000` as having **empty `remote` entries**. The
graph-engineering listing is later and supersedes it — but both agree on the shape of the
problem, and PROGRESS.md names it: *"the migration files and the live database disagree …
Read the files for intent. Query the database for behaviour."*

Since 2026-09-11 11:46, five more files were committed and **nothing in the repo records a
`db push`**. Git first-commit dates (`git log --diff-filter=A`):

| # | Migration | First committed | Applied? |
|---|---|---|---|
| 1 | `20260910220800_create_private_storage_buckets` | 2026-09-10 22:11 | **No** — named unapplied by the 09-11 listing |
| 2 | `20260911114300_add_resume_sha256_to_applications` | 2026-09-11 11:59 | **No** — named unapplied by the 09-11 listing |
| 3 | `20260911235500_add_linkedin_post_discovery_source` | 2026-09-12 00:12 | Unrecorded — committed after the listing |
| 4 | `20260912001500_gemini_key_pool_cycle_randomization` | 2026-09-12 00:12 | Unrecorded — committed after the listing |
| 5 | `20260912120000_update_search_preferences_and_employment_types` | 2026-09-12 11:24 | Unrecorded — committed after the listing |
| 6 | `20260917124500_fix_bootstrap_filter_rule_seed_columns` | 2026-09-17 12:46 | No |
| 7 | `20260917130000_guard_application_status_on_insert` | 2026-09-17 13:00 | No |

**This is inference from the repo record, not an observation of the database.** Only
`supabase migration list` settles it, and it is the first step of [§4](#4-the-runbook).

### 0.2 Cross-file interactions — what a per-file read misses

I looked specifically for: a type value added in one file and consumed in another, a column
added then altered, a function replaced twice, and any file assuming an earlier file
succeeded.

| Interaction | Files | Finding |
|---|---|---|
| **Enum value added, consumed elsewhere** | 3 → ?, 5 → ? | **None.** `linkedin_post` and `apprenticeship` appear *only* in their own files — grepped across all 17 migrations. No other file references either value. |
| **`bootstrap_user_defaults()` replaced twice** | 4, then 6 | **Correct as ordered.** File 4 installs the broken `evaluation_order` version; file 6 replaces it with the fixed one. No migration *calls* the function, so the broken body never executes in between. Final state is file 6's. |
| **`claim_gemini_key()` replaced** | 4 | Once only. Diffed against `20260909235100:284-355` — see [§3.4](#34-20260912001500_gemini_key_pool_cycle_randomizationsql). Nothing safety-relevant dropped. |
| **Column added, then depended on** | 5 → 6 | **Real dependency, correctly ordered.** File 6's backfill runs a bare `insert into public.search_preferences (user_id)`. File 5 adds three columns to that table. All three are nullable or defaulted, so the bare insert still works. Had any been `not null` with no default, file 6 would fail. |
| **Same table touched twice** | 2 and 7 both touch `public.applications` | Disjoint: file 2 adds a column, file 7 adds a trigger. No conflict. |
| **Backfill duplicated** | 4 and 6 both seed `gemini_key_state` from `auth.users` | Both `on conflict do nothing`. File 6 is a superset. Harmless. |

**The one that could have bitten and does not:** the `alter type … add value` trap recorded
at `20260910185900:5-19` — *"THE NEW VALUE CANNOT BE USED UNTIL THAT TRANSACTION
COMMITS"* — only fires when a value is added and consumed **inside one transaction**.
Neither new value is consumed anywhere at all.

That makes the answer **independent of how the CLI draws its transaction boundary**, which
matters: the repo records per-file wrapping (`20260910185900:7`) and that is standard CLI
behaviour, but I could not verify it against this CLI version. I did not need to. If the
whole push were one transaction the result here would be the same, because nothing consumes
a newly added value.

One genuine in-file case, and it is fine: file 4 adds `used_in_cycle` at `:17` and consumes
it at `:62,77,89,97`. That is a **column**, not an enum value — a new column is usable
immediately in the same transaction. The restriction is specific to enum values.

And file 5's `work_arrangements … default '{onsite,hybrid,remote}'` reads like the trap but
is not: `public.work_arrangement` and all three values are from
`20260909234500_enums.sql:153-157`, committed in migration 1.

### 0.3 If it dies partway — where you land

Each file is its own transaction (`20260910185900:7`), so a failure rolls that file back
completely and leaves every earlier file committed. `db push` stops at the first failure.

| Dies at | You are left with | Is that a safe resting place? |
|---|---|---|
| **1** — buckets | Nothing applied. Same state as now. | **Yes.** Fully safe. Fix and re-push. |
| **2** — resume_sha256 | Buckets + storage policies live. | **Yes.** Screenshots/resumes can now be uploaded; nothing else changed. |
| **3** — linkedin_post | + `applications.resume_sha256` column. | **Yes.** Additive, nullable, no code requires it. |
| **4** — key pool | + `linkedin_post` enum value. | **Yes.** Unused value. |
| **5** — search prefs | + `used_in_cycle`, new `claim_gemini_key()`, **and the BROKEN `bootstrap_user_defaults()`**. | **NO — this is the bad one.** See below. |
| **6** — bootstrap fix | + `apprenticeship`, three `search_preferences` columns, **still the broken bootstrap**. | **NO — same problem.** |
| **7** — INSERT guard | Everything except the INSERT guard. Bootstrap repaired. | **Yes.** Status quo on the security gap. |

> **The only genuinely bad resting places are "died at 5" and "died at 6", because file 4
> installs the `evaluation_order` break and file 6 is what repairs it.** Landing between
> them leaves `bootstrap_user_defaults()` raising `42703` on every call.
>
> **It is recoverable and not urgent** — nothing calls that function today
> ([§1.3](#13-existing-rows--the-loud-part)), so a live break there breaks nothing that is
> currently running. Fix the failing file and re-push. But do not walk away from a push
> that stopped at 5 or 6 thinking it was a clean partial.

Files 6 and 7 are both fully re-runnable, so re-pushing after a failure at 5 or 6 is safe.

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

## 3. The five earlier migrations

Reviewed to the same standard as §1 and §2. These are files 1–5 of the push and they run
**before** the two above.

### 3.1 `20260910220800_create_private_storage_buckets.sql`

**Verdict: APPLY — and this is the one to watch.** The SQL is correct. It is the only file
in the backlog that cannot be re-run, and it stands first in the queue.

**What it does.** Inserts two private buckets (`screenshots` 10 MB PNG-only, `resumes`
5 MB PDF-only) into `storage.buckets`, then creates four owner-scoped policies on
`storage.objects` — separate `select` / `insert` / `update` / `delete` rather than one
`for all`.

**Correctness — checked and good:**

- **The path-prefix boundary is right.** `(storage.foldername(name))[1] = auth.uid()::text`
  matches the gateway's `${userId}/${applicationId}/${timestamp}.ext`. Postgres arrays are
  1-indexed, and `[1]` is correct. The file flags this itself as the most likely thing to
  get wrong, and gets it right.
- **Splitting `for all` into four policies is the right call**, for the reason given at
  `:76-81`: `for all` writes one predicate into both `using` and `with check`, conflating
  "which rows you may see" with "which rows you may create". The `update` policy correctly
  carries **both** clauses — omitting `with check` would let an owner move an object into
  another user's prefix.
- **`insert into storage.buckets … on conflict (id) do nothing`** is idempotent.
- The column list (`id, name, public, file_size_limit, allowed_mime_types`) matches the
  current Supabase storage schema.

**THE DEFECT — a false idempotence claim.** The file says at `:43-45`:

> *"`on conflict do nothing` so re-running is safe — … a migration that cannot be re-run is
> a migration nobody dares re-run."*

**That is true of the bucket insert and false of the file.** Lines `:86`, `:99`, `:110`,
`:127` are four bare `create policy` statements. Postgres has no `create policy if not
exists` and no `create or replace policy`, and there is no `drop policy if exists` ahead of
them. **Re-running this file raises `42710` (duplicate_object).**

*In fairness, this is house style, not an outlier:* `20260909235000_rls_policies.sql`
contains 17 `create policy` and 0 `drop policy`. The whole repo's policy migrations share
this property. The reason it matters **here and not there** is that this file is first in a
seven-file push, so a failure in it stops everything behind it.

**When does non-idempotence actually bite?** Only when the object already exists from a
source other than this migration's own recorded application — because a *failed* file rolls
back completely, so retrying after a failure is clean. That sounds theoretical until you
read `docs/PROGRESS.md:250-260`, which names a **"NEW DIVERGENCE CLASS: the migration files
and the live database disagree"** in this very project. If any of these four policies was
ever created by hand in the dashboard under the same name, this file fails and nothing else
applies.

**Corrected SQL — reported, NOT applied** (I may not edit migrations; assign it if you want
it). Add ahead of each `create policy`:

```sql
-- Postgres has no `create policy if not exists` and no `create or replace policy`, so a
-- bare `create policy` raises 42710 on a second run. This file is FIRST in a seven-file
-- push: if it cannot be re-run, a stale policy of the same name blocks every migration
-- behind it, including the approval-gate fix. Dropping first is what makes the file
-- match the re-runnability its own header claims.
drop policy if exists "applyy owner reads own artifacts"   on storage.objects;
drop policy if exists "applyy owner writes own artifacts"  on storage.objects;
drop policy if exists "applyy owner updates own artifacts" on storage.objects;
drop policy if exists "applyy owner deletes own artifacts" on storage.objects;
```

**My recommendation is to apply the file AS-IS and not edit it.** A pre-flight query
([§4](#4-the-runbook)) tells you in one second whether the collision exists, and editing a
file to solve a problem you have not confirmed you have is how the `evaluation_order` bug
got in. Fix it only if the pre-flight says you need it.

**Residual I could not settle:** `create policy on storage.objects` requires rights on a
table owned by `supabase_storage_admin`. This is the pattern Supabase's own documentation
prescribes, and `db push` connects as the same `postgres` role the SQL editor uses, so I
expect it to work — but I could not verify it. If this file fails with `42501` rather than
`42710`, that is what happened. See [§7](#7-what-i-could-not-determine).

**Honest scope note the file makes itself, and it is correct:** creating a policy and having
it *scope correctly* are different claims, and every query available here runs as a role
with `BYPASSRLS`, so an inverted predicate would look identical in `pg_policies`. Treat
these four as **declared, not enforced**, until `rls-proof` runs. The buckets are private
regardless, so a wrong predicate is a broken feature, not an open door.

### 3.2 `20260911114300_add_resume_sha256_to_applications.sql`

**Verdict: SAFE TO APPLY.**

Adds `applications.resume_sha256 text` (nullable, no default) plus a shape check
`resume_sha256 is null or resume_sha256 ~ '^[0-9a-f]{64}$'`.

- **Nullable with no default is correct and well-argued** (`:21-33`): historical rows have
  no value, and applications that legitimately attach no resume never will. A `not null`
  here would force a fake digest, which is worse than an absent one.
- **The check is written `is null or …`**, so the nullable case stays legal. A bare regex
  would have rejected every resume-less application — the file spots this.
- **Additive and unused.** Nothing in the backlog or the codebase reads this column yet, so
  it cannot break anything downstream.
- Adding a nullable column with no default is catalog-only in PG11+ — no table rewrite, no
  lock of consequence.
- The `check` validates existing rows on creation; every existing row has `NULL` there,
  which passes.

**Same non-idempotence caveat, much lower stakes.** `:34` is `add column` **without**
`if not exists`, and `:50` is `add constraint` with no guard — re-running raises `42701`
then `42710`. Fix would be `add column if not exists` and wrapping the constraint in a
`do $$ … $$` existence check. **Not worth doing.** Unlike §3.1 this file is fourth from the
front and a collision is far less plausible.

**The file's own limits statement is worth keeping:** a shape check catches truncation,
case drift and an empty string, but **cannot catch a well-formed digest of the wrong
bytes** — which has already happened once on this project (a sha256 of the resume HTML
string rather than of the rendered PDF). This buys legibility, not integrity.

### 3.3 `20260911235500_add_linkedin_post_discovery_source.sql`

**Verdict: SAFE TO APPLY.** Eleven lines; the smallest and lowest-risk file in the backlog.

```sql
alter type public.discovery_source add value if not exists 'linkedin_post';
```

- **`if not exists` makes it idempotent.** ✅
- **Appended, not inserted mid-enum.** `add value` with no `before`/`after` appends, leaving
  the declaration order of the twelve existing values (`20260909234500_enums.sql:104-120`)
  untouched. This matters because Postgres sorts enums by declaration order and
  `packages/shared-types` mirrors it — inserting in the middle would silently change sort
  behaviour for every existing query.
- **The value is consumed nowhere.** Grepped all 17 migrations: `linkedin_post` appears only
  in this file. So the in-transaction trap at `20260910185900:5-19` cannot fire.
- **Its own file, which is the correct shape** — exactly what `20260910185900` argues for.

### 3.4 `20260912001500_gemini_key_pool_cycle_randomization.sql`

**Verdict: APPLY ONLY AS PART OF THE FULL SET.** The SQL is sound. The reason for the
qualifier is ordering, not correctness: **this is the file that installs the
`evaluation_order` break that file 6 repairs.** A push that commits this and then stops
leaves `bootstrap_user_defaults()` raising `42703`.

**What it does:** adds `gemini_key_state.used_in_cycle`, adds a covering index, rewrites
`claim_gemini_key()` from LRU to epoch-shuffle-with-key-1-pinned, rewrites
`bootstrap_user_defaults()` (introducing the break), and backfills 20 keys per user from
`auth.users`.

**Idempotence: clean.** `add column if not exists` (`:17`), `create index if not exists`
(`:20`), two `create or replace function`, and a backfill with `on conflict do nothing`
(`:169`). Fully re-runnable.

**I diffed the new `claim_gemini_key()` against the version it replaces**
(`20260909235100:284-355`), because `create or replace` swaps the *whole* body and **this
exact file has a demonstrated history of silently dropping things that way** — it lost the
staleness `config` seed and the cost ordering in the same change. So the question is not
whether the new logic is good but whether anything was lost.

**Nothing safety-relevant was lost.** Every control survives, in order:

| Control | Old | New |
|---|---|---|
| `for update` row lock on `system_settings` (serialises the counter) | `:26` | `:44` ✅ |
| Fail closed on missing/disabled settings row | `:29-31` | `:47-49` ✅ |
| Circuit breaker, explicit `is not null` so NULL = uncapped | `:35-37` | `:52-54` ✅ |
| Pacific date, not `current_date` | `:15` | `:34` ✅ |
| Cooling keys ineligible | `:51` | `:63,72,98` ✅ |
| `for update skip locked … limit 1` | `:54` | `:104` ✅ |
| Budget charged **only after** a key was handed out | `:64-68` | `:113-117` ✅ |

**What genuinely changed, and it is a deliberate design change, not a regression:**
`order by k.last_used_at` (LRU) became `order by (case when key_index = 1 then 0 else 1
end), random()` plus `used_in_cycle` bookkeeping. Over a full cycle each enabled key is
still used exactly once, so load stays even; key 1 simply leads each epoch.

**Two honest observations, neither blocking:**

1. **`gemini_key_state_lru_idx` is now dead for this query.** It was built for
   `order by last_used_at`; the new ordering is `case … , random()`, which no index can
   serve. With 20 keys per user the sort is free, and the new `gemini_key_state_cycle_idx`
   covers the `where`. Worth knowing before someone "optimises" by deleting the wrong index.
2. **The cycle-reset branch (`:66-84`) is correct.** When every eligible key is used it
   re-counts ignoring `used_in_cycle`, resets only if a non-cooling key exists, and
   otherwise returns NULL. Because the `system_settings` row lock at `:44` already
   serialises concurrent claims for a user, the bulk `update … set used_in_cycle = false`
   cannot deadlock against a second claim.

**Comment density is far below this repo's bar** — roughly 0.25 comment lines per code
line against the ≥1.00 the codebase holds elsewhere. I mention it because it is not
cosmetic here: **this is the one file in the whole set that silently dropped two ruled
decisions, and it is also the one written to a visibly different standard.** The two facts
are almost certainly the same cause.

### 3.5 `20260912120000_update_search_preferences_and_employment_types.sql`

**Verdict: SAFE TO APPLY.**

```sql
alter type public.employment_type add value if not exists 'apprenticeship';

alter table public.search_preferences
  add column if not exists work_arrangements public.work_arrangement[] not null default '{onsite,hybrid,remote}',
  add column if not exists max_salary numeric(14, 2),
  add column if not exists compensation_types text[] not null default '{paid}';
```

- **Fully idempotent** — `if not exists` on all four statements.
- **The enum value is appended and consumed nowhere.** `apprenticeship` appears only in this
  file across all 17 migrations, so the in-transaction trap cannot fire.
- **`work_arrangement[]` looks like the trap and is not.** `public.work_arrangement` and all
  three values in that default are from `20260909234500_enums.sql:153-157` — migration 1,
  committed long ago. Evaluating the default expression is therefore safe. *This is the one
  line in the backlog I would have expected to break, and it does not.*
- **`not null` + constant default on an existing table** is catalog-only in PG11+; no
  rewrite. `search_preferences` is almost certainly empty anyway.
- **The reason file 6 depends on this one:** `20260917124500`'s backfill runs a bare
  `insert into public.search_preferences (user_id)`. It works only because all three new
  columns are nullable or defaulted. They are. Correctly ordered (file 5 before file 6).

**Same low comment density as §3.4.** No defect; noted for consistency with the repo's
stated calibration.

---

## 3.6 Interdependence, all seven

Object-level overlap across the whole backlog:

| Object | Touched by | Conflict? |
|---|---|---|
| `storage.buckets` / `storage.objects` | 1 | No |
| `public.applications` | 2 (column), 7 (trigger) | No — disjoint |
| `public.discovery_source` | 3 | No |
| `public.gemini_key_state` | 4 (column, index, rows), 6 (rows) | No — both `on conflict do nothing` |
| `public.claim_gemini_key()` | 4 | Replaced once |
| `public.bootstrap_user_defaults()` | 4, then **6** | **Replaced twice — order-critical, and the order is correct** |
| `public.employment_type` | 5 | No |
| `public.search_preferences` | 5 (columns), 6 (rows) | **Real dependency, correctly ordered** |
| `public.filter_rules` | 6 | No |
| `applyy_internal.guard_status_insert()` | 7 | New object |

**Only two orderings are load-bearing, and both are satisfied by filename order:** 4 before
6 (the break before its repair) and 5 before 6 (the columns before the insert that relies on
their defaults). You cannot get these wrong — the CLI applies in filename order and offers
no way to reorder.

---

## 4. The runbook

**There is a documented, working, non-Docker path, and you have used it before.**
`docs/PROGRESS.md:44-46` records you running `supabase db push` yourself against
`xynqxekcqizwhtskzqrq`. `db push` connects to the remote database over the network;
Docker is needed only for `supabase start`, `db reset` and `db diff` (which uses a local
shadow database). **Your no-Docker rule does not block this** — an earlier version of this
review's brief implied it did.

State confirmed on disk: project linked (`supabase/.temp/project-ref` →
`xynqxekcqizwhtskzqrq`), CLI `2.117.0` at `/c/Users/tejam/tools/supabase/supabase`,
remote Postgres `17.6.1.166`.

### Step 1 — establish what is actually pending (do not skip this)

```bash
supabase migration list
```

**This is the only thing that settles [§0.1](#01-how-the-backlog-was-established).**
Everything this document says about *which* files are pending is inference from the repo
record, last observed 2026-09-11. Compare the **Remote** column against the seventeen files
in `supabase/migrations/`.

Expect seven pending. **If the list differs from §0.1's table, trust the list** and tell
whoever is coordinating, because §0.3's "if it dies at file N" mapping shifts with it.

### Step 2 — the one pre-flight that can save the whole push

[§3.1](#31-20260910220800_create_private_storage_bucketssql) is the file most likely to
fail, it is first, and it takes everything behind it down with it. This tells you in one
second whether it will:

```sql
-- THE ONLY PRE-FLIGHT THAT CHANGES WHAT YOU DO. Migration 1 creates four policies with
-- bare `create policy` -- no IF NOT EXISTS exists for policies -- so a policy already
-- carrying one of these names makes the file raise 42710 and stops all seven migrations.
-- Expect ZERO rows. Any row here means fix the file before pushing, per the corrected
-- SQL in section 3.1.
select policyname
  from pg_policies
 where schemaname = 'storage'
   and tablename  = 'objects'
   and policyname in (
     'applyy owner reads own artifacts',
     'applyy owner writes own artifacts',
     'applyy owner updates own artifacts',
     'applyy owner deletes own artifacts'
   );

-- SAME QUESTION FOR MIGRATION 2, which also has no re-run guard. Expect zero rows.
-- A row means `alter table ... add column resume_sha256` will raise 42701.
select column_name
  from information_schema.columns
 where table_schema = 'public'
   and table_name   = 'applications'
   and column_name  = 'resume_sha256';
```

### Step 3 — capture a baseline BEFORE you apply

The `124500` bug is proof that a migration can run clean and leave you broken. A count
taken only afterwards cannot tell "seeded 18 rows" from "was already 18". Take it first.

A green push is not evidence. The `evaluation_order` bug is the proof that a migration can
run clean and leave you broken, and a count taken only *afterwards* cannot tell "seeded 18
rows" from "was already 18". **Take the numbers first and keep the output.**

```sql
-- BASELINE FOR THE WHOLE BACKLOG. Run BEFORE the push, keep the result, diff it after.
-- Each row names the migration whose effect it measures, so a number that did not move
-- points at a specific file rather than at a vague worry.
select
  -- THE DETERMINING NUMBER for migration 6 (124500). Its entire backfill is
  -- `insert ... select ... from auth.users`, so if this is 0 the backfill inserts nothing
  -- and that migration is a no-op that reports success. As of docs/PROGRESS.md:70 this
  -- was 0. If it still is, expect every count below it to stay 0 too -- and that is a
  -- PASS, not a failure. See section 1.3.
  (select count(*) from auth.users)                     as auth_users,
  -- MIGRATION 1. Expect 0 before, 2 after ('screenshots' and 'resumes'). This is the
  -- number that proves the push got past its most failure-prone file.
  (select count(*) from storage.buckets)                as storage_buckets,
  -- MIGRATION 1's policies. Expect 0 before, 4 after. Counted separately from the buckets
  -- because the bucket insert is idempotent and the policy creates are not -- they can
  -- fail independently of each other.
  (select count(*) from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname like 'applyy owner%')              as storage_policies,
  -- MIGRATION 4. Expect false before, true after: the column the new key-pool cycle
  -- logic depends on.
  (select exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'gemini_key_state'
      and column_name = 'used_in_cycle'))               as has_used_in_cycle,
  -- MIGRATION 5. Expect false before, true after.
  (select exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'search_preferences'
      and column_name = 'work_arrangements'))           as has_work_arrangements,
  -- MIGRATION 7. Expect false before, true after. The approval-gate fix.
  (select exists (select 1 from pg_trigger
    where tgrelid = 'public.applications'::regclass
      and tgname  = 'guard_status_insert'))             as has_insert_guard,
  -- The kill-switch row. claim_gemini_key() fails closed without it, which is why a
  -- missing row presents as an idle pipeline rather than an error.
  (select count(*) from public.system_settings)         as system_settings,
  (select count(*) from public.search_preferences)      as search_preferences,
  -- Expect 9 per user after the backfill. The table migration 6 is about.
  (select count(*) from public.filter_rules)            as filter_rules,
  -- Expect 20 per user.
  (select count(*) from public.gemini_key_state)        as gemini_keys;
```

### Step 4 — apply

```bash
supabase db push
```

`--dry-run` was tried on 2026-09-11 and was blocked with no local DB connection
(`.remember/today-2026-09-11.done.md:8`), so do not count on it.

**Watch which file it stops on if it stops.** The CLI prints each migration as it applies.
That filename is what [§0.3](#03-if-it-dies-partway--where-you-land) is indexed by, and it
is the difference between a safe resting place and one you should not walk away from.

### Step 5 — verify

[§5](#5-what-you-should-see-afterwards). Do not skip §5.4's red test; it is the only check
in this document that proves a control *refuses* rather than merely *exists*.

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

### 5.5 The five earlier migrations landed (files 1–5)

Re-run the §4 Step 3 baseline and diff. Specifically:

```sql
-- ONE ROW PER MIGRATION, each asserting the object that migration exists. Written as
-- booleans rather than counts because these are structural: a column either exists or it
-- does not, and there is no "partially added" state to misread.
select
  -- MIGRATION 1. Expect 2 buckets and 4 policies. If buckets is 2 and policies is 0, the
  -- insert succeeded and the policy creates did not -- impossible inside one transaction,
  -- so it would mean the file did not apply as a unit and is worth reporting.
  (select count(*) from storage.buckets
    where id in ('screenshots','resumes'))                  as buckets_expect_2,
  (select count(*) from pg_policies
    where schemaname='storage' and tablename='objects'
      and policyname like 'applyy owner%')                  as policies_expect_4,
  -- MIGRATION 2.
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='applications'
      and column_name='resume_sha256')                      as resume_sha256_expect_1,
  -- MIGRATION 3 and 5. Enum values, checked by unnesting the enum rather than by casting
  -- a literal -- a cast would ERROR if the value were missing, which is a worse signal
  -- than a row that simply does not appear.
  (select count(*) from unnest(enum_range(null::public.discovery_source)) v
    where v::text = 'linkedin_post')                        as linkedin_post_expect_1,
  (select count(*) from unnest(enum_range(null::public.employment_type)) v
    where v::text = 'apprenticeship')                       as apprenticeship_expect_1,
  -- MIGRATION 4.
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='gemini_key_state'
      and column_name='used_in_cycle')                      as used_in_cycle_expect_1,
  -- MIGRATION 5.
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='search_preferences'
      and column_name in ('work_arrangements','max_salary','compensation_types'))
                                                            as new_pref_cols_expect_3;
```

Every value should equal the number in its alias. Anything short names the file that did
not land.

---

## 6. If it half-applies

**Within one file you cannot half-apply.** The CLI wraps each migration in a transaction
(`20260910185900:5-11`), so a file either commits completely or leaves no trace and is not
recorded in the ledger.

**Across files you can, and with seven files that is the likely shape of any trouble.**
`db push` applies them in order and stops at the first failure. Earlier files are
committed; the failing one is rolled back; later ones never run.

**[§0.3](#03-if-it-dies-partway--where-you-land) maps every stopping point to the state it
leaves you in.** Read that first — it is the part indexed by the filename the CLI prints.

**Recovery:**

1. **Do not re-run blindly.** `supabase migration list` first — it tells you exactly where
   it stopped.
2. **Five of the seven are safely re-runnable** (files 3, 4, 5, 6, 7). **Files 1 and 2 are
   not** ([§3.1](#31-20260910220800_create_private_storage_bucketssql),
   [§3.2](#32-20260911114300_add_resume_sha256_to_applicationssql)) — but that only bites
   if their objects exist *without* the ledger recording them, since a failed file rolls
   back completely. §4 Step 2's pre-flight is what tells you.
3. **If the ledger and reality disagree** — a file that clearly applied but is not
   recorded, or vice versa — use `supabase migration repair --status applied <version>`
   (or `--status reverted`) to correct the ledger. **Do not** hand-edit
   `supabase_migrations.schema_migrations`.
4. **If it stopped at file 5 or 6, do not walk away.** Those are the two bad resting
   places: file 4 installed the `evaluation_order` break and file 6 is its repair. Nothing
   calls `bootstrap_user_defaults()` today so nothing is actively failing, but the fix is
   half-landed. Fix the failing file and re-push.
5. **If `124500` (file 6) itself fails**, nothing of it was written: no function
   replacement, no backfill. No cleanup needed — but you are in the state above.
6. **If `130000` (file 7) fails after the function was created but before the trigger** —
   not possible within the transaction, but if the ledger says otherwise, check §5.4's
   `pg_trigger` query. A function with no trigger is inert and harmless; just re-push.
7. **There is no undo.** No file in this backlog has a down migration and this repo does
   not write them. Reversing `130000` is
   `drop trigger guard_status_insert on public.applications;` — which reopens the hole.
   Reversing `124500`'s backfill would mean deleting seeded rows, which you should not do;
   re-running the fixed function is the forward fix.

---

## 7. What I could not determine

Stated plainly, because you are running these blind and an overconfident SAFE is worse
than an honest gap.

| # | Unresolved | Why it matters | What settles it |
|---|---|---|---|
| 1 | **Which migrations are actually applied on remote.** Last record is 2026-09-11 11:46, and everything in §0.1 is inference from the repo, not observation. | It sets the apply set, and §0.3's failure map is indexed by position. | `supabase migration list` |
| 2 | **How many rows are in `auth.users`.** `docs/PROGRESS.md:70` says zero; that note is several days old. | This single number decides whether `124500`'s backfill does anything at all. | `select count(*) from auth.users;` |
| 3 | **Whether the migration role can read `auth.users`.** I reason it can (Supabase `postgres`, plus the `20260912001500:166` precedent), but that precedent would look identical if it had returned zero rows. | A silent zero-row read makes the backfill a no-op that reports success. | §5.2 — compare against the §4 baseline. |
| 4 | **Whether a `security invoker` trigger function in the revoked `applyy_internal` schema fires for `authenticated`.** I am confident (Postgres checks `EXECUTE` at `CREATE TRIGGER`; `set_updated_at` is a live precedent in the identical shape) but I could not execute SQL. | If wrong, **every** insert into `applications` fails — a full pipeline outage. | §5.4's red test. |
| 5 | **Whether the migration role may `create policy` on `storage.objects`**, a table owned by `supabase_storage_admin`. This is Supabase's own documented pattern and `db push` uses the same `postgres` role as the SQL editor, so I expect yes — but I did not verify it. | File 1 is first; if it cannot create policies the entire push stops before anything else applies. | Push and watch. A `42501` on file 1 is this; a `42710` is a name collision instead. |

**Items 1–3 are unanswerable from any Claude session**, not just this one: the Supabase MCP
server is configured but unauthenticated, this session is non-interactive so no OAuth flow
can run, and remote authorisation is gated to you. They are **questions for you**, not
inferences I withheld.

**Confidence summary.** High that no file in the backlog corrupts data, breaks an existing
code path, or widens privilege. High that `130000`'s allowlist is correct and has no
SQL-side bypass. High that the cross-file interactions are clean, and that conclusion does
not depend on the transaction-boundary question ([§0.2](#02-crossfile-interactions--what-a-perfile-read-misses)).
**Low that `124500` will visibly change anything** — a property of the database's current
state, not of the migration. **Medium that file 1 applies cleanly**, which is the single
biggest unknown in the push.

**On the framing, deliberately under-claimed:** this document says *"we cannot see the
database"*, not *"your database is broken."* If `20260912001500` is itself unapplied — and
the repo record suggests it is — then the `evaluation_order` break that `124500` describes
as live **is not live yet**, and both files apply seconds apart in the same push with the
broken function never executing in between. Do not go looking for damage that may never
have been done.

---

## 8. Defects found

**No blocking defects across all seven. Nothing must be changed before pushing.** Every
file is correct; five of seven are fully idempotent; all are transactional.

**One real defect, in a comment that asserts a property the file does not have:**

| # | File:line | Issue | Suggested action |
|---|---|---|---|
| **1** | `20260910220800:43-45` | **Claims re-running is safe. It is not.** Four bare `create policy` statements (`:86,99,110,127`) have no re-run guard — Postgres has no `create policy if not exists`. A second run raises `42710`. The bucket insert *is* idempotent, which is what the comment is describing; the file as a whole is not. **This is the first file in the push, so a failure here stops all seven.** | Corrected SQL in [§3.1](#31-20260910220800_create_private_storage_bucketssql) — four `drop policy if exists` lines. **Do not apply it blind.** Run §4 Step 2's pre-flight; fix only if it returns rows. This is house style (`rls_policies.sql`: 17 creates, 0 drops), so fixing it properly is a repo-wide change, not a one-file one. |

**Three comment-level issues.** None changes behaviour; all could mislead a later reader,
which in this repo is how stale claims get trusted.

| # | File:line | Issue | Suggested action |
|---|---|---|---|
| 2 | `124500:177-191`, `:245-251` | The population A / B model is counterfactual — `bootstrap_user_defaults()` has never been called, so neither population exists. The SQL reaches the right action for the wrong reason, and the comment sets a false expectation of what you will see post-apply. | Amend the comment after applying, when the real state is known. **Not worth blocking on.** |
| 3 | `124500:249-251` | Cites protecting "ordering a real user deliberately tuned on the settings page"; the Filters page cannot write (`filtersStore.ts:232` upserts `is_enabled`, column is `enabled`). | Leave the behaviour. Do not let this line be cited as evidence the settings page works. |
| 4 | `130000:39-41` | Lists `scout-remote.ts:343` as a live insert site; `CLAUDE.md` §5 records it as having no production caller. | Harmless — it writes `'discovered'`, allowlisted regardless. Note only. |

**Two non-idempotent files, reported as a property rather than a defect:** files 1 and 2
cannot be re-run. That is invisible in a normal push (each migration runs once) and only
matters where the ledger and reality can diverge — a class this repo has already met
(`docs/PROGRESS.md:250-260`). §4 Step 2 is the cheap check.

**One comment-density observation:** `20260912001500` and `20260912120000` run around 0.25
comment lines per code line against the ≥1.00 this codebase holds elsewhere. Not a defect,
and not worth retrofitting. Worth noticing because `20260912001500` is also the one file in
the set that silently dropped two ruled decisions via `create or replace` — the low density
and the silent omissions are very likely the same cause.

**One operational gap, outside both files and not theirs to close:** nothing calls
`bootstrap_user_defaults()` automatically — not the web app, not a trigger on `auth.users`.
After `124500` lands, any *new* signup still gets no rows until someone invokes the RPC by
hand. Worth a ticket.

---

## Appendix — what was checked and how

Every schema claim was re-derived from the migration files in filename order. Everything
below was read, not assumed:

- **all seven pending migrations in full**, plus targeted reads across the other ten
  (enums, both guard files, and all three prior `bootstrap_user_defaults` definitions)
- repo-wide greps for: `insert into public.applications`, `security definer`,
  `force row level security`, `alter type`, `revoke`/`grant`, `ignoreDuplicates`,
  `deduped`, `bootstrap_user_defaults`, `work_arrangement`, `apprenticeship`,
  `linkedin_post`, `used_in_cycle`, `resume_sha256`, every `.rpc(` call site
- all five `applications` insert sites, read in context rather than trusted from the
  migration's own enumeration
- **a diff of the replaced `claim_gemini_key()` against its predecessor**
  (`20260909235100:284-355`), control by control — because `create or replace` swaps the
  whole body and that is exactly how this file lost two other decisions
- every top-level DDL statement in the backlog, classified for re-runnability
- `git log --diff-filter=A` on every migration, to date the apply backlog
- `20260909235000_rls_policies.sql` policy-creation style, to establish whether file 1's
  bare `create policy` is an outlier (it is not)
- `supabase/config.toml` (PostgREST exposes `public` only — `applyy_internal` is not
  reachable over the API), `supabase/.temp/` link state

**Not done:** no connection to the live database, no `supabase` command, no local Postgres,
no Docker. `pnpm install` and root `pnpm run typecheck` were deliberately avoided
(the latter rewrites `pnpm-lock.yaml`).
