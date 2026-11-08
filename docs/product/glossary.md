# Glossary

_Written 2026-11-08 against 2a9ac31._

## What it is

One line for every term a newcomer meets in applyyy, with the file that defines it.
The terms come from code, migrations, workflows and the team's working process.
When this page and the code disagree, the code wins. Fix this page.

## Why it exists

applyyy has many names that look alike: `screened` vs `employer_screening`, "pre-gate" vs
"pre-screen", "kit" vs "assist", "master" vs "tailored". Handoffs and briefs use these words
without explaining them. A newcomer (or a fresh agent session after `/clear`) needs one place to
look them up. Each entry points to the file that defines the term, so you can check it yourself.

## How to use it

- Find the term in the tables below. The "Defined in" column is the source of truth.
- Paths are relative to the repo root.
- Counts are not listed on purpose. Run the command in the entry to get a fresh number.

---

## 1. Application statuses

`applications.status` IS the queue. Each agent claims rows in one status, does one job and
writes the next status. There is no separate queue table.

- Defined in: `supabase/migrations/20260909234500_enums.sql` (type `application_status`).
- Allowed moves: table `application_status_transitions`, seeded in
  `supabase/migrations/20260909234900_status_transition_guard.sql` and changed by later migrations.
- Read the live edges, never assume them:
  `select * from application_status_transitions where from_status = '<status>'`.
- Live counts: `select status, count(*) from applications group by 1`.

### Happy path

| Status | Meaning | Who moves a row out of it |
|---|---|---|
| `discovered` | A scout wrote the row. Nothing has looked at it yet. Only the fallback path (`scout-web`) inserts here now. | normalizer |
| `deduped` | The normalizer checked the job is not a duplicate. | screener |
| `passed_filters` | The row passed the deterministic filters. No LLM spent yet. Scouts insert here directly (screened on insert). | matcher |
| `scored` | The matcher attached a fit score and reasoning. | tailor |
| `tailored` | The tailor wrote a tailored resume, validated against the pinned master. | auditor |
| `audit_clean` | The auditor traced every tailored line back to the master. | moves on to approval |
| `audit_flagged` | The auditor found at least one claim it could not trace. Reviewed one by one. | human |
| `awaiting_approval` | In Teja's approval queue. A durable row state, not a paused process. | human |
| `approved` | Teja said yes. The only status from which `applying` is reachable. | applier |
| `applying` | The worker started to submit. The one non-idempotent state in the system. | applier / sweeper |
| `applied` | Submission confirmed. | tracker / human |

### After applying (the employer side)

| Status | Meaning |
|---|---|
| `employer_screening` | The employer is reviewing. Renamed from the plan's `screening`, which was one letter from "screened" and meant the opposite. |
| `oa_pending` | An online assessment was sent. |
| `interview` | An interview is scheduled or done. |
| `offer` | Terminal, good. |
| `rejected` | Terminal, bad. Also feeds the "rejected recently" blocklist rule. |

### Off-ramps

| Status | Meaning | Reason column |
|---|---|---|
| `dropped_filter` | A filter rule dropped the row. | `drop_reason` |
| `dropped_duplicate` | Its fingerprint matched a job already stored. | — |
| `blocked_needs_human` | Captcha, MFA, or a question the bot cannot answer. A normal queue item, not a failure. | `block_reason` (required by a check constraint) |
| `needs_verification` | A stale `applying` lease was swept. A human must check whether the submit landed before anything else touches the row. | — |
| `failed` | An unrecoverable error. | `failure_reason` |

Special edges worth knowing:
- `discovered -> passed_filters` exists for `human` only. It is the pasted-link path
  (migration `supabase/migrations/20261031200000_human_pasted_link_reenters_passed_filters.sql`). No agent may take it.
- `blocked_needs_human -> applied` is human only: Teja finished the submit by hand.

---

## 2. Agents (the `agent_name` enum)

Every status change and every event names the agent that did it. The transition guard checks this
name, which keeps the human-only lanes closed to automation.

Defined in: `supabase/migrations/20260909234500_enums.sql` (type `agent_name`), plus values added
later with `alter type public.agent_name add value` (grep the migrations for that line).

| Agent | What it does | Code |
|---|---|---|
| `scout_ats` | Polls company boards in the watchlist through ATS adapters (Greenhouse, Lever, Ashby; SmartRecruiters adapter exists but is OFF by the robots ruling). | `supabase/functions/scout-ats/`, `worker/src/cli/scout.ts` |
| `scout_aggregator` | Discovery from feeds and web search, not one company board. | `supabase/functions/scout-web/`, `worker/src/cli/scout-remote.ts` |
| `normalizer` | Computes a job fingerprint, drops duplicates. `discovered -> deduped`. | `supabase/functions/normalizer/` |
| `screener` | Deterministic filters, no LLM. `deduped -> passed_filters` or `dropped_filter`. | `supabase/functions/screener/`, `supabase/functions/_shared/screen/` |
| `matcher` | Scores fit with Gemini. `passed_filters -> scored`. | `supabase/functions/matcher/`, `supabase/functions/_shared/match/` |
| `tailor` | Writes a tailored resume from the master. `scored -> tailored`. | `supabase/functions/tailor/`, `supabase/functions/_shared/tailor/` |
| `auditor` | Checks every tailored line traces to the master. `tailored -> audit_clean / audit_flagged`. | `supabase/functions/auditor/`, `supabase/functions/_shared/audit/` |
| `applier` | The Playwright worker that fills and submits forms. Runs on GitHub Actions, not as an edge function. | `worker/src/claim-loop.ts`, `worker/src/apply-one.ts`, `worker/src/playwright-page.ts` |
| `tracker` | Reads employer emails and moves post-apply statuses. | `supabase/functions/email-tracker-intake/`, `supabase/functions/gmail-sync/` |
| `sweeper` | Sweeps stale claims (for example `applying -> needs_verification`). | `sweep_stale_claims()` in `supabase/migrations/20260909235100_queue_and_pool_functions.sql` |
| `human` | Teja acting through the dashboard. Approvals are events too. | `apps/web/` |
| `cover_letter`, `follow_up`, `interview_prep`, `referral`, `skill_gap` | The five satellites (see below). | `supabase/functions/<name with dash>/` |
| `jobs_tombstone` | Weekly cleanup of old job bodies to stay under the database quota. | `.github/workflows/jobs-tombstone.yml` |
| `keepalive` | Keeps the free Supabase project from pausing. | `.github/workflows/keepalive.yml`, `worker/src/cli/keepalive.ts` |

Note: the DB name uses `_` (`scout_ats`), the function folder uses `-` (`scout-ats`).

---

## 3. Resume terms

| Term | Meaning | Defined in |
|---|---|---|
| Master profile / master resume | Teja's single source of truth resume, stored as versioned rows. Every tailored claim must trace back to it. | table `master_profiles` in `supabase/migrations/20260909234700_core_tables.sql`; ingest in `packages/master-ingest/` |
| Pinned master | The master version a tailored resume was built from. Advances carry it so a newer master cannot silently mix in. | `supabase/migrations/20261008130000_advance_status_expected_updated_at_and_master_version.sql` |
| Tailored profile / tailored resume | The per-job resume the tailor writes into `applications.tailored_profile`. | `supabase/functions/_shared/tailor/tailorer.ts`, `validator.ts` |
| Tailored-profile freeze | `tailored_profile` is writable only at `scored`, `audit_flagged`, `awaiting_approval`. | `supabase/migrations/20261006190000_freeze_tailored_profile_outside_review.sql` |
| Unfaithful rewording / `summary_unsupported` | Auditor flags: a bullet names a skill its master entry never used, or summary skill words are not in the master. Teja ruled 2026-11-07. | `supabase/functions/_shared/audit/detector.ts` |
| One-page rule | Every resume, tailored and after edits, must fit ONE page. Teja ruled 2026-11-07. | `supabase/functions/_shared/tailor/page-trim.ts`, `packages/resume-template/src/page-fit.ts` |
| Typography ladder / rungs | Steps of smaller font and spacing tried before cutting content. The "dense rungs" shipped in `dc8ac5c`. | `packages/resume-template/src/render-resume-html.ts`, `packages/resume-template/src/page-fit.ts` |
| `fitToOnePage` / trim order | Pure trim after the ladder: certifications first, then project bullets over cap, then weakest bullet. Skills, summary and education are never removed. | `supabase/functions/_shared/tailor/page-trim.ts` |
| `page_overflow` | The tailor fails closed when the resume still overflows after trimming. | `supabase/functions/_shared/tailor/tailorer.ts` |
| ATS panel / ATS score | The approval-page chip "ATS N% verified". Simulates an applicant-tracking keyword scan. | `supabase/functions/_shared/tailor/ats-simulator.ts`, `apps/web/src/features/approval/` |
| Resume assist / AI edit | The AI edit panel on the approval page. The browser refuses an answer with an unknown op kind. | `supabase/functions/resume-assist/`, `apps/web/src/features/approval/aiEdit.ts` |
| Attest (bullet / skill) | Teja confirms a new claim is true, so the auditor accepts it. | `apps/web/src/features/approval/attestBullet.ts`, `attestSkill.ts` |

---

## 4. Discovery and screening terms

| Term | Meaning | Defined in |
|---|---|---|
| Watchlist | The list of company boards the scout polls. | table `company_watchlist` in `supabase/migrations/20260909234800_supporting_tables.sql` |
| Board token | The company's id on an ATS (for example the slug in a Greenhouse board URL). Unique per user, provider and token. A wrong token can point at a different company (memory: tcs pointed at Thornbury). | column `company_watchlist.board_token`, same migration |
| ATS provider vs discovery source | `ats_provider` = where you APPLY. `discovery_source` = where the job was FOUND. Kept separate on purpose. | `supabase/migrations/20260909234500_enums.sql` |
| `posted_at_source` | How much to trust `jobs.posted_at`: `exact`, `derived`, or `unknown` (cold-start guard for a new board). | same enums migration |
| Fingerprint | Canonical SHA-256 of a job used to find duplicates. Unique per user. | `jobs.fingerprint` in `supabase/migrations/20260909234700_core_tables.sql`; `supabase/functions/normalizer/` |
| Filter cascade | The ordered deterministic filter rules. | `supabase/functions/_shared/filter/cascade.ts`, table `filter_rules` |
| Tech gate (stage 0) | Screener stage that drops non-tech roles before other rules. | `supabase/functions/_shared/screen/tech-gate.ts` |
| Work-auth gate | Drops jobs in countries Teja cannot work in. Unknown location passes (Teja ruled 2026-11-05). | `supabase/functions/_shared/screen/work-auth-gate.ts` (has uncommitted edits in progress) |
| Experience ceiling | Drops jobs that require more experience than Teja has. | `supabase/functions/_shared/screen/required-experience.ts` |
| Pre-gate | The matcher's Gemini-free check run before scoring, to avoid spending LLM calls. | `supabase/functions/matcher/tech-pregate.ts` |
| Pre-gate sweep | A manual workflow that runs the pre-gate (`?mode=pregate_only`) over the whole `passed_filters` backlog. | `.github/workflows/pregate-sweep.yml` |
| Pre-screen drain | Manual workflow: pages `discovered` through the normalizer, then `deduped` through the screener. | `.github/workflows/prescreen-drain.yml` |
| Post-screen drain | Manual workflow: pages `passed_filters` through matcher, `scored` through tailor, `tailored` through auditor. | `.github/workflows/postscreen-drain.yml` |
| Run one | Push ONE application through matcher, tailor, auditor on demand. | `.github/workflows/run-one.yml`, `worker/src/cli/run-one.ts` |
| Score floor | The matcher drops rows below this score. Teja ruled 2026-11-07: 30 (was 45). Never remove it. | `supabase/functions/_shared/match/score-threshold.ts` |
| Blocklist | Companies never to apply to. | table `company_blocklist`; page `apps/web/src/features/settings/BlocklistPage.tsx` |
| Search preferences | Teja's role, location and pay preferences. | table `search_preferences` |
| Pasted link / add a job by link | Teja pastes one job URL; it skips robots (user-triggered) and enters at `passed_filters` by the human edge. | `supabase/functions/job-link-intake/`, `.github/workflows/ingest-links.yml` |
| Robots gate | Reads a site's robots.txt before scouting or applying. SmartRecruiters is OFF (Disallow: /). Ashby's 401 robots counts as no rules for board reads (Teja ruled 2026-11-01). | `packages/master-robots/src/gate.ts` |
| Jobs tombstone | Weekly job-body cleanup, because the free database quota is 500 MB. | `.github/workflows/jobs-tombstone.yml` |

---

## 5. Applying terms

| Term | Meaning | Defined in |
|---|---|---|
| Dry run | The worker fills the form but does not submit. Scheduled `apply.yml` runs stay dry unless the repo variable `APPLYY_CRON_LIVE` is `true`. | `worker/src/submission-mode.ts`, `.github/workflows/apply.yml` |
| `SUBMISSION_IMPLEMENTED` | Code switch that allows real submits at all. It is `true` since `c557533`. | `worker/src/playwright-page.ts` |
| Live run / single real submit | `gh workflow run apply.yml --ref main -f dry_run=false -f apply_only_id=<uuid>` | `.github/workflows/apply.yml` |
| Apply on approve | The browser calls `dispatch-apply` after an approve. It always dispatches the kit sweep; it starts a live applier drain only if `system_settings.auto_apply_on_approve` is exactly `true`. | `supabase/functions/dispatch-apply/handler.ts`, `apps/web/src/features/approval/dispatchApply.ts` |
| Batch cap | Max submits per run: `APPLY_MAX_SUBMITS`, default 3; 25 when dispatched by apply-on-approve. | `worker/src/claim-loop.ts` (`DEFAULT_MAX_SUBMITS`), `.github/workflows/apply.yml` |
| Daily cap | Settings value `max_applications_per_day`. Fails closed if it cannot be read. | `worker/src/claim-loop.ts` |
| Circuit breaker | Stops a live run after the first submit with an unknown outcome or a captcha. Without it, one bad IP score would park the whole queue at `needs_verification`. | `worker/src/claim-loop.ts` (`breakerReason`) |
| Kill switch | `system_settings.system_enabled`. When false, agents and the worker stop between applications. | `supabase/functions/_shared/agent/kill-switch.ts`, `supabase/migrations/20260909234700_core_tables.sql` |
| Run window / run budget | The worker checks time and auth BEFORE each `approved -> applying`, never inside it. Budget is about 3000 s per run. | `worker/src/run-window.ts` |
| Claim and lease | An agent claims rows with a lease (`claimed_by`, default 900 s) instead of a status change. A stale lease is swept. | `claim_applications()` in `supabase/migrations/20260909235100_queue_and_pool_functions.sql` |
| `advance_application_status()` | The only way to change a status. Checks the transition graph and the agent key. | `supabase/migrations/20260909235100_queue_and_pool_functions.sql` and later fix migrations |
| Plan fill | Maps each form field to an answer from our data. | `worker/src/plan-fill.ts`, `worker/src/extract-fields.ts` |
| Kit (manual apply kit) | For an approved row: opens the live form, plans every field, renders a fresh resume, and writes ONE `application_events` note. It never submits and never changes status. | `worker/src/apply-kit.ts`, `worker/src/apply-kit-sweep.ts`, `.github/workflows/apply-kit.yml` |
| Manual lane / Manual apply page | Rows the bot cannot apply show "Bot can't apply: <reason>"; Teja applies by hand with the kit. Teja ruled 2026-11-07. | `apps/web/src/features/manual-apply/` (uncommitted edits in progress), `botCantApply.ts` |
| Assist / assisted submit | Local, headed submit where Teja solves the captcha. Needs his stdin. | `worker/src/cli/assist.ts`, `worker/src/assist/assisted-submit.ts` |
| Rehearse | A no-submit dress rehearsal of the assist path. Refuses Workday. | `worker/src/cli/rehearse-assist.ts`, `worker/src/assist/rehearse.ts` (uncommitted edits in progress) |
| Answer bank | Saved answers to application questions. Answers saved in the browser are marked human-attested. The bot never ticks declarations. | table `answer_bank` in `supabase/migrations/20260909234800_supporting_tables.sql`; `supabase/migrations/20261009160000_answer_bank_attested_by_human.sql`; page `apps/web/src/features/settings/AnswerBankPage.tsx` |
| Unanswered questions | One row per normalised required question the bot could not answer. One card can "block 10 applications". | `supabase/migrations/20261105230000_unanswered_questions.sql`, `apps/web/src/features/settings/UnansweredQuestions.tsx` |

---

## 6. Data and security terms

| Term | Meaning | Defined in |
|---|---|---|
| `application_events` | Append-only history of every row. A correction is a new event, never an edit. | `supabase/migrations/20260909234700_core_tables.sql` |
| `agent_runs` | One row per agent run, for health and audit. | `supabase/migrations/20260909234800_supporting_tables.sql` |
| RLS | Row-level security on every table. All functions sign in as the app user. `rls-proof` is a one-shot check. | `supabase/migrations/20260909235000_rls_policies.sql`, `supabase/functions/rls-proof/` |
| App user | The single `authenticated` Supabase user that browser, edge functions and worker all use. | `supabase/functions/_shared/db/` |
| Agent key | The `x-applyy-agent-key` header. The only way the DB can tell a machine agent from Teja's browser. Fail-closed since 2026-11-04: no key in the table locks every agent out. | `supabase/migrations/20261008160000_agent_key_header_for_machine_agents.sql`, `supabase/migrations/20261008170000_agent_key_guards_claim_and_release.sql`, `supabase/migrations/20261102210000_agent_key_fail_closed.sql` |
| Gemini key pool | A rotating set of free Gemini API keys with per-key state. | `supabase/functions/_shared/gemini/pool.ts`, table `gemini_key_state` |
| Satellites | Five daily helper agents: skill-gap, follow-up, cover-letter, interview-prep, referral. | `.github/workflows/satellites.yml` |
| Keepalive | Scheduled job that keeps the free Supabase project awake and pushes a timestamp to the `automation-keepalive` branch (Teja approved 2026-11-01). | `.github/workflows/keepalive.yml` |

---

## 7. Process terms (how agents work on this repo)

| Term | Meaning | Defined in |
|---|---|---|
| Orchestrator (orch) | The session that coordinates. It decides, briefs, commits, pushes, deploys and runs live writes. Teja talks only to it. | `CLAUDE.md` §2-§3; `~/.claude/CLAUDE.md` "Orchestrator mode" |
| Peer (peer N) | A separate Claude session doing one big task. Named by number plus short id, for example "peer 1 (b0)". Peers never deploy. | `~/.claude/CLAUDE.md` |
| Recon subagent | A read-only helper agent used to map code fast. | `CLAUDE.md` §9 |
| Brief | The engineered task message to a peer: role, goal, owned files, facts, done-check, budget. | `~/.claude/CLAUDE.md` "Orchestrator mode" |
| Write ownership | No two workers write the same file. | `~/.claude/CLAUDE.md` rule 4 |
| Handoff pair | `docs/handoff/<date>-orchestrator-handoff.md` + `<date>-pending-tasks.md`. The newest pair is the resume point. | `docs/handoff/` |
| Clean worktree deploy | Deploy from a detached worktree pinned to a SHA, never from the shared tree. | `CLAUDE.md` §3 |
| Progress % | Share of 7 stages proven live end to end (discovered, screened, tailored, approved, submitted, confirmed, tracked). Re-derive at ask time. | `CLAUDE.md` §1; newest handoff |
| Fail-open | The dominant bug here: missing data read as an answer. | `CLAUDE.md` §6 |

---

## Rules and guardrails

- Every status change goes through `advance_application_status()`. Never `update applications set status`.
- `application_events` is append-only.
- Only `human` may approve, and only `approved` can become `applying`.
- A real submit needs `dry_run=false` plus an `apply_only_id`, or the apply-on-approve switch.
- Never delete the agent key to "fix" a lockout.

## Known gaps and open questions

- Bot submit (stage 5) has never been proven live. Receipt-confirm (stage 6) is on hold by Teja's
  ruling. Source: `docs/handoff/2026-11-08-1745-orchestrator-handoff.md`.
- The repo `CLAUDE.md` §1 says "a cap of 3 per run". That is only the default. Apply-on-approve
  runs set `APPLY_MAX_SUBMITS=25` (`.github/workflows/apply.yml`).
- Commit rule drift: repo `CLAUDE.md` §2 says "one commit per finished task"; the memory file
  `fewer-commits-one-per-task.md` says (2026-11-08 15:25) one commit per 15 minutes, made by the
  orchestrator only.
- `scout-ats` still has a SmartRecruiters adapter while SmartRecruiters is off by ruling.

## Related docs

- [Pipeline end to end](../architecture/pipeline-end-to-end.md)
- [Schema and status graph](../db/schema-and-status-graph.md)
- [Edge functions](../functions/README.md)
- [Web app](../features/web-app.md)
- [CI and workflows](../ops/ci-and-workflows.md)
- [Verification traps](../verification-traps.md)
