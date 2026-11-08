# Decisions and rulings

_Written 2026-11-08 against 2a9ac31._

## What it is

This is a dated log of the product and technical rulings Teja made for `applyyy`. Each row says what he
decided, why, and where the code enforces it today.

A "ruling" here means a decision Teja made himself, usually after an agent showed him the trade-off.
Agent-made design choices are not in this log unless Teja confirmed them.

How to read the table columns:

- **Date** is the day of the ruling (IST). A later row can replace an earlier one. The table says so when it does.
- **Where enforced** names the file that makes the rule hold in code. "Data only" means a live row
  holds the rule, but no code checks it. "Not in code yet" means the ruling is newer than the code.

## Why it exists

Agents keep "fixing" things that look like bugs but are deliberate. Examples: a resume claim Teja chose
to keep, a score floor someone wanted to remove, a robots refusal someone wanted to route around.
Each ruling was paid for once with Teja's time. This file stops it being asked again.

The rulings come from four places. Read them in this order when they disagree:

1. The code at HEAD. Code wins over any document.
2. Teja's memory files (`~/.claude/projects/c--Users-tejam-OneDrive-myproj-applyyy/memory/`, index `MEMORY.md`).
3. The repo `CLAUDE.md`.
4. Handoffs in `docs/handoff/` (newest pair: `2026-11-08-1745-*`). Older ones are in git history:
   `git log --format='%h %cs %s' -- docs/handoff/`.

## How it works: the rulings

### Stack and platform

| Date | Ruling | Why | Where enforced |
|---|---|---|---|
| 2026-09 (design phase) | Node + TypeScript everywhere. The first plan said "Python only". | Supabase Edge Functions run Deno/TypeScript only. Python could not run there. One language end to end. | `PROJECT_PLAN.md` §2 stack table; every package is TS. |
| 2026-09 (design phase) | Backend is Supabase: Postgres, Edge Functions, Auth, Storage, Realtime. Project ref `xynqxekcqizwhtskzqrq`. | The `applications.status` column *is* the workflow (database-as-queue). The dashboard reads the same table, so live tracking comes free. A framework like LangGraph would hide that state in memory. | `supabase/functions/`, `supabase/migrations/`; `PROJECT_PLAN.md` §5. |
| 2026-09 (design phase) | Frontend is React + Vite on Vercel, static only. | Vercel Hobby caps functions at 60 s. Long browser work cannot run there. | `apps/web/`; Vercel auto-deploys on push to `main`. |
| 2026-09 (design phase) | The browser worker runs on GitHub Actions + Playwright, not a local machine. Accept about 35 applications per day. | GitHub Free gives about 66 Actions minutes per day, billed per job rounded up to a minute. One batched run fits; 35 separate runs do not. The repo must stay private (it holds resume data). | `worker/src/`; `.github/workflows/apply.yml`. |
| 2026-09 (design phase) | LLM is Gemini, with a key pool: one key per Google Cloud project. | Free-tier quota is per project, so separate projects multiply capacity. | `supabase/functions/_shared/gemini/client.ts`; table `gemini_key_state`. |
| 2026-10-06 | Live model is `gemini-3.5-flash-lite`, set by the `GEMINI_MODEL` secret. A fallback model switches in after a 503. | A 503 "high demand" is per model, not per key. The flash-lite model served the full tailor prompt when the bigger model refused it. | Secrets `GEMINI_MODEL` and `GEMINI_FALLBACK_MODEL` override `GEMINI_DEFAULT_MODEL` in `_shared/gemini/client.ts` (commit `16eb099`). See the gap below. |
| 2026-10-06 | Gemini keys 12-20 disabled. | Google denied their Cloud projects (403 `PERMISSION_DENIED` on `generateContent`). | Data only: `gemini_key_state.enabled`. |
| 2026-09-10 | Email stays on Gmail via Apps Script. No automated sending at volume. | Reading, labelling and drafts are safe. Only bulk automated sending risks the account. Zoho's one advantage was already solved. | `docs/decisions/2026-09-10-gmail-continuous-read-write-vs-zoho.md`; edge function `email-tracker-intake`. |
| 2026-10-09 | No `pg_cron`. Nothing runs on a database scheduler. | Teja ruled no cron. Scheduling lives in GitHub Actions instead. | Comment in `supabase/migrations/20261009220000_reap_stale_agent_runs.sql`; schedules in `.github/workflows/*.yml`. |
| Standing (global rule) | pnpm is the only package manager. | One lockfile, no drift between npm and pnpm installs. | `package.json`: `"packageManager": "pnpm@11.25.0"` and `"preinstall": "pnpm dlx only-allow pnpm"`. |

### Identity and resume content

| Date | Ruling | Why | Where enforced |
|---|---|---|---|
| 2026-10-24 13:08 | One email on every resume and application: the app login email (the one the email tracker watches). The second, older address is retired. | A GitLab Greenhouse security code went to the old inbox. The tracker does not watch it, so the failure was invisible. | Data only: master profile v3 and later carry the one email. No code check refuses a different email (see gaps). |
| 2026-11-01 | Master v8 content rulings: keep the One-on-One "blockchain certificate verification" claim (not built yet); deploy line reads "Vercel and AWS using Docker"; keep the portfolio `.me` domain (not registered yet). | Teja heard the risk and chose these on purpose. An auditor agent would otherwise "fix" them. | Data only: live `master_profiles` (v9 and later keep them). Any new master builds on the highest version. |
| 2026-11-07 22:43 | Every resume is ONE page: the tailored one AND the one after AI-chat edits. "This is rule." | Edits like "add more skills" push a resume to page 2 silently. | Tailor: `supabase/functions/_shared/tailor/page-trim.ts` (`fitToOnePage`, fails closed with `page_overflow`). Typography ladder: `packages/resume-template/src/page-fit.ts` (`TYPOGRAPHY_LADDER`). Editor: `apps/web/src/features/approval/pageFitEdit.ts`. Worker: `worker/src/render-resume-pdf.ts` throws `ResumeNotOnePageError` when pages is not 1. Commits `41d7430`, `7a78d05`, `dc8ac5c`. |
| 2026-11-07 23:00-23:18 | How to fit one page: shrink font and spacing first, then trim. Never remove skills. Keep the floors (both educations, summary, Aczen internship at least 4 bullets, each project at least 3 bullets). The fit runs live in the editor, deterministic, no AI. If the floors cannot fit, fail closed. | Teja wants the fit visible while he edits, and predictable. | `PAGE_FIT_FLOORS` and `TRIM_ORDER` in `_shared/tailor/page-trim.ts`. Code order: `certification`, then `project_bullet_over_cap`, then `weakest_bullet`. See contradiction 1 below. |
| 2026-11-08 15:36 | At most 2 projects in a tailored resume ("never and ever"). Enforce in code at the tailor, the editor save and the submit gate, not only in the prompt. | Teja's resume policy. | Not in code yet at 2a9ac31: no project-count cap exists. `PAGE_FIT_FLOORS.minBullets.projects = 3` is bullets per project, a different rule. |

### What jobs get in

| Date | Ruling | Why | Where enforced |
|---|---|---|---|
| 2026-10-24 / 2026-10-25 | Work-auth country filter: onsite and hybrid jobs only in countries where Teja can work without a visa. Confirmed list: India, Nepal, Bhutan ("visa-free" means work, not tourist entry). | Applying to jobs that need a visa wastes Gemini spend and his review time. | `supabase/functions/_shared/screen/work-auth-gate.ts`; setting `work_authorized_countries`. |
| 2026-11-04 18:26 | Remote: keep remote that is India-tied or has no country lock ("Remote", "Anywhere"). Drop remote locked to another country ("Remote - US"). Show the choice in Settings. | Teja had assumed "remote" always meant "from India". 43 queue rows were remote locked to one foreign country. | Column `search_preferences.remote_location_policy` (default `unlocked_or_authorized`) in `supabase/migrations/20261104193000_remote_location_policy_and_experience_ceiling.sql`; the "Remote jobs" select in `apps/web/src/features/settings/SearchPreferencesPage.tsx`; commit `b93a936`. |
| 2026-11-04 | An unclear location ("2 Locations", "In-Office", blank) PASSES the gate and stays in the queue. | Unknown is not "foreign". Teja would rather see the job and decide. The fix for leaks is to fill gaps in the country map, not to drop unknowns. | `work-auth-gate.ts`: an unmapped fragment keeps the job. |
| 2026-11-04 19:00 | Drop jobs that ask for more than 1 year of experience. | Teja is early-career. The Axiad "6-8 years" job reached his manual queue before he caught it. | `supabase/functions/_shared/screen/required-experience.ts` reads the JD; `filter_rules.config.max_years` set to 1 by migration `20261104193000` and commit `9976d2c`. |
| 2026-10-05, changed 2026-11-07 22:45 | Matcher score floor: a scouted job scoring below the floor is dropped (`match_below_threshold`). Floor was 45; now **30**. Never remove it. | Teja reads "scored 42, below the floor" and agrees for senior or hardware roles. He wants leaks fixed upstream in the screener, not by removing the floor. On 2026-11-06 he first said "remove it", then reversed within 2 minutes: "keep the score". | `MATCH_ADVANCE_FLOOR = 30` in `supabase/functions/_shared/match/score-threshold.ts` (commits `25b4b5c`, `95df3f3`). A pasted link (`discovered_via` contains `manual`) is never dropped. |
| 2026-11-01 16:00 | Honor robots.txt when scouting. SmartRecruiters is OFF: never seed or re-enable an SR board. | SR's API robots.txt is `Disallow: /` for everyone but LinkedInBot. The two scouts disagreed, which is how 124 PhonePe SR jobs came in. | No SR adapter: `supabase/functions/_shared/ats/registry.ts` (test "smartrecruiters is not registered" in `adapters.test.ts`); commit `ad19be5`. |
| 2026-11-01 16:14 | A robots.txt that answers 401 means "no rules", but only for board reads. The applier stays strict. | RFC 9309 says so. Ashby answers 401 on robots.txt but 200 on its board API. The strict rule silently cut Ashby off. | `RobotsPolicy = 'strict' \| 'scouting'` in `packages/master-robots/src/gate.ts`; only `'scouting'` allows 401. |
| 2026-11-01 ~17:19 | A job link Teja PASTES skips the robots check. The SSRF guard stays. | A paste is a user-triggered fetch, not a crawl. 2 of 4 failed pastes that day were robots-only. | `supabase/functions/job-link-intake/index.ts` and `fetch-page.ts` (per-hop DNS check, private-address refusal). |
| 2026-10-31 | A pasted job link skips every filter and runs to the approval queue. | Teja finds jobs on LinkedIn and X posts that no scout sees. | `job-link-intake`; `apps/web/src/features/discovery/AddJobLinkPanel.tsx`; migration `20261031200000` (human-only edge `discovered → passed_filters`); commit `f5b3914`. |
| 2026-11-05 | A pasted job outside the work-auth countries asks Teja before it is added. The auditor re-runs the gate before a human sees a row. | Pasted links and master re-runs skipped the screener, so foreign jobs leaked. | Commits `e63f979` (intake asks) and `394d9ed` (auditor re-gate). |
| 2026-11-01 | When the master resume changes, queued rows go back to `passed_filters` through a human edge and are re-scored. Never via `dropped_filter`. | `application_events` is append-only. Routing through `dropped_filter` would write a permanent false "declined" event. | Migration `20261101173000`; `.github/workflows/postscreen-drain.yml`; commit `87fff82`. |

### Applying

| Date | Ruling | Why | Where enforced |
|---|---|---|---|
| 2026-10-09 | Submission is automatic after Teja approves a row. Teja hand-picks and approves; the bot submits. Max 3 per run, with a circuit breaker. Scheduled runs stay dry unless `APPLYY_CRON_LIVE=true`. | The goal is a pipeline that runs itself, with the human gate at approval. | `SUBMISSION_IMPLEMENTED = true` in `worker/src/playwright-page.ts`; `APPLY_MAX_SUBMITS` and `APPLYY_CRON_LIVE` in `.github/workflows/apply.yml`; commits `c557533`, `0c437e4`. |
| 2026-10-09 | A robots.txt gate runs before the apply page opens. | The applier must not visit pages the site forbids. | Commit `a3b4115`; `worker/test/apply-one-robots.test.ts`. |
| 2026-10-24 16:20 | Per-row work (like a manual-apply kit) is triggered by the system, never by an agent looping `gh workflow run`. | "The kits need to be generated automatically by system, not by you." A step that needs an agent to remember it is a manual step. | Trigger on state change plus a daily backstop: `worker/src/apply-kit.ts`, `worker/src/apply-kit-sweep.ts`, `.github/workflows/apply-kit.yml` (`cron: '0 12 * * *'`). |
| 2026-11-07 22:55 | If the bot cannot apply (Workday, robots refusal, unanswered required questions, non-ATS), the row goes to the Manual apply lane with its kit. Teja's answers there save to the answer bank, so the bank grows. The bot never ticks declarations (for example "I did not use AI") for him. | Chasing one bot-perfect row per night stalls the pipeline. | `apps/web/src/features/manual-apply/ManualApplyPage.tsx` (commit `e4ae103`); Workday refusal in `worker/src/workday.ts` (`WORKDAY_REFUSAL`). Some manual-apply files are being changed right now (uncommitted). |
| 2026-10-09 | Answers Teja saves himself are stamped `attested_by_human`. Only those may fill eligibility and EEO questions. | A machine must not answer legal questions in his name. | `supabase/migrations/20261009160000_answer_bank_attested_by_human.sql` (the server overwrites any client value). |
| 2026-11-07 23:02 | The orchestrator may run real bot submits itself, through `apply.yml` with `dry_run=false` and `apply_only_id`, for a row whose rehearsal exits 0. | `assist.ts` needs Teja's keyboard. Teja wants submits to happen without him. | Process rule. Workflow: `.github/workflows/apply.yml`. |
| 2026-11-07 / 2026-11-08 | Receipt-confirm (pipeline stage 6) is ON HOLD. | Teja's ruling in the 2026-11-08 handoff. | Not built. `docs/handoff/2026-11-08-1745-pending-tasks.md` item 14. |

### Security and UI

| Date | Ruling | Why | Where enforced |
|---|---|---|---|
| 2026-10-08 / 2026-10-09 | Machine agents must send the `x-applyy-agent-key` header. The browser does not. | Browser, edge and worker all call as the same Supabase user, so `auth.uid()` cannot tell them apart. The header is the only discriminator. | `applyy_internal.agent_key_state()` inside `advance_application_status`, `claim_applications`, `release_application_claim`, `sweep_stale_claims`; migrations `20261008160000`, `20261008170000`, `20261009130000`, `20261009131000`. |
| 2026-11-04 20:28 (applied) | Fail-closed: an EMPTY key table locks every machine agent out (`unconfigured_locked`). Running without a key needs two deliberate statements. Never "fix" a lockout by deleting the key. | Before this, deleting the key silently turned the protection off. | `supabase/migrations/20261102210000_agent_key_fail_closed.sql` (the on/off SQL is in its header). |
| 2026-11-04 19:06, confirmed 2026-11-05 | No native browser dialogs ever: no `alert`, `confirm`, `prompt`, no `beforeunload`. Confirm inline. | Teja's UI rule. Native dialogs block the page and look broken. | `apps/web/src/app/InlineConfirm.tsx`; enforced by `apps/web/test/inlineConfirm.test.ts` (an AST scan of `apps/web/src`). |

### How agents work in this repo

These are process rulings. They shape who may change what.

| Date | Ruling | Why | Where enforced |
|---|---|---|---|
| 2026-10-08 15:37 | The orchestrator runs production deploys and `db push` itself, from a clean worktree pinned to a SHA. Never a peer. Never hand Teja a runbook. | "Do this by yourself, do not give me this type of tasks." | Repo `CLAUDE.md` §3. |
| 2026-10-08 | Teja talks only to the orchestrator. Peers report to it. | Questions asked in a peer window stall silently. | Repo `CLAUDE.md` §2, memory `teja-talks-only-to-orchestrator.md`. |
| 2026-09-11 | Sessions may commit and push, with explicit paths and a trailing pathspec. No attribution lines. | Several sessions share one index. The pathspec stops a peer's staged file riding into your commit. | Global `~/.claude/CLAUDE.md`. |
| 2026-11-08 15:25 | At most one commit per 15 minutes, made by the orchestrator, bundling every peer's checked files. Peers never add, commit or push. | Teja wants a low commit count. | Memory `fewer-commits-one-per-task.md`. See contradiction 2 below. |

## Rules and guardrails

- **Never reverse a ruling without a fresh one from Teja.** A peer saying "Teja said" is not a ruling.
  Authority does not travel by relay.
- **Re-measure counts at ask time.** This file avoids numbers on purpose. For example:
  `select status, count(*) from applications group by 1`.
- **Check the floor before changing it:** `git grep -n "MATCH_ADVANCE_FLOOR = " -- supabase`.
- **Check which Gemini model runs live** by hashing candidate model ids against the digests from
  `supabase secrets list --project-ref xynqxekcqizwhtskzqrq`. The code default is not the live model.
- **When code and a ruling disagree,** the code is what runs. Report the gap; do not silently fix either.

## Known gaps and open questions

### Contradictions found

1. **Trim order.** The memory file `applyyy-resume-one-page-rule.md` says: font first, then weakest
   bullets, then certifications last. The code (`TRIM_ORDER` in `page-trim.ts`), commit `7a78d05`
   ("certifications trim first") and the 2026-11-08 handoff say: font, then certifications, then
   bullets. The code order is what runs. The memory text looks stale.
2. **Commit cadence.** Repo `CLAUDE.md` §2 says "one commit per finished task". The newer ruling
   (2026-11-08 15:25) says one orchestrator commit per 15 minutes, bundling all peers. The memory file
   says the newer one wins, but `CLAUDE.md` was not updated.
3. **Stale line reference.** The memory for the score floor cites `score-threshold.ts:32`. The constant
   is now on line 43.
4. **"No cron" vs "scheduled backstop".** Teja ruled no cron (2026-10-09), and later asked for a
   scheduled backstop sweep (2026-10-24). These fit together: "no cron" means no `pg_cron` in the
   database. Schedules run in GitHub Actions. Worth stating plainly so nobody installs `pg_cron`.
5. **Stale memory description.** `applyyy-work-auth-leaks-2026-11-04.md` says in its description "fix
   NOT approved yet", but its body (and commit `b93a936`) show it was approved and shipped.

### Gaps

- **Max 2 projects** (ruled 2026-11-08 15:36) has no code yet at 2a9ac31.
- **One email** has no code guard. A new master upload with another email would be stored without a warning.
- **Live Gemini model vs code default.** `GEMINI_DEFAULT_MODEL` is `gemini-3.8-flash`; the live secret
  was `gemini-3.5-flash-lite` (measured 2026-10-31). Request fields that work on one model can 400 on the other.
- **Agent key gap.** Anyone holding Teja's login token who omits the header is treated as human.
- **Locked-remote ruling** for pasted foreign jobs is listed as still open in memory.
- **`degree_mismatch`** filter rule has no producer.

### Open questions for Teja

- Should `CLAUDE.md` §2 be updated to the 15-minute bundled-commit rule, or does that rule apply only to tonight's run?
- Is the trim order "certifications before bullets" (as the code does) your intended order?
- Should the master upload refuse, or only warn, when it carries a different email?

## Related docs

- [Vision and why](vision-and-why.md) and [User journey](user-journey.md)
- Feature docs: [screening](features/screening.md), [matching and scoring](features/matching-and-scoring.md),
  [resume tailoring](features/resume-tailoring.md), [manual apply lane](features/manual-apply-lane.md),
  [auto apply](features/auto-apply.md), [job discovery](features/job-discovery.md)
- [Pipeline end to end](../architecture/pipeline-end-to-end.md)
- [Schema and status graph](../db/schema-and-status-graph.md)
- [Edge functions](../functions/README.md)
- [Web app](../features/web-app.md)
- [CI and workflows](../ops/ci-and-workflows.md)
- [Robots gate design](../robots/2026-09-17-robots-gate-design.md)
- [Gmail vs Zoho decision](../decisions/2026-09-10-gmail-continuous-read-write-vs-zoho.md)
