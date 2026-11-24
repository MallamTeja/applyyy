# Peer rules — 2026-11-24 round (orch applyyy-1f)

Global rules: `~/.claude/CLAUDE.md` + repo `CLAUDE.md`. Previous round: `2026-11-23-2340-orchestrator-handoff.md`.

## Hard rules (every peer)
- Peers never `git add` / commit / push / deploy / run live writes (UPDATE/INSERT/DELETE, workflow dispatch). SELECTs are fine.
  Prepare exact statements + prechecks; the orch runs them.
- Write ONLY files in your row below. Need another file? Message the orch, don't touch it.
- Comment rule: every code line carries a WHY comment (≥1.00 in source; `{/* */}` between JSX tags).
- TDD + red-on-revert for every fix. Gate: tsc/vite (web), `node --test` (fn), `deno check` with file count, worker tsc+vitest
  if you touch anything worker or web imports by relative path.
- Fan out read-only recon subagents in ONE parallel message before reading serially. No cap.
- One message per assignment: final report = bridge `docs/handoff/2026-11-24-peer-<n>.md` + ≤8-line SendMessage to `applyyy-1f`.
  Blockers only otherwise. No acks, no pings, no peer-to-peer.

## NEW 11:31 IST (Teja): 3 parallel tracks per peer
Each peer runs 3 tasks at the same time. Mid/big task = recon subagents + worker subagents, all launched in ONE parallel
message. Small task (one file, a lookup) = the peer itself. Workers inside a peer keep disjoint files too.

## P0 (Teja 11:46, said 4 times): re-tailor every awaiting_approval resume on the LATEST master (v52 now), "army of agents"
= one author subagent per row, in parallel. Peer 2 owns it; the orch runs every live write. Teja stays off /approvals.

## Ownership
| Peer | Session | Task | Owns (write) |
|---|---|---|---|
| — | — | Track adds 11:46: peer 1 + S40/S40b gone-job hiding (Ready to tailor + approvals) + S41 SQL prep; peer 3 + S30 Gemini fallback model; peer 4 + S24 web claim block (P0 from Teja 11:28) | peer 1 also `_shared/` gone-detection it adds; peer 3 also Gemini pool/model config files; peer 4 also the claim-block component (ask orch if it is in the S9k list) |
| 1 | applyyy-f1 | JD missing on Ready-to-tailor rows: permanent fix | `supabase/functions/jd-refetch/**`, `.github/workflows/jd-refetch.yml`, Workday detail-fetch code it adds under `_shared/ats/` (new file preferred), new migration(s) it creates |
| 2 | applyyy-af | S22 re-tailor of the approval queue (Claude-authored, no Gemini) | `scripts/retailor-claude/**`, `supabase/functions/_shared/tailor/**` |
| 3 | applyyy-25 | Ship-prep: S9k resume-chat fixes + #2 apply Storage 544 retry | the 15 S9k files (peer-1 bridge 2026-11-23 "ROUND 4"), `worker/src/supabase-gateway.ts` + its test |
| 4 | applyyy-24 | Grad-year gate (S-grad, migration 20261123220000) + S24 detector backend | `supabase/functions/_shared/screen/**`, `supabase/migrations/20261123220000*`, worker test fixtures needing `graduationYear`, `_shared/audit/detector.ts` + `detector-inflection.test.ts` |

Overlap rule: if an S9k file is also in peer 4's set, peer 3 owns it; peer 4 asks the orch.

## Live map 11:52 IST (orch is now applyyy-00)
Peer 3 = applyyy-b1 (was applyyy-25): owns P0 re-tailor (scripts/retailor-claude/**, _shared/tailor/**) + S9k/Storage 544.
Peer 4 = applyyy-c5: grad-year + S24 detector (finishing) + S24 web claim block + S30 fallback model. detector.ts frozen
while peer 3 runs apply.ts (changes go via orch). Peer 2 = applyyy-94 (fresh, 12:36): row 1 work = JD-missing root fix + S40/S40b + S41 SQL prep. Peer 1 not yet back.
NOT peers: applyyy-fa (standalone: internship search, master v52, watchlist seed), applyyy-c1 (standalone coordinator: writes pending-tasks only).

## Ready queue (next free peer, after the orch bundle commit lands)
1. S44a dead-code cuts (pending-tasks c52e8da4; audit docs/audit/2026-11-24-dead-code-audit.md). Touches AiEditPanel /
   ApprovalQueuePage: prefer peer 2 (owns S24 + S41b there). 2. S42 master fixes (Teja wording OK first). 3. S16 Workday robots cache.
Also NOT peers: applyyy-d0 (standalone, files tasks).

## Not a peer
applyyy-92 is Teja's standalone session (Teja 11:10 IST: not re-tailor). Never message or assign it. Orch checks its
uncommitted files before each commit/push.

## Parked (nobody touches): dead-posting card WIP (`approval/ApprovalQueuePage.{tsx,css}`, `queuePrefetch.ts`) unless in S9k list,
`worker/src/cli/run-one.ts` stalled-row WIP, D5 `_shared/scout/persist-jobs.ts` + `scout-ats/*`.

## Live facts at 2026-11-24 11:05 IST (orch-measured)
- passed_filters 113, of which 111 have `jobs.description_raw IS NULL`; all 111 = `ats_provider=workday`, all updated
  2026-11-23 16:05:33Z (Teja's standalone S8b/S11 move to passed_filters).
- Last jd-refetch run 45210050904 at 2026-11-23 15:52Z ended `none` (13 min BEFORE the move). Slots 21:07Z and 05:07Z never ran.
- Orch dispatched jd-refetch 45334499027 at 05:36Z (max_rows 30).
- awaiting_approval 20, approved 6. Master latest = v51. Re-tailor: 0 rows written live; 2dd68caa + f241448f have PASS update.sql;
  957991ec has response.json but no PASS; 15 rows only fetched. ccb0a52e + 9e76dea0 were tailored today 05:27/05:30Z at v51.
