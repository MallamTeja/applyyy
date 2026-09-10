# `applyy` — live progress

**Last updated: 2026-09-10 18:40 IST** · maintained by session `applyyy-8c`
(Stream 0 — `supabase/migrations/**`, `supabase/config.toml`, root config,
`docs/**`, `PROJECT_PLAN.md`)

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

When `applyyy-98` fixed it, **two genuinely broken packages surfaced**:

- `worker/test/guarded-advance.test.ts:11` imports `../src/guarded-advance.js`,
  which does not exist. → `applyyy-ef`
- `apps/web/src/App.tsx:19,21,22` import three settings pages that do not exist.
  → `applyyy-20`

Both had been red all along. **"Green" had never been measured** — it had been
*inferred from the absence of a report*, which is not the same thing.

### A claim of mine that was wrong

I reported that "two other packages carry the same pseudo-key pattern." They do
not. `applyyy-98` swept all six `tsconfig.json` files programmatically,
extracting each `compilerOptions` block: **zero hits outside the one it fixed.**
I had generalised from seeing `"// extends"` and `"// include"` at the *root* of
the same file, and did not check. Left visible rather than edited away.

The refined rule is more useful than my wrong one: the
`"// key": "explanation"` pseudo-key trick is **legal and harmless in
`package.json`** (npm ignores unknown keys and does no schema validation) and
**fatal inside `compilerOptions`** (TypeScript validates every key strictly).
That is why the trick appeared to work right up until it didn't.

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

### The batched run may outlive its own access token

`jwt_expiry = 3600`. The batching decision that fixes GitHub's minute-rounding
billing problem means **one run carries the whole daily queue**: ~35 applications
≈ ~54 min/day ≈ **~3240 s against a 3600 s token — ~10% headroom**, not the ~40×
that the old "~90 s per application" figure implied. The 3.75 s per-application
measurement was taken against a **localhost fixture** and excludes real-site
latency and file upload, so the true figure is higher.

The failure mode is the nasty one: it lands **late in a run, after real
applications have already been submitted**, not at startup where it would be
obvious. And a token expiring between `applying` and `applied` means the terminal
status cannot be written, the row goes stale, and the sweeper correctly routes it
to `needs_verification` — converting clean submissions into a pile of "did this
actually send?" questions. That is exactly what §14 exists to prevent.

Routed to `applyyy-ef`: refresh **proactively on remaining lifetime**, not
reactively on a 401 (a 401 caught at the wrong moment is indistinguishable from
the dangerous case). Raising `jwt_expiry` is the wrong fix — it trades a bounded,
testable refresh path for a longer-lived credential sitting in an Actions runner.

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
