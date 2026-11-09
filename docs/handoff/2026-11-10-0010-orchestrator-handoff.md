# Orchestrator handoff — 2026-11-10 00:10 IST

Outgoing orch: applyyy-f2. Replaces the 2026-11-09 22:35 handoff; every item there not listed as DONE below is still
open. Teja asked for a wind-up at 00:08 IST. Re-measure every number before you build on it.

## State at 00:10 IST
- origin/main = the commit that adds this file (parent a8c577d). CI green through ce5f224; 2396b27, ea339e8 and a8c577d
  pushed (check `gh run list --commit <full sha> --workflow=ci.yml`).
- Live counts 00:03: awaiting_approval 91, approved 4, applied 8, failed 83, rejected 1, dropped_filter 35,933.
- Progress: 71 % (5 of 7 stages). Gap: the first bot submit (code gates shipped; waits on Teja's clicks), then receipt-confirm.
- Peers 1–4 (da, 1e, 5e, 0b) told to stop at 00:08. Uncommitted work is left IN THE TREE and backed up byte-for-byte to
  `C:\Users\tejam\applyyy-handoff-keep\2026-11-10-0010-wip\` (STATUS.txt + tracked.diff + every file).

## Shipped this session (all pushed)
| SHA | What | Deployed |
|---|---|---|
| 8eff608 | CHECK: a failed row must carry failure_reason | migration 20261109211000 applied, validated |
| 245aadc | scout CLI passes the board token (xai alias) | worker (main) |
| 4795874 | Lever fail-closed guard + option-match module | worker |
| ca0b3f6 | resume chat: owner-named skill is added; composer stays typeable | resume-assist + Vercel (prod sentinels verified) |
| ce5f224 | **bot never answers a declaration** + failure_reason cleared on leaving failed | worker; migration 20261109233000 applied (body checked) |
| 2396b27 | dry run / rehearsal report a closed-union verdict (no unconditional wouldSubmit) | worker |
| ea339e8 | planner picks the form's own option text ("india"→"India") | worker |
| a8c577d | rehearsal runs the live pre_gate; pipeline stats doc | worker |
Also deployed: scout-ats (xai fix 2afaa99) from 245aadc.

Live writes done (Teja approved in this window): xai re-key 134 · aiven disabled · failure_reason back-fill 27 + 2 ·
recover9 (9 → passed_filters; drain re-tailored 7 to the queue) · master v29 (+MCP Integrations) · master v30 (+2 certs:
Brainovision Java Full Stack, Infosys R for Data Science; 5 total; issuer only, no dates/links) · 9 answer_bank rows
(degree, school, HackerRank ×2, Cadence ×5) — all **unattested** (the trigger only attests Teja's own JWT).
Branches: chore/gitleaks-proof, wip/2026-10-25-shutdown, wip/work-auth-countries archived as `archive/*` tags (verified on
remote) then deleted. Remote = main + automation-keepalive (keepalive.yml recreates it).
Global CLAUDE.md: "new orchestrator" startup protocol. Repo CLAUDE.md §9: no subagent cap.

## Uncommitted in the tree — gated by its peer, NOT yet re-gated by the orch
1. **Peer 1 t3 (W29 + runner count)**: worker/src/apply-kit.ts, worker/test/apply-kit.test.ts,
   apps/web/src/data/pipelineRunner.ts, apps/web/test/pipelineRunner.test.ts,
   apps/web/src/features/manual-apply/{applyKit.ts,ManualApplyPage.tsx,botCantApply.ts}, apps/web/test/kitSkipNoApplyUrl.test.ts.
   **Deploy order: web BEFORE worker** (the web skip-code reader is strict): commit+push the web files, wait for Vercel READY
   + sentinel, then commit the worker files. Bridge `...\2026-11-09-2240-peer1-t3.md`.
2. **Peer 3 t6 (fill-time matchOption for react-select + radio)**: worker/src/playwright-page.ts, worker/test/combobox-option-match.test.ts,
   worker/test/playwright-fill.test.ts (the 'yes'→'Ye' flip; check whether finished). Bridge `...\2026-11-09-2240-peer3-t6.md`.
3. **Peer 4 t6 (email-only form → no_resume_field)**: patch PARKED outside the tree at
   `C:\Users\tejam\applyyy-handoff-keep\2026-11-09-peer4-t6\`; only `worker/fixtures/synthetic/email-only-alerts.html` is in the
   tree. It breaks 48 tests in 9 files that use fake email-only forms; land it AFTER items 1–2, by ONE owner of apply-one.ts +
   those 9 test files. Until then: approve live submits only on Greenhouse/Lever/Ashby URLs. Bridge `...\2026-11-09-2240-peer4-t6.md`.
4. `docs/status/2026-11-09-gemini-call-rates.md` (peer 3 drain addendum) — docs, commit with the next bundle.
5. `apps/web/results-time.json` — stray perf artifact; ask Teja before deleting.
Shared-tree gating trap: full vitest mixes peers' WIP. Gate a peer's files alone in a worktree at HEAD with node_modules
junctions made in PowerShell (`New-Item -ItemType Junction`; Git Bash mangles `mklink /J`). Leftover gate worktree:
`%TEMP%\applyyy-gate-p2` (+ deploy worktrees `%TEMP%\applyyy-deploy-{245aadc,ca0b3f6,ce5f224}`) — removal is classifier-blocked; Teja.

## Waiting on Teja (none answered yet unless marked)
Clicks: (a) Approvals → approve TrueFoundry d0a7d313 (classifier blocked the orch); (b) Answer bank → attest the 9 new rows.
Then: rehearse-assist on d0a7d313 → one live `gh workflow run apply.yml --ref main -f dry_run=false -f apply_only_id=<uuid>`.
`auto_apply_on_approve=false`, `dry_run=true`, `APPLYY_CRON_LIVE` unset — approving starts nothing live.
Decisions: 2 default-deny (bot uses attested rows only; 29 unattested rows) · 3 resume certs as inline "Name (Issuer)"
(peer 4 measure: saves 2.1 lines, 0 queued rows lose bullets) · 4 back-fill: clear failure_reason on 213 dropped rows ·
5 Cadence "graduating Dec 2027 / May-Jun 2028?" (master says Jun 2027; orch did NOT write "Yes" — untrue) · 6 PR mode
(peers push PR branches vs orch does PRs; conflicts with "peers never push" + relay rule) · 7 is "I understand this is an
in-person role" a declaration · 8 resume-chat Apply of a non-master skill also writes the master (attest_skill) — OK?
Answered: 4 HackerRank = "Yes" (immediate) · 5A certs added · 6A PayPal/Nike = Manual lane · 7A Mumbai = YES →
plan in docs/status/2026-11-09-mumbai-move-plan.md (new project + dump/restore + cutover; Teja-only steps named).

## Open, not on Teja
- Page overflow under the 5-cert rule: 38bb2f12 failed page_overflow; 5 queued rows were tailored on v29 (3 certs) — not
  re-tailored (ruling).
- Audit recheck open items (docs/status/2026-11-09-wiring-audit-recheck.md): W10, W19, W20, W23, W27, W36-38, worker e2e not in CI.
- tech_gate_unclassified dropped 11,018 rows — sample for false drops (stats doc).

## Gotchas learned
- The auto-mode classifier blocks `advance_application_status` to `approved` from the orch ("Modify Shared Resources").
- answer_bank attested_by_human is stamped by trigger from the JWT role; DB-session inserts land unattested. Don't forge it.
- A peer's "gated" is a timestamp; re-gate before commit, and commit a peer's gated files before granting it the same files again.
