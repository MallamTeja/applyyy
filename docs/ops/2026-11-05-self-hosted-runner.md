# Self-hosted runner for live submits — design (2026-11-05)

> **Status 2026-11-08:** Current (design only, not built). `.github/workflows/apply.yml` still has only the `apply` and `redispatch` jobs, both `runs-on: ubuntu-latest` (`apply.yml:70`, `apply.yml:278`); no `apply-home` job or `applyy-home` label exists in any workflow. No bot submit has been proven yet; the next live target is a TrueFoundry row (`docs/handoff/2026-11-08-1745-orchestrator-handoff.md`). The runner is still an open item in `docs/handoff/2026-11-08-1745-pending-tasks.md` (item 13). The body below is the original record, unedited.

**Status: DECISION PENDING two proofs.** Option (c) (today's behaviour) stays until both pass;
only then is option (a) built. Ruled by the orchestrator on 2026-11-05 ~21:10 IST.

## The problem

Apply-on-approve (`dispatch-apply` → `apply.yml`) runs the live submit on GitHub-hosted
runners, which have datacenter IPs. Greenhouse's reCAPTCHA has refused every CI live
submit so far (0 of 7 landed). Submits from Teja's PC (a residential IP) are expected to
pass, but that is not proven yet.

## The two proofs that gate the build

1. **Headed, residential:** the 1-job live proof on Enterpret (`e1456a47…`), run locally
   with `HEADED=1` (a visible browser). Proves a residential IP passes at all.
2. **Headless, residential:** one more local live run on another approved row with
   `HEADED` unset. A Windows **service** runs in session 0, which has no desktop, so it
   can only run headless, and reCAPTCHA v3 scores the headless fingerprint too.

| Outcome | Then |
|---|---|
| Both pass | Build (a) and install the runner as a service |
| Only headed passes | (a) as an *interactive* runner (`run.cmd` at logon: live only while Teja is logged in), or stay with `assist.ts` (Teja clicks Submit) |
| Headed fails | Stay on (c); the IP is not the deciding factor |

## The options compared

| | (a) Self-hosted runner on Teja's PC | (b) Task Scheduler poller | (c) CI + captcha park (today) |
|---|---|---|---|
| Trigger | Immediate: approve → `dispatch-apply` → `apply.yml` | Every N minutes; approve does not trigger it | Immediate |
| Guards | All existing ones (Guard 1/2, the breaker, the B2 re-check, robots, kill switch) | The worker's guards only; the workflow's shell guards are lost | All existing ones |
| Code it runs | `main` at the dispatched ref, clean checkout | **Must not** be the shared working tree (it holds peers' uncommitted edits), so it needs a dedicated clean clone: a hand-built runner | `main`, clean |
| Secrets | GitHub secrets, scoped to the job | The password stored on the PC (a file or Credential Manager) | GitHub secrets |
| Audit trail | Actions logs + `agent_runs` | `agent_runs` only | Actions logs + `agent_runs` |
| Cost | $0 (self-hosted minutes are free; it also saves CI minutes) | $0 | CI minutes |
| Main risk | A **persistent** machine runs `main`'s code and its `pnpm install` scripts | Same, plus no isolation from the shared tree | ~0 automatic Greenhouse submits; rows land in Manual apply |

**Recommendation: (a)**, gated on the proofs above. (b) is strictly worse than (a). (c) is
the right interim: kits are now built on every approve, so a captcha-parked row is ready
to finish by hand.

### Security for (a)

- The repo is private (`MallamTeja/applyyy`, verified `isPrivate: true` on 2026-11-05).
- Only the live apply job targets the runner label `applyy-home`; no `pull_request` job may
  ever target it.
- The service runs as a dedicated **Standard** Windows account (`applyy-runner`), never
  Teja's own account.
- Installs stay `--frozen-lockfile`; actions stay SHA-pinned (already true).
- The job token stays scoped: workflow `permissions: contents: read` (already true); only
  the separate `redispatch` job holds `actions: write`, and that job stays on ubuntu.

### When the PC is off or asleep

The live job waits as "Queued", and GitHub cancels a queued job after 24 hours
(`timeout-minutes` counts only once a job starts). Nothing is harmed: the row stays
`approved` with no lease, and the next approve dispatches again.

## Does the current path work unchanged with (a)?

- `dispatch-apply`: **yes**, unchanged (same dispatch URL, same inputs).
- `apply.yml`: **no.** Today it is Linux-only:
  - `runs-on: ubuntu-latest`;
  - `playwright install --with-deps` and `playwright install-deps` use apt;
  - the Playwright cache path is `~/.cache/ms-playwright` (Windows uses
    `%LOCALAPPDATA%\ms-playwright`);
  - its `run: |` scripts are bash, while a Windows runner defaults to pwsh, so they need
    `shell: bash` (Git Bash on the service account's PATH).

The build therefore adds a second job, `apply-home`, for live dispatches only. Dry and cron
runs stay on ubuntu, so W30's dry-by-default holds there. Two jobs, rather than a `runs-on`
expression, because GitHub expressions compare case-insensitively (W30); the exact check
stays in each job's shell guard.

## What a build touches (a peer builds it)

- `.github/workflows/apply.yml`:
  - an `apply-home` job on `[self-hosted, windows, applyy-home]` with Windows-safe steps
    (`shell: bash`, no `install-deps`, the Windows cache path, `playwright install chromium`);
  - the routing: only `workflow_dispatch` with `dry_run` exactly `"false"` reaches it;
  - the `redispatch` job's `needs` covering both apply jobs.
- `worker/test/apply-workflow-dry-run.test.ts`: `stepScript` finds "Run the applier" by
  name, so two jobs make it ambiguous. Pin both jobs, and pin that only live dispatches
  reach `apply-home`.
- `worker/test/run-window.test.ts`: the pinned timeouts become `[60, 60, 5]`.
- No worker source and no edge function changes. `apply-kit.yml` stays on ubuntu (a kit
  never submits).
- Verify after the build: one DRY dispatch routed to `apply-home` with `apply_only_id` set,
  then one live `apply_only_id` run. Each change keeps a red-on-revert test.

## Teja's one-time steps (only after both proofs pass)

1. **Dedicated account.** Windows Settings → Accounts → Other users → "Add account" → "I
   don't have this person's sign-in information" → "Add a user without a Microsoft
   account" → name `applyy-runner`, set a password; leave it a Standard user.
   *Confirm:* it is listed under Other users as "Local account".
2. **Runner token.** Browser → https://github.com/MallamTeja/applyyy/settings/actions/runners
   → "New self-hosted runner" → Windows, x64. The page shows the download commands and a
   token valid for one hour. Never paste the token into a chat.
3. **Install.** Start menu → "Windows PowerShell" → right-click → Run as administrator →
   in `C:\actions-runner`, run the page's download and extract lines, then:
   ```
   ./config.cmd --url https://github.com/MallamTeja/applyyy --token <token from the page> --name teja-pc --labels applyy-home --runasservice --windowslogonaccount .\applyy-runner --windowslogonpassword <that account's password>
   ```
   For the interactive variant, leave out the three service flags and later run `run.cmd`
   while logged in.
   *Confirm:* the runners page lists "teja-pc" with a green "Idle".
4. **Keep it awake.** Windows Settings → System → Power & battery → Screen and sleep →
   "When plugged in, put my device to sleep after" = Never.
5. **Dependencies:** nothing to do. Node 24 and Git for Windows are installed system-wide,
   and pnpm comes from `pnpm/action-setup` in the job.

## Rollback

Same runners page → teja-pc → "Remove" (and, optionally, delete the `applyy-runner`
account). Live jobs then queue and expire after 24 h; dry and cron runs are unaffected.
Reverting the `apply.yml` commit restores today's routing.
