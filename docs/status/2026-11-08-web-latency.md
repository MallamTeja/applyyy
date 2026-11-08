# Web latency: why the applyy pages are slow (2026-11-08)

Teja, 16:32 IST: "so much latency on many pages, so much load time, lag to load all the components' data".
Measured by peer 1. The database side (query plans, indexes, RLS cost) belongs to peer 2 and is marked "see peer 2".

## The answer in one line

The time goes to **round trips to a database in Sydney**, not to work in the browser. Each request costs 0.32-0.49 s.
Every page makes at least 2 rounds of requests, one waiting on the other, and the app shell starts 3-5 more on
**every** click in the sidebar. Rendering resumes and running the JavaScript cost 0.15-0.35 s in total.

## How it was measured

| What | How | Result |
|---|---|---|
| Round trip to Supabase | `curl` ×5 from Hyderabad to `https://xynqxekcqizwhtskzqrq.supabase.co/rest/v1/` (a bare 401, so no database work) | connect 0.04-0.06 s; first byte **0.32-0.49 s**. Cloudflare edge `BOM` (Mumbai); the project is in **`ap-southeast-2` (Sydney)** (`supabase projects list`) |
| Requests and sequential rounds per page | Playwright on the built `dist/` with a fake session. Every `supabase.co` call is answered locally after 400 ms (the measured round trip), so no live calls are made. Empty fixtures, so rounds that depend on rows (marked "+1 with data") don't fire in this probe | see the table below |
| Browser CPU and bundle | the same probe with 0 ms delay | a page boots and settles in **146-356 ms** |
| Resume rendering per card | Node micro-bench on 19 real stored rows (validate, rebuild, render, page fit) | **~16 ms warm / 40-46 ms cold for 18 cards**. Resumes render only when Preview is opened |
| Payload | SQL `octet_length(row_to_json(...))` over each page's exact select shape (SELECT only) | approval queue 216 KB (16 rows); applied 432 KB (104 rows, 267 KB of it `tailored_profile`); discovered 80 KB; master 18 KB |
| Bundle | `vite build` | one JS chunk, 883 KB (262 KB gzip). No route-level `lazy()` |

## Ranked causes

| # | Page | Measured cost | Cause | Evidence | Fix | Expected gain |
|---|---|---|---|---|---|---|
| 1 | every page | 0.32-0.49 s per round trip; ≥ 2 rounds per page = **≥ 0.8 s floor** | The database is in Sydney; the browser is in India | curl timings above; project region `ap-southeast-2` | Moving region needs a NEW Supabase project in `ap-south-1` (Mumbai) plus a data migration. It cannot be changed in place. **Teja's decision.** | ~0.25-0.4 s off every round, on every page |
| 2 | every page, on every sidebar click | 3-5 extra requests in 2 rounds per click (~0.8 s), racing the page's own reads | The shell (`AppShell.tsx:62-75`, deps `[pathname, …]`) re-runs `application_status_counts` and the whole Manual-apply badge loader (`manualApplyData.ts:157`: 200 kit events with jsonb `detail`, then 3 `applications` reads) on **each route change** | probe: every NAV row shows `rpc/application_status_counts` + `application_events` + 2-3 `applications` | Load counts and the badge once per session, and refresh them after a status move or on Refresh, not per pathname | -3 to -5 requests and -2 rounds per click |
| 3 | System health | **43 requests**, 3 rounds with data (~1.2 s+) | `useAgentRuns` fans out up to 2 limit-1 `agent_runs` reads per agent (`useAgentRuns.ts:149-194`) after the main read | probe: `agent_runs: 35` on one load | One read for every agent's newest run instead of 35 | 43 → ~9 requests, -1 round |
| 4 | Approval queue | 3 rounds with data (~1.2 s) + 216 KB | The master profile is read only AFTER the applications read returns (`ApprovalQueuePage.tsx:803-811`), because the pinned versions come from those rows | recon, file:line | Read the latest master in parallel with the applications; fetch an older pin only when a row needs one | -1 round (~0.4 s) |
| 5 | Applied jobs | 2 serial rounds; **~101 KB** (9 live rows; 73 KB of it `tailored_profile`) | The list select pulls `tailored_profile` (`AppliedJobsPage.tsx:77-81`). The closed card DOES use it: the "Resume from master vN" chip and the resume/no-resume branch (`appliedView.ts:320`, `AppliedJobsPage.tsx:264, :277`) | CORRECTED: my first SQL guessed the page's statuses and counted 104 rows / 432 KB; the page's real stages hold 9 rows (re-measured with its exact filter) | **Not fixed, on purpose:** ~15 KB gzipped is noise next to a 0.3 s round trip, and the fix would weaken the card's shape check. Revisit if the applied list grows past ~100 rows | — |
| 6 | Pipeline, Discovered | 1 wasted request | `application_status_counts` is called twice: by the shell and again by the page's own `useApplicationCounts` | probe: `rpc/application_status_counts: 2` | Share one counts state between the shell and the pages | -1 request |
| 7 | Manual apply | N `master_profiles` reads + 2N renders/iframes (N = rows with a resume) | `ResumePreview` is mounted inside a CLOSED `<details>` for every row (`ManualApplyPage.tsx:289-314`); React mounts children of a closed `<details>` | recon; live rows with a resume today: 26 | Mount the preview only when the `<details>` is opened | -N reads. **Peer 3's slice** (resume render) |
| 8 | Discovered | not measured (14 rows live today) | `jdPlainText` (7 regex passes over the whole description) runs in render for every card, on every keystroke (`DiscoveredJobsPage.tsx:1015`) | recon | `useMemo` per item | small today; grows with the lane |
| 9 | first visit | 262 KB gzip, one chunk | No route-level code splitting | `vite build` | `React.lazy` per route | small: the boot is already 0.15-0.35 s |
| 10 | Approval queue: batch approve | 2 serial round trips **per row** (~0.6 s), so 10 rows ≈ 6 s | The loop (`ApprovalQueuePage.tsx:1127`) confirms then advances one row at a time; `confirmFresh` (`saveTailoredEdit.ts:128`) selects `tailored_profile` only to compare `updated_at` | peer 2 | Rows concurrently (cap 4); narrow `confirmFresh` to `updated_at, status` | 10 rows: ~6 s → ~1.5 s |
| 11 | Discovered | ~1.9 MB per page; cold TOAST reads mean 249 ms, max 6.2 s | Full `jobs.description_raw` for up to 300 rows, used for a 220-character card preview | peer 2 (`pg_stat`, EXPLAIN) | A `description_preview` column (migration, peer 2), full text on expand. **Decision pending (orchestrator/Teja)** | ~-1.8 MB per page |
| 12 | Discovered, Pipeline run modal | 1 + ~5 extra round trips | An exact count per lane and ~5 exact HEAD counts, though `application_status_counts()` already holds the numbers | peer 2 + recon | Read from the counts RPC | -1 to -5 round trips |
| DB | all | queries take 8-28 ms warm (EXPLAIN ANALYZE as the authenticated user) | **The database is fast; the network is slow.** An index on `applications.status` cannot help: `enum_eq` is not leakproof, so under RLS the status filter never becomes an index condition | peer 2: `docs/status/2026-11-08-web-latency-db.md` | Fewer serial round trips (this doc); optionally security-definer RPCs that bundle a page's reads into one call (a migration, peer 2) | ~0.3 s per round trip removed |

Not a cause: resume rendering on page load (#7 aside). The CPU bench measured it at 16-46 ms for a whole queue.

## Fixed so far

Filled in as each fix lands, with before/after numbers from the same probe.

Probe note: the first probe (`scratchpad/lat/measure.mjs`) sent `content-range` without
`access-control-expose-headers`. The browser then hides counts, so any count-based path looks worse than in
production. After-numbers use the corrected copy (`scratchpad/measure-fixtures.mjs`, which adds the header and
table-backed `agent_runs` fixtures).

| # | Fix | Files | Before → after | Proof |
|---|---|---|---|---|
| 3 | System health: the newest run / success for agents beyond the 200-row window is answered by ONE `.in('agent', owed)` read. "Never ran" is reported only when the page provably holds every matching row (rows = exact count); otherwise per-agent reads for just the open agents (CLAUDE.md §6) | `apps/web/src/data/useAgentRuns.ts`, `apps/web/test/agentRunsBeyondWindow.test.ts` | `agent_runs` requests: empty window 35 → 2; partial window 33 → 2; covered window 1 → 1. Total on /health 43 → 10 | 8/8 pass; HEAD's file swapped in → 3 red; restored identical (re-run by peer 1) |