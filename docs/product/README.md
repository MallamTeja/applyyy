# Product docs — applyyy

_Written 2026-11-08 against 2a9ac31. HEAD moved to 2936e8c while these docs were written; some docs note that commit._

applyyy is Teja's personal, single-user job-application system.
It finds jobs, screens them, scores them, and writes a truthful one-page resume for each one.
Teja approves every application by hand. After approval a bot submits it, or the Manual apply lane gives him a kit to submit it himself.
It exists because applying by hand is slow, and mass auto-apply tools send low-quality, untruthful applications.
The goal is one pipeline that runs end to end for real: discovered, screened, tailored, approved, submitted, confirmed and tracked.

## Reading order

Read top to bottom the first time. Each line says what the doc answers.

| # | Doc | What it answers |
|---|-----|-----------------|
| 1 | [vision-and-why.md](vision-and-why.md) | What applyyy is, who it is for, the problem it solves, and its eight principles. |
| 2 | [user-journey.md](user-journey.md) | One day of use: each page, what Teja clicks, and what runs between clicks. |
| 3 | [features/job-discovery.md](features/job-discovery.md) | How jobs come in: ATS scout, remote feeds, web scout, pasted links, watchlist. |
| 4 | [features/screening.md](features/screening.md) | Which jobs are dropped at insert, and why: tech, work-auth, experience, cascade rules. |
| 5 | [features/matching-and-scoring.md](features/matching-and-scoring.md) | How the matcher scores a job with Gemini, and the score floor of 30. |
| 6 | [features/resume-tailoring.md](features/resume-tailoring.md) | How the tailor writes a resume without inventing facts, and the one-page fit. |
| 7 | [features/approval-queue.md](features/approval-queue.md) | The Approval queue page: buckets, the AI resume chat, approve and reject. |
| 8 | [features/auto-apply.md](features/auto-apply.md) | How the worker submits approved rows: triggers, caps, robots gate, circuit breaker. |
| 9 | [features/manual-apply-lane.md](features/manual-apply-lane.md) | Rows the bot cannot submit: kits, Mark applied, why declarations stay with Teja. |
| 10 | [features/answer-bank-and-settings.md](features/answer-bank-and-settings.md) | The answer bank, attestation, and the six Settings pages. |
| 11 | [features/tracking-and-email.md](features/tracking-and-email.md) | After submit: the Gmail tracker, email classes, and the Emails page. |
| 12 | [decisions-and-rulings.md](decisions-and-rulings.md) | Every dated ruling by Teja, why, and where the code enforces it. |
| 13 | [roadmap-and-open-gaps.md](roadmap-and-open-gaps.md) | What is done, in progress, next (P0 to P3) and blocked; progress %. |
| 14 | [glossary.md](glossary.md) | One line per term: statuses, agents, resume, apply and process words. |
| 15 | [history-timeline.md](history-timeline.md) | How the project grew, phase by phase, with the commits that mark each phase. |

For the code side, see [../technical/README.md](../technical/README.md).

## Open questions for Teja

The writers collected these while checking docs against code. They are grouped by topic and de-duplicated.
Each one needs your ruling. None of them was decided by the writers.

### Goal, volume and stages

1. Receipt-confirm (stage 6) is on hold. Why, and what must happen before it comes off hold? It caps progress at 86%.
2. After the first bot submit works, what is the target volume? PROJECT_PLAN.md says about 35 a day. The worker default is 3 per run.
3. After that first submit, should `APPLYY_CRON_LIVE` and `auto_apply_on_approve` be turned on? Or should each submit stay a one-row `apply.yml` dispatch?
4. PROJECT_PLAN.md constraint 16 says "don't test with real applications". Should it be reworded, now that a real bot submit is planned to prove stage 5?
5. Should PROJECT_PLAN.md stay listed as a "Living doc"? Its header marks it STALE as of 2026-11-07. Its locked decisions and constraints could move into [decisions-and-rulings.md](decisions-and-rulings.md).
6. Is applyyy strictly single-user, or is a multi-user version ever planned? The docs say single-user.
7. Nothing scores `passed_filters` rows on a schedule (you ruled drains are manual on 2026-11-05). Is that still how you want to work, or should a capped automatic drain come back?
8. Are the Phase 3 extras from 2026-09-19 (follow-up nudges, interview prep, referral queue) still part of the product, or parked?
9. The first commit is dated 2025-12-29, and real work starts 2026-09-09. Was the repo first made for something else?
10. Should the "100% Phase 1" claim (commit a8b6e02, docs/PROGRESS.md) be formally retracted in a status doc?

### Discovery and screening

11. The 24 Greenhouse watchlist rows that returned 404 on 2026-11-01, and the `tcs` row that points at Thornbury: were they disabled?
12. The Adzuna, Jooble and Workable adapters and `_shared/scout/tiers.ts` have no caller. Wire them in, or delete them?
13. Should the SmartRecruiters mentions in the `scout-ats` header be removed or marked legacy? SR is off by your 2026-11-01 robots ruling.
14. The scout measured about 16 minutes for 246 boards against a 12-minute budget. How many boards are left unpolled each run now? Measure it from `agent_runs`.
15. Nothing moves `discovered` rows through the normalizer on a schedule. Is that intended?
16. Several enabled cascade rules have an empty config (`title_blocklist`, `location_allowlist`, `employment_type`, `staleness`, `degree_mismatch`). Give them real settings, or disable them?
17. The salary gate is written and tested, but nothing calls it. Wire it into the screener, or is the "Pay band UK/US only" chip enough?
18. Should the web app list screener drops with their `drop_reason`, and offer a revive button?
19. Is the locked-remote ruling (`unlocked_or_authorized`) final? Memory marks part of it as open.
20. There are two `search_preferences` rows, and one is empty. Is it a test user, or should it be removed?
21. Should the pre-gate sweep also cover `scored` and `awaiting_approval` rows?

### Matching and resumes

22. Six rows you want scored 13 to 27 (LSEG, FIS, Barclays). Should someone measure whether the rubric under-weights skills before any rubric change? The floor stays 30 either way.
23. The matcher eval set has 3 placeholder cases, and CI does not run it. Do you want to hand-label about 20 real cases?
24. `matcher/freshness-queue.ts` is unused. Wire it in (newest jobs first) or delete it?
25. Should the score floor become a per-user setting instead of a code constant?
26. Achievements floor: memory says at least 2, code keeps every entry with at least 1 bullet. Which did you mean?
27. Trim order: code trims certifications first, then project bullets over the cap, then the weakest bullet. Memory says the opposite. Is the code order what you want?
28. "Max 2 projects" (your 2026-11-08 15:36 ruling) has no code yet. Enforce it at the tailor, the editor save and Approve?
29. Should a master resume upload refuse, or only warn, when it carries a different email from the one app email?
30. Is the tailor deployed from dc8ac5c? If yes, Tether and L&T can be re-run.

### Approval, apply and the Manual lane

31. Should the Approval queue warn or block while a bulk status move runs? Today it relies on the orchestrator telling you to stay off the page.
32. Reject moves a row to `dropped_filter`, the same status as screener drops. Do you want a separate status, such as `rejected_human`?
33. Should the unused `applying -> failed` applier edge be removed, or should the worker start using it?
34. Is there a plan for reCAPTCHA from the CI datacenter IP (for example a self-hosted runner), or do reCAPTCHA boards always go to `assist.ts` or the Manual lane?
35. Should rows known to be bot-unsuitable (Workday, robots-refused) be flagged into the Manual lane at approve time?
36. Is `dispatch-apply` with `kit_only` (2936e8c) deployed? Until it is, saving an answer does not rebuild the kit right away. May the orchestrator deploy it?
37. The 15 answers inserted by CLI on 2026-11-07 have `attested_by_human = false`. Re-save them in the browser, or keep them usable for non-gated questions only?
38. `disability_status` has no `eeo_*` key, so the worker always leaves it blank. Add `eeo_disability_status`?

### Tracking, AI and security

39. Should more ATS vendors (Lever, Ashby) confirm `applying -> applied` from receipts? Today only Greenhouse can.
40. Is the hourly Apps Script trigger still installed live? Check `select max(started_at) from agent_runs where agent='tracker'`.
41. Should `applyyRemoveTriggers` be deleted or marked legacy, so nobody undoes the hourly ruling by mistake?
42. Should `GEMINI_DEFAULT_MODEL` in code match the live `GEMINI_MODEL` secret, so deleting the secret does not switch models silently?
43. Should the dead Gemini key secrets 12 to 20 be deleted from Supabase?
44. Should something watch `gemini_usage` on a schedule, such as a daily alert?
45. The Gemini pacer works only inside one isolate. Is that acceptable?
46. A JWT holder that omits the agent-key header is treated as human. Accept this for a one-user system, or require a separate human token for approve?
47. Is Supabase leaked-password protection available on your plan, and should it be on?
48. Is `STORAGE_STATE_ENC_KEY` still needed? Nothing in `worker/src` reads it.
49. Should `http://localhost:5173` stay in the production CORS allowlist?

### Process and docs

50. Which commit rule is current: repo CLAUDE.md §2 "one commit per finished task", or the 2026-11-08 15:25 memory rule "one commit per 15 minutes, orchestrator only"? Merge them into one place.
51. Deploy authority is worded three ways. Is it a standing grant to the orchestrator (2026-10-08), or does each deploy need your yes?
52. Should each deployed edge function carry a SHA stamp, so we can tell which commit is live?
53. Should repo CLAUDE.md §1 "cap of 3 per run" say 3 is the cron default and 25 is the apply-on-approve drain?
54. Should stale code comments be fixed by a peer? Examples: "15-minute" trigger, "nine pages", "audit_failed", SmartRecruiters in the scout headers.
55. The worker e2e runner is not in CI and needs the gitignored resume PDF. Keep it local-only, add a fixture PDF, or retire it?
56. Do you want a local script that runs the same log checks as CI (tests > 0, cancelled 0)?
57. No package defines a `lint` script. Remove `pnpm run lint`, or wire a real linter?

## Related docs

- [../technical/README.md](../technical/README.md) — technical index
- [../architecture/pipeline-end-to-end.md](../architecture/pipeline-end-to-end.md)
- [../db/schema-and-status-graph.md](../db/schema-and-status-graph.md)
- [../functions/README.md](../functions/README.md) (pending)
- [../features/web-app.md](../features/web-app.md)
- [../ops/ci-and-workflows.md](../ops/ci-and-workflows.md)
