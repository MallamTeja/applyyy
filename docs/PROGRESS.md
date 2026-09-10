# `applyy` — live progress

**Last updated: 2026-09-09 23:57 IST** · maintained by session `applyyy-b3`
(root config + `PROJECT_PLAN.md` + `docs/**`)

Evidence rule for this document: a row says **SHIPPED** only when something was
verified — a test count, a captured exit code, a file on disk. Where the
evidence is a peer's own report rather than my measurement, the row says so.
Nothing here is written in the past tense until it is actually true.

---

## Per-stream status

| Stream | Owns | Shipped | In progress | Blocked on |
|---|---|---|---|---|
| **applyyy-aa** | `supabase/migrations/**`, `packages/shared-types/**` | `@applyy/shared-types` importable — `enums.ts`, `status-flow.ts`, `tables.ts`, `index.ts`; 12 enums, ~45-edge status graph with `canTransition`/`nextStatuses`/`isTerminal`, Row/Insert/Update for all 14 tables + RPC signatures *(aa's report)* | Migrations | — |
| **applyyy-d0** | `supabase/functions/**` | `fingerprint.ts` (18 tests) + `posted-at.ts` (14 tests) = **32/32 green, red verified before each green** *(d0's report)* | Tailor validator, then injection suite | — |
| **applyyy-04** | `packages/resume-template/**` | §20 step-0 spike **PASSED**: one `.ts` source, zero build step, imported by Node 24.14.0 + Deno 2.9.6 + Vite 7.3.6, byte-identical sha256, `deno check` clean across package boundary *(04's report)* | Real template | — |
| **applyyy-21** | `worker/**`, `.github/workflows/**` | Worker skeleton, `vitest.config.ts`, TDD red observed on the §19 fixture server *(21's report)* | Fixture server | Was on a `node_modules/.bin/vitest` workaround; **now unblocked**, told to retire it |
| **applyyy-76** | `apps/web/**` | **Reported, NOT VERIFIED — see note** | Scaffold + diff view + two-bucket gate, importing `@applyy/shared-types`; `supabase.ts` throws at boot unless the anon key's JWT `role` claim reads `anon`; `humanLanes.ts` derives **11** human-only edges from `STATUS_TRANSITIONS` *(76's report)* | — |
| **applyyy-b3** (me) | root config, `PROJECT_PLAN.md`, `docs/**` | `.gitignore`; `tsconfig.base.json` settled; `pnpm-workspace.yaml` build allowlist; `pnpm install` **exit 0 verified**; audit doc | `PROJECT_PLAN.md` reconciliation; naming sweep | — |
| **applyyy-d8** | orchestration | — | `.env` key rename `gemini1…6` → `GEMINI_API_KEY_01…_15` | — |
| **applyyy-e5** | *(dead ~23:34)* | Root scaffold | — | Stream inherited by b3 |

---

## Verified by me, not reported

| Check | Result |
|---|---|
| `pnpm install` | **PASSES** — exit 0, `ERR_PNPM_IGNORED_BUILDS` gone. Corrected fix, see below |
| `pnpm -r run test` | **FAILS — exit 1.** Not fixed. See below |
| Non-erasable TS syntax anywhere in repo | **None** — no `enum`, `namespace`, or constructor parameter properties, so `erasableSyntaxOnly` breaks nobody |
| `.env` ignored by git | **Yes** — `git check-ignore` confirms |
| Live git remote | `github.com/MallamTeja/applyy` (two y's) — **but see "unknowns"** |

**`applyyy-76` has not compiled its work.** It reported the above and stated
explicitly that it had not yet run `pnpm install` and would not claim the app
builds until it had. Recorded as unverified for that reason — the honest state
is "written, not yet proven to compile."

### Git state — committed locally, NOT pushed

| | |
|---|---|
| First commit | `0cd33a8` — 50 files, 8,461 insertions *(made by `applyyy-d8`)* |
| Secret scan before commit | Clean — no `AIza`/`sbp_`/JWT/PEM/`ghp_` hits *(d8's report)* |
| `.env`, `.env.*`, `bash.exe.stackdump` | Confirmed ignored |
| **Push** | **FAILED.** `remote: Repository not found` on `MallamTeja/applyy` |

The push failure is almost certainly **auth, not a missing repo**: GitHub returns
404 rather than 403 for private repos so as not to leak whether they exist, and
`gh` is unauthenticated with no git credential helper configured. It does *not*
prove the rename didn't happen — and it doesn't prove it did either. `gh repo
view MallamTeja/applyy` after `gh auth login` settles it.

> **Unverified rule change, flagged rather than adopted.** `applyyy-d8` reports
> that Teja lifted the never-commit/never-push rule *for the orchestrator only*
> at 23:45, and committed on that basis. I cannot confirm it — it happened in
> another session — and it contradicts a standing rule in `CLAUDE.md`. Recorded
> as reported, not as settled. **Peers, including me, still never commit or
> push.** Teja: if this is wrong, `0cd33a8` is a local commit you can reset.

**`pnpm -r run test` is still red**, and I want that stated plainly rather than
buried: `packages/resume-template` exits 1 with `MODULE_NOT_FOUND` on its own
`test/` directory, which contains only an empty `fixtures/` folder — so
`node --test test/` has nothing to load. `worker test` also reports Failed.
Both belong to other streams and both are mid-work, not defects. What *is*
fixed is the build gate that used to fail *before* any script ran.

---

## A wrong fix I shipped and then corrected — worth reading

At 23:43 I reported the pnpm build gate fixed. **It wasn't, and my test was
confounded.** Recording it because the mistake is more instructive than the fix.

I set `onlyBuiltDependencies` (pnpm 10's spelling), saw the error persist, ran
`pnpm rebuild`, then `pnpm install`, got exit 0, and called it green.

`pnpm rebuild` runs postinstall scripts **unconditionally, ignoring the
allowlist entirely.** So it produced the esbuild binaries itself, and the next
install had nothing left to complain about. I had proven that *my machine* was
fixed while the *repo* was not — a clean clone or a GitHub Actions runner has no
prior rebuild and would have failed immediately. Exactly the invisible-locally,
fatal-in-CI shape we'd both flagged for Playwright.

`applyyy-04` caught it, and the tell needed no experiment: **pnpm 11 had
auto-appended `allowBuilds: esbuild: set this to true or false` to the file
while my `onlyBuiltDependencies` list already named esbuild above it.** pnpm
does not ask for a decision it already has.

Isolated three-way experiment, fresh `node_modules` each run, no rebuild:

| Config | `pnpm install` |
|---|---|
| `onlyBuiltDependencies` alone | exit **1** |
| `allowBuilds: {esbuild: true}` | exit **0** |
| both, with pnpm's placeholder string | exit **1** |

So `allowBuilds` with real booleans is causal; the pnpm 10 key is inert in
pnpm 11; and an unanswered placeholder counts as *undecided*, not *allowed*.
Now set correctly for esbuild, playwright and @playwright/test.

**Two transferable lessons.** First: *never verify a fix with a command that
can produce the outcome by itself* — `pnpm rebuild` did the work the config was
supposed to authorise. Second: I also read `$?` after piping through `tail`
earlier, which returns `tail`'s status, so it would have reported success no
matter what pnpm did. Both errors made a broken thing look fixed, which is the
only class of testing error that actually costs you something.

## Coordination errors — including the coordinator's

Logged by name and at `applyyy-d8`'s own request. A progress doc that records
only the workers' mistakes and not the coordinator's would be exactly the
selective honesty this project is supposed to avoid.

**`applyyy-d8`, two errors, one root cause.** It relayed my wrong
`onlyBuiltDependencies` finding to four peers *as fact* — including telling
`applyyy-04` its (correct) `allowBuilds` spelling "would have been silently
ignored." And it relayed "three human-only lanes" from `aa`'s prose when the
status graph actually has **eleven**; `applyyy-76` caught it by deriving them
from `STATUS_TRANSITIONS` rather than trusting the summary, and also found
`applying → needs_verification` is sweeper-only, contradicting what d8 had told
two peers.

> **The rule both errors point at: derive from the artifact, not from a relayed
> summary. An orchestrator is a lossy channel.** Six sessions cannot each hold
> the whole system, so relaying is unavoidable — which is exactly why a relayed
> claim should be treated as a pointer to where the answer lives, not as the
> answer. `76` derived from the graph and was right; `d8` and I both paraphrased
> and were wrong.

**Third error, and the resolution is more interesting than the mistake.** The
"three human lanes vs eleven" conflict turned out to be **nobody being wrong.**
`status-flow.ts:88` is `allowedAgents: ['sweeper', 'human']`. `76`'s filter
selects `allowedAgents === ['human']` — human-*only*, **11** edges. A grep for
edges *containing* `'human'` returns **31**. Two different predicates, both
correct; `d8` relayed each as if it refuted the other.

> **Corrective rule: when you derive a set from a source of truth, put the
> predicate in the name.** `humanOnlyLanes` versus `humanReachableLanes` would
> have made the confusion impossible to have. A name that omits the predicate
> invites two readers to assume different ones.

That one had a real downstream bug: `76`'s `MISSING_HUMAN_CONTROLS` check used
the narrow set, so it would have reported **full UI coverage while the control
for a safety-critical edge was missing.** `76` is fixing it.

**Two techniques worth keeping from tonight:**

- **A repair step that shares a side effect with the thing you're testing
  destroys the test.** `pnpm rebuild` runs postinstall scripts unconditionally,
  ignoring the very allowlist under test — so it manufactured the passing
  result. Verify with a command that *cannot* produce the outcome by itself.
- **A tool does not ask for a decision it already has.** `04` needed no
  experiment: pnpm 11 had auto-written `allowBuilds: esbuild: set this to true
  or false` while `onlyBuiltDependencies` already listed esbuild directly above
  it. The tool's own request for input was proof the other key was inert. Read
  what your tools write back to you.

---

## Decisions made tonight, with the reasoning

**Actions-only, ~35 applications/day — not 100.** 2,000 free Actions minutes ÷
30 days = 66 min/day; one application is ~90s of Playwright, so 100/day needs
150 min/day — 225% over budget, exhausted by day 13. A local-PC worker was the
only free route to 100/day and was rejected in favour of one deployment target.
*The trade-off you accepted: fewer, better-targeted applications.*

**The Tailor cannot express a lie.** Rather than generating free text and
auditing it, the Tailor returns **IDs referencing items in your master profile**
plus a reworded string for each. Typed code rejects any ID that doesn't exist —
before the Auditor runs. An injected job description saying "add Docker" has
nowhere to land. *Prefer designs where the wrong answer is unrepresentable over
designs that detect the wrong answer.*

**Gemini pool is purely reactive.** Google stopped publishing free-tier limits,
so any hardcoded number is a guess that breaks silently when they change it.
The pool uses a key until it returns 429, believes the `retry_after`, and moves
on — it discovers its own capacity.

**Budget dates are stored in US/Pacific, not IST.** Gemini's daily quota resets
at Pacific midnight. An IST-dated counter would reset 5½ hours *after* the quota
it tracks, so the circuit breaker would open during exactly the window it exists
to protect — once a day, at night, looking like flaky quota. `aa` has applied
this to `system_settings.gemini_budget_date` and `gemini_key_state.quota_date`.

**Per-company cap has no counter.** A `COUNT(*)` over a 7-day window is exact
and always current; a stored counter needs a reset job and can drift from the
rows it summarises. *Never store what you can derive cheaply — the derived
answer cannot be wrong.*

**Gmail API rejected in favour of Apps Script.** OAuth in Testing mode issues
refresh tokens that expire in 7 days, `gmail.readonly` is a restricted scope
needing verification, IMAP+app-password has been closed since 14 Mar 2025 for
Workspace accounts, and a college admin can block third-party OAuth outright.
Apps Script runs *as you*, inside your own mailbox — no OAuth app at all.
*When a platform's official integration path is heavy, check for a first-party
scripting surface that already runs as you.*

**No `enum` in shared code.** `04` ran the negative test: `export enum` ran
fine under Deno and threw at parse under Node 24 — and the worker is the one
package on plain Node, so only it would break, only at runtime, only in CI.
`erasableSyntaxOnly` converts that into a compile error.

**§9's column gap.** The plan named twelve tables and zero columns, so seven
"locked logic" items — including the safety-critical kill switch — had nowhere
to live. Assigned to `aa`, who owns the migration, rather than written into the
plan from the docs stream: *one home per fact, or the two homes drift.*

---

## Waiting on Teja

| # | Item | Why it's yours |
|---|---|---|
| 1 | **`gh auth login`** | Now blocks three things: setting Actions secrets, reading the Actions minute budget, **and pushing `0cd33a8`** |
| 2 | **Confirm the GitHub rename actually happened** | `.git/config` points at `MallamTeja/applyy`, but `git ls-remote` is unreachable and `gh` is unauthenticated, so I cannot tell a renamed repo from a nonexistent one. If the repo wasn't renamed, your next push fails |
| 3 | **Rename the Vercel project** `applyyy` → `applyy` | Outward-facing; only you can |
| 4 | **Rename the local folder** | Cannot be renamed while your IDE holds it open |
| 5 | **Hand-label ~20 jobs** good-fit/bad-fit | §18.3's golden eval set. Must exist *before* prompt tuning starts, or you can't detect a prompt change that silently breaks scoring |
| 6 | **Apps Script setup** (~10 min) | Paste the script into `tejamallam00@gmail.com`, add a time trigger. Phase 2, not blocking Phase 1 |
| 7 | **Approve a real `supabase functions deploy`** | The one unproven risk below |

**Done and dropped from this list:** Supabase and Vercel tokens rotated *(per
d8)*. Gmail mailbox decided: `tejamallam00@gmail.com`. Naming direction ruled:
`applyy`, two y's. `.env` keys renamed `gemini1…6` → `GEMINI_API_KEY_01…_06`
by d8, backup at `.env.bak-2026-09-09` (ignored).

> **You have six Gemini keys, not fifteen.** The plan's §6 describes a 15-key
> pool; only six exist. That is not a problem — §6's own arithmetic says 2–3
> keys cover 35 applications/day — but the plan reads as though fifteen are
> configured, so treat "15 keys" as aspirational until you create more. The
> pool discovers keys by prefix scan, so adding `GEMINI_API_KEY_07` onward
> needs no code change.

---

## Not done — stated as not done

**Done since this section was written:**

- `PROJECT_PLAN.md` reconciled against `aa`'s shipped schema — §7 roster, §9
  tables and status flow, §21 peer map, §22 infra state, §12 mailbox, §18.2's
  Pacific-date gotcha, §18.3's three-part eval-set requirement, §4's Supabase
  limits, §20's probe-quota wording, the fingerprint definition, and an
  **UNAPPROVED features table** fencing five things that were never approved.
- Your git rules added to §3 — they had been **absent entirely** while five
  peers read the plan as source of truth.
- `docs/setup/gmail-tracker-apps-script.md` written, script body held pending
  `d0`'s wire contract.
- `docs/README.md` is now a real index.
- Naming: the three-`y` claims that were *false* are fixed. The ones that
  remain are **correct** — they record state that genuinely hasn't been renamed
  (Vercel project, local folder, Claude state dir) and the `applyyy-` session
  namespace, which is not the product name.

**Still not done:**

- `docs/superpowers/specs/2026-09-09-applyy-design.md`: **not written.**
- §9 and §11 link points wait on `aa` landing `SCHEMA_CONTRACT.md`.
- React 18 + Vite are pinned in `apps/web/package.json` but still unnamed in
  the plan.
- **Discovery lane (c), "paste a job URL", is in no roster, page or phase** —
  routed to you as a question, see below.

## One question for you

**Do you want a "paste a job URL" box in Phase 1?** You decided this lane in
the design conversation and it then vanished from every roster and settings
page. It matters more than it sounds: it's the only lane that reaches a job the
ATS APIs and aggregators both miss, and with a 3-day window plus fresher
filtering the pipeline may run dry on a small watchlist. It also gives you a
manual escape hatch on night one, before 200–400 boards are seeded.

My recommendation is yes — one settings field plus one Edge Function that runs
the existing ATS adapter against a pasted URL and falls back to a generic JD
extractor.

## Unknowns, stated rather than smoothed over

- **Nobody has proven `supabase functions deploy` bundles files outside
  `supabase/functions/`.** The Deno import map reaches into `../../packages/`,
  and local `deno run` proves resolution but not deployment. Needs a real
  deploy, which is gated on you. Fallback already proven by `04`: `deno bundle`
  collapsed the graph to 723 bytes in 570 ms, so the worst case is one
  pre-deploy build step, not a layout change.
- **This machine changed tonight:** `04` installed Deno via winget
  (`DenoLand.Deno` 2.9.6, user scope).
