# Handoff — 2026-10-08 16:10 IST (orchestrator applyyy-df → new orchestrator)

Teja closed applyyy-df to save credits. **Every fact below was measured at a time; re-measure before
you trust it.** Read `CLAUDE.md` (rewritten today) and `~/.claude/CLAUDE.md` first.

## 1. How Teja works with you
- Teja talks **only** to the orchestrator. Peers report to you via SendMessage and never ask Teja in
  their own window. Relay his decisions with your recommendation.
- Refer to peers as **"peer 1 (b0)"** etc., never bare session names (global CLAUDE.md).
- The orchestrator **coordinates, teaches, decides**. It does no hands-on code. It **does** run:
  deploys, `db push`, live-data writes, and CLAUDE.md/GEMINI.md/memory edits (repo CLAUDE.md §2-§3).
- Teja does **not** want copy-paste task blocks. Do deploys yourself. Human-only steps: approving an
  application and clicking Submit.
- Every brief **and follow-up** that assigns work carries prompt + context + loop engineering
  (goal · facts it can't derive · done-check + retry cap + stop condition). Mandate subagent fan-out.
  Every peer report must open with a `Fan-out:` line (subagents, roles, files written).
- Teja approved **all of the orchestrator's recommendations** today ("the recommended option by you,
  I agree"). Still say what you decided and why.

## 2. Goal and state
**Goal:** ONE real application end to end. Row `ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154` (GitLab
"Intermediate Backend Engineer, India", Greenhouse 8775507002) is at **awaiting_approval**,
audit_clean, unclaimed, master pin 2. **Editing is ON** since dba6adc.
Teja's choice is pending: approve as-is, or wait for click-to-edit/add-skill (peer 3).
After he approves: he runs `node worker\src\cli\assist.ts --id ba1e5d1d-…` in his own terminal. It fills
**8** things (first/last, email, phone + its country picker, LinkedIn, "current country of residence =
India", resume). He answers 6 questions, checks the residence answer, clicks Submit, types `y`.
Avoid ~13:30–15:30 IST (GitHub runs the 08:00 cron 6–7 h late). Verify afterwards that the row
reached `applied`.

## 3. Production (verified by applyyy-df today)
- Migrations applied through **20261008170000** (`select max(version) from supabase_migrations.schema_migrations`).
- Edge functions redeployed today from pinned worktrees. Last deploys: tailor @5fec969, cover-letter
  @9615d74, and normalizer/screener/matcher/auditor/email-tracker-intake @3e3d6a3. Check with the
  supabase MCP `list_edge_functions`, sorted by **updated_at**, not by version.
- **Agent key (security G1):** `APPLYY_AGENT_KEY` is set in the Supabase secrets, the GitHub secrets and
  Teja's Windows **user** env. Its sha256 is
  `173cffbd0242d72a9d5bb98b993637269d4a3ea0f4e8217686a4e8bc3850d9ce` (also matches the digest in
  `supabase secrets list`). **Enforcement is OFF** (0 rows in `applyy_internal.agent_key`).
  **Seed it only AFTER Teja's first application succeeds**, because assist runs in his terminal:
  `insert into applyy_internal.agent_key (key_sha256) values ('173cffbd…d9ce');` (full hash above).
  That turns on the guards for advance_application_status, claim_applications and
  release_application_claim at once. **Kill switch:** `delete from applyy_internal.agent_key;`.
  After seeding, verify that the next machine transition doesn't 42501. Teja's terminal for assist needs a
  NEW PowerShell window to pick up the user env var.
- Gemini keys 12–20 are disabled for both users. `GEMINI_FALLBACK_MODEL` is intentionally unset.
- Web (Vercel) auto-deploys on push. Prove with a PRESENT + ABSENT bundle sentinel.

## 4. Deploy recipe (you run it)
Pinned worktree at `origin/main` → copy `supabase/.temp/{project-ref,pooler-url,linked-project.json,postgres-version}`
in → `$env:SUPABASE_ACCESS_TOKEN=$null` → `supabase db push --linked --dry-run` (push with `--yes`
only if it lists exactly the expected files) → `supabase functions deploy <fn> --project-ref
xynqxekcqizwhtskzqrq --use-api` → verify by SQL shape → `git worktree remove`. A leftover locked dir
`%TEMP%\applyyy-deploy` (unregistered) may block reusing that name, so use a different path.
Live DB: supabase MCP `execute_sql` (the CLI `db query` gives 403).

## 5. Peers, partitions, queues (authoritative map sent 16:01)
| Peer | Partition (sole writer) | Now | Queue after |
|---|---|---|---|
| peer 1 (b0) | apps/web features/pipeline/** EXCEPT resumeSnapshot.ts; features/discovery/**; data/pipelineRunner.ts; health files + useAgentRuns/agentFreshness | PipelineDrawer `fit_score`→`match_score` fix; "Send through pipeline" button in the drawer (passed_filters lane: matcher→tailor→auditor, real agents only, never stamps status) | the same button on Discovered cards once peer 2's Q1 lands (Teja **approved** this 16:08; record the ruling in DiscoveredJobsPage's header/footer comments); react-router 7 (W-C) |
| peer 2 (3a) | supabase/**, worker/**, docs/**, README.md, PROJECT_PLAN.md; lockfile only in a window you open | **Docs ↔ code sync** (Teja asked 15:56) | Q1 single-row ?application_id= for normalizer + screener → Q2 matcher patch guarded on status → W-A source-map-js override (--lockfile-only, approved) → run-summary budget + cascade.ts:297 escaping |
| peer 3 (e8) | apps/web features/approval/**, features/resume-preview/**, pipeline/resumeSnapshot.ts, approval/edit/preview tests | T2 click-a-line-to-edit, T3 "Add from your master profile" (option A: master skills only, labelled added-by-you; non-master keywords link to the master profile) | T4 zoom out the preview panes |
| peer 4 (new) | see its brief: a new migration for B2 + read-only W-C sizing | | |

Pending deploys you'll owe as items land: normalizer/screener (Q1), matcher (Q2), screener + scout-ats
(run-summary/cascade), the B2 migration push.
Dependabot: 14 open alerts. W-B (vitest 2→4, a real install, closes 11 incl. all 3 criticals) needs a window
when ALL peers are idle. Peer 2 has the plan.

## 6. Open decisions / items for Teja
- Approve GitLab now vs wait for T2/T3.
- After the first application: rotate the app password (new and strong; it was pasted in chat and equals his
  email) in 3 places: Supabase Auth, the GitHub secret, and the Supabase secret `APPLYY_APP_USER_PASSWORD`.
- The 390px Approve-bar layout takes 18% of the viewport (peer 1 flagged it; Teja's call).
- Optional: remove `%TEMP%\applyyy-clean` (old worktree at 5f4115d).

## 7. Lessons from today worth keeping
- Two of my briefs had wrong premises (the master_version column was never written; Discovered shows
  only `discovered` rows). Both peers checked instead of obeying. **Specify the goal, ask for the
  evidence, and let workers push back.**
- A handoff's claims are claims: applyyy-83's "red-on-revert" test names never existed.
- Deploy order: code calling a new DB parameter ships AFTER the migration; code a migration
  enforces ships BEFORE enforcement is switched on.
