# Orchestrator handoff — 2026-11-07 00:45 IST

**Resume here.** True as of 2026-11-07 00:45 IST. Open work: [2026-11-07-0045-pending-tasks.md](2026-11-07-0045-pending-tasks.md).
This pair replaces every earlier handoff. The older files were deleted on Teja's order (00:32); git history keeps
them. Re-measure every number before you build on it (CLAUDE.md §2: a handoff is data).

Written by orchestrator applyyy-9f (session dc6fc912). Sources: `git log`, live SELECTs at 00:3x, and the peers'
bridge files in `C:\Users\tejam\applyyy-handoff-keep\` (`peer1.md` … `peer5.md`; outside TEMP on purpose).

## Progress: 71% (5 of 7 stages)

Goal: one human-approved pipeline that runs end to end for real (discovered → screened → tailored → approved →
submitted → confirmed applied → tracked). Five stages work live. **The gap is still the first real submit (P0).**
Enterpret is approved; only Teja's password line in `.env` stands between it and the run. "Confirmed applied"
(stage 6) stays ON HOLD by Teja's ruling.

## Where things stand

- **origin/main = `4397a8d`** (or later if peers 3 and 5 committed after 00:45; read `git log origin/main..main`).
- **Deployed tonight (00:32–00:34 IST, from `e780ede`, all with `--import-map`):** screener, matcher, scout-ats,
  scout-web, auditor, job-link-intake. Verified by `updated_at` in `list_edge_functions`.
- **Pushed, NOT deployed:**
  - `4397a8d` (work-auth regex hardening). Its behaviour is the same as live: the corpus diff showed 0 India rows
    change. Deploy screener, matcher, auditor, scout-ats when convenient.
  - `c869a70` resume-assist (honest notes). Deploy `resume-assist`; no order constraint.
  - `5a3009b` + `630d6b5` tailor (skills floor + keep rule). **DO NOT DEPLOY `tailor`.** The review returned
    BLOCK (pending P0 #2).
- **Web** auto-deploys on push. The new things live there:
  - `e56c69f` Resume preview button.
  - `17e982c` AI chat docked on the right of the Approval queue.
  - `c869a70` chat honesty guard.
  - No sentinel check has been run on these yet.
- **Master profile = v19.**
  - v16: Claude Code.
  - v17: +9 skills (C, Python Scripting, Debugging & Troubleshooting, Integration/Unit Testing, Technical
    Documentation, Agile, Process Automation, Playwright Testing).
  - v18: +4 bullets, and Student Tribe now ends Feb 2025.
  - v19: Teja's own UI save, adding "Debugging".
  - Build every master write on the highest version.

## Shipped tonight (all pushed)

| SHA | What | Peer |
|---|---|---|
| `e56c69f` | Manual apply: a "Resume preview" button (Hide is broken; see pending) | 1 |
| `2fe0264` | SmartRecruiters adapter deleted (P2 #1 of the old list) | 2 |
| `69269c2` | Work-auth gate: Kuwait, Bahrain, Oman, Jordan, Lebanon, Iraq, Egypt, Turkey + Arabic aliases | 5 |
| `87bd325` | Assist: G1 robots gate before the claim; G2 latest-master identity, null master refused | 3 |
| `e780ede` | Screener title rules: AVP/VP/Intermediate (`title_seniority`), PhD (`title_phd`), non-software (`title_non_software`) | 1 |
| `4397a8d` | Work-auth regex hardening (`\p{L}` lookahead, non-vacuous negatives) | 1 |
| `5a3009b` `630d6b5` | Tailor skills floor + JD-keyword keep rule (**BLOCKED for deploy**) | 2 |
| `fa809ce` | vercel.json: no preview deploys for `automation-keepalive` | 2 |
| `17e982c` `c869a70` | AI resume chat docked right of the Approval queue; honest replies; traced master skills | 4 |

## Live writes tonight (all on Teja's word, in this window)

| When (IST) | What |
|---|---|
| 23:05 | master v16 (Claude Code in Tools, after Cursor) |
| 23:40 | master v17 (+9 skills) |
| 00:03 | master v18 (+4 bullets; Student Tribe ends Feb 2025) |
| 00:3x | Gushwork 207dd30d failed → needs_verification (`source: orchestrator_reopen`; Lever lists it OPEN) |
| 00:3x | root `.env`: SUPABASE_URL, SUPABASE_ANON_KEY, APPLYY_APP_USER_EMAIL added; APPLYY_APP_USER_PASSWORD left EMPTY for Teja |

## Teja's rulings tonight

| Ruling | State |
|---|---|
| 9f is the orchestrator; the orch assigns and reports and never builds | In CLAUDE.md already (global "Orchestrator mode"); no edit |
| Matcher score floor 45 STAYS (he said "remove" at 23:33, then "keep" at 23:35) | Memory `applyyy-matcher-keeps-poor-scores` corrected |
| Title rules: AVP/VP/Asst VP, PhD, "Intermediate", non-software roles all drop | Shipped `e780ede`, deployed |
| Tailored resume: only JD-relevant master groups (3–5), ≥4 skills each, ranked by the JD | Built `5a3009b`, BLOCKED (pending P0 #2) |
| Old tailored resumes must be re-tailored with the new master | Plan in `peer2.md`; not run |
| AI chat docks on the right in the Approval queue, one thread per job | Shipped `17e982c` |
| Axiad: check Gmail first; Gushwork: check Lever | Axiad NOT submitted (428 = Greenhouse email security code); Gushwork OPEN, re-opened |
| Commit everything that's green; holding commits causes problems | Pushed all green commits by 00:40 |
| Delete stale handoff docs | Done in this commit |

## Traps learned tonight

- **A resumed session clones the peer's identity.** applyyy-29 [e4571e] was a resumed copy of peer 1's
  conversation and signed as "peer 1 (d814f2)". Two sessions split one parcel. Check the `[ref]` in ListAgents,
  never the name a session gives itself.
- **`git commit --amend` on a shared tree rewrites the PEER's commit** when theirs is HEAD. It happened to
  67b55e7. CLAUDE.md §2 now bans amend.
- **`guard_failed_rerun` blocks failed → passed_filters for a row that was once approved** (migration
  `20261102203000`). Re-open such a row with failed → needs_verification ({human}). needs_verification →
  approved is also {human}.
- **A script run under Teja's JWT logs as agent=human.** On 11-05 at 13:59:49, 8 approved rows were failed by a
  one-off SQL retro (stages `retro_liveness_2026_11_05` / `retro_pre_gate_2026_11_05`). Teja never saw them go.
- **Before `6f91221` (11-05 20:29), Manual apply hid plain `approved` rows that had no kit.**
- **RemoteOK sends double-encoded UTF-8** (mojibake). The country gate could not read "Dubai". Peer 3 is fixing
  it at the feed boundary.
- **The live master has a skill named "C".** Any keyword check must not count "C++", "C#" or "C-level" as "C".
- **The Supabase CLI's last output line is an update notice**, not the deploy result. Verify a deploy by
  `updated_at` in `list_edge_functions`.
- **`applications` has no company/title columns.** Join `jobs` (`company_name`, `title`, `description_raw`,
  `discovered_via`).

## Sessions

Peers this session (Teja's numbers):
- peer 1 = applyyy-cb [d814f2]
- peer 2 = applyyy-cb [f5fa6c]
- peer 3 = Peer session [5025f5] (was applyyy-0e)
- peer 4 = applyyy-33 [1d3fb3]
- peer 5 = applyyy-29 [e4571e]

All were told to stop at 00:34 after committing green work. Teja is closing every session. Their bridge files are
the record of anything left on disk.
