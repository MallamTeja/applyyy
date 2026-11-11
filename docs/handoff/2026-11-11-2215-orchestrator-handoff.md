# Orchestrator handoff, 2026-11-11 22:15 IST

Outgoing session: fd354192. Teja asked it to hand off and retire. Run the new session in loop-engineering
mode: **act → verify → fix → re-verify**, stop and report on any classifier block, destructive step, or ruling.

## Live state at handoff (re-measure before you trust it)

- `origin/main` = `98fb4a6`. Everything up to and including it is pushed.
- Deployed today, all from clean `git archive` exports:
  - functions: tailor, auditor (old code, without the sweep), matcher, resume-assist, screener, scout-ats, job-link-intake
  - migrations: `20261111190000`
  - web: auto-deployed by Vercel
- **NOT deployed:** `98fb4a6` (email classifier). It is shared code, so redeploy `email-tracker-intake`.
- **The classifier blocks every live DB write from the agent** (`mcp__plugin_supabase_supabase__execute_sql` writes,
  "Modify Shared Resources"). Either Teja allows that permission, or Teja does the step in the UI. Never route around it.

## Pending list (Teja: "add all these to pending list and complete it")

### P1. Approval-queue re-gate sweep: written and tested, UNCOMMITTED in the working tree
- **Files (all mine; nobody else touched them):**
  - `supabase/functions/auditor/regate-queue.ts` (new)
  - `supabase/functions/auditor/regate-queue.test.ts` (new)
  - `supabase/functions/auditor/index.ts` (the `?mode=regate_queue` branch, plus its import)
  - `supabase/migrations/20261111220000_auditor_queue_regate_work_auth.sql` (new)
  - `.github/workflows/postscreen-drain.yml` (the regate call, before the count gate)
- **What it does:** each drain runs today's work-auth gate over `awaiting_approval` and `approved` rows. A foreign
  `awaiting_approval` row is dropped (auditor, `drop_reason='work_auth'`). An `approved` row is only listed as a
  `::warning::`.
- **How the DB keeps it narrow:** the migration adds `auditor` to the `awaiting_approval→dropped_filter` edge, plus the
  trigger `guard_auditor_queue_drop_work_auth_only`, which lets the auditor take that edge only with
  `drop_reason='work_auth'`.
- **Verified:**
  - `node --test supabase/functions/auditor/*.test.ts`: 12/12 pass
  - `deno check auditor/` is clean
- **Deploy order is mandatory:**
  1. Migration: `db push --linked --dry-run` must list exactly `20261111220000`; then push it.
  2. Deploy `auditor`.
  3. Commit and push the workflow, and only then.

  The reason: the drain's shape check aborts if the old auditor answers `?mode=regate_queue`, because it ignores the
  mode and audits as normal.
- **Extend it to the experience ceiling (see P3).** Teja wants these rows out too. Widen the trigger to
  `drop_reason in ('work_auth','experience_ceiling')` and `regateVerdict` to code `experience_ceiling`.
- **Done-check:** after a manual `postscreen-drain` dispatch, the log shows `regate_queue: checked=N dropped=<ids>`.
  Teja's 11 foreign rows (list below) must be gone from `awaiting_approval`. The rows that should stay are still there.

### P2. Email classifier fix `98fb4a6`: pushed, not deployed, live damage unrepaired
- **The bug:** Canonical's "Thank you for applying" receipts matched `hiring_manager_interview` 0.9, because of "panel
  interview" in the process text, and were stored as `interview_invite`.
- **The fix:** inside a receipt, only direct-invite tags count. Red on revert was proven.
- **To do:**
  1. Deploy `email-tracker-intake`.
  2. Repair the data. Teja must approve these, or do them himself:
     - `email_events` `119c17ed-8124-45fa-88bf-209b7c84c4a8` and `1b17d4a2-2b62-48e9-bc34-626cd6320ab3` are classified
       `interview_invite` and must become the receipt or unknown verdict. Read the enum first.
     - Application `8e9d58ce-7db8-481d-b9d8-a44198b1e526` (Canonical Web Frontend) was wrongly moved to `interview`;
       move it back to `applied`. Check the transition graph for a human edge, and use a compensating event, never a
       delete.
     - Application `800e8d08-34f8-4e79-8dd4-b023351c49ae` (Canonical Python Engineer) is `blocked_needs_human`, but
       Canonical's receipt proves it was submitted, so it should go to `applied` (human edge
       `blocked_needs_human→applied`).

### P3. Experience leak: Teja's 14 rows (22:10 IST, angry; "another loop holes")
- **Measured with `requiredExperienceYears`:**
  - `575da609` DXC DevOps: "Exp Needed - 8 to 14 years" → **null**. "Exp" is not in CONTEXT_BEFORE.
  - `7ba7ef22` DXC Sisense: "2-5+ years in business intelligence or data analytics" → **null**. The CONTEXT_AFTER
    `in (...)` list lacks BI/data analytics/analytics.
  - `ff10736a` Supabase: "ideally with 5+ years building" → **null**. SOFT_BEFORE skips it on purpose; Teja now calls
    it too senior, so treat "ideally N+ years" as hard when N ≥ 2.
  - `a6ec9042` Sourcegraph: "This job is an IC3" → **null**. Add a level rule: IC3+ / L4+ / "Senior" level = mid or
    senior.
  - `ce965450` Cursor: parser says **5**, but the row was queued 09-28, before the ceiling went live (11-04). This is
    exactly the re-gate gap; P1's extension fixes it.
- **The 9 "1+ year" rows** (22571d3c, 43db6d8e, 4bd46605, 61693261, c915386c, 72711ef6, dc7cfdec, 7a07b8f4, a4a74262)
  all parse to **1**. The live ceiling is `max_years 1` and the rule is `need > max`, so they pass by design.
  - Teja listed them as wrong, which implies a ceiling of **0**.
  - Changing it changes his own 11-04 ruling, so confirm with him in ONE line. Do not open a menu.
- **Approved ones need Teja to withdraw them:** 575da609, 7ba7ef22 (too senior) and 22571d3c (1+). 43db6d8e is
  blocked.
- **Fix in:** `supabase/functions/_shared/screen/required-experience.ts`. Add red-on-revert tests with these exact
  phrases. Then redeploy screener, scout-ats, matcher, auditor and job-link-intake (all bundle it).

### P4. Teja's 11 foreign rows: still in the queue (gate fixed and live in `c22d0d0`)
- **Awaiting:** 93f8e874, 40f975ed, e3cb7a26, 2de04f18, 8feb1dd5, 1a22e0e0, 0c9fdc58, a4a74262, ec3a6b39, ce30db83.
- **Approved:** 2b4e3eff (Budapest). It needs Teja's withdraw (approved→passed_filters, then reject).
- P1, once deployed, drops the 10 awaiting rows automatically.

### P5. Supabase "Software Engineer - Branching": Teja applied by hand (pasted the success screen)
- Application `442cedce-08b1-475e-9bfa-1173677d5554` is `approved` and should become `applied` (human edge
  `approved→applied`, stamp `2026-11-11 13:32:11.272647+00`).
- The write was classifier-blocked, so Teja marks it in the UI or allows the permission.

### P6. Workday: Teja's standing order (21:53 IST). He has since said "ignore above msgs" for this turn; re-confirm before building.
- **The order:** the applier logs into Workday with `tejamallam00@gmail.com`, or creates the account.
- **Today:** 53 queue rows are on Workday (43 awaiting, 10 approved). The guard in `worker/src/workday.ts` /
  `apply-one.ts:650` parks them all.
- **Constraints:**
  - Each company runs its own Workday site with its own account.
  - A new account needs email verification.
  - It must run locally via `assist.ts`; the cloud runner has a datacenter IP.
  - The password must come from a user env var (`APPLYY_WORKDAY_PASSWORD`) that Teja sets himself. Never write it into
    the repo or a memory file.
  - The password he pasted equals his email address. Security warning given; he should change it first.

### P7. Open offers (not confirmed by Teja)
- Backfill the 5-group skills rule onto the existing queue. This re-tailors rows, so warn him first and never do it
  silently.

## Gotchas learned today
- Vitest from a lowercase `c:/` cwd loads two module copies. Run it from PowerShell at `C:\...`.
- The Bash tool collapses `\\`. Write scripts with the Write tool.
- `tar` needs `cygpath -u "$TEMP"` for the export dir.
- Master v2 refuses any UPDATE (a NOT VALID check). Exclude `version <> 2` in data migrations.
