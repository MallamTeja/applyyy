# Orchestrator handoff — 2026-11-24 18:50 IST (orch applyyy-b2, before Teja's /clear of every session)

Teja 18:42: "/clear every session … drop 2 peers, only with remaining peers from now on" → after the clear the orch runs
**2 peers** (memory `applyyy-two-peers-max`). Each peer owns 2 whole features, run in parallel with subagents (Teja 15:57).
Re-measure everything below before building on it. Previous: `2026-11-24-1400-orchestrator-handoff.md`.
Ownership as of this round: `2026-11-24-1600-peer-rules.md` (5 peers; void after the clear, rewrite for 2).

## 1. Nothing from this round is committed or deployed
origin/main = ec0dad14 (docs only since 64e16abc). Every item below is uncommitted in the main tree. Machine: 8 GB RAM,
~371 MB free with ~10 Claude sessions open → worker vitest/Chromium time out under load. Run orch gates ONE AT A TIME.
The "25 hung node.exe" are per-session MCP servers (playwright-mcp, antislop, notebook), not hung tests.

## 2. Ship queue (re-gate on a `git archive HEAD` export + the listed files, then commit, then deploy)
| # | Feature | Bridge (pathspec + gate + deploy order) | State | Deploy |
|---|---|---|---|---|
| 1 | Grad-year gate S18 + S25 degree + S20 salary + S30 Gemini alternate (peer 1) | `2026-11-24-peer-1-r4.md` | GATED (fn 2514, deno 170=170; worker vitest 61/71, 10 Chromium files timed out on load, no assertion fail) | migration **20261123220000** FIRST (`db push --linked --dry-run` must list only it; now also allows degree_mismatch + salary_below_min), then screener/scout-ats/matcher/auditor/jd-refetch/job-link-intake; S30: resume-assist then the 8 Gemini callers. Needs peer 2's salary select edits in matcher/index.ts:358 + auditor/index.ts:230,317 and jd-refetch:171/128 (NOT done yet: peer 1 r5 never started) |
| 2 | S24 calm claim notice (web) + S43/S34 detector (peer 2) | `2026-11-24-peer-2-r4.md` | Orch re-gate was RED (approveCheck.test.ts:170, approveRecheckE2e.test.ts:192,:207: S34 summary grounding reached the web approve re-check via approveCheck.ts → detector.ts). **FIXED 18:49 by peer 2** (derivation stem step + the r5 stemmer folded into r4): its export gate web 1708/1708, fn 2507/2507, tsc/vite 0, deno 0. Pathspec is now 15 files (STATE AT CLEAR). Orch must re-gate it again | web → auditor + resume-assist → re-audit the queue (Teja approval pending). Detector ships BEFORE the S43 prompt |
| 3 | S32 + S46 held-title headline + skill line-fill + v53 skill-profile aliases (peer 3) | `2026-11-24-peer-3-r4.md` + `-r5.md` | 14-file unit GATED (web 1701, fn 2488, deno 121); now 15 files with skill-profile-v53.test.ts; its full gate was running at stop | auditor → tailor → matcher → jd-refetch. Commit WITHOUT prompt.ts/prompt.test.ts (S43 prompt waits for #2) |
| 4 | S29 stale-claim sweep (peer 3) | `2026-11-24-peer-3-r5.md` | assist.ts sweeps after sign-in; assist-sweep.test.ts 3/3 + red-on-revert; worker tsc 0; full gate unfinished. Peer 3 cites "Teja ruled no cron": NOT found in pending-tasks; verify before shipping | none (worker runs from repo) |
| 5 | S44a dead-code cuts (peer 4) | `2026-11-24-peer-4-r4.md` | GATED on bf80f170 (deno 114, fn 2433, web 1675, worker 911); 3 worker afterAll browser.close timeouts on load | web (Vercel) |
| 6 | S45 readable chat reply (peer 4) | `2026-11-24-peer-4-r4.md` | unit green (fn 2583, web 68); e2e aiEditServerApplyE2e + dockChatE2e + combined gate NOT run. aiEdit.ts imports `replyText` from server-plan.ts: ship #5+#6 TOGETHER | web BEFORE resume-assist |
| 7 | S16 Workday robots cache core (peer 5, retired) | `2026-11-24-peer-5-r4.md` lines 63-73 | GATED (108/108, 10/10, callers 172/172, deno 2=2) | migration 20261124170000 → edge → worker. Wiring NOT done (diffs at bridge :110-146); worker scout client lacks x-applyy-agent-key → 42501 until wired |
| 8 | S42a/b master v53 SQL (peer 5) | `2026-11-24-peer-5-s42.sql` | ready, one transaction (precheck v52 hash, insert v53, postcheck). Ships AFTER #3 (skill-profile OS/CN/K8s aliases) | live write: needs Teja's one-line OK in the orch window (heard only via the pending file) |

## 3. Waiting on Teja (asked in the orch window 18:20, no answer yet)
1. "yes v53": write master v53 (#8).
2. Re-audit the 31 awaiting_approval rows after #2 deploys (27/31 never re-audited after the v52 re-tailor: store 0 findings, detector finds 47).
3. Re-tailor ALL 31 after #3 + #8 (30/31 headlines change; line-fill changes all). Peer 5's "only 2 rows" covered just
   the v53 order edits. Teja stays off /approvals. Prep: `%TEMP%\applyyy-retailor-ec0dad14`, 3/31 fetched, 0 answered;
   v53 changes every prompt hash → re-fetch + re-answer all after v53.
4. Peer 3 r4 flag: "fill the line" read as: a group whose first 6 names fit one line stops there (Testing 7→6). OK?
5. Master's own headline "Full Stack AI Engineer" (no Intern) + 3 variants: keep or change under the 14:55 ruling?
6. Salary: band per month or per year; parse "12 LPA" from JD text; "or equivalent experience" keeps (current)?; write `requires_advanced_degree`?

## 3a. Peer 2 r5 leftovers (ungated WIP in the tree)
- S33 matcher: matcher/index.ts + 4 new files, ungated. (`matcher/tech-pregate*` changes are peer 1's, not S33.)
- S21: verdicts in peer 2's scratchpad, 22 boards to insert; SQL NOT written. S31: no output.
- NOT done: peer 1's salary selects (matcher/index.ts:358, auditor/index.ts:230,317) + dropping the `_jobTitle` arg at auditor/index.ts:562 (must ship with peer 3's param drop in master-facts.ts).

## 4. Ready queue (after the ship queue drains; 2 features per peer)
S16 wiring (+ jd-refetch salary select) · S27 recovery SQL (668 + 159 rows; start after the cache runs a day) ·
S33 matcher scores the tailored resume · S21 + S31 boards (re-verify each) · detector false-positive follow-up
(-ies→y stemmer, framing words) · S23 /approvals UI audit · S36–S39 · S26 Workday login · rest of S44 · S12 docs list.

## 5. Parked / unknown owner (do not ship blind)
`scout-ats/index.ts` (+124/-… WIP), `scout-ats/workday-wiring.test.ts`, `worker/src/scout/persist-jobs.ts`,
`worker/src/cli/run-one.ts` (+204; breaks 7 rowPipelineParity worker tests in the shared tree), `worker/test/run-one.test.ts`,
`.github/workflows/run-one.yml`, untracked `pm.html`, `q.json`. Author unknown; find it by grepping session transcripts.

## 6. Peers at clear
| Peer | Session | Bridge (STATE AT CLEAR) |
|---|---|---|
| 1 | applyyy-1e | `2026-11-24-peer-1-r4.md` |
| 2 | applyyy-9f | `2026-11-24-peer-2-r4.md` / `-r5.md` |
| 3 | applyyy-eb | `2026-11-24-peer-3-r5.md` |
| 4 | applyyy-17 | `2026-11-24-peer-4-r4.md` |
| 5 | applyyy-35 | retired 18:17 (`2026-11-24-peer-5-r4.md`) |
Gate exports left in %TEMP%: applyyy-orchgate-p2-15160, applyyy-orchgate-p2-plain-25139 (junctions removed), peers' own.
