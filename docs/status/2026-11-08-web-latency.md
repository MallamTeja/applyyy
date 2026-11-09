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
| 3 | System health: the newest run / success for agents beyond the 200-row window is answered by ONE `.in('agent', owed)` read. "Never ran" is reported only when the page provably holds every matching row (rows = exact count); otherwise per-agent reads for just the open agents (CLAUDE.md §6) | `apps/web/src/data/useAgentRuns.ts`, `apps/web/test/agentRunsBeyondWindow.test.ts` | `agent_runs` requests: empty window 35 → 2; partial window 33 → 2; covered window 1 → 1. Total on /health 43 → 10 | 8/8 pass; HEAD's file swapped in → 3 red; restored identical (re-run by peer 1) || 4 | Approval queue: the newest master is read in parallel with the applications (a prefetch, used only for rows pinned to that version; older pins still read their own version) | `apps/web/src/features/approval/ApprovalQueuePage.tsx`, `apps/web/test/approvalQueueParallelMasterE2e.test.ts` | Master read starts +682 → +317 ms after load and is answered ~365 ms sooner (one round at 300 ms). **Button shown, timed in the page (MutationObserver) from the first REST request: 869 → 570 ms median of 5 (−299 ms, one round).** Correction (2026-11-09): the first probe timed the button with Playwright's `waitFor`, which polls with a back-off of up to 500 ms, so it saw ~1.16 s both before and after and reported "unchanged". In the page, the button renders 28-34 ms after the reads answer. The page is now at its floor of one parallel round of reads | e2e 2/2; red-on-revert pinned by the test header (pre-fix `loadQueue` fails "started before the rows were answered") |
| 10 | Approve all settles rows 4 at a time (`SETTLE_CONCURRENCY`); each row keeps its own confirm → re-check → RPC order and writes only its own outcome | `ApprovalQueuePage.tsx`, `apps/web/test/approvalBatchConcurrentE2e.test.ts` | 10 rows, 300 ms per call, median of 5: **6,534 → 2,406 ms (−63%)** | e2e 2/2 alone and inside a 206-test run; the one-row-at-a-time loop fails "more than one call in flight" |
| 11 | Discovered option B: the list selects `description_preview` (first 600 chars) and `description_requires_degree` (both generated, migration `20261108170000`), never `description_raw`. The JD modal reads one row's full text on open; search adds a debounced server `ilike` over the loaded window | `discoveredList.ts`, `DiscoveredJobsPage.tsx`, `filtersStore.ts`, `apps/web/test/discoveredPreviewColumn.test.ts` | Live (SELECT only, 2026-11-09), newest 300 per lane: `dropped_filter` **858,109 → 133,308 bytes (−84%)**; `passed_filters` 39,968 → 5,400. `EXPLAIN (ANALYZE, BUFFERS, SERIALIZE)` on `dropped_filter`: 479 → 32 buffers, output 852 → 144 KB, serialize 3.4 ms warm (142.8 ms on the first run) → 0.2 ms. Total execution time warm is NOT better (61 vs 81 ms, within run-to-run noise). The win is ~720 KB less over the ~300 ms Sydney link | 7/7; with only `filtersStore.ts` reverted, "the degree rule reads the generated column, not the description text" goes red |

Probe for #4 and #10: the built e2e bundle at HEAD `5f1cb2c` (extracted to a scratch dir) vs the working tree,
fake session, every Supabase call held 300 ms, 10 rows, 5 cold contexts each.

**Degree-column parity (2026-11-09).** `description_requires_degree` is true on 0 of 7,158 jobs that have a
description. That 0 is real, not a regex that matches nothing: the deleted JS regex (`filtersStore.ts` at
`5f1cb2c`, line 452) agreed with the column on 861/861 live rows (all 361 that mention "PhD" or "Master's", plus
500 random). The JS regex returns true on 4/4 crafted positives. The Postgres regex returns true on a literal
"PhD required.", and an independent `ilike` for the same phrases finds 0. No fix migration.

## After all fixes: live site, and the Mumbai what-if (2026-11-09, cb58582)

For Teja's region decision ("ship fixes first, check how fast pages feel, move only if still slow", 2026-11-08).

### How it was measured
- **Boot and rounds, on the LIVE site.** https://applyyy.vercel.app (cb58582: lazy routes, counts RPC, Approval
  parallel master + pool, Discovered option B, self-hosted fonts) in headless Chromium from Teja's machine (India), with a
  fake session. Every `supabase.co` call is answered locally after 300 ms, so no live data is read or written. "Waves" =
  serial REST rounds: a request that starts after an earlier response ended opens a new wave. 5 cold contexts per
  route, medians. `/approvals` got 86 fixture rows (the live queue size); the other routes got empty fixtures, so a
  round that only fires when rows exist is not counted there.
- **Real Supabase hop, measured.** Chromium `fetch` to the project's REST with the public anon key (an RLS-empty GET
  that still runs a Postgres query in Sydney). The app's `apikey` header makes these CORS requests, as in the app.
  5 fresh contexts × (1 cold + 5 warm).
- **Network RTT, Sydney vs Mumbai.** TCP connect time (= 1 RTT) from the same machine to `s3.` and
  `ec2.ap-southeast-2.amazonaws.com` vs `s3.` and `ec2.ap-south-1.amazonaws.com`, 7 each.

### Measured
| | Sydney (today) | Mumbai (ap-south-1) |
|---|---|---|
| Network RTT (TCP connect, median) | **~265 ms** (252-288) | **~30 ms** (26-55) |
| Supabase warm hop (browser, 25 samples) | **354 ms** median; spikes to 0.8-1.06 s | est. **~55 ms** |
| Supabase COLD first request (browser, 5) | **1,145 ms** median (908-1,315) | est. **~240 ms** |

Supabase is fronted by Cloudflare (edge 31 ms away), so DNS/TCP/TLS are local. The cold cost is ~3.8 Sydney round
trips (CORS preflight + the edge's leg to the origin), paid on the first request of every fresh page load. Model:
warm = 1.28 × RTT + 15 ms; cold = 110 ms local + 3.8 × RTT + 15 ms. The Mumbai column is that model at RTT 30 ms,
an estimate, not a measurement of a Mumbai project.

### Per route (live boot + measured rounds + modelled real hops)
Boot = first REST request start on the live site (JS, route chunk, fonts). Render = data → painted (~30 ms; 65-105 ms
for 86 approval rows, measured in the page).

| Route | FCP | Boot (first REST) | Waves | Requests | Fresh load, Sydney | Fresh load, Mumbai | In-app nav, Sydney | In-app nav, Mumbai |
|---|---|---|---|---|---|---|---|---|
| /approvals (86 rows) | 168 ms | 226 ms | 1 | 6 | **~1.47 s** | ~0.57 s | ~0.45 s | ~0.16 s |
| /discovered | 260 ms | 369 ms | 1 | 6 | **~1.54 s** | ~0.64 s | ~0.38 s | ~0.09 s |
| /pipeline | 196 ms | 268 ms | 1 | 4 | **~1.44 s** | ~0.54 s | ~0.38 s | ~0.09 s |
| /health | 204 ms | 249 ms | 2 | 10 | **~1.78 s** | ~0.57 s | ~0.74 s | ~0.14 s |
| /manual-apply | 240 ms | 346 ms | 1 | 9 | **~1.52 s** | ~0.62 s | ~0.38 s | ~0.09 s |
| /filters (settings) | 204 ms | 234 ms | 1 | 5 | **~1.41 s** | ~0.50 s | ~0.38 s | ~0.09 s |
| /search-preferences (settings) | 192 ms | 224 ms | 2 | 6 | **~1.75 s** | ~0.55 s | ~0.74 s | ~0.14 s |

Fresh load = boot + cold first hop + (waves − 1) × warm hop + render. In-app navigation reuses the open connection and
the cached shell: waves × warm hop + render. Spreads were under 2× the median except `/approvals` run 1 (cold
FCP 1,072 ms), which was re-run: FCP 160-300 ms across those 5.

Not modelled: transfer size. The live 86-row approval read is ~1.67 MB of JSON before compression: `tailored_profile`
852 KB, `description_raw` 438 KB, `tailor_refs` 382 KB. Over the Sydney leg that can add round trips of TCP growth.
`description_raw` is read only for the pay-band chip (`ApprovalQueuePage.tsx:527`), so it is the next cut (a lead, not
built).

### Recommendation: move to Mumbai
**Threshold:** time-to-usable under **1 s** on a fresh load, the classic limit for keeping the user's flow of thought
(Nielsen).
- **Fresh loads miss it on every route: 1.41-1.78 s.** About 1.1 s of that is the single cold first request to Sydney.
  Client fixes can't remove it: everything left is ≤ 2 serial waves, the DB answers in 8-28 ms, and a `preconnect` would
  save only the ~110 ms of local DNS/TCP/TLS, not the Sydney round trips.
- **In-app navigation passes it:** 0.38-0.74 s.
- **Mumbai would put every fresh load at ~0.5-0.65 s** (−0.9 s each) and navigation at ~0.1-0.15 s (−0.3 to −0.6 s).

So the pages are still slow by this threshold, and what remains is the region. Per Teja's 2026-11-08 ruling, that means
move. The cost, for Teja to weigh: a NEW Supabase project in `ap-south-1`, plus a data migration, every edge function
redeployed, and the secrets in all three places (Supabase, GitHub, the Windows env). A region cannot be changed in place.
If Teja keeps Sydney, the cheaper partial win is the `description_raw` cut above, plus starting the first Supabase
request before the route chunk loads (that overlaps up to the ~0.25-0.37 s boot with the cold hop).
