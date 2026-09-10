# The agents in `applyy` — what each one does, and which actually exist

**Written 2026-09-10 21:56 IST.** Answers "how many agents do we have and what
does each do", in detail.

**Read the status column first.** There are **twelve agent identities** the
database recognises, **eleven** things that could reasonably be called an agent,
and — as of tonight — **two** of them have code you could run. A roster that
listed all eleven as though they were running would be the most useful-looking
and least true document in the repo, so every row below says which it is and
what the evidence was.

Sources: `PROJECT_PLAN.md` §7 and §14 for intent; the **live database** for the
transition table (queried, not read from a migration file); and a direct listing
of `supabase/functions/**` for what exists.

---

## 1. The shortest useful answer

| # | Agent | Runs on | Calls Gemini? | State |
|---|---|---|---|---|
| 1 | **Scout-ATS** | Edge Function, cron | no | **logic built, no entrypoint** |
| 2 | **Scout-Aggregator** | Edge Function, cron | no | **not built** |
| 3 | **Normalizer** | Edge Function, cron | no | **logic built, no entrypoint** |
| 4 | **Screener** | Edge Function, cron | **no — deliberately** | **logic built, no entrypoint** |
| 5 | **Matcher** | Edge Function, cron | **yes** | **logic partly built, no entrypoint** |
| 6 | **Tailor** | Edge Function, cron | **yes** | **logic built, no entrypoint** |
| 7 | **Auditor** | Edge Function, cron | **yes** | **not built** |
| 8 | **Applier** | GitHub Actions + Playwright | no | **BUILT AND RUNS** (dry-run only) |
| 9 | **Tracker** | Edge Function, **push** | yes (classification) | **intake BUILT AND LIVE**, classifier not built |
| 10 | **Sweeper** | database function, cron | no | **BUILT** (SQL, live) |
| 11 | **Keepalives** ×2 | Actions cron / DB query | no | **one built but disabled, one implicit** |
| — | **`human`** | you, in the dashboard | no | the most powerful identity in the system |

**So: two agents you can actually run today** (Applier in dry-run, Sweeper),
**one live endpoint** (the Tracker's email intake), and **nine agents' worth of
shared logic sitting in `supabase/functions/_shared/` with nothing wired to
call it.**

That last point is the real state of the project and it is better news than it
sounds — see §5.

---

## 2. The kill switch: what that one row actually stops

**Every agent checks `system_settings.system_enabled` first, before any other
work.** One row halts the entire system on the next tick, without deleting a
cron or revoking a key at 2am. It is the only safety-critical check in the
stream and it is `PROJECT_PLAN.md` §18.1.

It stops rows **1–7 and 10–11** — every Edge Function agent, the sweeper and the
keepalives — plus the **Applier**, which checks it before claiming work.

**It does not stop the `human` identity**, and it should not. You approving a
row in the dashboard is not something the kill switch exists to prevent.

**The switch has three "off" states and only one is obvious**, which is the part
worth understanding:

1. `system_enabled = false` — the deliberate stop. What you flip.
2. **No settings row at all** — the account was never bootstrapped. *This is the
   live database's current state*, so it is production behaviour, not a
   hypothetical.
3. **The read failed** — transport, RLS, a paused project.

All three halt, and they halt under **different names** (`disabled`,
`no_settings_row`, `unreadable`) because the remedies differ: the first needs
nobody, the second needs one RPC call, the third is a genuine incident. A health
page that could not tell them apart would report an outage every time you paused
the system — and a page that cries wolf is one you stop reading.

The natural implementation gets states 2 and 3 wrong **in the same direction**:
an absent row reads as an absent objection, and a failed read looks like
something to retry past. Both would have an agent acting on your behalf while
unable to confirm it is allowed to. So it fails **closed**.

**Belt and braces:** `claim_applications()` and `claim_gemini_key()` also check
`system_enabled` internally, so an agent that skipped the check would still claim
nothing. But the SQL check alone presents as *"the queue is empty"* —
indistinguishable from a quiet day. The explicit check is what turns the same
condition into a named, visible reason.

Code: `supabase/functions/_shared/agent/kill-switch.ts`, with 31 tests that
**as of tonight are finally run by something** — they were unreachable by every
runner in the repo until commit `5d367b4`.

---

## 3. What each agent does, and what it may do to your data

The "may write" column is not documentation — it is enforced. Every status
change goes through `advance_application_status()`, which checks the attempted
edge against `public.application_status_transitions` **and** against the
`applyy.acting_agent` identity the caller set. There are **45 edges** in that
table on the live database right now.

> Note: PROJECT_PLAN and several docs say **44 edges**. Measured live tonight it
> is **45** — migration `20260910190000` added `approved → blocked_needs_human`
> and the older figure was never swept. Trust the query, not the prose.

### 1. Scout-ATS — finds jobs on company boards
Polls the company watchlist's Greenhouse, Lever and Ashby boards and inserts
whatever it finds at `discovered`. **Creates rows rather than transitioning
them**, which is why it has zero edges in the table.

Batch size is **one board per run**, which looks absurdly small until you know
why: a Greenhouse `content=true` response returns every full job description at
once, so a multi-megabyte `JSON.parse` is the actual CPU risk on a ~2s CPU
budget.

*Built:* `_shared/ats/` has Greenhouse, Lever and Ashby adapters plus a registry,
all tested. **No `scout-ats/` function directory exists**, so nothing invokes
them.

### 2. Scout-Aggregator — finds jobs on aggregators
Same job via Adzuna/Jooble, for postings that never touch an ATS board.
**Not built at all** — no adapter, no entrypoint.

### 3. Normalizer — deduplicates and dates
`discovered` → `deduped` / `dropped_duplicate` / `failed`. Fingerprints each job
so the same role found on three boards becomes one row, and decides how much to
trust its `posted_at`.

**Why it matters more than it sounds:** `posted_at` is the least reliable field
in the system. Greenhouse gives `updated_at` — a description edit resets it.
Lever and Ashby give genuine dates. Aggregators sometimes give relative text. So
each job carries `posted_at_source ∈ {exact, derived, unknown}` and the 3-day
freshness filter behaves differently per confidence level.

**The cold-start guard is the subtle part.** The obvious fallback for an unknown
date is "we've never seen it, so it's new" — sound in steady state, and wrong on
day one of any new board, where an entire back catalogue arrives looking three
days old. So a board's *first* poll marks everything `unknown` and excludes it
from the filter. Boards become trustworthy from their second poll onward.

*Built:* `_shared/normalize/fingerprint.ts` and `posted-at.ts`, tested.
**No entrypoint.**

### 4. Screener — throws most jobs away, cheaply
`deduped` → `passed_filters` / `dropped_filter` / `failed`.

**This one has no LLM, on purpose, and that choice is what makes free Gemini keys
sufficient rather than merely hopeful.** Deterministic filters run *before*
anything costs a model call, and most discovered jobs die here. Batch size
**200** — the one stage with no LLM and no I/O, so it is the only one that can
afford volume and it is the one that needs it.

*Built:* `_shared/filter/cascade.ts`, tested. **No entrypoint.**

### 5. Matcher — scores fit
`passed_filters` → `scored` / `dropped_filter` / `failed`. First Gemini call:
compares the job description against your master profile and scores it.

**It is deliberately gated.** §18.3 forbids tuning the Matcher's prompt before
~20 hand-labelled jobs exist in `matcher_eval_cases`, because otherwise you tweak
a prompt to fix one bad match and silently break scoring on everything else with
no way to notice. **Those labels don't exist yet, so a Matcher built now could
not be evaluated** — which is precisely the failure the gate exists to prevent.

*Built:* the eval gate (`_shared/eval/gate.ts`) and the Gemini pool exist.
**No prompt, no entrypoint.**

### 6. Tailor — rewrites the resume for one job
`scored` → `tailored` / `failed`. Second Gemini call, and **the most
safety-critical agent in the system.**

**It cannot invent anything, by construction rather than by checking.** The
master profile is JSON where every node carries a stable id, and the Tailor
returns **references to those ids**, not free text. So an invented skill is not
"detected and rejected" — it is *inexpressible*, because there is no id to point
at. That is the whole architecture of the anti-fabrication guarantee.

A validator then re-checks every reference resolves, is scoped to the right
parent, and smuggles in no unbacked technology or metric.

**The subtle attack it defends against is `misattributed_bullet`:** a bullet that
genuinely belongs to a personal project, nested by the model under a named
employer. Every individual claim survives a fact-check — the work happened, the
words are true — and yet the resume now credits your side project to a company.
**Fabricated experience assembled entirely out of true parts.** Line-by-line
tracing passes it, which is why references are validated for *parent scope* and
not merely for existence.

*Built:* `_shared/tailor/validator.ts` and `prompt.ts`, both tested — and the
validator's tests **had never been executed by any runner** until commit
`65a9842` tonight, despite §19 calling that file "the load-bearing wall under
constraint #2". **No entrypoint.**

⚠️ One live gap found while wiring those tests: the *invented-metric* check is
caught by exactly **one** test out of 249. It works, but it is thinly defended.

### 7. Auditor — the second opinion
`tailored` → `audit_clean` / `audit_flagged` / `failed`, then either onward to
`awaiting_approval`. Third Gemini call.

**Its whole justification is generator–critic separation: never let the model
that produced the artifact be the one that approves it.** A flagged tailoring
goes into the review-individually bucket; a clean one can be batch-approved.

Cover letters need no human approval **but are still Auditor-gated**, because
prose invents more freely than bullet points — a cover letter is exactly where a
model writes *"during my time leading a team of five…"* about something that
never happened.

*Built:* **nothing.** No prompt, no entrypoint.

### 8. Applier — actually submits (and currently cannot)
`approved` → `applying` → `applied` / `blocked_needs_human` / `failed`. Runs on
GitHub Actions with Playwright, not as an Edge Function.

**`approved → applying` is the only edge into `applying`, and only the `applier`
may walk it.** Nothing else in the system can put a row into the submitting
state.

**`DRY_RUN=true` and there is deliberately no code in the repo capable of
submitting an application.** `playwright-page.ts`'s `submit()` throws by
construction — so the guarantee does not depend on three layers of gate each
being correct.

**Submission is the one non-idempotent action, so it never auto-retries.** If the
worker dies between `applying` and `applied`, the Sweeper routes the row to
`needs_verification` — *not* back to the queue — and you check whether it went
through. Retrying a submit blind is how you send two applications.

**`blocked_needs_human` is a real state, not an error.** Actions cannot solve a
captcha, so the Applier screenshots the page, uploads it, and parks the row.
Failure becomes a visible queue item instead of a lost application.

The whole day's queue runs in **one** Actions job. Splitting it into a parallel
matrix is the obvious "speed-up" and would multiply the billed minutes by ~35,
because GitHub bills every job rounded up to a whole minute.

*Built:* yes — `worker/src/` has the claim loop, guarded advance, run window,
field extraction, fill planning and PDF rendering, with 62 of 65 tests passing.
⚠️ The three failures are all in `render-resume-pdf.test.ts`
(`Unsupported resume schema_version undefined`), so **resume PDF rendering is
currently broken**, and `apply-one.ts` never calls the renderer anyway.

### 9. Tracker — reads your inbox so the pipeline advances itself
Advances post-apply statuses: `applied` → `employer_screening` / `oa_pending` /
`interview` / `rejected`, and onward to `offer`. **12 edges — the second most of
any non-human agent.**

**Push-driven, never polling.** A Google Apps Script bound to your own mailbox
POSTs `from`/`subject`/`snippet` to a Supabase Edge Function on a 15-minute
trigger. No GCP project, no consent screen, no restricted-scope review, no
refresh token to expire — because the script already runs *as you*. Our code does
the classification, so Apps Script stays a dumb pipe.

Two details that are load-bearing: it uses a **dedicated Gmail label, not
`is:unread`** — opening a recruiter email on your phone before the trigger fires
would otherwise mean it is never ingested, and read state belongs to you. And
`message_id` is the dedupe key, because **Apps Script time triggers double-fire.**

**It is the only agent that can walk a status backwards by machine**
(`interview → oa_pending`), which is correct: an employer really can move a
candidate back a stage. Every other backward edge is human-only.

*Built:* the intake endpoint **is deployed and live** —
`email-tracker-intake`, ACTIVE, deliberately `verify_jwt = false` because Apps
Script cannot hold a Supabase JWT; it authenticates on a shared secret header
instead. **It is inert until you set `EMAIL_INTAKE_SHARED_SECRET`** (it returns
500 "server misconfigured" with the secret unset — it fails closed, verified
live). The Gemini classifier that reads those rows is **not built**.

⚠️ Known gap: `email_events` has no column for `thread_id`, so it is validated
and dropped. That is the one that hurts — `thread_id` is the key for "has this
recruiter already replied?"

### 10. Sweeper — cleans up after crashes
**One edge, and it is the important one: `applying → needs_verification`.**

Rows carry `claimed_at`/`claimed_by`; the sweeper reclaims anything whose lease
expired, so a crashed agent self-heals. But it treats `applying` differently from
everything else, for the reason in §8 above: a row stuck mid-submit goes to a
human, never back to the queue.

*Built:* yes, as the SQL function `sweep_stale_claims()`, live on the database.
⚠️ Its `released_count` **double-counts** rows the first statement already moved,
so build no metric on that number.

### 11. The two keepalives — the agents that exist because things die quietly
`PROJECT_PLAN.md` §14. Neither advances any application status; both exist purely
so that *nothing stops silently*.

- **Supabase pauses a free project after ~1 week idle.** The daily Actions cron's
  database query counts as activity, so this one is implicit in the Applier run.
- **GitHub disables scheduled workflows after 60 days of repo inactivity.** A
  weekly workflow touches a timestamp file. *Built as
  `.github/workflows/keepalive.yml` but **disabled**, pending your approval — it
  is the only workflow with `contents: write`, because it force-pushes a
  timestamp commit to a dedicated branch.*

**Neither failure errors. They just stop.** That is why `keepalive` earned its own
`agent_name` identity and why the health page must be able to say *"Scout hasn't
run in 9 days"* — otherwise you believe the automation is working while getting
no interviews.

### `human` — you, and by far the most powerful identity
**31 of the 45 edges permit a human; 11 permit *only* a human.**

Those are two different facts and conflating them caused a real UI bug, where a
completeness check reported full coverage while the control for the
safety-critical `applying → needs_verification` edge was missing.

The rule worth remembering: **every edge into `approved` is human-only.** There
are two of them — from `awaiting_approval` and from `needs_verification` — and
that is a stronger invariant than an edge count, because it survives a third
being added. Nothing reaches `approved` without you.

---

## 4. Which agents cost you Gemini calls

Only **Matcher, Tailor, Auditor** and the Tracker's classifier. That is why the
Screener is deterministic — it kills most jobs before any of these run.

The pool draws on **six** keys (`GEMINI_API_KEY_01`–`_06`, not the fifteen §6
aspires to) with a daily budget and a circuit breaker, because without a cap one
retry loop burns every key before noon.

⚠️ **The live pool is empty and will stay empty until someone signs in.**
`bootstrap_user_defaults()` seeds the pool, `system_settings` and the filter
rules — but it must be *called by an authenticated session*, and no Auth user
exists. So `claim_gemini_key()` returns NULL forever right now. Every insert is
`on conflict do nothing`, so re-running it is safe.

A quota-exhausted pool is **not an error**: all keys cooling → the row returns to
its previous status and gets picked up next run. Nothing fails, nothing is lost.

---

## 5. So what is actually left to do

**Less than the table in §1 suggests, and this is the useful conclusion.**

Nine agents' worth of *logic* is written and tested and sitting in
`supabase/functions/_shared/` — the ATS adapters, the filter cascade, the
fingerprinter, the `posted_at` confidence rules, the Tailor validator and prompt,
the Gemini pool, the eval gate. What is missing is the five **function
entrypoints** that wire that logic into the agent loop in
`_shared/agent/loop.ts` — which itself is built, and whose kill-switch, batch,
status-guard and loop tests are now mutation-verified.

**So the remaining work is wiring, not building.** It splits on dependency:

- **Unblocked now:** `screener` and `normalizer`. No model calls, no prompts, no
  eval set. Their logic exists and is tested.
- **Blocked on you:** `matcher`, `tailor`, `auditor`. All three need the Gemini
  pool, which is empty until an authenticated session calls
  `bootstrap_user_defaults()`. And the Matcher additionally needs your ~20
  labelled jobs before its prompt may be tuned at all.

**One action of yours clears three blockers:** creating two Supabase Auth users
unblocks the RLS proof (still the project's top risk — the policies are proven to
*exist* and have never been proven to *scope*), the Gemini pool bootstrap, and
those three agents, all at once.
