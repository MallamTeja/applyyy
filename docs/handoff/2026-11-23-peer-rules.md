# Peer rules + ownership — round of 2026-11-23 20:00 IST

Orch: **applyyy-c9** (took over from applyyy-31 at 19:57 on Teja's own line: "take the control over"). Previous peers
(applyyy-27, applyyy-d2) are gone. Plan source: the SEQUENCED PLAN at the top of
`docs/handoff/2026-11-12-1305-pending-tasks.md`.
Base: `main` = `origin/main` = 90d29981. The tree carries UNCOMMITTED work of gone peers (bridges
`2026-11-21-peer-1-r10.md`, `2026-11-21-peer-5-r10.md`, plus applyyy-27 / applyyy-d2 work from 19:20-19:55 today
with no bridge). It is inherited, not abandoned: build on it, never revert it.

## Rules (all peers)
- Write only the files in your row. A file you need outside it: stop and ask the orch.
- Never `git add` / commit / push / stash / checkout. Never deploy. Never write live DB rows (SELECT only).
  Never dispatch a GitHub workflow. Live SQL, migrations and dispatches go to the orch as exact statements.
  The orch bundles, commits, deploys.
- Comment rule: every code line carries a WHY comment (source >= 1.00 comment/code); `{/* */}` between JSX tags.
- Gates: see repo `CLAUDE.md` §5 (count Deno files; tests: report pass + fail + cancelled; red-on-revert per fix).
- Fan out read-only recon subagents in ONE parallel message before reading serially. No subagent cap.
- Report: bridge `docs/handoff/2026-11-23-peer-<n>.md` + ONE message to applyyy-c9 (<= 8 lines). No acks, no pings.
  Blockers and decision requests: one message, with a recommendation.
- Ship in increments: when a gated slice is ready, report it (file list to stage + gate output) and keep working.

## Ownership
| Peer | Feature | Owns (write) |
|---|---|---|
| 1 (applyyy-6f) | Resume chat: ship the r10 increment, then S9i P2 server-side apply (web half: no Apply buttons, server outcome list), S9h, S9j op wiring (move_section/entry/bullet), personal-details refusal, masterStore/masterAdd twins | `supabase/functions/resume-assist/**`, `supabase/functions/_shared/resume-edit/**`, `supabase/functions/_shared/text/**`, `apps/web/src/features/approval/**`, `apps/web/src/features/settings/master*.ts`, `apps/web/src/app/safeHref.ts`, `apps/web/tsconfig.json`, `apps/web/test/aiEdit*.test.ts`, `attest*.test.ts`, `resumePreview.test.ts`, `skillLineWrap.test.ts`, `tailoredEdits.test.ts`, `pageFitE2e.test.ts`, `supabase/functions/deno.json` |
| 2 (applyyy-a8) | Screening: S13 seniority drop (AVP/VP/Director) to ship-ready + migration 20261121203000 statement; jd-refetch zero-candidate check; own the uncommitted `_shared/email` edits (find their purpose, gate or report) | `supabase/functions/_shared/screen/**`, `supabase/functions/auditor/**`, `supabase/functions/jd-refetch/**`, `supabase/functions/_shared/email/**`, `supabase/migrations/20261121203000_*.sql` |
| 3 (applyyy-0b) | Discovered page missing rows (filter-rules read failure hides loaded rows, bug-24 missing-jobs counter) + e2e debt (scanClock red-on-revert + 6x throttle, shellNoRefetchOnNav test 3 timeout) | `apps/web/src/features/discovery/**`, `apps/web/src/data/discoveryService.ts`, `apps/web/test/discoveredMissingJob.test.ts`, `scanClockE2e.test.ts`, `shellNoRefetchOnNavE2e.test.ts`, `apps/web/src/app/` shell files except `safeHref.ts` |
| 5 (applyyy-09) | Location leak (Teja 20:00 IST: "rm the most recent java job because it needs germany … make filter which removes it"): identify the row, prepare the drop statement for the orch, close the gate gap so such JDs drop | `supabase/functions/_shared/screen/work-auth-gate.ts` + `work-auth-gate*.test.ts` (carved OUT of peer 2's `_shared/screen/**`), `supabase/functions/_shared/location/**` if it exists, NEW `supabase/functions/_shared/screen/language-gate*.ts` (row 5e108a32 dropped by orch 20:04 IST; rule = required language Teja lacks, not work_auth) |
| 4 (applyyy-d3) | r1 DONE (apply readiness, 0/8 bot-submittable, bridge peer-4). r2: D5 scout drift: converge worker cli scout vs edge scout-ats/scout-web into `_shared/scout/` | `worker/**`, `.github/workflows/apply.yml`, `supabase/functions/scout-ats/**`, `supabase/functions/scout-web/**`, NEW `supabase/functions/_shared/scout/**` |
| 2 (applyyy-a8) r2 grants | email fixture + W1 + D15 | `supabase/functions/email-tracker-intake/decide.test.ts`, `.github/workflows/scout.yml`, `scout-remote.yml`, `prescreen-drain.yml` (comments only) |

Untouchable by all: `pm.html`, `q.json`, `u.html` (unknown author), `pnpm-lock.yaml`, everything not listed.
E2E runs: from an isolated `git archive` export + your files copied in (the shared `apps/web/dist` goes stale).
