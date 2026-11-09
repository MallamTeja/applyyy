# Plan: move the Supabase project from Sydney to Mumbai (2026-11-09)

Teja ruled YES at 22:54 IST ("7a", in the orchestrator's window). This is a PLAN. Nothing in it has run.
Peer 3 wrote it from 4 read-only recon passes (secrets/env, live DB, deploy surface, Supabase docs) at 23:00-23:05 IST.
Re-measure every count at execution time; counts here are timestamps.

**Why:** pages are slow because of round trips to Sydney, not DB work (`docs/status/2026-11-08-web-latency.md`).
- Network RTT from Hyderabad: Sydney about 265 ms, Mumbai about 30 ms (TCP connect median).
- A warm Supabase hop in the browser takes 354 ms median.
- Warm DB queries take only 8-28 ms.

---

## 0. Facts the plan rests on (with sources)

| Fact | Source |
|---|---|
| **A region cannot be moved in place.** The docs send region moves to "migrating your project". | supabase.com/docs/guides/platform/project-transfer: "cannot be used to transfer between different regions. To move your project to a different region, see migrating your project" |
| **Mumbai = `ap-south-1`.** | supabase.com/docs/guides/platform/regions |
| **"Restore to a new project" (clone) cannot be used.** It keeps the source region and is paid-plan only. | supabase.com/docs/guides/platform/clone-project: "The data will remain in the same region as the source project" |
| **The documented route is a CLI dump (roles, schema, data) restored with psql.** It needs Docker Desktop and psql. | supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore |
| **A plain `db dump` skips the auth and storage schemas.** Changes made to them (our trigger on `auth.users`, the storage RLS policies) must be restored separately. | supabase.com/docs/reference/cli/supabase-db-dump; backup-restore guide |
| **Storage FILES are not in any DB dump.** They are copied via the Storage API (the supabase-js script in the backup-restore guide). | supabase.com/docs/guides/platform/backups |
| **New project = new JWT secret.** Existing sessions die and Teja signs in again. Users and password hashes DO carry over. | self-hosting/restore-from-platform; clone-project |
| **Free plan allows 2 active free projects.** Paused projects don't count. | supabase.com/docs/guides/platform/billing-on-supabase |

### Live source shape (measured 23:02 IST, `env -u SUPABASE_ACCESS_TOKEN supabase db query --linked`)
- **Size:** DB 184 MB. Biggest tables: `jobs` 139 MB (~36k rows), `applications` 20 MB (~35.7k), `application_events` 8.4 MB (~26k).
- **Schemas:** 21 tables in `public`; 2 tables and 15 functions in `applyy_internal` (`agent_key` holds 1 row and must arrive, or every agent locks out fail-closed, CLAUDE.md §7).
- **Auth:** 2 users, both `email` provider, both with password hashes. **No Google OAuth exists**: sign-in is `signInWithPassword` only (`apps/web/src/data/useAuth.ts:171`), so there is no OAuth redirect URI to change. One custom trigger on `auth.users`: `on_auth_user_created_seed_defaults` (migration `20261008180000`).
- **Storage:** buckets `screenshots` (private, 10 MB limit, 22 objects, ~8.2 MB) and `resumes` (private, 5 MB limit, 57 objects, ~3.3 MB). Total 79 files, ~11.5 MB. 4 storage RLS policies; buckets come from migration `20260910220800`.
- **Extensions:** pgcrypto, uuid-ossp, pg_stat_statements, supabase_vault.
- **Not present, nothing to move:**
  - pg_cron (`cron.job` does not exist), pg_net and DB webhooks;
  - vault secrets (0 rows), so there is no pgsodium key to copy;
  - realtime publications (0);
  - DB functions that embed the URL or ref (0).
- **Migrations:** 66 applied, max `20261109211000`, Postgres **17** (config.toml:42). The new project must be PG 17.
- **Role settings:** anon statement_timeout 3 s; authenticated and authenticator 8 s. Check the new project's defaults match.

---

## 1. Inventory: every place the ref, URL or keys live

`OLD` = `xynqxekcqizwhtskzqrq`; `NEW` = the Mumbai ref.
**Teja-only** = a step only Teja can do (dashboard login or his own machine).

### 1a. Supabase (new project)
| Item | Action | Who |
|---|---|---|
| Project | Create in region **South Asia (Mumbai)**, Postgres 17, same org | **Teja-only:** https://supabase.com/dashboard > New project > Organization (same as OLD) > Region "South Asia (Mumbai)" > Create. Confirmation: the project page shows region `ap-south-1`. |
| Edge-function secrets (29 user-set) | `supabase secrets set --project-ref NEW --env-file <file>`. Names: `APPLYY_AGENT_KEY` (sha256 must stay `173cffbd…d9ce`), `APPLYY_APP_USER_EMAIL`, `APPLYY_APP_USER_PASSWORD`, `APPLYY_GMAIL_SYNC_SECRET`, `APPLYY_GMAIL_SYNC_URL`, `EMAIL_INTAKE_SHARED_SECRET`, `GEMINI_API_KEY_01..20`, `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL`, `GITHUB_APPLY_DISPATCH_TOKEN` | Orch can run the command. **Teja-only part:** the VALUES. `secrets list` shows digests only, so they come from Teja's copies (Windows user env, `.env`, his password manager). |
| Platform keys (`SUPABASE_URL`, `ANON`, `SERVICE_ROLE`, `DB_URL`, `JWKS`, `PUBLISHABLE`/`SECRET`) | Injected automatically per project. Nothing to set. | — |
| Auth settings: signup OFF, email confirmations OFF, JWT expiry 3600, refresh rotation ON (reuse 10 s), Site URL `https://applyyy.vercel.app` plus redirect URLs | Copy the OLD project's values. config.toml holds local values only (`localhost:5173`). | **Teja-only:** dashboard > project NEW > Authentication > Sign In / Providers (Email: "Allow new users to sign up" OFF, "Confirm email" OFF); > Authentication > URL Configuration (Site URL, Redirect URLs, copied from OLD's same page); > Authentication > Sessions. |
| API settings: exposed schemas `public`, max rows 1000 | Match OLD | **Teja-only:** dashboard > Project Settings > Data API |
| 18 edge functions | Deploy from a pinned worktree (CLAUDE.md §3) with `--project-ref NEW --use-api --import-map supabase/functions/deno.json`. `verify_jwt` comes from config.toml (5 false, 13 true). | Orch |
| `supabase/.temp/*` link files | `supabase link --project-ref NEW` (rewrites project-ref, pooler-url, linked-project.json) | Orch |

### 1b. GitHub (repo secrets; 12 workflows read them)
| Secret | Change |
|---|---|
| `SUPABASE_URL` | to `https://NEW.supabase.co`, via `gh secret set SUPABASE_URL` |
| `SUPABASE_ANON_KEY` | to NEW's anon/publishable key |
| `APPLYY_AGENT_KEY`, `APPLYY_APP_USER_EMAIL`, `APPLYY_APP_USER_PASSWORD`, `STORAGE_STATE_ENC_KEY` | Unchanged. The auth users and the `agent_key` row come across with the dump. |

### 1c. Vercel (project `applyyy`, `prj_XbvMrvMlwWlbfxTlbtGUVGCdPAAt`)
| Item | Change | Who |
|---|---|---|
| `VITE_SUPABASE_URL` in production, preview and development | NEW URL. This also feeds `api/render-job-page.ts:728-732`. | Orch via Vercel MCP `edit_project_env`, or **Teja:** vercel.com > applyyy > Settings > Environment Variables |
| `VITE_SUPABASE_ANON_KEY` in the same 3 environments | NEW key | same |
| `vercel.json:31` CSP `connect-src https://OLD.supabase.co wss://OLD.supabase.co` | Repo edit to NEW. **If missed, the browser blocks every Supabase call.** Must ship in the same deploy as the env change. | Orch (commit) |

### 1d. Repo files that hard-code OLD (one commit, shipped at cutover)
- Production paths:
  - `vercel.json:31` (CSP)
  - `supabase/functions/rls-proof/guard.ts:23` (`PRODUCTION_PROJECT_REF`; redeploy rls-proof)
  - `scripts/deploy-drift.mjs:26`
  - `apps/web/.env.example:6`
- Test paths:
  - `apps/web/.env.e2e:8`
  - `apps/web/test/support/e2eDist.ts:28,111`
  - `apps/web/test/remoteDiscoveryRetired.test.ts:56` (asserts the CSP hosts)
  - `apps/web/test/e2eSuite.test.ts:777`
  - `worker/test/e2e-runner.mjs:101,198`
  - `supabase/functions/_shared/gemini/client.test.ts:1251`
- Comments (cosmetic): `supabase/config.toml:5`, `supabase/migrations/20261102211000_capture_rls_auto_enable.sql:5` (never edit an applied migration; leave it), `supabase/tests/invariants.sql:9`.
- Docs: 25 files mention OLD (CLAUDE.md §3/§4 deploy and query commands are the ones that matter). Update CLAUDE.md §3/§4 in the cutover commit, and leave history docs as they are.
- Find them all again at execution time: `git grep -n xynqxekcqizwhtskzqrq -- ':!docs'`.

### 1e. Google Apps Script email tracker
| Item | Change | Who |
|---|---|---|
| Script property `APPLYY_INTAKE_URL` = `https://OLD.supabase.co/functions/v1/email-tracker-intake` | to `https://NEW.supabase.co/functions/v1/email-tracker-intake` | **Teja-only:** https://script.google.com > project id `10uX0idYUjZkVQs6MFDxczrdsLZooV8DwQNdeU4ak6dLD_5P_yfp9XTQg` > ⚙ Project Settings (left rail) > Script Properties > Edit script properties > `APPLYY_INTAKE_URL` > Save. This is NOT the `.gs` file in VS Code. |
| `APPLYY_INTAKE_SECRET`, `APPLYY_SYNC_SECRET` | Unchanged (the same secrets are copied to NEW) | — |

### 1f. Teja's machine (Teja-only)
- `apps/web/.env.local`: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
- Repo-root `.env`: `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
- Windows user env:
  - `SUPABASE_DB_PASSWORD` becomes NEW's DB password.
  - `APPLYY_AGENT_KEY` is unchanged.
  - `SUPABASE_ACCESS_TOKEN` is the wrong-account token and stays unset for every CLI call.
- **Not touched:** `~/.clasprc.json` and MCP configs (the supabase MCP is project-scoped by ref in its calls, so later calls pass NEW).

### 1g. Not affected (checked)
- Google OAuth: none exists.
- `cors.ts:25` (allows `applyyy.vercel.app`) and `job-link-intake/page-readers.ts:125` (`applyyy.vercel.app/api/render-job-page`) don't depend on the ref.
- pg_cron, vault, webhooks and realtime: none exist.
- No workflow deploys to Supabase.

---

## 2. Data copy method

The documented CLI dump/restore runs into the **fresh** NEW project. Do not `db push` the 66 migrations first: they seed rows and would collide with the data dump.

**Rehearse first on a LOCAL stack** (`supabase start`, Docker) with the same commands. A failed rehearsal costs nothing. `--single-transaction` plus `ON_ERROR_STOP=1` means a failed restore on NEW also leaves it empty and retryable.

```bash
# OLD connection string: Teja's pooler URL (Session pooler, port 5432), password from SUPABASE_DB_PASSWORD
OLD_DB="postgresql://postgres.xynqxekcqizwhtskzqrq:<pw>@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres"
# NEW connection string: dashboard > NEW > Connect > Session pooler (Teja copies it)
NEW_DB="postgresql://postgres.<NEW>:<pw>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres"

# 1. Dumps (documented commands). Run unset: env -u SUPABASE_ACCESS_TOKEN
supabase db dump --db-url "$OLD_DB" -f roles.sql  --role-only
supabase db dump --db-url "$OLD_DB" -f schema.sql
supabase db dump --db-url "$OLD_DB" -f data.sql   --use-copy --data-only -x "storage.buckets_vectors" -x "storage.vector_indexes"
supabase db dump --db-url "$OLD_DB" -f mig_schema.sql --schema supabase_migrations
supabase db dump --db-url "$OLD_DB" -f mig_data.sql   --schema supabase_migrations --use-copy --data-only

# 2. MEASURE the dump before trusting it (§6: assert the positive shape). Each must be present:
grep -c 'COPY "public"."jobs"' data.sql              # 1
grep -c 'COPY "auth"."users"' data.sql               # 1 (users + password hashes)
grep -c 'COPY "applyy_internal"."agent_key"' data.sql # 1 (else agents lock out)
grep -c 'COPY "storage"."buckets"' data.sql          # 1
grep -c 'CREATE SCHEMA "applyy_internal"\|CREATE SCHEMA IF NOT EXISTS "applyy_internal"' schema.sql  # >=1

# 3. Restore (documented command)
psql --single-transaction --variable ON_ERROR_STOP=1 \
  --file roles.sql --file schema.sql \
  --command 'SET session_replication_role = replica' \
  --file data.sql --dbname "$NEW_DB"
psql --single-transaction --variable ON_ERROR_STOP=1 --file mig_schema.sql --file mig_data.sql --dbname "$NEW_DB"

# 4. The auth/storage customizations the dump skips (docs: "restore them separately"):
#    the trigger on_auth_user_created_seed_defaults (migration 20261008180000) and the 4 storage policies
#    (migration 20260910220800). Generate them from OLD and apply them to NEW:
supabase db diff --linked --schema auth,storage > auth_storage.sql   # while still linked to OLD
#    READ auth_storage.sql before applying. Expected: 1 create trigger + 4 create policy, and nothing else.
psql --single-transaction --variable ON_ERROR_STOP=1 --file auth_storage.sql --dbname "$NEW_DB"

# 5. Storage FILES (79 objects, ~11.5 MB): the backup-restore guide's supabase-js script.
#    It lists buckets, recreates them, downloads and re-uploads each file. It uses readline prompts:
#    adapt it to read OLD/NEW URL + service keys from env, run it, then compare counts (section 5).
```

`<pw>` values and both service keys are secrets. Pass them through env, never on a command line that gets logged.

Revoke default privileges before the restore, per the db-dump reference ("tables inherit ALL privileges from default privileges in the target database"). Then verify with the RLS proof in section 5.

---

## 3. Cutover order and downtime window

**Writers to freeze:**
- 12 GitHub workflows (cron plus dispatch);
- 18 edge functions, invoked by those workflows and by the web;
- the Apps Script trigger, which POSTs to email-tracker-intake;
- Teja in the web app.

The DB has no internal writers: no cron, no webhooks.

**Window:** about 60-90 min. The dump, restore and checks for 184 MB plus 11.5 MB of files take about 20-30 min. The rest is redeploys and checks.
**When:** a Teja-chosen evening slot, NOT 07:00-11:00 IST. scout, apply and postscreen crons land there, and GitHub cron starts up to 2 h late.
**Approval queue:** stays intact (the data copies over). Teja doesn't approve during the window.

| # | Step | Who | Reversible? |
|---|---|---|---|
| 0 | Days before: Teja creates NEW (1a). The orch sets 29 secrets on NEW, deploys 18 functions to NEW, and rehearses the restore on a local stack. Nothing points at NEW yet. | Teja + orch | yes |
| 1 | **T-0 Freeze:** `gh workflow disable` for each of the 12 Supabase workflows. Record the list. Check none is running: `gh run list --status in_progress`. | orch | yes (`enable`) |
| 2 | Teja signs out of the web and stays off it. Apps Script: Teja pauses its trigger (script.google.com > project > ⏰ Triggers (left rail) > the trigger's ⋮ > Delete, after noting its settings), or accepts that mail arriving in the window is caught by the next Gmail sync. | **Teja-only** | yes |
| 3 | Final counts on OLD (section 5 query). Save the output. | orch | read-only |
| 4 | Dump, measure, restore, migration history, auth/storage diff, storage files (section 2). | orch | NEW only |
| 5 | Same counts on NEW. They must be **equal row for row**. Stop on any difference. | orch | read-only |
| 6 | Flip pointers: Vercel 2 vars × 3 envs; GitHub `SUPABASE_URL`/`SUPABASE_ANON_KEY`; the repo commit (vercel.json CSP + ref files + CLAUDE.md §3/§4) pushed to main, which auto-deploys Vercel with the new env; redeploy rls-proof (guard ref). | orch | yes (revert) |
| 7 | Teja-only flips: the Apps Script `APPLYY_INTAKE_URL` (1e), then re-create its trigger; local `.env.local`, `.env`, `SUPABASE_DB_PASSWORD` (1f); `supabase link --project-ref NEW` on the main tree. | **Teja** (+ orch for link) | yes |
| 8 | Sentinels (section 5). | orch | read-only |
| 9 | Unfreeze: `gh workflow enable` for each one; dispatch one `postscreen-drain` and one dry `apply.yml` and watch them go green. | orch | — |
| 10 | Keep OLD **untouched and un-paused for 7 days** (the rollback target), then Teja pauses it (dashboard > OLD > Project Settings > General > Pause project). Never delete it within 30 days. | **Teja-only** | pause is reversible |

**Quota check before step 0 (Teja-only):** OLD plus NEW must both be active for about 7 days. The free plan allows 2 active free projects across every org where Teja is Owner or Admin. If another active project exists (any org), NEW cannot be created free. Check at dashboard > All projects. The account's credit/billing state is not visible to the CLI.

---

## 4. Rollback

- **Before step 6 (no pointers flipped):** run `gh workflow enable` on the 12 workflows. OLD was never written, so rollback is complete. NEW stays as a retry target.
- **After step 6:**
  1. Revert the cutover commit (new commit, never force).
  2. Restore the Vercel and GitHub values to OLD.
  3. Teja reverts the Apps Script property.
  4. Re-enable the workflows.
- **Data written to NEW between unfreeze and rollback** would be lost on OLD. The rollback decision window is the sentinel step (8), BEFORE unfreeze (9). After unfreeze, rolling back means a reverse dump NEW→OLD with the same commands.
- Sessions: Teja signs in again after either direction (different JWT secrets).

---

## 5. Verification sentinels (each must pass; a sentinel that can pass vacuously is not one)

1. **Row counts, OLD = NEW, exact:** for every table in `public` (21) and `applyy_internal` (2), plus `auth.users` (2), `auth.identities`, `storage.buckets` (2), `storage.objects` (79), `supabase_migrations.schema_migrations` (66). Use one generated `select '<t>', count(*) from <t> union all …` run on both sides. Diff the two outputs, and assert the diff is empty AND the table count is 28 (not 0).
2. **Agent key:** `select count(*) from applyy_internal.agent_key` = 1 on NEW. Then one real keyed call succeeds: a dispatch of `run-one.yml` against NEW returns no 42501. Also the negative case: the same call without the key header gets 42501. That proves the lock is live, not vacuous.
3. **RLS:** invoke `rls-proof` on NEW (after the guard ref is updated). It must report pass.
4. **Storage:** object count 79 and total bytes (~11.5 MB) equal on both sides. One `resumes` file downloads via the web.
5. **Web is on NEW** (CLAUDE.md §4 two-sentinel rule): grep the prod JS (entry chunk plus every imported chunk) for `NEW.supabase.co` (PRESENT) and `xynqxekcqizwhtskzqrq` (ABSENT). First prove that the ABSENT sentinel is present in today's bundle. `curl -sI https://applyyy.vercel.app/` CSP header names NEW.
6. **Auth:** Teja signs in with his password on prod. The worker's app user signs in (any workflow's first step).
7. **Mail:** Teja sends himself a test mail; one new row appears via `email-tracker-intake` on NEW.
8. **The point of the move:** repeat the latency doc's probe. The warm Supabase hop should drop from about 354 ms toward the about 30 ms RTT baseline. Record it in `docs/status/`.
9. **Pipeline:** after unfreeze, one `postscreen-drain` run writes `agent_runs` rows on NEW and none on OLD (`select max(started_at) from agent_runs` on both).

---

## 6. Open questions (not answerable read-only)

- **Keys on a new project.** Docs: "legacy anon and service_role keys keep working until the end of 2026". Whether a project created today still gets legacy JWT keys, or only `sb_publishable_`/`sb_secret_`, is not documented. All 12 workflows and the web pass `SUPABASE_ANON_KEY`; a publishable key works for supabase-js sign-in. Teja checks dashboard > NEW > Project Settings > API Keys at step 0. If only new-style keys exist, test one workflow on NEW before the cutover.
- **Undocumented:** whether `db dump` includes the `vault`/`cron` schemas. It doesn't matter here: both are empty or absent.
- **Pre-existing:** `ADZUNA_APP_ID`/`ADZUNA_APP_KEY`/`JOOBLE_API_KEY` are read in code but unset on OLD. Nothing to copy.
