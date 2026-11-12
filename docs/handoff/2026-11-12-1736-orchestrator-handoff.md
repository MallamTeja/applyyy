# Orchestrator handoff — 2026-11-12 17:36 IST

Outgoing orch: applyyy-8e [ab7473], took control 13:02 IST. Teja is closing the IDE. Re-measure everything below
before you build on it (`git log`, `git status`, live SELECTs). The previous handoff is
[2026-11-11-2215-orchestrator-handoff.md](2026-11-11-2215-orchestrator-handoff.md).

## Shipped today (all pushed to main, CI green on every code commit)

| Commit | What | Deployed |
|---|---|---|
| 5414b39 | AI resume chat queues prompts FIFO | web (Vercel) |
| c77b31f | compact achievements/certs row (~74pt freed) | tailor, resume-assist, auditor + web |
| ab56ce2 | resume-assist tops up every master skill of a named group | resume-assist |
| 4b7e75a | every skill group = ONE full line, ≤7 skills, ≥5 groups (Teja 13:57) | tailor, resume-assist, auditor |
| 3bc52c5 | docs: resume-tailoring rules updated | — |
| 21ee3a0 | job-link-intake keeps only JobPosting JSON-LD (boilerplate fix) | job-link-intake |
| ffa32af | email tracker: owner-sent mail ≠ rejection; 4 receipt wordings | email-tracker-intake |
| c01372e | refuse a skill add that wraps its group ("all" overrides) | web |
| 9d35e04 | human-only interview→applied correction edge (migration 20261112160000) | db push |
| 2523886 | skill add on an older-master row saves at its pinned master | web |
| 232356d | Emails page Insights panel + card UX (Teja 12:41 ask) | web |
| ec40723 | tech gate rescues bare "Engineer"/"Intern"/"Analyst I Software Engineering" | screener, scout-ats, matcher, auditor, job-link-intake |
| 714a3d7 | new bullet on an older-master row: clear refusal message | web |

## Live data writes today (all Teja-approved in the orch window, all verified)

- master_profiles **v45** (14:40): removed twins "azure", "express js". **v47** (16:08): removed "LLM Applications",
  split "Tool Calling & Guardrails" → "Tool Calling" + "Guardrails". v46 was Teja's own edit. Latest = v47 (110 skills, 18 AI).
- email_events relabel (15:50): 5 owner-sent → unclassified, 9 → application_received (guarded, A=5 B=9).
- Canonical 800e8d08 + 8e9d58ce: interview → applied (human, reason tracker_misread_receipt).
- e1 also wrote master v41 at 12:39 (AuthScore project), on Teja's own approval in its window.

## IN FLIGHT — uncommitted, gates NOT confirmed by the orch

Backup of every uncommitted file: `C:\Users\tejam\applyyy-handoff-keep\2026-11-12-1736-wip\`. Peer bridge files:
`docs/handoff/2026-11-12-1736-peer-4b-wip.md`, `...-peer-a3-wip.md` (asked for at 17:36; check they exist).

1. **Workday descriptions — peer 4 (4b).** Root cause of the job drought (Teja pasted the report 17:10; 4b to re-measure):
   the Workday scout stores no description → `tech_gate_unclassified` / `missing_description` drop. ~668 Workday rows in 3 days.
   Fix: fetch `/wday/cxs/<tenant>/<site>/job/<path>` per NEW job. Files: `_shared/scout/workday-detail*`, `scout-ats/index.ts`,
   `scout-ats/workday-wiring.test.ts`, `worker/src/cli/scout.ts`, `worker/test/persist-jobs.test.ts`,
   `worker/scripts/workday-backfill-preview.ts`. Also pending from 4b: SQL to fix or deactivate 11 dead boards (Greenhouse
   Atlassian, Postman, BrowserStack, CleverTap, Yugabyte; Lever Swiggy, Rippling, Walmart, Apna; Workday PwC, Amgen),
   a recovery plan for the 668 (dropped_filter→passed is HUMAN-only, Teja 10-31; may need Teja per row or a ruling),
   then new India fresher boards (no SmartRecruiters).
2. **Hold no-description rows — peer 2 (a3).** Approved design: in `screen-batch.ts`, blank description AND (gate pass OR
   tech_gate_unclassified) → HELD (scouts insert at `discovered`, the row stays `deduped`); the screener select skips blank
   descriptions so held rows can't starve the queue. **NO age-based drop** (Teja 11-10: never drop for age). Phase 1 files:
   `screen-batch*.ts`, `screener/index.ts`, `screener/queue*.ts`, `worker/src/scout/remote-run.ts`. Phase 2 (held counters in
   scout-ats + worker scout) ONLY after 4b's commit lands: same files, write ownership.
   **Deploy order:** Workday fetch + hold must ship together or hold first; otherwise rows keep dropping as missing_description.

## Parked by Teja (do NOT start until he releases them)

`docs/handoff/2026-11-12-1305-pending-tasks.md`: 6 screener-leak parcels (location, experience, seniority/grad-year/CGPA,
closed postings, dedupe, failure-reason back-fill) + the HPE hardware-role leak. 8 human-only drops are Teja's clicks.

## Open questions for Teja

- New bullets on resumes pinned to an older master stay refused (needs a DB function for a safe 2-version write). Build it?
- Move "Observability" (Backend Engineering) next to "Monitoring" (DevOps & Cloud)? Offered, no answer.
- "Machine learning" duplicate in master: Teja named only azure/express js; ask before removing.
- Reject/re-paste MongoDB 93f8e874 (tailored on no JD) and reject Fractal 002b1d10 (source has only filler): Teja's clicks.
- Email parser doesn't strip quoted reply text (an employer reply quoting an old rejection can still read as one). Not started.

## Facts that bite

- DB region = **Sydney ap-southeast-2** (`supabase projects list`). Mumbai move is deferred by Teja; the remember summary
  saying "Mumbai migration deployed" is WRONG.
- Master versions move under you: e1 found v44 and v46 when briefs said v41/v45. Always build from `max(version)` with a CAS guard.
- Progress today: ~87% (all 7 stages ran for real; the gap is screener supply/quality). Queue intake/day: 11-09 73, 11-10 26,
  11-11 9, 11-12 4.
- Peers today: peer 1 = applyyy-30, peer 2 = applyyy-a3, peer 3 = applyyy-e1, peer 4 = applyyy-4b. jobhuntt-* sessions are another repo.
