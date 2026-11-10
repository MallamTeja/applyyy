# Edge Functions stream — findings, open questions, and things not to re-derive

> **Status 2026-11-08:** Partly superseded. The findings in sections 1, 3, 4 and 8 still hold; sections 5 and 6 were not re-checked in this pass. Changed since: the `bundle-probe` cleanup in section 1 is done (no `supabase/functions/bundle-probe/` exists); the section 2 test is now `_shared/ats/adapters.test.ts`; section 7 is fixed (`email_events.thread_id` added in migration `20260918213000`, and `email-tracker-intake/index.ts` stores it); section 9 is stale, because no migration schedules a function with pg_cron and the drains run from GitHub Actions (`prescreen-drain.yml`, `postscreen-drain.yml`, `satellites.yml`); section 10's key count is stale (the pool prefix-scans `GEMINI_API_KEY_*`, `_shared/gemini/pool.ts`). The current per-function reference is `docs/functions/README.md`. The body below is the original record, unedited.

**Scope:** `supabase/functions/**` only. Written here rather than in `docs/` because
`docs/` belongs to another stream and this file must live beside the code it describes.

**Status of everything below:** stated at the confidence it was actually established.
Where something is unproven it says so, in those words, rather than being rounded up.

---

## 1. Deno ↔ Node cross-boundary imports: **SETTLED — IT WORKS**

**Answered 2026-09-10 18:50 by deploying, not by reasoning.** `supabase functions
deploy` **does** bundle files outside `supabase/functions/`. No `deno bundle`
pre-step is needed and no layout change is required. Keep imports bundleable.

**Evidence, both halves:**

1. The deploy log enumerates the cross-boundary files it uploaded:
   ```
   Uploading asset (bundle-probe): supabase/functions/_shared/contracts/shared-types.ts
   Uploading asset (bundle-probe): packages/shared-types/src/index.ts
   Uploading asset (bundle-probe): packages/shared-types/src/tables.ts
   Uploading asset (bundle-probe): packages/shared-types/src/profile-nodes.ts
   Uploading asset (bundle-probe): packages/shared-types/src/enums.ts
   Uploading asset (bundle-probe): packages/shared-types/src/status-flow.ts
   ```
2. **Upload is not execution**, so the deployed function was then called:
   `GET /functions/v1/bundle-probe` → `200`
   `{"cross_package_import":"resolved at runtime","status_count":21,"first_status":"discovered"}`

**Why the probe imports a runtime VALUE and not a type — the design point that makes
this evidence rather than a vacuous green.** `import type` is erased at compile time,
so a probe built on one would pass identically even if the bundler ignored
`packages/` completely: a test that cannot fail. `APPLICATION_STATUSES` is a `const`
tuple that must physically be in the deployed bundle for the function to respond at
all. The returned `status_count: 21` and `first_status: "discovered"` match the shared
package, so the tuple arrived with its contents rather than as an empty stub.

`email-tracker-intake` then deployed the same way, carrying nine assets across the
boundary including `_shared/db/client.ts` and both intake modules.

**CLEANUP OWED:** `supabase/functions/bundle-probe/` is a throwaway and is still
deployed. It requires an anon JWT, touches no tables and returns only a count, so it
is harmless — but it should be deleted (`supabase functions delete bundle-probe`) and
the directory removed now that the answer is recorded here.

---

### Superseded record of how this stood before the probe

Kept because the reasoning was correct and the distinction is reusable.

`supabase/functions/**` imports `packages/shared-types/src/index.ts` through a single
quarantine module, `_shared/contracts/shared-types.ts`, using a **relative** path.

`deno check` proved the graph RESOLVED and type-checked, which ruled out the "path is
simply wrong" failure. It could not prove the CLI's bundler FOLLOWS a resolvable graph,
because the CLI has no dry-run or bundle-only flag — so the honest state was
**"resolution proven, bundling unproven"**, and it was deliberately not rounded up to
"it works". That distinction held for a day and was the correct thing to record.

The unused fallback, kept in case a future CLI change reopens the question:
`deno bundle --config supabase/functions/deno.json -o <out>.js`, documented in
`packages/resume-template/README.md`, where it collapsed the graph to 723 bytes in
570ms.

**Why the relative path and not the bare `@applyy/shared-types` specifier:** Deno reads
`deno.json`'s import map and Node's test runner does not. The relative path works in
both today with zero configuration. Confining it to one module means switching later is
a one-line edit rather than a sweep.

---

## 2. CONTRADICTION: the cold-start guard's scope

**Two artifacts disagree, and this has not been ruled on. Do not silently pick one.**

- `SCHEMA_CONTRACT.md` §8.7 says: *"On a board's first poll only `derived` degrades to
  `unknown`."* Read literally, a Greenhouse `updated_at` — which is always `derived` —
  degrades to `unknown` on a first poll.
- `_shared/normalize/posted-at.ts` (this stream, 14 tests, written before I arrived)
  degrades **only the `first_seen_at` inference**. A Greenhouse `updated_at` stays
  `derived` on a first poll, because the board genuinely gave us a timestamp.

**The axis they differ on is not confidence level — it is where the date came from.**

The implementation's argument, which is in its comments: §13's defect lives entirely in
the "anything we have never seen must be new" inference. A Greenhouse `updated_at` is a
real board timestamp with the wrong *meaning* (edit date, not post date), so a job last
edited in March correctly reads as stale on day one. Degrading it discards a true fact
to defend against a guess we never made — and supply is the scarce thing (§13: a 3-day
window over 50 boards yields single digits per day, not 35).

**The counter-argument, which is real and is why this needs a ruling:** on a new
Greenhouse board, a job open since March whose description was edited yesterday has
`updated_at = yesterday` and looks fresh. That is precisely the stale-but-recently-
touched posting §13 does not want quota spent on, and `derived` passed the staleness
filter.

**Moot since 2026-11-10:** the staleness (job-age) rule is retired (Teja: "dont ever skip
even though they are 1 mon 2 mont old"; commit 8ba2b06, migration
`20261110120000_retire_job_age_and_company_cap.sql`). The cascade's `retiredRule` never
drops or warns, so `posted_at_source` no longer decides whether a job survives. It still
says how far to trust the displayed date.

**Currently shipped behaviour:** the implementation's. `_shared/ats/adapters_test.ts`
pins all three cases explicitly ("the cold-start guard degrades the first_seen_at
inference and nothing else"). If the ruling goes the other way, that test is the one
line to change, and `posted-at.ts` is the only place the policy lives.

**Raised with:** the orchestrator, for the schema owner to rule on.

---

## 3. `posted_at_source = 'unknown'` has exactly one cause

**It means "this board is not yet trusted". It NEVER means a parse failure.**

Every degraded input — malformed string, epoch 0, missing field, unparseable prose —
resolves to `derived` via `first_seen_at`. No column type can express this, and a
reader who assumes `unknown` signals a bad parse will write the wrong filter. Pinned by
a test in `adapters_test.ts` for exactly that reason.

`unknown` used to **fail** the staleness check rather than bypass it, via the setting
`filter_rules.config.treat_unknown_posted_at_as_fresh` (default `false`). **Retired
2026-11-10:** the staleness rule no longer drops anything (Teja: job age must never skip a
job), and migration `20261110120000_retire_job_age_and_company_cap.sql` deleted the
`staleness` rows that carried this setting, so nothing reads it. The enum value
`staleness` stays only because Postgres cannot drop one.

---

## 4. Mutation-testing results on the layered defences

**The rule:** *a test that passes when you delete the guard it is named after is
testing the composite, not the guard.* Redundant defences make each other untestable —
when two guards can both catch a case, isolating one needs an input that ONLY that
guard catches.

Four mutations run, each restored byte-identically and verified with `diff`.

| Guard mutated | Tests that failed | Verdict |
|---|---|---|
| `validator.ts` parent-scope check | exactly 1 (`misattributed_bullet`) | independently tested |
| `validator.ts` unresolved-ref report | exactly 1 (`unresolved_ref`) | independently tested |
| `prompt.ts` neutralize on **title + company** | **0 — all 23 green** | **GAP, now closed** |
| `prompt.ts` neutralize on description | 1 | was already tested |
| `validator.ts` global master-id uniqueness → **per-section** | 5 of 26 | suite discriminates the two designs |

**The per-section mutation is the most instructive of the five.** Global uniqueness
was replaced with per-section uniqueness — the plausible wrong design, and the one
that reads as more sensible. Result: **21 passed, 5 failed**, and critically *the
within-section duplicate test SURVIVED*. That is the test most people would write
first, and on its own it would have ratified the broken design. The five that died
were the cross-parent bullet collision, two parent-id collisions, the skill/bullet
collision, and the totality check. **A checker that catches the common mistake and
misses the dangerous one is worse than none, because it produces confidence it has
not earned** — the collision per-section misses is exactly the one a flat index
cannot survive.

**The gap and why the old test missed it:** the existing test asserted
`systemInstruction` byte-equality. That property is satisfied by the *assembly* —
untrusted fields are never interpolated into the instruction region — so it held
whether or not the fields were neutralised. **Fence FORGERY is a different property
from fence PLACEMENT, and only placement was covered.** It was testing the right thing
about the wrong layer.

Closed by three new tests, one payload per field, every other untrusted field held
benign so only the guard under test can catch it: forged closer in title alone, forged
closer in company alone (separate on purpose — one test covering both would pass with
only one guard live), and a forged *opener* in the title as the mirror attack, since a
second opener makes an ambiguous nested region rather than an early close.

**What is NOT claimed:** that the fence is total. The defensible statement is narrower —
*the fence resists forgery of its own delimiters in all three untrusted fields.* No
payload has been demonstrated that defeats the fence and is caught only by the
validator, and that remains an **open question** rather than a conclusion. Property 3
(validator rejection of anything a compromised model emits) is separately and directly
tested, so the layers are not propping each other up.

---

## 5. The two very different NULLs from `claim_gemini_key()`

~~`bootstrap_user_defaults()` **never seeds `gemini_key_state`**, and nothing else in the
repo writes to it either.~~ *(CORRECTED 2026-10-24: since `20261009150000`,
`applyy_internal.seed_user_defaults` — called by the signup trigger `20261008180000` —
DOES seed `gemini_key_state`; live rows re-measured today.)* On an account where seeding
never ran, `claim_gemini_key()` returns NULL
forever, every agent dutifully releases its claim, and the pipeline **looks merely idle
with no error anywhere** — the exact silent stop §14 exists to prevent.

The pool client must therefore distinguish:

- **NULL with `count(*) > 0` on `gemini_key_state`** — all keys cooling, or the daily
  budget is spent. Normal, self-healing, **not even logged as unusual.** A health page
  that cries wolf about ordinary quota behaviour is a page Teja stops reading.
- **NULL with `count(*) = 0`** — no keys configured at all. **Needs a human**, surfaces
  on the health page immediately.

Today both are the same NULL and they demand opposite responses.

---

## 6. RPC return shapes — `tables.ts` is wrong on two, follow the SQL

- `claim_gemini_key()` is `returns smallint`, so over PostgREST it is a **bare number
  or null**. Never `data.key_index`.
- `sweep_stale_claims()` is `returns table (...)`, so it yields an **array**:
  `data[0].released_count`. Its `released_count` also **double-counts** rows the first
  statement just moved to `needs_verification`, so do not build a metric on it.

---

## 7. Fields the intake contract sends that the schema cannot store

`email_events` has no column for `thread_id`, `to`, or `label_ids`. The intake endpoint
validates all three and then drops them. `thread_id` is the one that will hurt: it is
the natural key for "has this recruiter already replied?".

Validating-then-dropping is still worth it — the day a column is added, the parser
already produces the value and only one function changes. Raised with the schema owner.

---

## 8. One Auth user, one credential pair — do not let two names survive

RLS scopes every row by `auth.uid()`, so a second Supabase Auth user would be a second
disjoint `user_id` and the worker and dashboard would silently stop seeing each other's
rows. There is therefore **exactly one** application identity.

One name everywhere: `APPLYY_APP_USER_EMAIL` / `APPLYY_APP_USER_PASSWORD`
(`_shared/db/client.ts`). **Two names for one credential is how somebody rotates only
one of them.** *(Resolved 2026-10-23: the ruling — `docs/PROGRESS.md` "one credential,
one name", 2026-09-10 — picked `APPLYY_APP_USER_*`; code and workflows were renamed in
`21f0701`, and `SCHEMA_CONTRACT.md` §8.3, which this section previously flagged as
still saying the old `APPLYY_WORKER_*` names and "awaiting the ruling", was fixed on
2026-10-23.)*

**No service-role key anywhere in this stream.** Edge Functions sign in as the ordinary
app user and run under normal RLS, so *an Edge Function cannot do anything Teja could
not do from the dashboard*.

---

## 9. Batch sizes are set by the CPU limit, not the wall clock

Supabase free tier: **~150s wall clock, ~2s CPU**, and **the 2s CPU is the binding
one**. CPU measures active computing, so a 40s Gemini wait costs almost none of it.

That means CPU-bound and wall-clock-bound stages want **opposite** batch sizes, and one
number cannot serve both:

| Stage | Batch | Why |
|---|---|---|
| Scout-ATS | **1 board** | `content=true` returns every full HTML description at once; multi-MB `JSON.parse` is the risk, not per-job work |
| Normalizer | 50 | light per-row work |
| Screener | **200** | no LLM, no I/O, pure set/regex — the one stage that can afford volume and needs it |
| Matcher / Tailor / Auditor | 5 | wall-clock bound, ~zero CPU |
| Tracker | 50 | one Gemini call each, wall-clock bound |

**Every stage re-fires via `pg_cron` rather than draining.** An agent written to
"process all pending" passes in testing on ten rows and fails in production on four
hundred.

---

## 10. Never hardcode a quota number

Google no longer publishes free-tier limits, with credible reports of Flash being cut
250 → 20 RPD. `gemini_key_state.requests_today` is **observability only, never a
gate**. The only gate is `system_settings.gemini_daily_call_budget`, which a human set
and which is nullable (NULL = uncapped). The pool is purely reactive: use a key until
it 429s, believe its `retry_after`, move on.

Teja has **six** keys (`GEMINI_API_KEY_01`…`_06`), not fifteen. Keys are discovered by
**prefix scan**, so the pool must be correct with exactly one configured.
