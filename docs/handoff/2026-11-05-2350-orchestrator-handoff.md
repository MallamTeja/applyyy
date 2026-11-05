# Orchestrator handoff — 2026-11-05 23:50 IST

**Resume here.** True as of 2026-11-05 ~23:55 IST. Open work is in
[2026-11-05-2350-pending-tasks.md](2026-11-05-2350-pending-tasks.md). This pair supersedes the 14:40 pair
([2026-11-05-1440-orchestrator-handoff.md](2026-11-05-1440-orchestrator-handoff.md)); every item still open
there is carried in the new pending list, and every item that shipped is closed there with its SHA.
Re-measure every number before you build on it (CLAUDE.md §2: a handoff is data).

Sources: `git log 1341608..origin/main` (70 commits), the 14:40 pending list, the retiring peers' handoff files
(`%TEMP%\applyyy-handoff\{ae,f7,bf}.md`), and facts from the
orchestrator (applyyy-09) that git cannot show. Live numbers marked "23:56" were re-read by SELECT at that time.

## Progress: 71% (5 of 7 stages)

Goal: one human-approved pipeline end-to-end for real (discovered → screened → tailored → approved → submitted
→ confirmed applied → tracked). Five stages work live. **The gap is the first real submit** ("submitted" has
no live proof yet, and the automatic "confirmed applied" step is ON HOLD by Teja's ruling). Re-derive this
at ask time.

## Where things stand

- **origin/main = `783940f`** (bf's T1-T4 worker form reads; `87a7ade` before it, both pushed). CI last
  verified green at `54fc2c7`. **Local main is ahead:** `c6391ef` (09's CLAUDE.md §3 commit) and this docs
  commit; the orchestrator (applyyy-8b) pushes them.
- **In flight at 00:00:** postscreen-drain run 42073925051 (started 22:52, dispatch-only; the 32 re-run rows
  return to awaiting_approval) and apply-kit run 42084465698 (Enterpret `e1456a47` rebuild, 23:57). Read both.
- **Live bridge from 09:** `C:\Users\tejam\AppData\Local\Temp\applyyy-handoff\orch-09.md`.
- **The 14:40 held stack shipped:** `625a437`, `e63f979`, `c4e57c0`, `009f216` are on origin/main, with the
  P1-6 fix-up `a157d7f` on top.
- **Uncommitted on disk (NOT abandoned, CLAUDE.md §2):** `CLAUDE.md` (the orchestrator's);
  `apps/web/src/features/manual-apply/{applyKit,manualApplyData}.ts` (owner unknown at writing: ask before
  touching). None of the three retiring peers left uncommitted files.
- **Live counts (SELECT, 23:56):** dropped_filter 34,177 · passed_filters 247 · failed 81 · scored 66 ·
  awaiting_approval 7 · applied 4 · approved 3.
- **Database:** 514 MB → **137 MB** after the tombstone back-fill (22,945 rows) and `VACUUM FULL` at 20:02.
  156 MB at 23:56 (normal growth plus the new table). Under the 500 MB Free quota.
- **Migrations applied tonight:** `20261105140000`, `200000`, `201000`, `202000`, `203000` (applied with
  `--include-all`, out of order), `220000`, `230000`. All ten `20261105*` versions are in
  `supabase_migrations.schema_migrations` (23:56).
- **Functions:** 18 redeployed with `--import-map` after `bb55391` (CLAUDE.md §3).
- **Security (P2) is live:** CORS allowlist + `Access-Control-Max-Age` 86400; definer-function EXECUTE and
  TRUNCATE revokes verified (false/false/0); gitleaks proven on PR #2 (run 42074688093, "leaks found: 1";
  PR closed).
- **Jobs tombstone:** weekly workflow `jobs-tombstone.yml` (Sundays 06:45 UTC); its first run succeeded; the
  `jobs_tombstone` cadence is on the health page (`298f34a`). **Edge-1 proven live (23:56):** 8,789 tombstones
  were re-sighted by a scan and stayed slim (`raw_payload` and `description_raw` still null).
- **Unanswered questions (`4f37c97`) is live:** migration `20261105230000` applied, 98 back-fill rows.

## Teja's rulings tonight

| Ruling | State |
|---|---|
| Retro drop 11 queue rows; keep Cadence PM, Rubrik PM, HPE College | Done. Rubrik PM and HPE College were later dropped by the drain gate, per Teja |
| NO minimum-score drop | Standing (memory `applyyy-matcher-keeps-poor-scores`) |
| P2 security: start | Started and done (see above) |
| Enterpret chosen as the proof row | Recorded; used by the first-submit proof |
| Bangalore relocation answer = Yes | `answer_bank` row `89d99b73` |
| KEEP `tejamallam.me` | Standing |
| Re-run the 32 v9/v11 awaiting rows + drain (21:16) | Done |
| An attested answer on the EXACT label may answer EEO / eligibility questions (23:19). Consent checkboxes stay NEVER | Build pending (bf's H1 hook) |
| WhatsApp alerts via Meta Cloud API | PENDING: Teja must do the Meta setup first; build later |
| Receipt-confirm (stage 6, `needs_verification → applied` automation) | ON HOLD |
| Gmail fetches when the Email page opens | Requirement noted, not built |
| Leaked-password protection | NOT POSSIBLE on the Free plan |
| Self-hosted runner for live submits | Pending 2 proofs (headed + headless); design in `docs/ops/2026-11-05-self-hosted-runner.md` |

## Open with Teja (decide first)

**The first live submit.** Option A: CI (`gh workflow run apply.yml --ref main -f dry_run=false
-f apply_only_id=<uuid>`), risk: reCAPTCHA on a datacenter IP. Option B: local headed via `assist.ts`, needs
an `APPLYY_APP_USER_PASSWORD` line in the git-ignored root `.env`. The live AI chat e2e also needs B.
**`APPLYY_E2E_PASSWORD` in `.env` is WRONG** (400 `invalid_credentials`).

## Traps learned tonight

- **`--use-api` ignores `deno.json`.** Every deploy needs `--import-map supabase/functions/deno.json` since
  `bb55391` (CLAUDE.md §3).
- **Moving an export breaks the worker.** `worker/` imports function code by relative path; `7a98b79` broke it
  until `54fc2c7`. Gate worker tsc + vitest on any `supabase/functions` export move.
- **A chained check + push violated rule 5a.** The orchestrator pushed ae's unreported commits under `7a98b79`.
  Run the check, read it, then push.
- **Never retype a SHA.** A hand-typed full SHA pushed the wrong commit. Copy SHAs from `git log` output.
- **Windows case collision:** `Foo.tsx` + `foo.ts` in one directory breaks tsc (TS1261); name the pure file
  `fooView.ts`.
- **0 fields ≠ closed:** Ashby renders after `goto`; Lever text inputs are invisible to `extractFields`
  (memory `applyyy-form-extract-ashby-lever-traps`).
- **E2E_DIST_STALE:** any peer edit under `apps/web/src` makes `dist` older than source and fails every e2e
  test. Gate in an isolated worktree (f7's is `%TEMP%\applyyy-p3-gate`).
- **PGlite proof harness** (ae): real Postgres 17 in WASM, outside the repo, at
  `C:\Users\tejam\AppData\Local\Temp\claude\2bf4570b4444f56a\9c909f6f-d548-4f8e-ad9a-8ddae8aa0dde\scratchpad\pg\`.
  Prove a migration there; `db push --dry-run` validates nothing semantic. It is in TEMP: copy it before it goes.

## Roster (since 2026-11-06 00:00)

Retired at 23:48: ae (security, tombstone, unanswered questions), f7 (approvals perf, AI chat), bf (worker form
reads `783940f`, runner design; H1/H2 not started). Orchestrator applyyy-09 retired at 23:59 (Teja).

| Role | Session | Owns |
|---|---|---|
| Orchestrator | applyyy-8b | decides, pushes, deploys, live writes |
| Peer 1 | applyyy-27 | `worker/**`, apply-kit pipeline: K1 → K2 → H1 → H2 → Cursor Ashby |
| Peer 2 | applyyy-7f | `apps/web/**`: Manual apply resume, kit-skip reason, A1, A3, A4 |
| Peer 3 | applyyy-fe | `supabase/functions/**`, new migrations, `docs/` |
