# Pending-work re-verification — 2026-09-18

**Measured:** 2026-09-18, ~13:00 IST, session `applyyy-b0`, HEAD `3c09f54`, working tree clean,
nothing unpushed, no peer sessions listed **at that moment**.

> **That last clause decayed within seven minutes, and it is the fourth instance of this doc's own
> thesis.** Peer `applyyy-f1` started ~13:03 and committed `baa483c` at 13:08. I had already
> briefed four writers with "no peer sessions active" as settled fact. One of them checked and
> refused the line; the peer flagged it independently. **A partition map is a lease, not a record —
> and so is a tree-state observation.** Everything below was measured at `3c09f54` and that is
> still what it says; only the "nobody else is here" claim was wrong.

**Method:** five read-only recon agents, partitioned by tree so none re-read another's files —
frontend / Deno functions / CI+SQL / docs+deps / migration ledger. Every verdict below carries
`file:line`. Where an agent's finding contradicted the brief it was given, the agent's finding wins
and is recorded as a correction.

**Source under test:** [`../handoff/RESUME-HERE.md`](../handoff/RESUME-HERE.md) (written 2026-09-17
18:05 by `applyyy-94`), tasks T1–T24.

Only three commits landed between that doc and this measurement — `305857d`, `8fa5411`, `3c09f54`,
all watchlist or docs. **So the expected answer was "everything is still pending," and that is nearly
what we found — but several claims were wrong, and the two biggest were wrong in the direction that
costs the most: they described work as impossible when it was not.**

---

## 1. The headline: the top blocker was never a blocker

### T1 — "Authenticate the Supabase connector… **No Claude session can do this**" — **FALSE**

`RESUME-HERE.md:35` lists this as the single largest blind spot, needing an interactive session.
It does not. The Supabase **CLI** at `C:\Users\tejam\tools\supabase\supabase` is **v2.117.0,
authenticated, and linked** to project `xynqxekcqizwhtskzqrq` (`applyy`, ap-southeast-2,
`ACTIVE_HEALTHY`). `supabase migration list --linked` ran **non-interactively, exit 0, first try** —
twice, once by a recon agent and once by this session directly.

The confusion is a **name collision between two different things called "Supabase"**: the *MCP
connector* is unauthenticated (true, and still true), the *CLI* is not. `CLAUDE.md:603` collapses
them into "No session can check the live database," which is false and has been for a day — the
user's own memory file `applyyy-supabase-cli-authenticated` already recorded the distinction, and
the repo docs never picked it up.

### T2 — the migration backlog is **THREE**, and all three are the reviewed ones

Four sources, four different numbers, none of them right:

| Source | Claim | Reality |
|---|---|---|
| `CLAUDE.md:483` | "SEVEN files, not two" | wrong |
| `docs/handoff/RESUME-HERE.md:49` | "The apply set is **EIGHT**" | wrong |
| `docs/architecture/graph-engineering.md:262` | "exactly two" | stale (09-11 measurement) |
| memory `applyyy-migration-backlog-is-two-not-seven` | "two" | stale (09-17 measurement) |
| **`supabase migration list --linked`, 2026-09-18** | **18 local, 15 applied, 3 pending** | **measured** |

Genuinely unapplied — local file present, `remote` field empty:

- `20260917124500_fix_bootstrap_filter_rule_seed_columns.sql`
- `20260917130000_guard_application_status_on_insert.sql`
- `20260917174600_retract_forged_fast_path_agent_events.sql`

All three are the 09-17 files, i.e. **the only three anybody has reviewed.** RESUME-HERE's eight-item
apply set includes five files (`20260910220800`, `20260911114300`, `20260911235500`,
`20260912001500`, `20260912120000`) that are already on the remote; `db push` will skip them.

**Two consequences that change the plan:**

1. **The `create policy` idempotency hazard cannot fire.** `20260910220800_create_private_storage_buckets.sql`
   really does have the defect — its comment at `:43-45` claims re-running is safe, which is true of
   the bucket insert at `:57` and false of the four bare `create policy` statements at `:86`, `:99`,
   `:110`, `:127` (zero `drop policy` in the file; a second run raises `42710`). But the file is
   **already applied**, so `db push` will never re-run it. The one-second pre-flight that
   RESUME-HERE §2 builds its runbook around is **no longer on the critical path**. Latent defect,
   not a blocker.
2. The "if it dies between files 5 and 6" recovery analysis is moot — files 1–5 are not in the set.

### Why all four counts were wrong, and it is the same mistake each time

`CLAUDE.md:483` and `RESUME-HERE.md:49` were derived by **counting files on disk after a date
cutoff**. The two "two" claims were derived by **querying, on 2026-09-11 and 2026-09-17** — and then
quoted forward as settled fact without their timestamp.

`RESUME-HERE.md:27` warns about exactly the first failure: *"Every claim about applied migrations is
inferred from filenames. Say so out loud."* The doc states the rule and then breaks it eighteen lines
later. The second failure is the one `CLAUDE.md` §4 already names — *a test count is a measurement at
a timestamp, not a property of the repo* — applied to migrations instead of tests. **A measured claim
decays into a false one the moment it is copied without its date.**

---

## 2. Verdict table — all 24 tasks

`PENDING` = claim verified true, work still open. `STALE` = already done, or the claim is false.

| # | Task | Verdict | Evidence |
|---|---|---|---|
| T1 | Authenticate Supabase connector | **STALE — false premise** | CLI v2.117.0 authenticated; `migration list --linked` exit 0, non-interactive |
| T2 | Apply the migrations | **PENDING, but 3 files not 8** | ledger above |
| T3 | The 60-second deploy test | **STALE — ANSWERED, production is current** | two sentinels over the live bundle, reproduced by two sessions; see §4 |
| T4 | Dispatch `apply.yml` with `dry_run` | PENDING (optional) | `apply.yml:26-33`, defaults `true` |
| T5 | Second reader for `20260917174600` | **PENDING — all 4 claims confirmed** | discriminator `:103`, `:122-123`; marker `:155`, `:205-210`; both counts `:117-124`, `:212`, `:227-229`; `raise warning` `:219-222` |
| T6 | `ApprovalQueuePage:214` null→shape check | **PENDING** | `:214` still a bare null/undefined test; `:223-224` fallback still present, still unreachable |
| T7 | Nothing builds `apps/web` in CI | **PENDING — wider than stated** | 3 workflows; `grep -ri vercel .github/` = 0; grep for `typecheck`/`tsc`/`build` = **0**. *No package is typechecked or tested in CI at all* |
| T8 | 4 Deno type errors | **PENDING — confirmed by running it** | `deno check` run bare, EXIT=1, 43 files checked, `Found 4 errors.` |
| T9 | The Auditor does not exist | **PENDING** | `find supabase/functions -iname "*audit*"` = 0 hits |
| T10 | No runner writes `deduped` | **PENDING, both halves** | helpers imported at `ats/registry.ts:25,27`, `scout/tiers.ts:20,21`; zero writers repo-wide |
| T11 | `match`/`tailor`/`gemini`/`agent`/`eval` unreachable | **PENDING — one clause false** | `_shared/eval/` **has** a non-test importer: `match/scorer.ts:25` |
| T12 | No `discovered → passed_filters` edge | **PENDING — narrower than stated** | `status_transition_guard.sql:101-103`; strands **fallback-path rows only** |
| T13 | Nothing writes `tailored_profile` | **PENDING** | 2 hits repo-wide, both declarations: `tables.ts:524`, `fixtures.ts:40` |
| T14 | Nothing calls `bootstrap_user_defaults()` | **PENDING** | complete `.rpc(` inventory = 7 sites, none of them it; 17 triggers, all on `public.*` |
| T15 | PDF path broken three ways | **PENDING — all 4 sub-claims true** | `pdfExtractor.ts:17-21` probes `extractPdf`; symbol absent from the package; not in `apps/web` deps; bare `catch {}` at `:23` |
| T16 | `master-robots` has no Deno caller | **PENDING — pointer stale** | 0 imports under `supabase/functions`; real seam is `transport.ts:94`/`:146`/`:367`, **not `:301`** |
| T17 | W2 vite, W4 vitest | **W3 STALE (done), W2+W4 PENDING** | playwright 1.55.1 in both manifests + lockfile; vite still `6.0.3`; vitest still `2.1.8` |
| T18 | Re-derive the tier scheme | **PENDING** | Tier 2 exists and is empty (`plan:204`); deferral stated at `:222-223`, `:455-458` |
| T19 | Actions-budget flag | **PENDING — every repo-side fact confirmed** | env vars absent everywhere; `pnpm-workspace.yaml:67` `allowBuilds: playwright: true`; scout/keepalive have no browser cache. Conclusion still unproven — see §3 |
| T20 | `worker/scripts/` untypechecked | **PENDING** | `worker/tsconfig.json` include list omits `scripts/**`; one real 16KB file there |
| T21 | No component render harness | **PENDING** | `apps/web` test script is `node --test`; no jsdom/testing-library/vitest; 17 `.test.ts`, zero `.tsx` |
| T22a | PROJECT_PLAN "peers never commit" | **STALE — already fixed** | `PROJECT_PLAN.md:215-222` leads with the grant; the old rule survives only as quoted, retired text at `:217-219` |
| T22b | Diagram shows `screened`/`screening` | **PENDING — +1 instance** | `PROJECT_PLAN.md:530,533`, **and unlisted `:692`**; rename recorded at `:399` |
| T22c | §8 example built on `experience_ceiling` | **PENDING — claim mis-scoped** | the code block `:427-431` drops on the *title blocklist*, which works. The stale part is the table row `:439` plus `:448` "Every row is a settings field you control" |
| T22d | PROGRESS "every status write" | **PENDING** | `docs/PROGRESS.md:566`; counter-evidence `screen-batch.ts:188,202,207` inserts directly |
| T23 | `supabase-js` modernisation | **PENDING** | pinned `2.50.0` in both manifests; `planJobUpsertGroups` at `_shared/screen/upsert-plan.ts:83` |
| T24 | `ApprovalQueuePage` hand-rolls read-state | **PENDING — count off by one** | `readState.ts` has **5** non-test importers, not 6; the sixth is its own test |

**Tally: 20 pending, 4 stale — and 8 of the 20 needed a correction to the claim itself.**

**Three of the four "stale" entries were never work at all — they were blockers that did not
exist** (T1 Supabase, T3 deploy, and T17/W3 already shipped). That ratio is the finding: the
backlog was not mostly wrong about the *code*, it was wrong about what we could *reach*.

---

## 3. Corrections to the handoff — where the doc was wrong, not merely old

These matter more than the stale entries, because `CLAUDE.md` §2 is right that *a stale claim gets
re-checked, an attributed one gets trusted.* Each of these arrived with a `file:line` that made it
look already-verified.

1. **T1's "No Claude session can do this."** False. Cost: it sat at the top of the blocked list
   overnight, and all of §2 was written around not being able to answer it.
2. **T2's count.** Three docs and one memory; four numbers; all wrong. Corrected above.
3. **T8's `tiers.ts:384`.** The diagnostic is reported at **`:381`** (the `raw_payload:` property
   key); `:384` is the offending *member* (`portal_job_id: input.portalJobId`). The `?? null` fix is
   right — note `ats_job_id` at `:376` already does exactly that. A reader who opens `:381`, sees no
   obvious defect and moves on will conclude the whole inventory is unreliable.
4. **T11's "zero non-test importers" for `_shared/eval/`.** False — `match/scorer.ts:25` imports it
   (type-only). The *conclusion* survives, because `match/` itself has zero importers, so `eval` is
   dead **transitively, not directly**. Worth the distinction: deleting `match/` deletes `eval`'s
   only caller; deleting `eval/` first breaks `match/`.
5. **T12's blast radius.** Rows reach `discovered` **only on the screener-unavailable fallback
   path** — both scouts normally insert at `passed_filters` (`worker/src/cli/scout.ts:314`,
   `scout-ats/index.ts:402`; fallbacks at `:312` / `:400`). "The existing backlog can never be
   screened" overstates it: the stranded set is fallback-path rows, not the discovery stream.
6. **T16's `transport.ts:301`.** At HEAD that line is inside a bare `fetch()` call. The injectable
   seam is `:94` (`export interface RetryPolicy`), `:146-147`, consumed at `:367` — and
   `transport.test.ts:436` names it "the seam master-robots needs". The pointer drifted from an
   older revision.
7. **T22c's wording.** "The worked example is built on `experience_ceiling`" is imprecise; the
   illustrated drop uses a rule that works. Re-scope it to the filter-table row `:439` and the
   unqualified claim at `:448`.
8. **T24's "six other files".** Five. The sixth is `readState.test.ts`, the helper's own test.

**Also found, not in the handoff at all:** `DiscoveredJobsPage.tsx:243` is cited by
`docs/audit/2026-09-17-unapplied-migrations-review.md:400` and
`docs/security/2026-09-17-pipeline-identity-gaps.md:221` as a UI writer of `deduped`. It no longer
exists — it went out with the fast-path button deletion (`75a75a0`). Two docs still cite it.

---

## 4. T3 is ANSWERED — production is current

**Updated 13:16 IST.** `RESUME-HERE.md:38` blocked the deploy check on the Vercel CLI not being
installed. The CLI really is absent — **and it never mattered.** The bundle is public. Peer
`applyyy-f1` answered it with `curl`, and this session **reproduced it independently rather than
quoting the peer** (at that session's own request):

```
curl -s https://applyyy.vercel.app/ -o idx.html                          # HTTP 200
grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' idx.html                     # /assets/index-Ba-KNQiA.js
curl -s https://applyyy.vercel.app/assets/index-Ba-KNQiA.js -o app.js    # 532,579 bytes
grep -c "Nothing compared these against your master profile" app.js      # 1  PRESENT
grep -c "Fast-tailored and queued from Discovered Jobs Explorer" app.js  # 0  ABSENT
```

**Production is serving the post-deletion copy, and the forged fast-path button is gone from it.**
Both sessions got byte-identical results.

Two things worth keeping:

- **The two-sentinel design is why this is conclusive.** One string that must be PRESENT and one
  that must be ABSENT. A present-only check cannot tell "the new bundle" from "a bundle that
  happens to contain the string"; the absent-check is what closes it. This is `CLAUDE.md` §5's
  *validate the shape you expect* applied to a deploy.
- **This is the third blocker in one session that was a tooling-inventory problem, not an access
  problem** — after T1's Supabase CLI and the Vercel MCP tools nobody had enumerated. Each one
  recorded *"the one route I reached for is absent"* as *"no route exists"*, and because each was
  phrased as a capability limit rather than a claim, **nobody re-tested it.** A missing CLI is not
  an unreachable platform. **Before recording anything as blocked, enumerate every route to the
  thing.**

*(Vercel MCP tools are also connected and remain the better route for build logs and env vars,
which `curl` cannot see.)*

---

## 5. Recommended order, given the corrected facts

1. **`supabase db push`** — three reviewed files, no pre-flight needed, hazard discharged. Much
   smaller than the docs made it look. Still take the baseline count **first**: file 6's whole point
   is that a count taken only afterwards cannot distinguish *seeded 18* from *was already 18*.

   **And it has real work to do — measured live 2026-09-18, this is new.** Reading the remote
   read-only with `supabase db query --linked`:

   | fact | measured | what the docs said |
   |---|---|---|
   | `auth.users` | **2** | zero (`docs/PROGRESS.md:70`, review §1.3) |
   | `filter_rules` | **9** | "empty" (`CLAUDE.md` §8) |
   | `applications` | 1,492 | — |
   | deployed `bootstrap_user_defaults()` | contains `evaluation_order`, **not** `sort_order` | "the break is not live yet" |

   The seeded set belongs to **one** of the two users; the second has 0 filter_rules, 0
   search_preferences, 0 system_settings. So `20260917124500` is **not** the low-effect migration
   it was reviewed as — the broken function is **live right now**, and there is a real unseeded
   account for its backfill to fix. It was sized as "APPLY WITH CAVEAT, LOW on effect." That is
   wrong in the direction that gets a migration deferred forever.

   **Two claims in the review doc were not merely stale, they discouraged the check that refutes
   them:** *"the break is not live yet"* and *"do not go looking for damage that may never have
   been done."* Both are now retracted in place. **An instruction not to look is the most
   expensive kind of wrong** — a stale fact gets re-measured by the next person who needs it; a
   stale fact that tells you measuring is pointless does not.
2. **T8** — four one-line type fixes, and nothing in CI will ever catch them for you.
3. **T7** — ~15 lines of YAML, and the finding is worse than logged: **no package is typechecked or
   tested in CI at all.**
4. **T6** — shape check plus deleting the dead fallback, in one pass. **Sequencing matters, and
   the reason to fix it is not the obvious one.** Framing refined 2026-09-18 with `applyyy-f1`,
   which is designing the Tailor runner:

   The `'{}'::jsonb` hazard at `ApprovalQueuePage.tsx:214` is **not** a hazard about the coming
   Tailor. `_shared/tailor/validator.ts:70` already declares `{ok:true, resume: ResolvedResume}`
   "the only way a `ResolvedResume` comes into being", and a runner built on it cannot emit a
   `'{}'` row. The gate needs fixing because **a gate must not trust its producers** — a hand-edit
   in the SQL editor, or a later agent that skips the validator, is the real source. Those two
   framings send a reader to different fixes: one hardens the consumer, the other sends someone
   auditing a runner for a bug it cannot have.

   **Today the gate guards a column with no producer, so it has never been exercised in anger.**
   The moment a real `ResolvedResume` lands, `:214` goes from decorative to load-bearing and the
   dead fallback at `:223-245` goes from harmless to actively misleading. T6 is **not** a
   prerequisite for the Tailor runner — but the CLI-driven window before that runner is wired to
   anything automatic is the cheap time to land it.
5. Then the severed-pipeline tier (T9–T14), which is design work, not repair work.

---

## 6. What this exercise is an instance of

Every wrong claim here failed the same way, and it is the mirror of `CLAUDE.md` §5's reader-side
rule. There the fail-open is *the permissiveness of the reader*. Here it is **the confidence of the
record**: a claim written with a `file:line` reads as verified, so nobody re-runs the command.

The counter-discipline is the one `CLAUDE.md` §4 already states and this repo keeps re-learning:
**any inventory that can drift must point at the command that regenerates it, never at the list
alone.** The migration count is the proof — four sources, four numbers, and the one-second command
that settles all of them was available to every one of the four.
