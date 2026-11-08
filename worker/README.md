# `@applyy/worker` — the Playwright applier

_Last verified against code: 2026-11-08 (2a9ac31)._

The browser half of `applyy`. It runs on GitHub Actions and on Teja's laptop.
It claims `approved` applications, opens the real ATS form, fills it from our
data, attaches a freshly rendered resume, screenshots it, and, when the run is
live, submits it. The same package also holds the job scouts, the manual apply
kit builder, and a few operator CLIs (see §4).

**Status: submission is implemented and ON in code.** `SUBMISSION_IMPLEMENTED`
is `true` (`src/playwright-page.ts:21`). Whether a given run actually sends
anything is decided by the gates in §2, and every gate defaults to "do not send".
Check the build with the commands in §6, not with a number written here.

---

## 1. The one thing to know before changing anything here

`applying` is the **only non-idempotent state in the entire system**. A row
stuck there means the worker died between submitting and recording the result,
so the real-world outcome is *unknown*. An unknown submit is not a retryable
submit. The sweeper (`sweep_stale_claims`) routes those rows to
`needs_verification`, which only a human may resolve. Teja then opens the
employer's site and checks by hand.

Everything in this package is shaped by keeping that window small:

- Every operation that *can* happen before `applying` **does** happen before it:
  the Workday guard, the robots gate, navigate, detect anti-bot walls, extract
  fields, plan the fill, type values, attach the resume, screenshot
  (`src/apply-one.ts:1-23`). The window holds one operation: the submit.
- The auth token is refreshed **before** `approved -> applying`, never inside it
  (`src/run-window.ts`).
- Every status write goes through `guardedAdvance` (`src/guarded-advance.ts`),
  which checks the edge in TypeScript before the browser does anything. The
  database trigger would also refuse an illegal edge, but only after the form
  was already driven.
- A submit that throws writes **no status at all**. Not `failed` (that asserts
  it did not send), not `applied` (that asserts it did). The lease expires and a
  human decides.

---

## 2. When the worker submits, and when it cannot

Submission is implemented (2026-10-09, on Teja's ruling that the system submits
by itself after his approval). Every layer below defaults to **not** sending.

### 2.1 The gates, in the order a run meets them

| Layer | Where | What it does |
|---|---|---|
| Workflow mode | `.github/workflows/apply.yml` "Run the applier" step | Starts at `DRY_RUN=true`. Only two opt-ins set `false`: a manual run with input `dry_run` exactly `"false"`, or a scheduled run while the repo variable `APPLYY_CRON_LIVE` is exactly `"true"`. The compare is shell `[ = ]`, because GitHub's `==` ignores case (W30). |
| Live manual scope | same step, "Guard 1" | A live manual run must name ONE row (`apply_only_id`) or ask for a drain (`drain_approved=true`). Both at once is refused. A live run with neither exits red before anything is claimed. |
| Worker mode gate | `src/submission-mode.ts` | `submits: true` only for the exact string `"false"`. Unset, empty, mis-cased or padded values all mean dry run. The workflow and the worker fail closed independently. |
| Code switch | `src/playwright-page.ts:21`, `src/cli/apply.ts:56` | `SUBMISSION_IMPLEMENTED`. A live mode with this `false` is announced at startup and the run stays dry. |
| Kill switch | `src/claim-loop.ts` (`system_settings.system_enabled`) | Read before claiming and again between applications. Off means claim nothing, or stop mid-run. Stale claims are still swept first (W31). |
| Per-run submit cap | `src/claim-loop.ts` `parseMaxSubmits`, `DEFAULT_MAX_SUBMITS = 3` | `APPLY_MAX_SUBMITS` counts submit attempts (sent plus outcome unknown). `apply.yml` sets `'3'`; a drain sets `25`. A set but malformed value (blank, `0`, `1.5`, `1e3`) stops the run. |
| Daily cap | `src/claim-loop.ts` `DailyCap` | `system_settings.max_applications_per_day`, counted against submit attempts already in the window. |
| Circuit breaker | `src/claim-loop.ts` (search `circuit breaker`) | Live runs only. The first unknown submit outcome, the first captcha, or any thrown error stops further claims for the rest of the run. Each of those would likely repeat on the next row. |
| Single row | `APPLY_ONLY_ID`, `src/claim-loop.ts` `parseOnlyApplicationId` | Limits a run to one application. A set but blank or non-UUID value stops the run rather than widening it to the queue. Other claimed rows are released untouched. |
| Pre-submit re-check | `src/apply-one.ts` `recheckBeforeSubmit` | Before a live submit, re-runs the matcher's pre-gate with today's config and checks whether the opened posting is closed. A drop parks the row instead of sending (B2, P1-6). |

### 2.2 Three ways a live run starts

| Trigger | Scope | Notes |
|---|---|---|
| Cron `30 2 * * *` (08:00 IST; real start is often hours later) | Whole approved queue, cap 3 | Live only while `APPLYY_CRON_LIVE` is exactly `true`. Check it with `gh variable list`. |
| `gh workflow run apply.yml --ref main -f dry_run=false -f apply_only_id=<uuid>` | One row | The single-submit command. |
| `dispatch-apply` edge function (apply on approve) | Drain: `drain_approved=true`, 25 per run | Sent when Teja approves and his `auto_apply_on_approve` setting is on. The `redispatch` job in `apply.yml` starts the next drain run only when the worker writes `redispatch=true` (`shouldRedispatchDrain`: never after the breaker, the kill switch, the daily cap, a one-row run, an empty queue or a dry run). |

### 2.3 What a submit can return

`page.submit()` has one call site (`src/apply-one.ts`), after the dry-run exit.
It returns a closed union, `SubmitResult` (`src/apply-one.ts:160`). Only a page
that positively shows THIS job's confirmation becomes `applied`: same origin,
the form's own path plus `/confirmation`, and a "thank you for applying"
heading or title (`src/playwright-page.ts`, `CONFIRMATION_SUFFIX`,
`CONFIRMATION_HEADING`). This shape is Greenhouse's. Other outcomes:

- browser-side rejection, captcha, or "not safe to click": nothing was sent,
  the row is parked for a human;
- Greenhouse's security-code gate (HTTP 428, code emailed): nothing was sent,
  parked with `SECURITY_CODE_ACTION`;
- anything else is `unconfirmed`: no status write, never retried. A note is
  appended to the row's events, and the sweeper later routes it to
  `needs_verification`.

### 2.4 Dry run

A dry run is **structurally unable to move a row forward**. It records the
screenshot and resume paths, releases the claim, and leaves the row at
`approved`. So the same rows are still there when the flag flips. Its log line
says whether a live run would have submitted or blocked, and why.

---

## 3. The apply flow for one row (`src/apply-one.ts` `applyToOne`)

1. **Mode.** Resolve the gate from §2 first.
2. **Workday guard.** `isWorkdayApplyUrl` (`src/workday.ts`) or
   `ats_provider = 'workday'`: a Workday form needs a candidate account, which
   the worker must not create. Live run: park at `blocked_needs_human`. Dry
   run: release. No page is opened.
3. **Form URL.** `src/form-url.ts` turns a company careers page that only
   iframes Greenhouse into the Greenhouse embed form. It does this only after
   Greenhouse's own API confirms the job is on that board. Any doubt returns
   the stored URL unchanged.
4. **Robots gate.** `createRobotsCheck` asks the host's robots.txt about the
   resolved URL, under the worker's own product token `applyy-applier`
   (`APPLIER_ROBOTS_TOKEN`). The gate is `packages/master-robots`, imported by
   relative path. Anything but `allow` stops before the page opens. A live
   `refuse` parks with block reason `robots_refused`; an indeterminate answer
   (timeout, 5xx) or a `wait` releases the row for a later run.
5. **Open and detect walls.** `goto`, then `detectBlocker` (captcha, login
   wall, anti-bot page). Constraint #5: a wall is never solved, the row goes to
   a human. Invisible reCAPTCHA is deliberately not a wall
   (`src/playwright-page.ts:31`).
6. **Extract fields** from the accessibility tree (`src/extract-fields.ts`).
   Zero fields is a closed or unrendered page, not an empty form (W5).
7. **Plan the fill** (`src/plan-fill.ts`, `src/profile-answers.ts`).
   Constraint #4: copy an answer we hold, or block. There is no third branch.
   Refused required questions are reported with `record_unanswered_questions`.
8. **Plan and attach the resume.** `src/plan-resume-attachment.ts` picks the
   file input. `src/render-resume-pdf.ts` renders the frozen
   `tailored_profile` on its own page (`src/resume-renderer.ts`) and refuses a
   resume that is not one page. Its sha256 is stored in
   `applications.resume_sha256`.
9. **Type values, screenshot.** The screenshot is uploaded to the Storage
   bucket `screenshots`.
10. **Dry run ends here** (release). A live run re-checks (§2.1), then moves
    `approved -> applying`, calls `submit()` once, and records the result.

---

## 4. Entry points

Every CLI is a composition root: it reads env vars, builds clients and
launches Chromium. The decisions live in pure modules behind injected ports.
Every script signs in as the ordinary app user, never with a service-role key,
so every query runs under RLS.

| Script (`pnpm --filter @applyy/worker run <x>`) | File | Runs where | What it does |
|---|---|---|---|
| `apply` | `src/cli/apply.ts` | `apply.yml` | The batched claim loop (`src/claim-loop.ts`). |
| `assist -- --id <uuid>` | `src/cli/assist.ts` | Teja's laptop | Assisted submit, see §5. |
| `rehearse -- --id <uuid>` | `src/cli/rehearse-assist.ts` | Laptop, from repo root | Read-only preflight plus every assist step up to the click. Exit 0 ready, 2 waits on Teja, 1 failed. |
| `run-one -- --id <uuid>` | `src/cli/run-one.ts` | `run-one.yml` or laptop | Pushes one row through the deployed matcher, tailor and auditor edge functions. |
| `keepalive` | `src/cli/keepalive.ts` | `keepalive.yml` | A real Postgres query so Supabase does not pause the project. The git push that keeps cron alive is a separate workflow step. |
| `scout` | `src/cli/scout.ts` | `scout.yml` | Polls `company_watchlist` boards through the shared ATS adapters, screens, and inserts jobs. |
| `scout:remote` | `src/cli/scout-remote.ts` | `scout-remote.yml` | Remote job feeds (RemoteOK, Jobicy, Arbeitnow). |
| (no script) `node src/cli/apply-kit.ts [--id <uuid>]` | `src/cli/apply-kit.ts` | `apply-kit.yml` | Builds manual apply kits. Never claims, moves, fills or submits. Without `--id` it sweeps due rows and honours the kill switch. |
| (no script) `node src/cli/resume-pages.ts rows.json` | `src/cli/resume-pages.ts` | Laptop | Prints the real page count of each resume. Read-only. |

Env vars for the apply and assist CLIs: `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`APPLYY_APP_USER_EMAIL`, `APPLYY_APP_USER_PASSWORD`, and `APPLYY_AGENT_KEY`
(the machine-agent header; without it every applier status write is refused,
CLAUDE.md §7). The apply CLI also reads `DRY_RUN`, `APPLY_ONLY_ID`,
`APPLY_MAX_SUBMITS` and `HEADED` (exactly `1` shows the browser).

### ATS coverage

There is no per-ATS adapter class in the apply path. The worker uses one
generic form reader (accessibility tree) for every board, plus a few
board-specific pieces:

| ATS | Discovery (scouts) | Apply path |
|---|---|---|
| Greenhouse | `supabase/functions/_shared/ats/greenhouse.ts` | Supported. Confirmation shape, security-code gate, upload wait and embed resolver are Greenhouse-specific. |
| Lever | `.../_shared/ats/lever.ts` | Generic fill (fixture `fixtures/lever/netomi-apply-form.html`). No confirmation shape, so a submit reads as `unconfirmed`. |
| Ashby | `.../_shared/ats/ashby.ts` | Generic fill, with a wait for the late-rendering form (`src/playwright-page.ts`, T1). No confirmation shape. |
| Workday | `.../_shared/scout/adapters/workday.ts` | Discovery only. The apply path refuses it (§3 step 2). |
| SmartRecruiters | not in `supportedProviders()` | Off by the robots ruling (2026-11-01). |

The adapter registry is `supabase/functions/_shared/ats/registry.ts`.

### Source layout

```
src/
  submission-mode.ts        the DRY_RUN gate; one string enables submission: "false"
  run-window.ts             may we start another application? token + wall clock
  guarded-advance.ts        canTransition before every status write
  apply-one.ts              one application, start to finish; the robots and Workday guards
  claim-loop.ts             the batched run, caps, breaker, kill switch. DO NOT split into a job matrix
  supabase-gateway.ts       the domain port over Supabase (claim, advance, release, sweep RPCs)
  playwright-page.ts        the browser port; submit() clicks once and reports what the page showed
  extract-fields.ts         accessibility-tree field extraction
  plan-fill.ts              constraint #4: copy an answer or block
  profile-answers.ts        factual answers from the master profile
  plan-resume-attachment.ts which file input gets the resume
  render-resume-pdf.ts      the resume PDF and its digest; refuses more than one page
  resume-renderer.ts        owns the separate page the PDF is printed on
  form-url.ts               Greenhouse embed-form resolver
  workday.ts                the one Workday predicate (zero imports; the web imports it too)
  apply-kit.ts              one manual apply kit
  apply-kit-sweep.ts        which rows need a kit
  ats-parse-check.ts        what an ATS actually reads from the PDF
  fixture-server.ts         localhost static server for saved forms
  assist/                   assisted submit, rehearsal, sign-in check, its gateway
  scout/                    board paging, remote feeds, persistence, liveness, run outcome
  cli/                      the composition roots in the table above
scripts/
  capture-fixture.ts        saves a real ATS form to fixtures/ as static HTML
  workday-backfill-preview.ts  read-only preview of the Workday description back-fill
```

**Dependency inversion throughout.** The loop talks to a narrow `RunGateway`
port, never to Supabase's builder API, and to an `ApplicationPage` port rather
than a Playwright `Page`. That is why the tests use real fakes instead of mocks.
`submit()` appearing in one interface is deliberate: "how can this system send
an application?" is a one-line grep.

**No build step.** Relative imports carry `.ts` extensions and Node 24 strips
types natively. `tsc` is a checker here, never a compiler. The worker imports
some `supabase/functions/_shared` and `packages/*` modules by relative path, so
moving an export there can break this package (CLAUDE.md §3).

---

## 5. Assisted submit: the local, headed path

`pnpm --filter @applyy/worker run assist -- --id <uuid>` opens ONE `approved`
application in a **visible** Chromium window on Teja's machine. It is the
preferred way to send a real application, because Greenhouse's reCAPTCHA
scores a CI datacenter IP badly and a home IP well.

The flow (`src/assist/assisted-submit.ts`, pure core; `src/cli/assist.ts`, shell):

1. Honours the kill switch, refuses any row not exactly `approved`.
2. Resolves the form URL, runs the same robots gate as the applier.
3. Moves `approved -> applying` as `applier`, fills the form and attaches the resume.
4. Parks `applying -> blocked_needs_human` with the note
   `assisted: awaiting human submit` (`ASSISTED_BLOCK_NOTE`).
5. **Teja clicks Submit himself**, then answers a y/n prompt in the terminal.
   `y` writes `blocked_needs_human -> applied` as `human`; `n` writes `failed`.

The page type it receives (`AssistPage`) has no `submit` member, so "this flow
never submits" is a compile-time fact. Run `rehearse` first to check a row
without writing anything.

---

## 6. Testing

Run from `worker/`:

```
./node_modules/.bin/tsc --noEmit -p .     # typecheck
./node_modules/.bin/vitest run            # unit + real-browser tests (test/**/*.test.ts)
pnpm --filter @applyy/worker run test:e2e # test/e2e-runner.mjs
```

Count test files with `ls test/*.test.ts`. Do not trust a count written in a
doc. Browser tests run in a real Chromium against `fixtures/` over localhost;
files run one at a time to avoid port races (`vitest.config.ts`).

**Constraint #16: never test by submitting a real application.**

When the guards below were added, each was **mutation-tested**: disabled,
confirmed to fail, restored.

| Guard | Mutation | Result |
|---|---|---|
| Fixture-server path traversal | guard removed | serves a sentinel `SERVICE_ROLE_KEY` file |
| `DRY_RUN` gate wiring | `if (!mode.submits)` -> `if (false)` | exactly the 2 dry-run tests fail |
| `aria-hidden` sentinel filter | guard commented out | the labelled-sentinel test fails |

That third one is the cautionary tale. **The original aria-hidden regression
test passed with its guard deleted.** The real GitLab sentinels carry no
`aria-label`, no `aria-labelledby` and no `id`, so they were dropped by
`if (!label) continue` further down, not by the check the test was named after.

> **A test that passes when you delete the guard it is named after is testing
> the composite, not the guard. When two guards can both catch a case,
> isolating each needs an input only one of them catches.**

The fix was a synthetic `setContent` DOM with two inputs identical except for
`aria-hidden`, both carrying a resolvable `<label for>`.

---

## 7. Two measured findings (2026-10)

Both were measured, not argued. The figures are from that time; the
conclusions still hold.

### 7.1 The plan's budget table was wrong by ~25x

`PROJECT_PLAN.md` §2 used "~90 s per application". Measured through the real
loop (real Chromium, captured GitLab Greenhouse DOM, fixture server, dry run):
about 1.4 s per application amortised over 10, ~2.5-2.9 s cold, so 35
applications are about 49 s of in-process work.

| Shape | Overhead | Work | Billed/day |
|---|---|---|---|
| 1 batched run | ~40-70 s | ~50 s | **~2 min** |
| 35 separate runs | 35 x ~40-70 s | ~50 s | **~35-70 min** |

**Batching still wins decisively**, because GitHub bills each job rounded up to
a whole minute. Do not split `claim-loop.ts` into a job matrix. The proactive
token refresh in `run-window.ts` is kept anyway: localhost excludes real-site
latency, TLS and upload. Caveat: measured on a localhost fixture.

### 7.2 Chromium-printed PDFs do not interleave columns

Measured with `page.pdf()` and `pdf.js getTextContent()`: Chromium emits text
in paint order, which equals DOM order for `column-count`, flex, grid, float,
absolute positioning and tables. **Only flexbox visual reordering
(`flex-direction: row-reverse`, `order:`) scrambles the text.**

So for the resume template the rules are: never use `order:` or `row-reverse`
to place sections, and keep every claimed skill in the text layer. The
load-bearing checks in `src/ats-parse-check.ts` are `no_text_layer` and
`missing_phrase`. `test/ats-parse-real-pdf.test.ts` pins the reordering case.

---

## 8. Open items

- **No bot-confirmed submission yet.** As of 2026-11-08, every `applied` event
  was written by `human`, none by `applier`. Re-check:
  `select agent, count(*) from application_events where to_status = 'applied' group by 1`.
- **Only Greenhouse has a confirmation shape.** A real success on Lever or
  Ashby reads as `unconfirmed` (the safe direction) and goes to
  `needs_verification`.
- **Greenhouse's confirmation route is unproven on a live bot submit.** If it
  differs from what `playwright-page.ts` expects, a success also reads as
  `unconfirmed`.
- **`STORAGE_STATE_ENC_KEY`** is passed by `apply.yml`, but no worker code
  reads it.
