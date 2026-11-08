# Edge functions reference

_Last verified against code: 2026-11-08 (2a9ac31)._

One section per directory in `supabase/functions/`. Each section says what the
function does, who calls it, which application statuses it reads and writes,
which secrets it reads (by name, never by value), and which `_shared/` modules it
imports directly.

Regenerate the function list with:

```bash
ls supabase/functions/*/index.ts
```

Regenerate one function's direct `_shared` imports with:

```bash
git grep -hoE "_shared/[a-z0-9_/.-]+" HEAD -- supabase/functions/<fn> | sort -u
```

Read the legal status edges from the live table, never from this page:

```sql
select * from application_status_transitions where from_status = '<s>';
```

Older findings for this code (bundling across `packages/`, RPC return shapes,
mutation tests) are in `supabase/functions/STREAM_NOTES.md`. That file is a
record, not a reference.

---

## 1. Rules every function follows

| Rule | Where it lives |
|---|---|
| Every function signs in as the one app user and runs under RLS. No function holds a service-role key. | `_shared/db/client.ts` |
| The caller is checked BEFORE the password sign-in (W15). A refused caller costs no password grant. | `createAuthorizedAppUserClient(req)` in `_shared/db/client.ts`; `authorizeBeforeSignIn` / `authorizeCaller` in `_shared/db/gates.ts`; pinned by `_shared/db/w15-sign-in-order.test.ts` |
| Machine agents send the `x-applyy-agent-key` header. The database tells a browser from an agent only by this header. | `_shared/db/agent-key.ts`, used by `_shared/db/client.ts` |
| Every status change goes through the `advance_application_status` RPC. | grep `advance_application_status` in each function |
| Pipeline and satellite agents stop when the kill switch is off (`system_settings.system_enabled`). A missing row reads as off. | `readKillSwitch` in `_shared/db/gates.ts` |
| Agents record each run in `agent_runs` (`running`, then a final status). | grep `from("agent_runs")` |
| CORS headers and the "uncaught throw becomes JSON" wrapper are shared. | `_shared/cors.ts` |
| Gemini calls go through one client: key pool, pacing, failover. | `_shared/gemini/client.ts`, `_shared/gemini/pool.ts` |
| Every function's gateway setting (`verify_jwt`) is pinned, so a deploy cannot flip it. | `supabase/config.toml`, `[functions.<name>]` blocks |

### Secrets shared by most functions

Names only. Values live in Supabase secrets.

| Secret | Read by | Used for |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | `_shared/db/client.ts:40-43` | The project the client talks to. Supabase provides these. |
| `APPLYY_APP_USER_EMAIL`, `APPLYY_APP_USER_PASSWORD` | `_shared/db/client.ts:55-57` | The one app-user sign-in. |
| `APPLYY_AGENT_KEY` | `_shared/db/agent-key.ts:20` | The agent header. It must match the GitHub secret and Teja's Windows user env (repo `CLAUDE.md` section 7). |
| `GEMINI_API_KEY_<NN>` | `_shared/gemini/pool.ts:40` | The key pool. Keys are found by prefix scan, so the pool works with any count. |
| `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL` | `_shared/gemini/client.ts:692,706` | The live model. The secret wins over the code default. |

In the sections below, "app-user secrets" means the first three rows, and
"Gemini secrets" means the last two rows.

### Who calls the functions

There is **no pg_cron job** that calls a function (`grep -l "cron.schedule" supabase/migrations/*.sql` finds none).
Callers are:

- the web app, through `invokeEdge` in `apps/web/src/data/edgeCall.ts`;
- GitHub Actions workflows that POST to `/functions/v1/<name>`;
- `worker/src/cli/run-one.ts` (matcher, tailor, auditor for one row; started by `.github/workflows/run-one.yml`);
- the Gmail Apps Script (only `email-tracker-intake`).

---

## 2. Pipeline agents

These move a row along the main graph:
`discovered -> deduped -> passed_filters -> scored -> tailored -> audit_clean|audit_flagged -> awaiting_approval`.
Each one takes `?limit=` and most take `?application_id=` (`_shared/http/application-id.ts`).

### normalizer

- **Purpose:** fingerprint each new posting (SHA-256) and drop duplicates.
- **Trigger:** web pipeline runner (`apps/web/src/data/pipelineRunner.ts`); `.github/workflows/prescreen-drain.yml` (manual dispatch). `verify_jwt = false`; the in-function caller check is the control.
- **Reads:** `discovered`.
- **Writes:** `deduped`, `dropped_duplicate`, or `failed`.
- **Secrets:** app-user secrets.
- **`_shared`:** `cors.ts`, `db/client.ts`, `db/gates.ts`, `http/application-id.ts`, `normalize/existing-job-lookup.ts`, `normalize/normalize-batch.ts`.

### screener

- **Purpose:** run stage 0 (tech gate) and the deterministic filter cascade. No LLM.
- **Trigger:** web pipeline runner; `prescreen-drain.yml`. `verify_jwt = false`.
- **Reads:** `deduped`.
- **Writes:** `passed_filters`, or `dropped_filter` with `drop_reason` naming the rule, or `failed`.
- **Secrets:** app-user secrets.
- **`_shared`:** `contracts/shared-types.ts`, `cors.ts`, `db/client.ts`, `db/gates.ts`, `http/application-id.ts`, `screen/context.ts`, `screen/persist-verdict.ts`, `screen/run-summary.ts`, `screen/screen-batch.ts`, `screen/supabase-queries.ts`.
- **Note:** most rows never reach the screener as `deduped`. `scout-ats` screens on insert (see below).

### matcher

- **Purpose:** score each row against the pinned master resume with Gemini. Rows under the score floor are dropped (`_shared/match/score-threshold.ts`). Before Gemini it re-runs cheap gates: tech gate, work authorization, required experience.
- **Trigger:** web pipeline runner; `postscreen-drain.yml`; `pregate-sweep.yml` (`?mode=pregate_only`, a Gemini-free sweep); `run-one.yml`; and `job-link-intake` in the background. `verify_jwt = true`.
- **Reads:** `passed_filters`.
- **Writes:** `scored`, `dropped_filter`, or `failed`.
- **Secrets:** app-user secrets, Gemini secrets.
- **`_shared`:** `agent/deadline.ts`, `contracts/shared-types.ts`, `cors.ts`, `db/client.ts`, `db/gates.ts`, `eval/gate.ts`, `gemini/client.ts`, `gemini/failure-message.ts`, `http/application-id.ts`, `match/score-threshold.ts`, `match/scorer.ts`, `pregate-config-loader.ts`, `screen/required-experience.ts`, `screen/screen-batch.ts`, `screen/tech-gate.ts`, `screen/work-auth-gate.ts`, `tailor/tailor-batch.ts`.

### tailor

- **Purpose:** rewrite the master resume for one posting with Gemini, validate every claim back to a master node, and write the result to `applications.tailored_profile`. The payload is written first, the status second.
- **Why Deno, not the worker:** `_shared/gemini/` imports `jsr:@supabase/supabase-js` and reads `Deno.env`, so the Node worker cannot import it (`tailor/index.ts` header).
- **Trigger:** web pipeline runner; `postscreen-drain.yml`; `run-one.yml`; `job-link-intake` in the background. `verify_jwt = true`.
- **Reads:** `scored`.
- **Writes:** `tailored` or `failed`.
- **Secrets:** app-user secrets, Gemini secrets.
- **`_shared`:** `agent/deadline.ts`, `contracts/shared-types.ts`, `cors.ts`, `db/client.ts`, `db/gates.ts`, `gemini/client.ts`, `gemini/failure-message.ts`, `http/application-id.ts`, `scout/liveness.ts`, `tailor/persist.ts`, `tailor/tailor-batch.ts`, `tailor/tailorer.ts`.

### auditor

- **Purpose:** run the anti-fabrication check on the tailored resume against the pinned master. Write `audit_findings`. No Gemini call.
- **Trigger:** web pipeline runner; `postscreen-drain.yml`; `run-one.yml`; `job-link-intake` in the background. `verify_jwt = false`.
- **Reads:** `tailored`, `audit_clean`, `audit_flagged` (`auditor/index.ts:226`). The last two let it finish a row that stopped half way.
- **Writes:** `audit_clean` or `audit_flagged`, then `awaiting_approval`; or `failed`.
- **Secrets:** app-user secrets.
- **`_shared`:** `audit/audit.ts`, `audit/pinned-master.ts`, `contracts/shared-types.ts`, `cors.ts`, `db/client.ts`, `db/gates.ts`, `http/application-id.ts`, `match/score-threshold.ts`, `pregate-config-loader.ts`. Also its own `auditor/pregate.ts`.

---

## 3. Discovery

### scout-ats

- **Purpose:** poll boards in `company_watchlist` through the ATS adapters, store postings in `jobs` (deduped by fingerprint), and create `applications` rows. The board fetch is robots-gated (`_shared/http/index.ts`).
- **Adapters:** Greenhouse, Lever, Ashby, Workday (`_shared/ats/registry.ts`). SmartRecruiters is deliberately absent (robots ruling 2026-11-01). Workable is written but not registered.
- **Trigger:** web, "scan" on the discovery page (`apps/web/src/data/discoveryService.ts:237`). `verify_jwt = false`; the in-function caller check is the control. The scheduled scout is the Node worker (`worker/src/cli/scout.ts`, run by `scout.yml`), which shares the same board logic but does not call this function.
- **Writes (insert):** rows are screened on insert and are born `passed_filters` or `dropped_filter`. They are born `discovered` only when the screener could not run (`scout-ats/new-applications.ts:11-15`).
- **Secrets:** app-user secrets, `APPLYY_AGENT_KEY`.
- **`_shared`:** `agent/deadline.ts`, `ats/identity.ts`, `ats/registry.ts`, `contracts/shared-types.ts`, `cors.ts`, `db/client.ts`, `http/index.ts`, `scout/feed-liveness.ts`, `scout/liveness.ts`, `scout/queue-liveness.ts`, `scout/workday-detail.ts`, `screen/context.ts`, `screen/run-summary.ts`, `screen/screen-batch.ts`, `screen/supabase-queries.ts`, `screen/tech-gate.ts`, `screen/upsert-plan.ts`.

### scout-web

- **Purpose:** ask Gemini (with web search) for Greenhouse, Lever or Ashby posting URLs, then check every URL against the live board before storing it. The LLM proposes; deterministic code decides (`scout-web/core.ts`, `scout-web/urls.ts`).
- **Trigger:** web, `apps/web/src/features/discovery/WebScoutPanel.tsx`. `verify_jwt = true`.
- **Writes (insert):** `discovered`. The normalizer and screener take the row from there.
- **Secrets:** app-user secrets, Gemini secrets.
- **`_shared`:** `ats/identity.ts`, `ats/registry.ts`, `ats/types.ts`, `contracts/shared-types.ts`, `cors.ts`, `db/client.ts`, `db/gates.ts`, `gemini/client.ts`, `gemini/failure-message.ts`, `http/concurrency.ts`, `http/index.ts`, `screen/upsert-plan.ts`.

### job-link-intake

- **Purpose:** add one job from a pasted link. Fetch the page (SSRF-guarded, pinned GET), extract the posting, run the work-authorization gate, and create or revive the row. After a 200 with `pipeline_started`, it runs matcher, then tailor, then auditor on that row in the background (`EdgeRuntime.waitUntil`), so the run survives a closed tab.
- **Contract:** POST `{ url, text? }`. Error statuses are listed in `job-link-intake/index.ts:4-8`.
- **Trigger:** web, `apps/web/src/features/discovery/AddJobLinkPanel.tsx`; `.github/workflows/ingest-links.yml` (manual dispatch, one link at a time). `verify_jwt = true`.
- **Writes:** inserts at `discovered`, then moves to `passed_filters` as `human` (a pasted link skips dedupe and filters). A pasted link can also revive an existing row at `discovered`, `deduped`, `dropped_filter` or `failed` (`REVIVE_FROM`, `job-link-intake/handler.ts:58`). A row that failed at or after approval is refused by the `guard_failed_rerun` trigger and answered as `cannot_restart`.
- **Secrets:** app-user secrets, Gemini secrets.
- **`_shared`:** `ats/registry.ts`, `ats/types.ts`, `contracts/shared-types.ts`, `cors.ts`, `db/client.ts`, `db/gates.ts`, `gemini/client.ts`, `http/errors.ts`, `http/index.ts`, `match/prompt.ts`, `normalize/fingerprint.ts`, `pipeline/row-pipeline.ts`, `scout/apply-url.ts`, `screen/context.ts`, `screen/work-auth-gate.ts`.

---

## 4. Satellites

Side artifacts. None of these changes `applications.status`. All five are run
daily by `.github/workflows/satellites.yml` (the stage list is at
`satellites.yml:70-78`).

| Function | Reads statuses | Writes | Gemini | `_shared` modules |
|---|---|---|---|---|
| `cover-letter` | `tailored`, `audit_clean`, `audit_flagged` (`cover-letter/run.ts:32`) | `applications.cover_letter` only | yes | `audit/pinned-master.ts`, `contracts/shared-types.ts`, `cors.ts`, `db/client.ts`, `db/gates.ts`, `gemini/client.ts`, `gemini/failure-message.ts` |
| `follow-up` | `applied`, older than seven days | `follow_up_nudges` (a draft for Teja to review) | yes, no template fallback | `cors.ts`, `db/client.ts`, `db/gates.ts`, `follow-up/nudge-row.ts`, `follow-up/nudge.ts` |
| `interview-prep` | `interview` | `interview_prep_packs` (skips rows that already have one) | yes | `cors.ts`, `db/client.ts`, `db/gates.ts`, `gemini/client.ts`, `gemini/failure-message.ts`, `interview-prep/prep-generator.ts`, `interview-prep/prompt.ts` |
| `referral` | `awaiting_approval`, `approved` (`referral/eligible-queue.ts`) | a referral draft in `application_events` (append-only) | yes | `contracts/shared-types.ts`, `cors.ts`, `db/client.ts`, `db/gates.ts`, `gemini/client.ts`, `gemini/failure-message.ts` |
| `skill-gap` | `applications` and `master_profiles` (no status filter in the entry point; see `skill-gap/handler.ts`) | `skill_gap_reports` | no (pure CPU) | `analytics/skill-extractor.ts`, `analytics/skill-gap.ts`, `contracts/shared-types.ts`, `cors.ts`, `db/client.ts`, `db/gates.ts` |

All five use `verify_jwt = true` and the app-user secrets. The four Gemini callers
also use the Gemini secrets. The web page
`apps/web/src/features/analytics/SkillGapPage.tsx` only reads the `skill_gap_reports` table that
`skill-gap` writes; it does not call the function.

---

## 5. User-facing helpers

### resume-assist

- **Purpose:** the AI box on the review page. It proposes resume edits as ops; the web applies them. Every proposal is validated (`_shared/tailor/validator.ts`, `_shared/audit/detector.ts`). All logic is in `resume-assist/assist.ts`; `index.ts` is wiring only.
- **Trigger:** web, `apps/web/src/features/approval/aiEdit.ts`. `verify_jwt = true`.
- **Statuses:** none written.
- **Deploy order:** the web (`aiEdit.ts`) refuses a whole answer over one unknown op kind. Ship the web consumer before this function emits a new op kind (repo `CLAUDE.md` section 3).
- **Secrets:** app-user secrets, Gemini secrets.
- **`_shared`:** `audit/detector.ts`, `cors.ts`, `db/client.ts`, `db/gates.ts`, `gemini/client.ts`, `gemini/failure-message.ts`, `tailor/jd-keywords.ts`, `tailor/prompt.ts`, `tailor/validator.ts`.

### dispatch-apply

- **Purpose:** start GitHub workflows after Teja approves a job. On every approve it dispatches `apply-kit.yml` (kits never submit). Only when `system_settings.auto_apply_on_approve` is exactly true does it also dispatch `apply.yml` as a live drain of the approved queue. A body of exactly `{"kit_only": true}` dispatches only the kit sweep (sent after an answer is saved).
- **Trigger:** web, `apps/web/src/features/approval/dispatchApply.ts` (after approve) and `apps/web/src/features/settings/answerBankStore.ts` (kit only). `verify_jwt = true`.
- **Reads:** a count of `approved` rows whose job is still live. Writes no status.
- **Responses:** 503 for an unreadable switch or a missing token; 502 when GitHub refuses (`dispatch-apply/handler.ts:18-26`).
- **Secrets:** app-user secrets, `GITHUB_APPLY_DISPATCH_TOKEN` (`dispatch-apply/handler.ts:50`).
- **`_shared`:** `cors.ts`, `db/client.ts`, `db/gates.ts`.

### gmail-sync

- **Purpose:** proxy the dashboard's "sync now" click to the Gmail Apps Script Web App, so the shared secret stays on the server. The Apps Script enforces its own 60-second cooldown.
- **Contract:** POST, user JWT. Returns `{ ok, cooldown?, details?, error? }`.
- **Trigger:** web, `apps/web/src/features/emails/emailSync.ts`. `verify_jwt = true`.
- **Statuses:** none.
- **Secrets:** app-user secrets, `APPLYY_GMAIL_SYNC_URL` (`gmail-sync/index.ts:60`), `APPLYY_GMAIL_SYNC_SECRET` (`gmail-sync/respond.ts:34`).
- **`_shared`:** `cors.ts`, `db/client.ts`, `db/gates.ts`, `intake/auth.ts`.

---

## 6. Email intake

### email-tracker-intake

- **Purpose:** the public webhook for the Gmail Apps Script. It authenticates a shared-secret header, validates the batch, classifies each email (`_shared/email/`), matches it to an application, stores it in `email_events`, and moves the status when the email proves a change.
- **Trigger:** the Apps Script only. `verify_jwt = false`, because Apps Script cannot mint a Supabase JWT (`supabase/config.toml:132-149`). The shared secret is the control.
- **Writes:** tracker edges from `applied` and later: `employer_screening`, `oa_pending`, `interview`, `offer`, `rejected` (read the exact edges from `application_status_transitions` where `'tracker' = any(...)`). Also `application_events`.
- **Secrets:** `EMAIL_INTAKE_SHARED_SECRET` (`_shared/intake/auth.ts:20`), app-user secrets.
- **`_shared`:** `contracts/shared-types.ts`, `db/client.ts`, `email/classifier.ts`, `email/parser.ts`, `intake/auth.ts`, `intake/email-contract.ts`.

---

## 7. Diagnostic

### rls-proof

- **Purpose:** a one-shot proof that RLS policies really isolate users. It signs in as two test users and checks that neither can see the other's rows. Not part of the pipeline. It never signs in as the app user.
- **Why it exists:** a broken policy looks like "the agent found no work", the same as an idle queue. Only a test from outside can tell them apart (`rls-proof/index.ts` header).
- **Trigger:** manual only. `verify_jwt = true`, and a secret header plus a target-project check (`rls-proof/guard.ts`).
- **Secrets:** `APPLYY_RLS_PROOF_SECRET`, `APPLYY_RLS_PROOF_TARGET_REF` (`rls-proof/guard.ts:16-20`), `APPLYY_RLS_TEST_A_EMAIL`, `APPLYY_RLS_TEST_A_PASSWORD`, `APPLYY_RLS_TEST_B_EMAIL`, `APPLYY_RLS_TEST_B_PASSWORD` (`rls-proof/index.ts:45-48`), `SUPABASE_URL`, `SUPABASE_ANON_KEY`.
- **`_shared`:** `intake/auth.ts`.
- **Deploy note:** it is the low-traffic function to deploy first whenever the import map changes (repo `CLAUDE.md` section 3).

---

## 8. Deploy

Only the orchestrator deploys (repo `CLAUDE.md` section 3). A peer never deploys.
Deploy from a clean worktree pinned to a SHA, because the CLI ships the working
tree, including other sessions' uncommitted edits.

```powershell
git worktree add --detach "$env:TEMP\applyyy-deploy" <sha>
# copy supabase/.temp/{project-ref,pooler-url,linked-project.json,postgres-version} into it
$env:SUPABASE_ACCESS_TOKEN = $null   # the user env var belongs to the WRONG account
supabase functions deploy <fn> --project-ref xynqxekcqizwhtskzqrq --use-api --import-map supabase/functions/deno.json
```

- `--import-map` is required. `supabase/functions/deno.json` maps the bare
  `@supabase/supabase-js`, and `--use-api` does not read `deno.json` on its own.
- `supabase/config.toml` is applied on every deploy, so each function's
  `verify_jwt` must stay pinned there.
- Order function versions by `updated_at`, never by version number.
- Ship a migration before code that calls its new parameter. Ship the strict
  reader of a new response shape before the producer.

## 9. Verify

```bash
cd supabase/functions && deno check --reload _shared/ */
```

`deno check` over zero files exits 0. Count the `Check` lines and compare with
`ls */index.ts` (repo `CLAUDE.md` section 5). Unit tests are `*.test.ts` beside
each module and run with `node --test`; `deno check` skips them.
