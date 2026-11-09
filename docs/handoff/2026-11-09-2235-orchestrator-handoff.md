# Orchestrator handoff — 2026-11-09 22:35 IST

Outgoing orch: applyyy-e2 (resumed as applyyy-3b). Replaces the 20:35 pair
([2026-11-09-2035-orchestrator-handoff.md](2026-11-09-2035-orchestrator-handoff.md),
[2026-11-09-2035-pending-tasks.md](2026-11-09-2035-pending-tasks.md)); every item there not listed as DONE below is
still open. Re-measure every number before you build on it.

## State at 22:35 IST
- origin/main = the commit that adds this file (parent 65c810f). Nothing unpushed besides it.
- Live counts: awaiting_approval 86, approved 2, applied 8, failed 91, rejected 1, dropped_filter 35,932.
  tailored/audit_* = 0 (checked 22:24).
- Progress: 71% (5 of 7 stages). The gap is still the first bot submit (stage 5).
- ListAgents at 22:32 showed **no peers alive**. Peers 1–4 from this session (d4, f1, 31, 6d) are gone; their
  uncommitted work is listed below.

## Shipped this session (all CI green, all deployed)
| SHA | What | Deployed |
|---|---|---|
| 3a8d8ae | job-link-intake + resume-assist write agent_runs.gemini_calls; guard test closes the hole | migration 20261109210000 + both functions |
| 3aa849e | /approvals queue read starts at app load (first card 702→600 ms) | Vercel (push) |
| cc4478a | TrueFoundry d0a7d313 pre-flight test + fixtures | test only |
| e4e4772 | failed-without-reason unrepresentable in screener/tailor/matcher persist (types) | not deployed: no behavior change; rides the next deploy of those functions |
| ba90a40 | **Teja's rule:** ≥5 certifications + every achievement on every tailored resume, never trimmed; overflow refused | tailor + auditor |
| 65c810f | pre-flight tests for HackerRank, Cadence, Canonical ×3 | test only |

Migration 20261109190000 (scout_web) was already applied (dry-run "up to date"); the 20:35 handoff was right.

## Uncommitted in the tree — owner gone, do not "rescue" blindly
- `worker/src/cli/scout.ts` + `worker/test/scout-board-identity.test.ts` — **HELD on purpose**: commit only after the
  134-row xai re-key (else 134 duplicate jobs). Same rule for a scout-ats deploy.
- `supabase/migrations/20261109211000_failed_requires_reason_check.sql` + `supabase/functions/_shared/db/failed-requires-reason-check.test.ts`
  — peer 2, gated green. **Commit + db push only after the back-fill** (27 rows + the 2-row step); otherwise VALIDATE
  fails and the push rolls back. Bridge: `C:\Users\tejam\applyyy-handoff-keep\2026-11-09-2040-peer2.md`.
- `worker/src/playwright-page.ts` (+63), `worker/test/submit-outcome-428.test.ts`, `worker/test/submit-outcome-real-form.test.ts`,
  `worker/fixtures/lever/required-radio-card-shape.html`, `worker/test/lever-required-unfilled.test.ts` — peer 4's
  Lever fail-closed guard, **in flight, NOT gated** (23 submit-outcome-* tests were red at 22:27). Bridge (if written):
  `...\2026-11-09-2040-peer4-t2.md`. Give it to a fresh peer to finish; don't commit as is.
- `apps/web/results-time.json` — stray perf artifact; ask before deleting.

## Open work, in priority order
### P0 — safety, blocks the first live bot submit
1. **Declarations are auto-ticked.** worker/src/plan-fill.ts fills REQUIRED declarations ("own words / no AI",
   privacy Acknowledge/Confirm) from attested "yes" bank rows; its consent rule misses agree/confirm/acknowledge.
   Teja's standing ruling (11-07): the bot never ticks declarations. Briefed to peer 1 (d4) at 22:28 as task t3; the
   peer is gone and plan-fill.ts is unmodified, so **not started**. Brief: positive-shape classifier, fail closed
   (unsure → human_only → Manual). Fixtures on main: worker/fixtures/greenhouse/canonical-*. **Hold every live
   apply.yml run (TrueFoundry included) until this ships.**
2. **Finish peer 4's Lever guard** (above).

### P0 — waiting on Teja (none approved yet; ask in your window)
3. Live writes (the classifier blocked the previous orch; SQL in `C:\Users\tejam\applyyy-handoff-keep\2026-11-09-sql\`):
   xai re-key 134 (`rekey_count.sql` must say 134 first) · aiven disable (docs/status/2026-11-09-identity-drift.md) ·
   failure_reason back-fill 27 (`backfill_fr.sql`) · the 2-row step for 3c476629/0fcd296f (CAS UPDATE in the peer2
   bridge) · recover9 (`recover9.sql`; still matched live at 20:46). Then: peer 2's migration; then scout-ats deploy +
   the held worker scout commit.
4. TrueFoundry d0a7d313 answer_bank rows: degree "Bachelor's Degree", school "Other" (Teja's statements; SQL in
   peer4 bridge `...\2026-11-09-2040-peer4.md`). Then Teja approves the row → kit → rehearse-assist → live apply.yml
   (after P0-1).
5a. **Teja asked 22:34 IST, in the outgoing orch's window (an approved master write; re-confirm in yours since
   authority doesn't relay):** add skills "MCP Integrations" and "Monitoring" to the master. "Monitoring" appears on
   his PDF under Cloud & DevOps; check whether v28 already has it (`master_profiles.profile->'skills'`, entries
   `{id,name,category}`), add only what's missing, the same way the web Master Profile page inserts a version
   (apps/web/src/features/settings/masterStore.ts:318-331). A new version changes nothing for queued rows.
5. Master: add 2 certifications (Brainovision Java Full Stack, Infosys R for Data Science). Until then the 5-cert
   rule yields 3 (it takes min(5, master count)). Master v28 already has Java and C.
6. HackerRank cb64a4bf: Teja must write the Jan-2027 6-month availability answer. Cadence 526e7895: 8 drafted answers
   need his OK ("graduating = No" likely screens him out). Table + SQL: `...\2026-11-09-2040-peer3-t2.md`.
7. `git rm supabase/functions/_shared/agent/loop.ts supabase/functions/_shared/agent/loop.test.ts` (classifier-blocked).
8. Mumbai move ruling (recommended yes; numbers in docs/status/2026-11-08-web-latency.md).
9. Approved PayPal 81edd933 + Nike 6ca9e421 are Workday → bot parks them; Teja applies via Manual lane.

### Decided this session (don't re-open)
- Canonical ×3 → Manual lane (the no-AI declaration rules out agent-drafted essays).
- 6+ cert master is refused, not trimmed to 5 (fail-closed; moot until master > 5).
- `drop_reason string|null` on dropped rows: left as is.
- Lever guard: build it (fail closed).

### P1/P2
- Dropdown exact-match: 9–10 answers per Canonical form ("india" vs "India") park at fill. Safe but blocks coverage;
  an option-mapping step for peer 4's area after P0.
- Re-measure tailor calls/min after the next drain (e99b758 fix); matcher was 8.56/min (peak 12.31), 1×429, 2×503.
- Deploy screener/matcher to carry e4e4772 whenever they next ship.
- Everything P1/P2 in the 20:35 pending list not done above (Barclays f3a0c6bf, temp worktree cleanup incl.
  `%TEMP%\applyyy-deploy-{3a8d8ae,ba90a40}`, CLI v3 plan, receipt-confirm, WhatsApp, locked-remote ruling).

## Gotchas learned this session
- `db push` sends EVERY pending migration: keep a migration that must wait (211000) uncommitted, or deploy from a
  SHA without it.
- The outgoing orch once chained `git log origin/main..main` and `git push` in one command (CLAUDE.md 5a breach;
  nothing extra went out). Run the gap check and the push as separate calls.
- Peer bridges: `C:\Users\tejam\applyyy-handoff-keep\2026-11-09-2040-peer*.md`; shared peer rules:
  `...\2026-11-09-2040-peer-common.md` (reuse it for new briefs).
