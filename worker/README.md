# `@applyy/worker` — the Playwright applier

The GitHub Actions half of `applyy`. Claims `approved` applications, fills real
ATS forms, screenshots them, and — once Teja explicitly enables it — submits.

**Status: submission is implemented and OFF by default.** A run sends nothing
unless `DRY_RUN` is exactly `"false"`; see §2. Check the current gates with
`./node_modules/.bin/tsc --noEmit -p .` and `./node_modules/.bin/vitest run`
rather than trusting a number written here.

---

## 1. The one thing to know before changing anything here

`applying` is the **only non-idempotent state in the entire system**. A row
stuck there means the worker died between submitting and recording the result,
so the real-world outcome is *unknown* — and an unknown submit is not a
retryable submit. The sweeper routes those rows to `needs_verification`, which
is human-only, and Teja then opens the employer's site and checks by hand.

Everything in this package is shaped by minimising that window:

- Every operation that *can* happen before `applying` **does** happen before it:
  navigate, detect anti-bot walls, extract fields, plan the fill, type values,
  screenshot. The window contains exactly one operation — the submit.
- The auth token is refreshed **before** `approved → applying`, never inside it,
  so the credential is freshest exactly where a failure is unrecoverable.
- A submit that throws writes **no status at all**. Not `failed` (that asserts
  it did not send), not `applied` (that asserts it did). The lease expires and a
  human decides.

---

## 2. When the worker submits, and when it cannot

Submission is implemented (2026-10-09, on Teja's ruling that the system submits
by itself after his approval). Whether a given run sends anything is decided by
three layers, and every one defaults to **not** sending:

| Layer | Mechanism |
|---|---|
| Workflow | `apply.yml` resolves a scheduled run (no inputs) to `DRY_RUN: 'true'`. A manual `dry_run=false` dispatch must also name ONE application (`apply_only_id`), or the step exits before the worker starts |
| Gate | `submission-mode.ts` returns `submits: false` for *everything* except the exact string `"false"` |
| Scope | `APPLY_ONLY_ID` limits a run to one application; a set-but-blank value stops the run rather than widening it to the queue |

`page.submit()` has exactly one call site (`apply-one.ts`), after the dry-run
exit. What it returns is a closed union (`SubmitResult`), and only a page that
positively shows THIS job's confirmation (same origin, the form's own path +
`/confirmation`, a "thank you for applying" heading) becomes `applied`.
Anything unrecognised is `unconfirmed`: no status write, never retried, and the
sweeper routes the row to `needs_verification` for Teja to check by hand. A row
is parked as "blocked" after the click only when no request that could have
carried the application left the page.

`DRY_RUN` is **structurally incapable of moving a row forward**. It releases
the claim and leaves the row at `approved` (after recording the screenshot and
resume paths), which is what makes the dry-run review work: the *same rows* are
still there when the flag flips.

---

## 3. Two measured findings that contradict the plan

Both were measured rather than argued. Both should be read before anyone
re-derives the numbers.

### 3.1 The budget table is wrong by ~25×

`PROJECT_PLAN.md` §2 refutes the "~90s per application" estimate in prose, then
uses it in the arithmetic three lines later: `≈53 min work` is exactly 35 × 90s.

Measured through the real loop — real Chromium, real captured GitLab Greenhouse
DOM, fixture server, full-page screenshot, dry-run:

| Measurement | Value |
|---|---|
| Per application, amortised over 10 | **1407 ms** |
| Single cold application | ~2500–2900 ms |
| **35 applications** | **≈49 seconds** of in-process work |

Corrected arithmetic:

| Shape | Overhead | Work | Billed/day |
|---|---|---|---|
| 1 batched run | ~40–70s | ~50s | **~2 min** |
| 35 separate runs | 35 × ~40–70s | ~50s | **~35–70 min** |

**The batching decision survives decisively** — 2 min versus 35–70 min — and its
reasoning (per-run overhead plus GitHub billing every job rounded up to a whole
minute) is exactly right. Only the magnitude was wrong.

Two consequences:

- **The JWT has ~97% headroom, not ~10%.** The "3240s against a 3600s token"
  figure inherits the refuted 90s. The proactive refresh in `run-window.ts` is
  **kept anyway**, because a localhost measurement excludes real-site latency,
  TLS, resume upload and `page.pdf()` against a live page — the true figure is
  unmeasured and higher. Cheap insurance against an unmeasured risk is a good
  trade; near-certain mid-run failure was never the situation. Sanity bound: even
  at 40× (network plus a slower 2-core runner), 35 applications ≈ 33 min ≈ 1980s,
  still inside a 3600s token.
- **The ~35/day ceiling is not budget-bound.** At ~2 min/day a batched run leaves
  ~64 of the 66 min/day unused. The real ceilings are supply (§13: a 3-day window
  over ~50 boards yields single digits/day) and constraint #1's deliberate
  quality-over-volume choice. Both are good reasons — but §2 presents 35/day as
  forced by Actions minutes, and that is no longer true.

*Caveat, stated plainly: measured against a localhost fixture, so it excludes
real-site latency and file upload. The batching conclusion is unaffected either
way, because overhead is per-run regardless.*

### 3.2 Chromium-printed PDFs do not interleave columns

§17.2's premise — "a two-column resume parses into interleaved gibberish" — is
true of PDFs from Word, LaTeX and design tools, which is where the advice comes
from. **It is not true of PDFs printed by Chromium**, which emits its text
content stream in *paint* order, and paint order equals DOM order for every
ordinary side-by-side layout.

Measured (`page.pdf()` → `pdf.js getTextContent()`), extraction order vs DOM order:

| Layout | Result |
|---|---|
| `column-count: 2` | DOM order — **not** scrambled |
| `display: flex` | DOM order — **not** scrambled |
| `display: grid` | DOM order — **not** scrambled |
| `float: left/right` | DOM order — **not** scrambled |
| `position: absolute` | DOM order — **not** scrambled |
| `<table>` two cells | DOM order — **not** scrambled |
| `flex-direction: row-reverse` | **VISUAL order — SCRAMBLED** |
| flex `order:` | **VISUAL order — SCRAMBLED** |

So printing through a browser is structurally safer than the folklore assumes.
The real hazard for a browser-printed resume is **flexbox visual reordering**,
where paint order follows the visual result rather than the markup — and that is
the case `ats-parse-real-pdf.test.ts` pins.

**For the resume-template stream:** "no columns, no tables" is not the rule that
protects you, and the structural assertions currently standing in for §17.2
compliance are checking the wrong property. The rules that matter are: never use
`order:` or `row-reverse` to place sections, and keep every claimed skill in the
text layer. The load-bearing checks in `ats-parse-check.ts` are `no_text_layer`
and `missing_phrase`; `out_of_order` is real but fires only on visual reordering.

---

## 4. Layout

```
src/
  submission-mode.ts    the DRY_RUN gate. One string enables submission: "false"
  run-window.ts         may we start another application? token + wall clock
  guarded-advance.ts    canTransition before every status write
  apply-one.ts          one application, start to finish
  claim-loop.ts         the batched run — DO NOT split into a job matrix
  supabase-gateway.ts   the domain port implemented over Supabase
  playwright-page.ts    the browser port; submit() clicks once and reports what the page showed
  extract-fields.ts     accessibility-tree field extraction
  plan-fill.ts          constraint #4 — copy an answer or block, no third branch
  fixture-server.ts     localhost static server for saved forms
  ats-parse-check.ts    §17.2 — what an ATS actually reads
  cli/apply.ts          composition root for `pnpm run apply`
  cli/keepalive.ts      composition root for `pnpm run keepalive`
```

**Dependency inversion throughout.** The loop talks to a narrow `RunGateway`
port, never to Supabase's builder API, and to an `ApplicationPage` port rather
than a Playwright `Page`. That is why every test here uses a real fake instead of
a mock, and why the whole loop was built and proven before an Auth user existed.

`submit()` appearing in exactly one interface is deliberate: it makes "how can
this system possibly send an application?" a one-line grep.

**No build step.** Relative imports carry `.ts` extensions and Node 24 strips
types natively, matching the contract `shared-types` documents. `tsconfig.base`
sets `noEmit: true` (required by `allowImportingTsExtensions`), so `tsc` is a
checker here, never a compiler.

---

## 5. Testing

`pnpm --filter '@applyy/worker' run test` — 62 tests, 13 files.

**Constraint #16: never test by submitting a real application.** Every
browser test runs against `fixtures/` over localhost.

Three guards in this package have been **mutation-tested** — disabled, confirmed
to fail, restored:

| Guard | Mutation | Result |
|---|---|---|
| Fixture-server path traversal | guard removed | serves a sentinel `SERVICE_ROLE_KEY` file |
| `DRY_RUN` gate wiring | `if (!mode.submits)` → `if (false)` | exactly the 2 dry-run tests fail |
| `aria-hidden` sentinel filter | guard commented out | the labelled-sentinel test fails |

That third one is the cautionary tale. **The original aria-hidden regression test
passed with its guard deleted.** The real GitLab sentinels carry no `aria-label`,
no `aria-labelledby` and no `id`, so they were dropped by `if (!label) continue`
further down — not by the check the test was named after. Two guards existed,
only one was load-bearing, and no test could tell them apart.

> **A test that passes when you delete the guard it is named after is testing the
> composite, not the guard. Redundant defences make each other untestable — when
> two guards can both catch a case, isolating each needs an input only one of
> them catches.**

The fix was a synthetic `setContent` DOM with two inputs identical except for
`aria-hidden`, both carrying a resolvable `<label for>` — an input only the
`aria-hidden` guard can catch. Labelled synthetic for the same reason the Lever
fixture is: it proves something different from a real capture.

---

## 6. Not done, stated as not done

- **No real application has been submitted yet.** The first one is a local,
  watched run (`APPLY_ONLY_ID` + `HEADED=1`) after one local dry run, on Teja's
  explicit go. Only then does the cron's `DRY_RUN` default change, as a separate step.
- **Greenhouse's confirmation page is unverified.** If its route or heading differs
  from what `playwright-page.ts` expects, a real success reads as `unconfirmed`
  (the safe direction) and is checked against the confirmation email.
- **`keepalive.yml` is disabled**, pending his explicit approval — it is the only
  workflow with `contents: write` and it force-pushes. Its presence is not
  consent.
- **No Auth user exists**, so a real session claims zero rows. That is correct
  behaviour, not a bug, and it must not be "fixed" with a service-role key.
- **RLS has never been exercised as `authenticated`** — every verifying query so
  far ran as `postgres`, which carries `BYPASSRLS`. The first real worker sign-in
  is the first genuine test of it.
- **The keepalive writes no `agent_runs` row**, because `agent_name` has no
  `keepalive` value. Borrowing another agent's identity would corrupt the very
  health page it feeds, so this is raised rather than worked around.
- **Resume PDF generation and upload are not wired into the applier yet**, so the
  §17.2 check currently runs against the template's golden fixture rather than
  against a per-application render.
- **Recommended graph addition:** `approved → blocked_needs_human`,
  `['applier']`. Today a blocked row must pass through `applying` because that is
  the only route to the human queue, so a crash between those two adjacent writes
  produces a `needs_verification` row for an application that was never
  submitted — a spurious instance of the most expensive human task in the system.
