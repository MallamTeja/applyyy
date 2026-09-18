# `applyy` — live progress

**Last updated: 2026-09-10 19:06 IST** · maintained by session `applyyy-8c`
(Stream 0 — `supabase/migrations/**`, `supabase/config.toml`, root config,
`docs/**`, `PROJECT_PLAN.md`)

> **Corrections appended 2026-09-18.** The body below is a dated log and is left
> as written; where a claim has since become false it carries a strikethrough and
> a dated note **in place**, never a silent edit. Corrected today: the migration
> counts (§"Migrations are now immutable", §"NEW DIVERGENCE CLASS") and the
> *"every status write goes through `advance_application_status()`"* absolute
> (§"The batched run may outlive its own access token"). **Counts in this file
> date-stamp themselves — re-measure, do not quote.**

Evidence rule for this document: a row says **VERIFIED** only where there is a
measurement behind it — a captured error string, an exit code, a row count, a
catalogue query. Where the evidence is a peer's own report rather than my
measurement, the row says so. **Nothing is written in the past tense until it is
actually true**, and a claim retracted later is left visible rather than edited
away.

---

## THE HEADLINE: the SQL has been executed

All 7 migrations — ~116 KB, 15 tables, the transition guard, RLS on every
table, 7 RPCs — **apply cleanly from scratch**. Before today they had never been
parsed by Postgres once, so every claim about the schema was a claim about SQL
*text*.

Full record with reproduction steps:
[`audit/2026-09-10-schema-invariants-verified.md`](audit/2026-09-10-schema-invariants-verified.md).

| Invariant | Result | Isolated how |
|---|---|---|
| `UNIQUE(user_id, job_id)` refuses a duplicate (constraint #7) | **VERIFIED** — `duplicate key value violates unique constraint "applications_user_job_key"` | Duplicate row otherwise perfectly legal; control insert against a different `job_id` succeeded |
| Transition guard rejects `tailored → applying` (constraint #15) | **VERIFIED** — `illegal status transition tailored -> applying … No such edge` | `applyy.acting_agent` set to the agent permitted on the legal edge, making both `42501` paths unreachable; control on `approved → applying` succeeded |
| RLS enabled on every table | **VERIFIED** — 15/15 via `pg_class.relrowsecurity` | Separate assertion from the one below, on purpose |
| Every table has ≥1 policy | **VERIFIED** — 15/15 via `pg_policies`; 0 holes, 0 locked | RLS-on-no-policy and RLS-off fail identically from outside |

**What that does NOT prove**, stated because a verification note is most
dangerous when read as broader than it is: nothing is deployed; the policies were
never exercised **as `authenticated`** (every query ran as `postgres`, which
holds `BYPASSRLS`), so "15/15 have a policy" is a statement about the catalogue
and **not** a demonstration that rows are scoped correctly; and the 7 RPCs are
confirmed to *exist*, not to *behave*.

---

## THE SCHEMA IS NOW LIVE ON THE REMOTE — 18:45 IST

Teja ran `supabase db push` himself against `xynqxekcqizwhtskzqrq`; all 7
migrations applied in order, `Finished supabase db push.` The local from-scratch
`db reset` above is what made that safe to attempt, which is the whole reason
the local-first sequencing was insisted on.

**Reported, NOT independently verified — and that distinction matters here more
than usual.** `applyyy-2b` attempted `supabase migration list` to confirm the
remote state and it failed with `password authentication failed for user
"postgres"` against the pooler host. So **the only evidence for the remote
schema is Teja's own terminal output** — explicit and sequential, but not a
query. The remote is currently the part of the system we have the *least* ability
to inspect.

It also raises a live question worth recording before someone assumes otherwise:
**`supabase link` validates the access token, not the database password.** So
`link` succeeding proves nothing about the password, and the credential that
worked for `db push` may have come from a stored one rather than from the string
Teja supplied. Nobody should treat that string as the verified DB password.

### Two of my runtime findings are no longer hypothetical — they are production state

1. **`gemini_key_state` is empty on the remote** and `bootstrap_user_defaults`
   has not been called. So the silent-stop bug *is* the current state of
   production: `claim_gemini_key()` returns `NULL` forever, every LLM agent
   releases its claim, and the pipeline reads as **merely idle**. No error, no
   failed run, nothing on the health page.
2. **There is no Supabase Auth user yet**, so any real session gets **zero rows
   from every table** — correct RLS behaviour, indistinguishable from an empty
   database. **Blocking prerequisite**, alongside the Actions secrets.

Named plainly because the combination is the trap: with no auth user and an empty
key pool, a deployed system looks **working but idle** rather than broken. That
is the §14 silent death arriving through *configuration* rather than through code
— and configuration has no test suite.

### Migrations are now immutable

> **Count re-measured 2026-09-18: 18 local, 15 applied, 3 pending.** The pending
> three are `20260917124500`, `20260917130000`, `20260917174600`. Measured with
> `supabase migration list --linked`, which **is** available and authenticated —
> only the Supabase *MCP connector* is unauthenticated, and the two get confused.
> The "7" below is left as written because it was true on 2026-09-10 and this is a
> dated log; **the number is a measurement at a timestamp, not a property of the
> repo.** Re-run the command rather than quoting any figure in this file — an
> inventory that can drift must point at the command that regenerates it.

`supabase_migrations.schema_migrations` on the remote records all 7 versions as
applied, so Supabase will never re-run those files. **Editing an applied
migration in place would leave the file saying one thing while the live database
does another, silently**, because nothing re-reads an applied migration. Same
class of divergence as the CRLF bug: two artifacts disagreeing with no error
anywhere.

Consequence for the two logic fixes below: they must ship as a **new migration**
using `create or replace function`, not as edits to the applied files. Comment-only
corrections are a separate case — they never reached Postgres, so fixing them in
place changes no behaviour, and leaving a *false invariant written down* is worse
than the file/ledger divergence.

### Verified live by `applyyy-20`, which docs could only assert

- **`MISSING_HUMAN_CONTROLS` reports zero gaps at runtime.** It built, ran `vite
  preview`, and drove three pages with a real browser: every one of the **31
  human-reachable transitions** has a screen offering it, derived **from the
  graph** rather than from a reading of the file. Strongest evidence yet that the
  human-lane work is complete.
- A `/favicon.ico` **404 on every page load**, now fixed. Small, and the
  justification is the good part: **a console that always has one error in it
  trains you to ignore the console**, and this app depends on the console being
  worth reading. Compilation could never have caught it.

### CRLF sweep of the current working tree — 18:50 IST

The root `.gitattributes` protects **future checkouts**, not files already sitting
in the tree, so 14 tracked files still carry CRLF. Read-only measurement, nothing
renormalised (the repo-wide `--renormalize` stays deferred — see above):

| CR bytes | File |
|---|---|
| 742 | `PROJECT_PLAN.md` |
| 470 | `apps/web/src/features/approval/DiffView.tsx` |
| 406 | `apps/web/src/features/approval/DiffView.css` |
| 361 | `apps/web/src/features/approval/diffAdapter.ts` |
| 183 | `apps/web/src/features/approval/diffModel.ts` |
| 175 | `apps/web/src/features/approval/ApprovalQueuePage.tsx` |
| 167 | `apps/web/src/features/approval/fixtures.ts` |
| 166 | `apps/web/test/keyRole.test.ts` |
| 86 | `apps/web/src/data/supabase.ts` |
| 47 | `.gitignore` |
| 46 | `apps/web/index.html` |
| 33 | `apps/web/tsconfig.json` |
| 28 | `apps/web/package.json` |
| 18 | `apps/web/tsconfig.node.json` |

`applyyy-98` normalised its own two packages (`tables.ts` was 1141 CR bytes) and
both now measure 0. **The remaining CRLF is concentrated almost entirely in
`apps/web`.** Git normalises these to LF on staging — the warning `CRLF will be
replaced by LF the next time Git touches it` is that mechanism working, not a
problem — so the committed bytes are already correct and the exposure is limited
to anything that hashes a *working-tree* file before staging. Nothing in
`apps/web` currently does; the renderer, which does, measures 0 CRs and its
output hash `525c5304…ad70ebf3` / 11111 bytes is unchanged across all of today's
edits, which is the signal that none of them reached the output.

---

## Per-stream status

| Stream | Owns | Verified | In progress | Blocked on |
|---|---|---|---|---|
| **applyyy-8c** (me) | `supabase/migrations/**`, `supabase/config.toml`, root config, `docs/**`, `PROJECT_PLAN.md` | All 7 migrations apply; 3 invariants proven; root `.gitattributes` proven by CR-byte measurement; one TS version workspace-wide; both workflows lint clean | `PROJECT_PLAN.md` §2/§11 reconciliation; 4 runtime findings in migrations | — |
| **applyyy-2b** | orchestration, git | Independently re-verified my 15/15 RLS result against the running container; committed `10b0336`, `088f938`, and the index fix | Coordination | **`git push` — `gh` unauthenticated** |
| **applyyy-98** | `packages/**` | `TS5025` pseudo-key bug fixed; `erasableSyntaxOnly` proven accepted; 14/14 enum mirrors match SQL by value **and declaration order** *(98's report)* | `matcher_eval_cases` + `eval_label` mirrors; parity test | — |
| **applyyy-f8** | `supabase/functions/**` | Tailor validator work *(f8's report)* | Intake endpoint | Needs `email_events` columns — see open questions |
| **applyyy-ef** | `worker/**`, `.github/workflows/**` | Both workflows **lint clean** under actionlint 1.7.12 *(my measurement)* | Run loop | — |
| **applyyy-20** | `apps/web/**` | `tsc --noEmit` 0 **and** `vite build` 0 — 60 modules, 224.22 kB JS / 70.73 kB gzip, **first time ever** *(20's report)* | Settings pages | — |
| **applyyy-5e** | *(joined 15:27)* | — | — | — |

### `apps/web` — the cause was **not** the TypeScript pin

Worth recording because the obvious suspect was the wrong one. It was
`moduleResolution: Bundler` overridden while inheriting `module: nodenext` — **a
coupled pair that `tsc` rejects if you override half of it.** The TS version pin
was a real problem and a separate one.

**Credit correction:** `applyyy-20`'s predecessor had already fixed both the TS
bump and the `humanLanes` predicate split before it died. Earlier versions of
this document credited it with less than it shipped.

---

---

## Update — 19:06 IST

### THE REPO IS `applyyy`, THREE Ys. The push was never only an auth problem.

Vercel's build log shows it **cloning `github.com/MallamTeja/applyyy` successfully.**
That is decisive third-party evidence: the remote we spent the afternoon pushing
to — `applyy`, two ys — **genuinely does not exist.** `origin` has been corrected.

**The lesson is about the investigation, not the URL.** GitHub returns
404-instead-of-403 for private repos to avoid leaking their existence. That is
true, useful, and exactly the kind of knowledge that makes you feel informed —
and it gave us a **satisfying explanation that stopped us checking the simpler
one.** Every `Repository not found` today was a real 404 *as well as* an auth gap.

> **A plausible cause is worse than no cause when it ends the investigation.**

Also worth noting about our tooling rather than our reasoning: **we had no way to
observe the remote's existence independently.** The fact that settled it arrived
from a third-party build log, not from anything we ran.

**Naming consequence:** the `applyy` rename is **entirely outstanding**. Supabase
is the only resource carrying the correct name. New names use `applyy`; nothing
existing gets renamed; and nothing in these docs should describe the repo as
renamed. Vercel is **git-connected and auto-deploying `main`**.

### The root `build` script was breaking every Vercel deploy — FIXED and verified

```
[ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT] None of the selected packages has a "build" script
Error: Command "pnpm run build" exited with 1
```

`package.json` had
`build: pnpm -r --filter "./packages/**" run build && pnpm -r --filter "./apps/**" run build`.
Neither `packages/shared-types` nor `packages/resume-template` has a `build`
script — **and that is correct and deliberate**: both export raw `.ts` source with
zero build step, which is precisely what makes the Deno/Node/Vite cross-runtime
guarantee work. **The script encoded an assumption the architecture deliberately
rejects**, so the first half of the `&&` failed and `apps/web` was never reached.

Fixed as `pnpm -r --if-present run build`, **not** by deleting the packages half:
a package that later *gains* a build step is then picked up automatically, whereas
an apps-only filter would silently stop building it. Derived over hardcoded —
this project has now been bitten three times by the hardcoded form.

Verified: `pnpm run build` → **exit 0**, 136 modules, 345.62 kB JS / 104.44 kB
gzip, built in 4.05 s.

**The sibling sweep found a second live bug: `lint` could never have worked.** Not
"would fail if a package lacked it" — **no package in the workspace defines
`lint` at all**, so it was guaranteed to fail identically. It had simply never
been invoked by anyone. Now `--if-present` and exits 0 as a no-op.

> **A script that has never been run is not a working script; it is an unmeasured
> one.** Same distinction as typecheck being unmeasured rather than passing.

`engines.node` also pinned to `>=24.0.0 <25.0.0`. Vercel warned that the
open-ended range auto-upgrades on the next Node major — an unbounded runtime
range breaks a deploy **with no local change**, months later, which is the worst
diagnostic shape available.

### `pnpm run typecheck` is GREEN across all four packages — first time ever

Measured 19:06 IST: `shared-types` Done, `resume-template` Done, `worker` Done,
`apps/web` Done, **exit 0.**

Stated with a timestamp deliberately. At 18:50 `worker` was failing on
`TS2307: Cannot find module '../src/ats-parse-check.ts'` plus four `TS7006`
implicit-anys; ef has since landed it. This value has been red all day for
*shifting* reasons, so it is the kind of fact that needs a measurement time
rather than a checkbox.

### The remote schema is now INDEPENDENTLY VERIFIED

Upgraded from "reported, not independently verified". Teja reset the DB password,
it propagated, and `supabase migration list` connected. All seven original
migrations confirmed present on **both** sides: `20260909234500`, `234600`,
`234700`, `234800`, `234900`, `235000`, `235100`.

**The earlier failure was propagation timing on a freshly reset password, not a
wrong credential** — the same value succeeded minutes later. Recorded because
`password authentication failed for user "postgres"`, read alone, sends someone
hunting through credential stores for a string that was already correct. See
[`verification-traps.md`](verification-traps.md) instance 8.

`SUPABASE_DB_PASSWORD` is now a persistent user environment variable, so the CLI
picks it up **without the value ever entering a transcript.**

### NEW DIVERGENCE CLASS: the migration files and the live database disagree

`supabase migration list` shows my two corrective migrations —
`20260910185900_add_keepalive_agent_name.sql` and
`20260910190000_fix_sweep_count_bootstrap_seed_and_blocked_edge.sql` — with
**empty `remote` entries**.

~~So right now the live database does **not** have the `keepalive` agent value,
does **not** have the `approved → blocked_needs_human` edge, and still runs the
**un-fixed** `bootstrap_user_defaults` and `sweep_stale_claims`.~~ **Nothing
errors.** A peer reading the files gets one answer; the same peer querying the
database gets another.

> **Superseded 2026-09-18.** Both migrations named above —
> `20260910185900` and `20260910190000` — **are now applied** (verified by
> `supabase migration list --linked`; non-empty `remote` entries). The specific
> divergence described here is closed. **The standing rule below is not** — it
> simply points at a different set of files now: the three still carrying empty
> `remote` entries are `20260917124500`, `20260917130000` and `20260917174600`.
> Struck rather than deleted because *"right now"* in an undated paragraph is the
> trap itself: this text read as current for eight days after it stopped being
> true, and a reader had no way to tell from the sentence which "now" it meant.

> **Read the files for intent. Query the database for behaviour. Never assume they
> agree while any migration has an empty `remote` entry.**

This recurs with **every** corrective migration, so it is a standing rule rather
than an incident. Third member of a family this project keeps producing — two
artifacts disagreeing with no error anywhere — alongside CRLF and the
applied-migration edit.

~~**AND THE SHARPEST REMAINING RISK: neither new migration has ever been parsed by
Postgres.**~~ Docker is gone, so the first execution will be **against the live
database** — exactly the condition this whole day was spent escaping. Stated at
the top of both files. If Docker is restarted for one thing, it should be a
single `supabase db reset` before that push; that is a stronger reason than the
RLS proof was.

> **Resolved for these two, 2026-09-18** — both were parsed and applied
> successfully. **The risk itself is unchanged and now sits on the three pending
> files**, two of which contain `alter type ... add value` (the trap documented at
> `20260910185900:5-19`). The shape to carry forward is the *condition*, not the
> filenames: **any migration with an empty `remote` entry will meet Postgres for
> the first time on the production database.** That the last two survived it is
> not evidence the next three will.

The push is escalated to Teja framed as **"align the database with the files
before the first sign-in"** — deliberately *not* as a production hotfix, because
`bootstrap_user_defaults()` still has to be **called** by an authenticated
session and there is no Auth user yet. Every insert in it is
`on conflict do nothing`, so re-running the fixed version after the old one has
run still works — which lowers this from "drop everything" to "cheap now, a
diagnosis later."

### Two false invariants corrected in the migration comments

Both verified by query before being changed, not taken on report.

1. **"`awaiting_approval → approved` is the only edge into `approved`"** — FALSE.
   There are **two**: `needs_verification → approved` also exists, and it must —
   it is the only way a row re-enters the submit path after a human confirms a
   possibly-submitted application did not go through.
   **The correction strengthens the argument, which is exactly why the false
   version survived.** Constraint 15 never needed `approved` to have one
   entrance; it needed **every entrance to require a human**. Both are
   `array['human']`, so it holds. Reworded to **"every edge into `approved` is
   human-only"** — the property the constraint actually rests on, and one that
   stays true when a third human-only entrance is added, unlike an edge count.
2. **"the status graph has zero backward edges"** — FALSE, and it appeared in
   **five** places across three migrations plus a `comment on column` that ships
   into the database itself. There are exactly **seven**, measured against
   `application_status` declaration order: `audit_flagged→tailored`,
   `interview→oa_pending`, `needs_verification→applied`,
   `needs_verification→approved`, `blocked_needs_human→applied`,
   `blocked_needs_human→dropped_filter`, `failed→needs_verification`.
   **Narrowed rather than deleted, because the reasoning was right and only the
   scope was wrong.** "No backward edge is needed for *claim rollback*" is true —
   claiming takes a lease and never moves status, so an agent giving up has
   nothing to undo. Human correction and agent rollback are different purposes,
   and only the second is absent. The claim that was true all along is sharper:
   **no machine can walk backward, with exactly one deliberate exception** —
   `interview → oa_pending` `['tracker','human']`, which is *correct*, because an
   employer genuinely can move a candidate back a stage and the Tracker must
   record it. All seven are now listed with their agents so the next reader counts
   rather than infers.

### §17.2's premise was wrong — measurement overturned it

The plan warned that a two-column resume "parses into interleaved gibberish".
That is **true of Word, LaTeX and design tools** — where the advice comes from —
and **not true of a browser print.** ef rendered the real golden resume in two
columns *expecting failure*, and **it passed**, then measured every layout through
`page.pdf()` → `pdf.js getTextContent()`.

**Chromium emits its PDF text stream in PAINT order, and paint order equals DOM
order** for `column-count`, `flex`, `grid`, `float`, `position: absolute` and
two-cell tables. Only **`flex-direction: row-reverse`** and flex **`order:`**
scramble it.

So the two rules that actually bind are: never use `order:` or `row-reverse` to
place sections — **the only thing that reorders the text layer, and invisible in
the rendered PDF**, which is what makes it dangerous — and keep every claimed
skill in the text layer. The structural assertions ("no columns, no tables") are
being **relabelled, not deleted**: they are cheap and encode intent, but calling
them §17.2 compliance is *worse than no proxy*, because it stops anyone looking
for the real hazard.

> **Advice inherited from a different toolchain can be exactly correct there and
> exactly wrong here.**

Second premise measurement to overturn a plan claim today, after the Actions
budget arithmetic. Both had been carried for months because they were plausible
and unmeasured.

### Closed, verified, and corrected elsewhere

- **The Deno/Node bundling unknown is CLOSED.** f8 deployed a probe importing a
  **runtime const tuple** — deliberately not a type, since `import type` is
  erased and a type-only probe would have passed identically even if the bundler
  ignored `packages/` entirely, **closing the question with the wrong answer.**
  Live call returned the package's real contents (`status_count: 21`,
  `first_status: "discovered"`). No `deno bundle` pre-step, no layout change.
- **`email-tracker-intake` FAILS CLOSED IN PRODUCTION.** With
  `EMAIL_INTAKE_SHARED_SECRET` unset it returned **500 "server misconfigured"** —
  not 401, and critically not 202. A guard verified in a live deployment rather
  than in a test.
- **`email-tracker-intake` LIVE END-TO-END VERIFIED (2026-09-11 17:51 IST).**
  Google Apps Script (`supabase/functions/_shared/apps-script/email-tracker.gs`)
  bound to `tejamallam00@gmail.com` executed `applyyIngest` live against
  `https://xynqxekcqizwhtskzqrq.supabase.co/functions/v1/email-tracker-intake`.
  Returned `202 Accepted: {"accepted":9,"duplicates":0,"rejected":0}`. 9 rows
  confirmed stored in `public.email_events` under RLS (`SELECT count(*) FROM email_events`),
  and all 9 threads in Gmail automatically received the `applyy-ingested` label.
  Auth credentials (`APPLYY_APP_USER_EMAIL` / `APPLYY_APP_USER_PASSWORD`) set in Supabase
  secrets, and user provisioned in `auth.users`.
- **A `service_role` token was embedded verbatim in `dist/assets/index-*.js`
  while `vite build` exited 0.** Decoded out of the bundle to confirm. `dist/` is
  gitignored (`.gitignore:21`) and no `dist/` file is tracked, so **nothing
  leaked into git** — but on a deploy the URL goes live carrying an RLS-bypassing
  key. 20 added a **build-time** refusal reading the role claim of every
  `VITE_`-prefixed variable, deliberately asymmetric with the runtime guard (a
  *missing* key must not fail the build; an unconfigured preview is legitimate).
  **A guard that reports an incident is not a guard that prevents one.**
- **Mutation testing, three independent measurements: 12/14, 2/36, 4/8.** The
  survivors are consistently the **order-insensitive** assertions — including
  "every skill is readable", the obvious test and the one the whole feature
  exists for. One is an anecdote; three is a law. All three, plus the vacuity
  problem none of them catch, are in
  [`verification-traps.md`](verification-traps.md).
- **Correction: `packages/resume-template`'s test was NEVER red.** 98 ran it at
  session start: 20/20 with the glob-form script already in place. This document
  previously recorded an invocation bug and missing fixtures for it — the
  invocation trap is real but applies to `apps/web`, not here.
- **`.playwright-mcp/` and `worker/dist/` are now gitignored**, both with the
  reasoning in the file. Verified with `git check-ignore`.

## Verified by me today, with the measurement

| Check | Result |
|---|---|
| 7 migrations apply from scratch | **VERIFIED** — `supabase_migrations.schema_migrations` holds all 7 versions; 15 public tables; 44 transition edges; 0 leftover rows, so the reset genuinely started from empty |
| Root `.gitattributes` fixes checkout | **VERIFIED** — fresh clone of `088f938` has **0 CR bytes across the entire repo**; before, `PROJECT_PLAN.md` 525, `validator.ts` 279, `posted-at.ts` 209, `contract.ts` 97, `escape-html.ts` 60 |
| One TypeScript version workspace-wide | **VERIFIED** — all four packages' `node_modules/typescript` symlinks resolve to `typescript@5.9.3`; lockfile references only 5.9.3. The `5.7.2` in `node_modules/.pnpm` is an orphaned store leftover, unreferenced |
| `erasableSyntaxOnly` accepted (≥5.8 floor met) | **VERIFIED** *(by applyyy-98)* — two packages compile clean past it |
| `.github/workflows/*.yml` lint | **VERIFIED CLEAN** — actionlint 1.7.12 official image, 0 findings, exit 0; harness self-tested against a deliberately broken workflow first |
| No link state on disk | **VERIFIED** — `supabase/.temp` holds only `cli-latest`; no project-ref, so a local `db reset` provably cannot reach `xynqxekcqizwhtskzqrq` |
| `postgres` role privileges | **VERIFIED** — `rolsuper=false`, `rolbypassrls=true` |
| `pnpm -r run typecheck` | **STILL RED**, for `worker` and `apps/web` reasons — see below |

### `typecheck` was **unmeasured, not passing** — the whole lesson

`pnpm -r run typecheck` failed at `packages/shared-types` with
`TS5025: Unknown compiler option '// noEmit'`. Because pnpm orders packages
topologically and dependents of a failed package are **SKIPPED rather than run**
(`--no-bail` does not change this), the other three packages were never
type-checked at all.

When `applyyy-98` fixed it, **two genuinely broken packages surfaced**. Both had
been red all along: **"green" had never been measured**, it had been *inferred
from the absence of a report*, which is not the same thing.

**Re-measured 18:50 IST, and my earlier record of this was stale in both halves:**

| Package | State |
|---|---|
| `packages/shared-types` | **Done** |
| `packages/resume-template` | **Done** |
| `apps/web` | **Done** — exit 0. All six settings pages exist and are committed (`AnswerBankPage`, `BlocklistPage`, `FiltersPage`, `MasterProfilePage`, `SearchPreferencesPage`, `WatchlistPage`). My earlier note that three were missing was **wrong when I wrote it down** |
| `worker` | **FAILS** — but on a *different* error than before. `guarded-advance` is fixed; the current failure is `test/ats-parse-check.test.ts(17,60): error TS2307: Cannot find module '../src/ats-parse-check.ts'` plus four `TS7006` implicit-`any` parameters |

`pnpm -r run typecheck` therefore still exits 1, for `worker` alone.

**Worth flagging about this row specifically:** `worker`'s failure is a *moving
target* — it is mid-TDD, so a red run there is expected-and-temporary rather than
a defect, and the specific error changes between measurements. That makes it
exactly the wrong thing to record as a static fact. Any future note about it
should carry a timestamp and the error text, or it will be stale within the hour,
as mine was.

### A claim of mine that was wrong

I reported that "two other packages carry the same pseudo-key pattern." They do
not. `applyyy-98` swept all six `tsconfig.json` files programmatically,
extracting each `compilerOptions` block: **zero hits outside the one it fixed.**
I had generalised from seeing `"// extends"` and `"// include"` at the *root* of
the same file, and did not check. Left visible rather than edited away.

The refined rule is more useful than my wrong one — and `applyyy-98` then found a
second instance that generalises it further. The `"// key": "explanation"`
pseudo-key trick also fails inside **`dependencies` / `devDependencies`**, where
pnpm validates dependency names and raises `ERR_PNPM_INVALID_DEPENDENCY_NAME`
(hit live while adding `@types/node`).

So the rule is **not** "fatal in `compilerOptions`". It is:

> **The pseudo-key trick is fatal inside any object whose parser validates its
> keys, and safe only where the parser ignores what it does not recognise.**

`package.json`'s *top level* ignores unknown keys, which is why the trick looks
harmless there; `compilerOptions` and `dependencies` both validate, which is why
it detonates there. **And it fails at the place you add it, not at the place you
learned the pattern** — which is exactly why it spread. Both instances are
tabulated in §2 of `SCHEMA_CONTRACT.md`.

---

## Rulings made today

### Naming: one credential, one name → **`APPLYY_APP_USER_*`**

There is exactly **one** Supabase Auth user in this system, because RLS scopes
every row by `auth.uid()` — a second auth user would be a second disjoint
`user_id`, at which point the worker and the dashboard silently stop seeing each
other's rows. That single credential pair was being called **two** different
things: `APPLYY_WORKER_*` in `SCHEMA_CONTRACT.md` §8.3 and `APPLYY_APP_USER_*`
in the Edge Function.

**Ruling: `APPLYY_APP_USER_EMAIL` / `APPLYY_APP_USER_PASSWORD`.**

Reasoning, which is the CLAUDE.md naming rule applied directly: `APPLYY_WORKER_*`
names the credential after **one of its several consumers**. The worker is one
consumer, the Edge Function is another, and the dashboard could be a third — so
under that name every non-worker consumer *looks wrong when it uses it*, which
is precisely what invites somebody to introduce a second name. That already
happened here. `APPLYY_APP_USER_*` says what the thing **is**. Two names for one
credential is how somebody rotates only one of them.

Must be fixed in **every** occurrence — contract, Edge Function, workflows,
Actions secrets — not just the one in front of you. A half-renamed thing is worse
than an unrenamed one.

### actionlint: official image locally, official Action pinned by SHA in CI

The npm package named `actionlint` was **rejected**, not merely skipped. It is
versioned **2.0.6** while upstream actionlint is at **1.7.12**, so you cannot
tell which upstream ruleset is inside it. It declares **no repository URL, no
homepage and no author**, describes itself as "Actionlint as wasm", and its sole
maintainer is a release bot at an unrelated company
(`solar-web-npm-hops@xing.com`), not `rhysd`.

Constraint #11 is written about credentials, but the same instinct governs supply
chain: **an unauditable repackaging that executes in CI is exactly the dependency
you cannot justify after an incident.**

---

## Known-deferred — deliberately not done, do not do ad hoc

### `git add --renormalize .`

**Decision: deferred by `applyyy-2b`. Not a maybe.** The root `.gitattributes`
protects fresh clones and CI, which is where the real damage was (the Ubuntu
runner receiving different bytes than a Windows clone). The existing working tree
stays un-renormalised.

Reasoning: it rewrites files across **all four peers' write-ownership
territory**, and every one of them has unstaged work in flight — it would collide
with concurrent writers and produce exactly the tangled diff that write-ownership
partitioning exists to prevent. Scheduled for when peers are idle and Teja is at
the keyboard. Recorded here so it is neither quietly forgotten nor quietly done.

---

## Will break later — not broken now

These are the items a progress document is uniquely good at not losing.

### The `status_change` trigger will cause double-writes

The `log_status_change` trigger **has never run** in any consumer's environment,
so consumers written *now* are emitting those audit events **explicitly**. The
trigger's eventual arrival is therefore a **behaviour change for code written
against its absence** — those consumers will double-write once it exists.

Nobody infers this from either the SQL or the TypeScript in isolation. Also
recorded in `SCHEMA_CONTRACT.md` by `applyyy-98`.

### ~~The batched run may outlive its own access token~~ — MY MAGNITUDE WAS WRONG BY ~25×

**Retracted as stated, kept as a worked example of how I got it wrong**, because
the mechanism is more instructive than the number.

I claimed one batched run was ~3240 s against a 3600 s token — **~10% headroom**.
`applyyy-ef` measured the real loop (real Chromium, real captured Greenhouse DOM,
full-page screenshot, dry-run): **1407 ms per application amortised**, 2839 ms
cold. So ~35/day is **~49 SECONDS** of in-process work, one batched run is **~2
min** of billed time, and the headroom is **~97%**, not ~10%.

**How the error happened, which is the part worth keeping:** I derived 3240 s
from PROJECT_PLAN §2's "~54 min/day" table cell — and *that cell was itself
35 × 90 s*, the per-application estimate the same section had explicitly refuted
three lines earlier. **A stale derived figure survived a correction to the figure
it was derived from, and then looked reviewed because it sat next to corrected
prose.** I trusted a number inside a document I was in the middle of correcting.
The lesson: when you supersede a figure, sweep everything *derived* from it, not
just its headline.

**What survives, and it is not nothing.** The recommendation was right and ef
implemented it: refresh **proactively before each application**, never reactively
on a 401, because a 401 caught at the wrong moment is indistinguishable from the
dangerous case. But it is now **insurance against an unmeasured risk** rather
than a fix for a near-certain failure — the measurement excludes real-site
latency, TLS and resume PDF upload, so per-application cost will rise and is
unmeasured. Raising `jwt_expiry` remains the wrong fix at any magnitude: it
trades a bounded, testable refresh path for a longer-lived credential in a runner.

**Also resolved structurally**, by ef: the guard's `applyy.acting_agent` is
per-connection state, which I flagged as droppable by a pool, retry or re-auth.
~~Every status write goes through `advance_application_status()`, which calls
`set_config('applyy.acting_agent', p_agent, true)` — transaction-scoped, so it is
re-established on **every call** rather than assumed from setup. The re-auth case
is structurally safe, not merely unlikely.~~

**Corrected 2026-09-18 — the absolute was false, and the word "every" was the
whole error.** What is true:

- Every status **UPDATE** is *supposed* to go through
  `advance_application_status()`, which calls
  `set_config('applyy.acting_agent', p_agent, true)` — transaction-scoped, so it
  is re-established on **every call** rather than assumed from setup. For the
  re-auth case this still holds, and that part of the finding stands.
- **INSERTs do not go through it, and cannot.** The transition guard is declared
  `before update on public.applications`, so **an INSERT bypasses it by
  construction** — not by oversight. `_shared/screen/screen-batch.ts:188,202,207`
  creates `applications` rows directly at `dropped_filter` and `passed_filters`,
  never touching the RPC. The module says so in its own header (`:31`) and
  defends itself with a **closed union** of the only two statuses it may insert
  at, precisely because a full-`application_status` insert helper would be a way
  to manufacture a row already sitting at `approved` or `applying`.
- So the discipline is enforced **by convention and by types, not by the
  database**: `_shared/agent/port.ts:128` omits `status` from `ApplicationPatch`
  entirely, making a bare `.update({status})` unrepresentable rather than
  merely discouraged, and `:159` routes movement through `advanceStatus`.

**Why this correction matters more than the fact it fixes.** The original
sentence was load-bearing for a *security* argument — "the re-auth case is
structurally safe" — and an over-broad "every" in a security claim is how an
unguarded path gets budgeted for as if it were guarded. The guard's own header
makes the narrow claim correctly (it holds for UPDATEs); this document widened it.

**Related, and deliberately not repeated here:** `core_tables.sql:471` says a bare
UPDATE *"passes the guard and strands the row"*. `CLAUDE.md` §7 records that as
**false** — such an UPDATE is refused outright with SQLSTATE `42501`. The SQL
comment is another session's file and is left untouched; it is flagged so the
claim does not get laundered into this document by someone citing it.

Related, and easy to miss: the guard requires **session-local** state.
`set applyy.acting_agent = 'applier'` is **per-connection**, not one-time setup —
anything that silently reconnects (a pool, a retry, a re-auth) drops it, and
every subsequent status write then fails with
`42501 status change X -> Y refused: no acting agent`.

---

## Open questions — recorded rather than silently resolved

1. **`application_status_transitions` has `relforcerowsecurity = f`** while the
   other 14 tables have force RLS **on**. It is the read-only reference seed, so
   this is *defensible* — but defensible is not *decided*, and it is the single
   place the pattern differs. If `SCHEMA_CONTRACT.md` says "force RLS on every
   table", that sentence is currently false.
2. **`email_events` cannot store `thread_id`, `to`, or `label_ids`**, which the
   published wire contract sends — so the Edge Function validates and drops
   them. `thread_id` is the one that hurts: it is what "has this recruiter
   already replied?" needs, and the natural join key for threading a conversation
   onto an application. **Recommendation: add the columns.** A dropped field is
   invisible until someone needs it. Not yet done.
3. **Should `supabase/tests/invariants.sql` exist?** The invariant script is
   currently a transcript in a docs file. It should be checked in and
   re-runnable, but `supabase/tests/` has **no assigned owner**, so it is
   proposed rather than created.

---

## Runtime defects found in my tree — not yet fixed

Load-time is clean; these are behavioural.

1. **`sweep_stale_claims` double-counts, and its own comment asserts the
   opposite.** The first statement moves stale `applying` rows to
   `needs_verification` **without clearing the lease**; the second statement's
   predicate (`claimed_by is not null and claim_expires_at < now() and a.status
   <> 'applying'`) then matches those very rows, so they are released **and
   counted again** in `released_count`. The comment claims the first statement
   "already moved every stale `applying` row out of this predicate" — it moved
   them out of `status = 'applying'`, **not** out of the predicate. Net behaviour
   is safe (the lease does get cleared, which is desirable) but the two return
   values cannot both be trusted, **and the health page reads them**.
2. **`bootstrap_user_defaults` never seeds `gemini_key_state`** — the silent stop
   §14 exists to prevent. It inserts `system_settings`, `search_preferences` and
   the 9 `filter_rules` only. **Nothing anywhere else writes to
   `gemini_key_state`**; the only other touches are the two `UPDATE`s inside
   `claim_gemini_key` and `report_gemini_result`. So on a freshly bootstrapped
   account **`claim_gemini_key()` returns `NULL` forever, every LLM agent
   releases its claim, and the pipeline looks merely idle** — no error, no failed
   run, nothing on the health page. Whatever the fix, **the absence must be
   visible if it has not been done.**
3. **The `FORCE RLS` comment gives the wrong reason.** It says the
   `SECURITY DEFINER` insert "is not subject to this policy". It succeeds, but
   **only because `postgres` carries `BYPASSRLS`** — `rolsuper` is `false`, and
   `FORCE RLS` genuinely *does* apply to the table owner. As written it will
   mislead the next reader into thinking superuser status is what saves it, and
   it would be **false** for a plain owner role, where every status change would
   fail.
4. **Two false invariants stated in migration comments.**
   `awaiting_approval → approved` is **not** the only edge into `approved` —
   `needs_verification → approved` also exists, both human-only, so the true
   statement is "**every edge into `approved` is human-only**". And "no backward
   edges" is false: there are **seven**, of which `interview → oa_pending` is
   `['tracker','human']` and therefore **the one reverse edge a machine can
   walk**.

---

## Waiting on Teja — nothing below can proceed without him

| Item | Detail |
|---|---|
| **`gh auth login`** | `git push` fails with `remote: Repository not found` on `github.com/MallamTeja/applyy`; `gh auth status` says not logged in. GitHub returns 404-instead-of-403 for private repos to avoid leaking their existence, so this is an **auth** failure, not a missing repo. Commits are stacked locally. |
| **Remote database authorisation** | `supabase link` / `db push` against `xynqxekcqizwhtskzqrq` is **gated**. An attempt to delegate this authorisation between sessions was correctly refused — a peer session cannot grant it. Teja's to lift, in his own session. |
| **Docker Desktop** | Stopped again as of ~18:34 IST. It was **not running** at session start (service `com.docker.service` STOPPED, exit 1077 = never started since boot). Needed for any further local SQL work; images are cached, so a restart is fast. |

---

## Not done — stated as not done

- **Nothing is deployed.** No `supabase link`, no `db push`, no `vercel deploy`,
  no Actions run has ever executed. This has not changed today.
- The RLS policies have **never been exercised as `authenticated`**. This is the
  single highest-value verification still outstanding.
- The 7 RPCs have **never been called**. Existence ≠ behaviour, and two of them
  have known defects above.
- `pnpm -r run typecheck` is **red** (`worker`, `apps/web`).
- The working tree is **not renormalised** (deliberate — see above).
- `supabase/tests/invariants.sql` does not exist.
- The `APPLYY_WORKER_*` → `APPLYY_APP_USER_*` rename is **ruled but not
  executed** across contract, function, workflows and Actions secrets.

## Unknowns, stated rather than smoothed over

- **Why the local `supabase_storage` container reports `unhealthy`.** It made
  `supabase db reset` **exit 1 while the SQL itself fully succeeded**. Unrelated
  to migrations, but unexplained, and it will mislead the next person who reads
  the exit code. See [`verification-traps.md`](verification-traps.md).
- Whether `application_status_transitions`'s missing force-RLS was a decision.
- Whether the hosted project's `postgres` role matches the local one's
  privileges. It should — same image — but "should" is not "verified", and the
  `FORCE RLS` path depends on it.

---

# Archive — 2026-09-09 night (session `applyyy-b3`)

Preserved verbatim rather than deleted, because the retraction narrative and the
coordination-error section are the most instructive parts of it. The stream ids
below (`aa`, `d0`, `04`, `21`, `76`, `b3`, `d8`, `e5`) belong to the peers of
2026-09-09, all of which are now dead. The streams for 2026-09-10 are listed at
the top of this document.

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
