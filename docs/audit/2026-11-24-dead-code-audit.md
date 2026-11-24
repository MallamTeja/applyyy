# Dead-code audit — 2026-11-24

Read-only audit asked for by Teja 11:43 ("do we have much dead code in this large code base, obsolete features, removed features?").
Method: `git grep -w` per export across the WHOLE repo (worker/ and apps/web import function code by relative path), `supabase functions list`, `gh run list` per workflow. Nothing was edited.
Work item: **S44** in `docs/handoff/2026-11-12-1305-pending-tasks.md`.

**Size:** ~2,700 production lines dead with high confidence, plus ~1,350 test lines that cover only that code (~4,050 total). ~1,850 more lines need a ruling. All 19 function folders are deployed and every one has a caller.

## Safe to delete

| What | Lines (prod + test) | Evidence |
|---|---|---|
| `_shared/agent/` loop cluster: `loop.ts`, `port.ts`, `batch.ts`, `kill-switch.ts`, `status.ts`, `test-port.ts`, `fixtures.ts` + 4 tests. **KEEP `deadline.ts` (live)** | ~829 + ~1,050 | no importer outside the folder; e6dc3142 called it "partial agent loop scaffolding, incomplete and untested". Docs wrongly cite `kill-switch.ts` as the live switch (`PROJECT_PLAN.md:30`, `glossary.md`, `agents.md:67`); the real one is `_shared/db/gates.ts`, so fix those docs in the same commit |
| `_shared/tailor/ats-simulator.ts` + test | 463 + 133 | only its test imports it |
| `matcher/freshness-queue.ts` | 237 | zero importers; `PROJECT_PLAN.md:949,1118` wrongly says the matcher uses it |
| `_shared/tailor/validator-ats.ts` | 132 | zero importers |
| `worker/src/ats-parse-check.ts:28-144` `checkAtsReadability` + `ATS_CHECK_AGENT` (:51). **KEEP `extractPdfText` (CI e2e uses it)** | ~107 | only tests call it |
| Unused CSS: `followup.css:1-95` (5 of 6 classes), `EmailMonitoringPage.css:248-300`, `settings.css:279,1458,2157`, `DiscoveredJobsPage.css:123,232`, `base.css:392` | ~240 | class names have zero hits |
| Web exports: `companyCatalog.ts:1021-1075` `PROBED_ABSENT_COMPANIES`, `:1014` `POLLABLE_COMPANIES`, `:167-184` `NO_BOARD_FOUND_*`; `data/supabase.ts:100-124` `requireSupabase` | ~100 | zero hits |
| `_shared/interview-prep/prep-generator.ts:24` `buildFallbackPrepPack` | 55 | zero hits |
| Used only by their own tests: `useAuth.ts:66` `isSessionValid`, `keyRole.ts:86` `isBrowserSafeKey`, `classifier.ts:604` `classifyRawEmail`, `eval/gate.ts:234` `formatGateReport`, `gemini/pool.ts:86`, `validator.ts:218` `indexMasterMetrics` | ~100 | test-only importers |
| Stale comments: `worker/test/postscreen-drain-workflow.test.ts:1-2` (11-09 trigger), `packages/shared-types/src/enums.ts:345` (company cap "active") | — | contradict the 11-18 and 11-10 rulings |

## NOT dead — the audit listed these, the coordinator overruled

- `_shared/match/salary-gate.ts` + test (~361): **unwired, not dead.** S20 (Teja 11-23) orders it wired into the screener. Never delete it.
- `_shared/scout/adapters/workable.ts` (256): `ats/registry.ts:76` says "written, not yet registered". Parked on purpose; Teja decides.

## Needs a ruling

- Resume-chat Apply / "Apply all" cards (`AiEditPanel.tsx:1081,1104`, handlers ~640-900, previews `ApprovalQueuePage.tsx:1918-1960`, ~300 lines). S9i removed the Apply button, but these still render for OLD stored chats or a reply with no `applied` field (`aiEdit.ts:1845`). Measure how many stored chats still need them before cutting.
- `SUBMISSION_IMPLEMENTED = true` (`worker/src/playwright-page.ts:29`), with a false branch of ~23 lines. It is a deliberate safety guard that CLAUDE.md §1 cites. Recommend: keep.
- `supabase/snippets/`: 11 dated one-off seed and backfill files (~1,640 lines, 09-17 → 11-10). Nothing runs them, but docs cite them for reproducibility. Git history keeps them anyway, so deleting them is low risk.
- `packages/shared-types/src/tables.ts`: 6 Row types, RPC types (:1423-1590) and ~14 Insert/Update types are unused (~205 lines). The tables are live, so these may be a deliberate contract (see the memory "new table needs a Row type"). Recommend: keep.
- `DiscoveredJobsPage.tsx:883` still has a `smartrecruiters` filter option. SR is off, but old rows may carry it. Count those rows first.
- `prescreen-drain.yml` (manual, last ran 10-24) and `pregate-sweep.yml` (manual, last ran 11-07). Decide whether they are still runbooks.

## Keep (looks dead, isn't)

`rls-proof` (the canary deploy, §3); `skill-gap`, `follow-up`, `interview-prep`, `cover-letter` (called from `satellites.yml`); `email-tracker-intake` (called by the Apps Script); `postscreen-drain.yml` (manual + daily re-gate, ran 11-23); `tokens.css:280,299` dark rules (allowed exceptions); the `per_company_weekly_cap` enum value (Postgres can't drop it); the worker CLIs `resume-pages.ts`, `capture-fixture.ts`, `workday-backfill-preview.ts`. Already clean: bulk-drop, native dialogs, "Proposed N changes", SmartRecruiters adapters. All 15 workflows are active.

## Traps for whoever deletes

- CI's Deno check asserts a FILE COUNT. Update it in the same commit as any deletion under `supabase/functions/`.
- Run worker tsc + vitest and the web gate, not only the functions suite (relative-path imports).
- Before cutting a "test-only" export, name the question it answers (CLAUDE.md §6).
