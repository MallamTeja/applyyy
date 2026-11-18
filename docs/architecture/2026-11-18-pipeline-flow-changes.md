# Pipeline flow changes — 2026-11-18 (what changed, and why)

Decision record for one orchestrated evening (21:31–23:30 IST). Each entry: the old design, the new design, the
reason, and the evidence. Code commits: `5aeb07d0`, `fa315449` (+ round 3, pending at time of writing).
Living docs updated in the same commits: `pipeline-end-to-end.md`, `agents.md`, `docs/ops/ci-and-workflows.md`,
`docs/product/decisions-and-rulings.md`, `docs/product/features/{screening,matching-and-scoring,resume-tailoring}.md`.

## 1. Scouted jobs stop at "Ready to tailor" (human picks what gets tailored)

**Before (7fcc6ed, 2026-11-09):** `postscreen-drain.yml` ran matcher → tailor → auditor after every scout
(`workflow_run`) and daily. A passed job reached `awaiting_approval` within 1–10 min, so the Ready to tailor
lane was always empty.

**After:** two entry paths with different autonomy.

```
Scouts (watchlist, remote feeds, web scout)        Add a job by link (job-link-intake)
        │ screen at insert                                   │ screen
        ▼                                                    ▼
  passed_filters ── "Ready to tailor" ──┐             matcher → tailor → auditor (server-side)
        │  Teja clicks                   │                    │
        ▼  "Send through pipeline"       │                    ▼
  matcher → tailor → auditor             │             awaiting_approval
        ▼                                │
  awaiting_approval ◄────────────────────┘
```

`postscreen-drain.yml`: no `workflow_run`; the schedule runs only `auditor?mode=regate_queue` (REGATE_ONLY) and
exits before any tailoring; `workflow_dispatch` still runs the full drain on demand.

**Why:** Teja, 21:45 IST: "they don't need to directly reach approval, they need to go to ready to tailor; only
the jobs which I add through the Add job link button need to go directly to the approval queue." A pasted link is
already a human pick; a scouted job is not. Tailoring also costs Gemini calls per row.

**Guard:** `apps/web/test/postscreenDrainTriggers.test.ts` goes red if `workflow_run` returns or the scheduled
path reaches matcher/tailor.

## 2. Jobs with no description go to Ready to tailor, not a hidden hold

**Before (cb774d83, 11-14):** a scouted job with a blank description was held at `discovered`, "to be re-judged
once a scout stores the text". No code ever did that: only the normalizer reads `discovered`, and only on a manual
drain; Workday text was fetched for new rows only (max 40/run). Held rows sat there forever.

**After:** blank-description rows still pass the title, work-auth and cascade screens, then land at
`passed_filters` with a "No description" pill on the card. The single held row (Eli Lilly) was moved by the human
edge `discovered → passed_filters` (orch, 22:58).

**Why:** Teja, 21:46 IST: "no jd jobs also need to be in ready to tailor." A hold with no exit is a silent drop.

## 3. "Already applied" also matches the job board's own posting ID

**Before:** the fingerprint is company + title + location. When a board retitles a posting, a NEW job row is
created; already_applied compared fingerprints, so the retitled copy of an applied job reached the queue
(Canonical greenhouse 5150422: applied as 8e9d58ce, retitled copy 111d1ff4 in awaiting_approval).

**After:** `ScreenableJob.atsJobKey` (provider:ats_job_id) is REQUIRED, and already_applied blocks a row whose
key matches an applied / in-flight / approved-then-failed row. Rows are not merged.

**Why not re-key or merge:** 2966 posting IDs own 6262 rows; some retitles are real role changes (Keyloop
Senior → Junior) that deserve a fresh screen. The field is required, not optional, so no builder can skip it and
let the check pass vacuously (CLAUDE.md §6).

## 4. Screening reads more of the job text

- Lever: keep `lists[]` sections (heading + bullets) and `additional`, not only `descriptionPlain`. The years
  requirement lived in the bullets (Keyloop, Netomi, Egen). Headings are kept so "Requirements" stays hard and
  "Nice to have" stays soft for `required-experience.ts`.
- Jobicy: full description before the excerpt (round 3).
- Experience: "Exp Needed - 8 to 14 years" and "years in business intelligence / analytics" now trip the ceiling.
- Location: a bare "Remote" board location no longer skips the JD; "anywhere in <non-India places>" or a required
  GMT/UTC window that excludes IST drops the job. Unknown location still PASSES (Teja's 11-05 ruling).

## 5. Discovery channel set

Six channels remain: watchlist scout (worker, 10×/day), Scout Watchlist button (edge), remote feeds (daily),
web scout (button), Add a job by link. **Removed:** Bulk links (`ingest-links.yml`, `worker/ingest/`); Teja chose
"Delete it" 22:29. **Dead code removed:** adzuna/jooble adapters, `tiers.ts`, `freshness.ts` (0 importers).
**Disabled:** 9 boards failing ≥29 runs with 0 jobs (see the findings register).

## 6. Daily closed-posting check without a full scan (round 3, in progress)

`scout-ats?mode=liveness`: read the listing only for boards that hold queue rows, retire a row only with TWO
proofs (absent from a complete listing AND the posting endpoint says 404/closed), no screening, no job upserts.
An unknown mode is refused (400), not treated as a full scan. **Why two proofs:** a renamed board token makes every
posting 404; one proof would retire the whole queue.

## 7. Workday reliability (round 3, in progress)

A 429/5xx on robots.txt means "unknown, retry later": skip the board this run without counting a failure; cache
robots per host; Workday requests serial per host with a 1–2 s gap. **Why:** all Workday tenants share
`*.myworkdayjobs.com` infrastructure; 43 robots checks in one run tripped its rate limit, and the gate counted each
429 as a refusal, so 63 of 64 boards were "failing" and new Workday jobs fell from 287/day to 0. robots.txt is
still honoured: a readable Disallow still refuses.

## Operating changes

- Deploys run from a `git archive` export pinned to the pushed SHA, after CI passes on that full SHA.
- `postscreen-drain.yml` was disabled 21:50 by Teja (stop the bleed) and re-enabled 23:10 after the new trigger
  set shipped.
