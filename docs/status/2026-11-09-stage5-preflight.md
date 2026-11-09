# Stage 5 pre-flight: first real bot submit (TrueFoundry), 2026-11-09 ~16:50 IST

Read-only checks, made before Teja approves. Everything here can be re-run. Each claim gives the command or file it came from.

**Row:** `applications.id d0a7d313-90e0-4e63-9b03-b02d84686812`, "Backend Interns", TrueFoundry, greenhouse job `5126892008`, `status=awaiting_approval`, `master_version=27`, `match_score=68`.

## Verdict

**No blocker found in anything checkable before approval.** One step can only be proven after approval: the rehearsal finding form fields in a real browser. That is step 2 of the run order.

## Pre-flight table

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Posting still open | PASS | `GET boards-api.greenhouse.io/v1/boards/truefoundry/jobs/5126892008?questions=true` returned 200, `updated_at 2026-11-06`. The scout saw it at `last_seen_at 2026-11-09 06:45 UTC`; `disappeared_at` is null. |
| 2 | URL the worker opens | PASS: rewritten to the Greenhouse embed | The stored `apply_url` is a **careerpuck.com wrapper** (`app.careerpuck.com/job-board/truefoundry/job/5126892008?gh_jid=…`). `worker/src/form-url.ts:109-141` rewrites it to `https://job-boards.greenhouse.io/embed/job_app?for=truefoundry&token=5126892008`. All three of its conditions hold. (a) Exactly 1 enabled `company_watchlist` row, slug `truefoundry`, greenhouse, `board_token=truefoundry`. (b) The API answers 200 with the same id. (c) The API's `company_name` is "TrueFoundry", equal to `jobs.company_name`; `absolute_url` also equals `apply_url`. The embed URL returns 200. |
| 3 | Form path | PASS | There is no per-ATS adapter. The generic `createPlaywrightPage` (`worker/src/cli/apply.ts:153`) handles every row. Greenhouse-specific handling keys off the URL host, which is `greenhouse.io` after the rewrite (`playwright-page.ts:189-200`). The Workday guard (`apply-one.ts:481`) does not match. |
| 4 | Robots gate (strict applier policy) | PASS | The gate checks the resolved host, `job-boards.greenhouse.io/robots.txt`: 200 `text/plain`, every rule commented out, so no rules apply. Note: `boards.greenhouse.io` has `Disallow: /embed/`, but the worker never uses that host. `app.careerpuck.com/robots.txt` has no Disallow, so it passes too if the rewrite ever falls back. |
| 5 | Required fields vs. data | PASS | The required fields are First Name, Last Name, Email, Phone and Resume/CV, with no custom questions; GDPR `requires_consent=false`. First/last come from `answer_bank` (`first_name`, `last_name` have values). Email and phone come from master v27 `identity` (`profile-answers.ts:244`): both non-empty, email = the ruled `tejamallam00@gmail.com`. The resume renders from `tailored_profile`, which is non-null (10.5 KB), so `no_resume_snapshot` cannot fire. Optional fields: LinkedIn and Website are absent from `identity` and stay blank; the cover letter is optional. |
| 6 | Open questions that would block | PASS | 0 `unanswered_questions` rows list this id in `blocked_application_ids`. |
| 7 | Resume artifact columns null | PASS (expected) | `resume_storage_path` and `resume_sha256` are null. The applier renders and uploads the resume itself, then writes both columns (`apply-one.ts:710-762`). |
| 8 | Live-run gates | PASS | `system_enabled=true`. `max_applications_per_day=35`, and 0 applications were sent in the last 24 h. `apply.yml` with `dry_run=false` plus `apply_only_id` scopes the run to this one id (`claim-loop.ts:710`). The breaker trips on an unknown outcome, a captcha or a throw. A posting-closed re-check runs right before submit (`apply-one.ts:794-805`). |
| 9 | Form fields render (0-field guard) | AFTER APPROVAL | `rehearse-assist` prints `formUrl`, the robots verdict and the field count (`rehearse-assist.ts:217-225`). 0 fields gives `no_form_fields`, so no submit. It cannot run before approval because the kit check is at `rehearse-assist.ts:160-164`. |

## Run order after Teja approves

1. Kit builds. The trigger is automatic on the status change; the scheduled sweep is the fallback.
2. `node --env-file=.env worker/src/cli/rehearse-assist.ts --id d0a7d313-90e0-4e63-9b03-b02d84686812`. Expect `formUrl` to be the job-boards embed, robots allowed and field count > 0.
3. The orchestrator runs `gh workflow run apply.yml --ref main -f dry_run=false -f apply_only_id=d0a7d313-90e0-4e63-9b03-b02d84686812`.

## Today's daily applier (run 42597739534, 2026-11-09 10:00 UTC)

- **It ran in DRY mode.** The log says `DRY_RUN=true (event schedule)` and `submission mode: DRY RUN`. The repo variable `APPLYY_CRON_LIVE` is not set; the only repo variable is `APPLYY_SATELLITES_LIVE=true`.
- **It touched one row**, `8f20a220-5682-45a5-8cda-f3bcce0dc579` (Supabase "SDK Engineer - Python", via jobicy). That is the only `approved` row. The run claimed it, logged `wouldSubmit=true blockers=0`, and released it; it is still `approved` and unclaimed.
- **Gap:** the apply-kit logged `posting_closed` for that row on 2026-11-08 12:16 UTC. The applier's dry run still reports `blockers=0`, so the dry run does not read that note. The pre-submit posting-closed re-check (`apply-one.ts:794-805`) would still run on a live attempt. This row should leave the approved queue before any drain or live cron. That decision is for the orchestrator or Teja.

## Unrelated: the jobs tombstone failure (run 42486953107)

The cause is a statement timeout, not a GitHub 504. The log reads `tombstone_dropped_jobs failed: HTTP 500 {"code":"57014",…"canceling statement due to statement timeout"}`. Fix: `scripts/jobs-tombstone.mjs` now starts at batch 250 and halves the batch on a `57014`. The bridge file and the orchestrator report have the details.
