# Orchestrator handoff — 2026-11-06 23:00 IST

**Resume here.** This is true as of 2026-11-06 23:01 IST. The open work is in
[2026-11-06-2300-pending-tasks.md](2026-11-06-2300-pending-tasks.md). This pair supersedes the 23:50 pair
([2026-11-05-2350-orchestrator-handoff.md](2026-11-05-2350-orchestrator-handoff.md)). Re-measure every number
before you build on it (CLAUDE.md §2: a handoff is data).

Written by orchestrator applyyy-8b, resumed as applyyy-f1. Sources: `git log d6029ec..origin/main`, the
peers' bridge files in `%TEMP%\applyyy-handoff\` (`27.md`, `7f.md`; peer 3 (fe) left no file, only its
commit `34f33c1` and a pending-list edit), and live SELECTs at 23:01.

## Progress: 71% (5 of 7 stages)

Goal: one human-approved pipeline that runs end to end for real (discovered → screened → tailored → approved →
submitted → confirmed applied → tracked). Five stages work live. **The gap is still the first real submit**,
which is now fully prepared (see P0 in the pending list). "Confirmed applied" (stage 6) stays ON HOLD by
Teja's ruling. Re-derive this when asked.

## Where things stand

- **origin/main = `34f33c1`**, and local main matches it at 23:01. Everything that was gated is pushed.
- **Uncommitted on disk (NOT abandoned, CLAUDE.md §2):** `worker/src/assist/assisted-submit.ts`,
  `worker/src/cli/assist.ts`, `worker/test/assist.test.ts`. These are peer 1's G1 + G2: robots gate and
  latest-master identity in assist. tsc is clean and 29/29 assist tests pass, but red-on-revert and the full
  vitest run are NOT done. Finish and commit (pending P1 #1). Do not revert.
- **Live counts (SELECT, 23:01):** dropped_filter 35,023 · failed 81 · scored 67 · passed_filters 60 ·
  awaiting_approval 8 · applied 5 · approved 2 · tailored 2.
- **Functions deployed tonight**, all with `--import-map`:
  - 00:30, from `acfe111`: screener, matcher, scout-ats, scout-web, auditor, job-link-intake.
  - 01:00, from `4f38458`: scout-ats, scout-web, job-link-intake.
  - 23:00, from `34f33c1`: the same six as at 00:30.
- **Web** auto-deploys on push. At 00:26 the live bundle had `5a5d9b9`, shown by the "No tailored resume on
  this row" + "The AI is busy right now" sentinels. Later web pushes (`3c2601f`, `a5f419e`, `4f38458`) are not
  sentinel-checked.

## Shipped since the 23:50 handoff (all pushed)

| SHA | What |
|---|---|
| `07df623` | K1: a kit is due again when an answer or the master is newer than it |
| `5a5d9b9` | K2: robots refusal or an unreadable form → resume-only kit (written once) |
| `3bd1cf4` `4f4d05b` | Manual apply shows the tailored resume on every card + kit-skip reasons; A1 "AI is busy" text; the badge no longer reads tailored_profile |
| `3c2601f` | A3: one source chip per distinct source |
| `aabedc8` `acfe111` | H1: an attested answer on the EXACT label answers EEO/eligibility (Teja 23:19); consent stays NEVER; W29 robots rows get kits |
| `1bf142a` | Screener: decodes `&#43;`-style numeric entities; reads bare title year ranges ("4 to 8yrs"); runbook: a bulk revive must be followed by the pre-gate sweep |
| `d6bbede` | H2: every refused required field is reported to `unanswered_questions` |
| `5336dfb` | The kill-switch.ts comment names the real repair (`applyy_internal.seed_user_defaults` as postgres) |
| `b43b13d` | Scored-leak retro SQL (19 rows) + pending-list updates |
| `fc5097f` `a5f419e` | SmartRecruiters unregistered from the scan registry and from the web catalog/selects (ruling 11-01) |
| `642b535` | CLAUDE.md §4: a docs-only push runs no CI |
| `4f38458` | Opening the Email page syncs Gmail at most once a minute |
| `34f33c1` | Greenhouse double-escaped content decoded one layer; dead `confirm_revive` refusal removed from ingest-links.yml |

## Live writes run tonight (all on Teja's yes, in the orchestrator window)

| When (IST) | What | Proof |
|---|---|---|
| 00:33 | Pre-gate sweep over passed_filters (run 42090382461) | 137 in, **90 dropped** (experience_ceiling 76, tech_gate 11, work_auth 2, tech_gate_unclassified 1; this includes Rubrik PM), 0 Gemini |
| 00:41 | Scored-leak retro, `docs/screener/2026-11-06-scored-leak-retro.sql` | 19 moved scored → dropped_filter; 19 notes; xAI 0c9fdc58 still scored |
| 00:52 | Razorpay 6b4a9e61 scored → failed (posting_closed) | status failed |
| 00:2x | Kit rebuilds for Tether 04d5c6e4 + L&T 7890ff1b (`apply-kit.yml`) | both resume-only (robots refuses arbeitnow; the peoplestrong form is unreadable) |

## Teja's rulings tonight (2026-11-06)

| Ruling | State |
|---|---|
| Senior roles leaking (BMS DS III, SE II; Cisco "8 to 12 yrs") are a bug; Data Scientist titles stay in scope | Fixed (`1bf142a`) + sweep + retro |
| Drop the 19 scored leaks; KEEP xAI 0c9fdc58 | Done. xAI is human-picked (`discovered_via` has `manual`), and the auditor skips human-picked rows, so nothing was built |
| Drop Rubrik PM c7447083 | Done (in the sweep's 90) |
| Razorpay closed → failed | Done |
| Delete the SmartRecruiters adapter file + its tests | **Not done**: peer 3 stopped first (pending P2 #1) |
| First real submit = Enterpret 30889f9e, option **B** (local headed assist.ts) | Prepared; waiting on Teja's steps (pending P0) |
| Enterpret e1456a47 (the 11-05 proof row) | Teja hand-applied it at 23:58 on 11-05; it can no longer be the proof row |
| Use the GitHub MCP | Noted. It has no workflow-dispatch or run tools, so `gh` is still needed for those |

## Traps learned tonight

- **An unscoped settings read gives a false kill-switch.** `system_settings` has TWO rows: user `0f4b24da`
  (Teja, `tejamallam00@…`, every application, system_enabled TRUE) and user `31e899ad` (0 apps,
  system_enabled FALSE, last touched 2026-09-18). Filter every user-scoped read by the row's `user_id`.
- **A status move writes TWO events:** the transition (its detail is the column snapshot, with no `source`) and a
  note (from/to NULL, carrying `p_detail`). A proof query must count `detail->>'source'` notes, not
  `source AND to_status`.
- **A bulk revive skips every insert-time gate.** The 11-05 Workday back-fill moved failed → passed_filters with
  no screen. Run the pre-gate sweep after any revive (`docs/screener/2026-11-06-bulk-revive-needs-pregate-sweep.md`).
- **`dry_count_only` on pregate-sweep prints the plan, not a count.** To pre-count, replay `firstPreGateDrop` over
  a SELECT snapshot.
- **The matcher's pre-gate reads `passed_filters` only.** For rows already at `scored`, the only way out is a
  pinned-id human retro (scored → dropped_filter is `{human}` only).
- **`apply-kit.yml` needs the FULL uuid.** A short id fails the run.
- **The kit refuses rows that are not in KIT_STATUSES** (approved, applying, needs_verification,
  blocked_needs_human). An `applied` row fails the run.
- **A worker-side change can break web CI.** `apps/web` imports worker `plan-fill.ts` and the functions registry by
  relative path, so gate the web suite before pushing such a change.

## Sessions

Peers 1 (27, worker), 2 (7f, web) and 3 (fe, functions/docs) stopped at 00:57 on Teja's "kill every session and
save the work safely". Their bridge files are `%TEMP%\applyyy-handoff\27.md` and `7f.md`. Peer 3 left no file.
At 23:00 four NEW sessions were open (applyyy-9f, -0e, -cb ×2) that this orchestrator did not brief. Check
ownership with ListAgents before assuming any of them owns work.
