# Orchestrator handoff — 2026-11-10 13:55 IST

Outgoing orch: applyyy-22 [d533f7]. Replaces `2026-11-10-0010-orchestrator-handoff.md`; every item there not listed
as DONE below is still open. Teja called a wind-up at 13:53. Peers 1–4 (4f7c, 70fd, 5c67, 141a) were already closed.
`applyyy-4b` [b22be7] is TEJA'S OWN session: never message, assign, stage or revert its files.
Re-measure every number before you build on it.

## State at 13:55
- origin/main = the commit that adds this file (parent `1158066`). CI green through `dc9328b`. Read CI for
  `1158066` + this commit by FULL sha and `--workflow=ci.yml`.
- Live: awaiting_approval 86 (approval page count, 12:20), 1 auth user (tejamallam00).
- Prod web (Vercel) = `dc9328b`, plus this push once Vercel builds it.

## Shipped this session (all pushed)
| SHA | What | Live? |
|---|---|---|
| 5d4723a | W29 web half (no_apply_url kit skip), certs inline "Name (Issuer)", tech-gate software spellings (4.3% false drops measured) | web + tailor + matcher/screener/scout-ats/auditor/job-link-intake |
| c9f13e7 | W29 worker half; react-select/radio matchOption | worker |
| 5baf245 | W36: web tests type-checked in CI (134 → 0), one typed fakeEdgeClient | CI |
| d0cbbe1 | CLAUDE.md §3: deploy from a `git archive` export, not a worktree | docs |
| 30e1aa3 | project bullet floor 3 (last trim step); worker e2e repaired + in CI | web, auditor, matcher, tailor |
| 86ad2ca | T5 no_resume_field form-shape gate | worker |
| 8ba2b06 | W10 retired: never drop by job age or per-company count | functions + migration 20261110120000 |
| 1a2393a | T8 bot fills only attested answers; T14 anon table grants revoked | worker + migration 20261110130000 |
| dc9328b | T10 resume chat add group/skills/points (truthful) + swap fix; T13 AI skill group ≥5; T14b anon default privileges | web + resume-assist + tailor + auditor + migration 20261110150000 |
| 1158066 | T12 aggregator↔ATS dedup (crossSourceKey, forward block, sweep, already_applied twins); W20 email-tracker types | **migration 20261110160000 APPLIED; worker live on push; FUNCTIONS NOT DEPLOYED (below)** |

Migrations applied today, each verified by a post-check: 120000 (2 columns + 2 filter_rules rows gone), 130000 (anon: 0
tables, 0 sequences; authenticated 21/21; an anon REST probe returns 401), 150000 (anon default ACL 0), 160000 (6
scout_aggregator edges into dropped_duplicate).
Live writes, each on Teja's word in this window: 213 stale failure_reason cleared · 52 tech-gate rows recovered to
passed_filters · `Leader` + `Leadership` added to excluded_keywords · W19 never-signed-in auth user deleted.

## Do first (next orch)
1. **Deploy T12's functions from `1158066`**: screener, scout-ats, matcher, auditor, job-link-intake (they bundle
   screen-batch/cascade/context), plus email-tracker-intake (type-only). The export already exists at
   `%TEMP%\applyyy-export-1158066`. Check CI on 1158066 first.
2. **T16 is UNCOMMITTED in the tree** (peer 2, gated, NOT re-gated by the orch): it deletes the dead onPreflight /
   preflightBatch path in 8 apps/web files. Bridge `C:\Users\tejam\applyyy-handoff-keep\2026-11-10-1345-peer2.md`;
   byte backup `...\2026-11-10-1355-wip\`. Re-gate the web (tsc, test-tsc, `vite build --mode e2e`, node --test) and
   commit. Also fix 2 stale doc lines: docs/product/features/approval-queue.md:147-148, resume-tailoring.md:260.
3. The T12 sweep runs on the next scout-remote run: it moves the 3 Jobicy copies sitting in awaiting_approval
   (Supabase "SDK Engineer - Python", Canonical "Python Engineer", Canonical "Python and Kubernetes…", the Remote
   copies) to dropped_duplicate. Teja was told not to approve those copies. Verify after the run.

## Waiting on Teja (asked, not answered)
- **Ashby robots A/B** (T15 on hold): jobs.ashbyhq.com robots says `Disallow: /api/`, and the form SPA calls
  /api/non-user-graphql by itself. A = robots governs the URLs the bot chooses to fetch (recommended); B = every
  Ashby row (15: Ramp approved + 14 queued) goes to the Manual lane. Peer 4's single Ramp render showed the bot reads
  `file REQ "Resume"`, so the gate doesn't park Ashby. Bridge `...\2026-11-10-1325-peer4.md`.
- **Answer bank Save** on first_name, last_name, degree, school, discipline (unattested since T8, so split-name
  forms park).
- **"retry dedup"**: clear the stale drop_reason on the 51 live rows from the 52-row recovery (the orch's miss).
  Blocked twice by the classifier ("Modify Shared Resources"); MCP execute_sql ran writes only after Teja's
  explicit word.
- 4 swap cases (Supabase Branching approved Jobicy copy, Supabase Storage, Deepgram, Twilio): see the 12:38 analysis.
  The sweep never touches approved or later rows, or rows whose twin isn't live.
- Approve TrueFoundry d0a7d313 · re-run 38bb2f12 on the new tailor · re-tailor the 67 queued rows without an AI group
  (ruling "never re-tailor the queue" stands until he says so) · close the intro-bullet pattern (T11, optional).

## Rulings today (in memory files)
W10: remove the company cap, never skip by age · `Leader` excluded · every resume carries an AI group with ≥5 AI skills ·
the assistant does group/skill/point edits, master or dictated content only · Cadence row kept · worker e2e fixed,
not retired · freshness-queue.ts kept (W23) · no Vercel "wait for checks" (W38) · resume-chat Apply may write the
master · one-typo group-name match kept.

## Gotchas learned
- gitleaks generic-api-key fires on comments like "key …, 1..v_key_count". Real gitleaks has stopwords: the same
  `extractJdKeywords, keywordAppearsIn` import line passed on 11-07.
- Node maps `/tmp` to `C:\tmp`; Git Bash maps it to AppData\Local\Temp. Pass absolute Windows paths to `-f`.
- `on conflict do nothing` on transitions silently skips an existing edge: pre-check before applying.
- A migration must sort after the last applied one, or db push refuses it.
- The web edit gate refuses only a NEW rule break (count-free rule key), so non-compliant queue rows stay editable.
- 52 old worktrees remain in %TEMP%. Teja said ignore. The safe script is in `applyyy-handoff-keep` (junctions point
  into the main node_modules).
