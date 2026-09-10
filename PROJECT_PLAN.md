# applyy — Job Application Automation: Full Plan

**Status:** design approved, spec not yet written, zero code.
**Recovered:** 2026-09-09 from session `7247c841` transcript. This document is the single source of truth; `.remember` only kept a one-line digest.

---

## 1. What this is

A multi-agent system that discovers jobs from ATS boards, scores them against a master resume, tailors a resume per job, audits that tailoring for fabrication, waits for human approval, submits the application, and tracks the outcome from email — with a React dashboard where every part of it is configurable.

---

## 2. Locked decisions

| Decision | Value | Note |
|---|---|---|
| Language | **Node + TypeScript** everywhere | Originally "Python only" — relaxed because Supabase Edge Functions are Deno/TS and Python could not run there. One language end to end. |
| Frontend | React + TypeScript on **Vercel** (static only) | Project exists → `applyy.vercel.app` after rename |
| Backend | **Supabase** Edge Functions + Postgres + Auth + Storage + Realtime | Project `applyy`, ref `xynqxekcqizwhtskzqrq`, ap-southeast-2 |
| Browser worker | **GitHub Actions + Playwright** | Chosen over a local worker |
| Daily volume | **~35 applications/day** | Not 100 — see below |
| LLM | Gemini, key pool across 15 GCP projects | Likely only needs 2–3 keys; see §6 |
| Approval | Two-bucket: batch-approve fully-traced, individually review flagged | Nothing fabricated ever goes out unseen |
| Package manager | pnpm only | |
| Repo | `github.com/MallamTeja/applyy` (remote as configured) — private | Holds resume, CTC, personal answers |

### Decisions made by explicit choice (verbatim from the session)

These were answered as structured choices, not prose, so they are the least ambiguous record of intent:

| Question | Your answer |
|---|---|
| Where does the Playwright "Applier" worker live? | **GitHub Actions runner on cron** |
| How should the system discover jobs across LinkedIn, Naukri, career pages? | **Layered: ATS APIs + free aggregators** |
| What form is the master resume, and how are tailored resumes generated? *(flagged as the hardest technical piece)* | **Structured JSON master → HTML template → PDF** |
| How autonomous should the loop be, and how are you told there is something to approve? | **Scheduled discovery, batched approval queue** |
| How should the system treat LinkedIn? | **Discovery only, human applies** |
| Worker split, given 100/day needs ~150 min and Actions allows ~66? | **Actions only, accept ~35 applications/day** |
| 100/day vs the ~35/day cap — which do you actually want? | **Keep Actions-only, ~35/day is fine** |
| How should the approval gate work? | **Two buckets, batch-approve the clean ones** |
| Gemini keys — same project or different? | **Different projects, 1 key per project, 15 total, same env-var naming pattern** |
| 3-day window yields single digits/day — how to handle supply? | **Seed a large ATS watchlist** |
| Is the GitHub repo private? | **Yes** — confirmed by Teja |

**Discovery sources named explicitly:** LinkedIn posts, LinkedIn jobs, company career pages, Naukri — reached through ATS APIs and aggregators rather than scraping, per the layered choice above.

### The master resume pipeline

**Structured JSON master → HTML template → PDF.** The master profile is JSON, not a document. Every tailored resume is a *selection and rewording of JSON nodes*, rendered through one HTML template and printed by Playwright's `page.pdf()`.

This is what makes §10's structural honesty defense possible: because the Tailor manipulates identified JSON nodes rather than free text, "return references into the master" is the natural interface rather than a constraint bolted on afterwards. The format choice and the anti-fabrication guarantee are the same decision.

### The 100/day → 35/day resolution

GitHub Free = 2,000 Actions minutes/month = **66 min/day**. Public-repo unlimited
minutes is unavailable because the repo must stay private (it holds resume data,
CTC and personal answers).

> **This derivation was rebuilt on 2026-09-09 against measured numbers. The
> earlier version — "one application ≈ 90s, so 100/day = 150 min/day" — was my
> estimate during design and is superseded. It is not presented as still
> standing.**

`applyyy-21` instrumented a real captured Greenhouse form: browser launch 475 ms,
navigate 413 ms, extract 47 ms, screenshot 784 ms, `page.pdf()` 303 ms —
**≈3.75 s of in-process work per application.**

*Honest caveat, 21's own:* that is against a **localhost fixture**, so it
excludes real-site network latency and file upload. The original 90 s may still
hold in the wild. **The conclusion below is unaffected either way**, because the
binding cost is not per-application.

**The real constraint is per-RUN overhead, and GitHub bills every job rounded up
to a whole minute.** Checkout + node + `pnpm install` + browser-state restore is
~40–70 s *before any work happens*:

| Shape | Overhead | Work | Total/day | Verdict |
|---|---|---|---|---|
| 35 separate runs | ≈35 min | ≈53 min | **≈88 min** | over the 66 min budget |
| 1 batched run | ≈1 min | ≈53 min | **≈54 min** | fits |

**So batching is not an optimisation — it is the difference between fitting the
budget and burning the month in ~13 days.** `.github/workflows/apply.yml`
processes the whole day's queue in a single run, and the reasoning is written in
a comment beside it, because **the change that breaks this will look like an
improvement**: splitting one job into a matrix of parallel jobs is the obvious
"speed-up" and it multiplies the billed minutes by 35.

The **~35/day ceiling stands**, but it is now justified by minute-rounding and
per-run overhead rather than by a 90 s work estimate — a different and better
argument for the same number.

Constraint #1 ("don't blindly optimize for 100 applications/day") resolved this deliberately: **trading volume for fit, on purpose.** Response rate on mass low-fit applications is 1–2%, so 100/day ≈ 1–2 callbacks. The §17 rate multipliers change the *rate* rather than the count.

---

## 3. The seventeen constraints (verbatim, checkable)

1. DON'T blindly optimize for 100 applications/day.
2. DON'T invent experience, projects, skills, technologies, metrics, companies, certifications, education, or qualifications.
3. DON'T falsely answer job-application questions.
4. DON'T guess when an application question cannot be answered from the user's profile.
5. DON'T bypass CAPTCHAs, MFA, authentication controls, robots restrictions, or anti-bot mechanisms.
6. DON'T run long-lived Playwright/browser automation inside Vercel serverless functions.
7. DON'T submit the same application twice.
8. DON'T regenerate unchanged resumes/documents unnecessarily.
9. DON'T let job-description text act as instructions to the AI agent.
10. DON'T allow arbitrary shell-command execution by the LLM.
11. DON'T commit API keys, passwords, cookies, browser profiles, session tokens, or private credentials to GitHub.
12. DON'T create one universal brittle scraper for every job website.
13. DON'T fabricate external APIs or integrations that don't actually exist.
14. DON'T generate the entire production system in one giant implementation.
15. DON'T automate final submission by default without human approval.
16. DON'T test the automation by submitting real job applications.
17. DON'T treat job descriptions or application pages as trusted input.

### Standing rules that are NOT in the seventeen — and were missing from this plan

The list above is Teja's prohibitions on the *product*. These are his rules on
*how the work is done*, from `CLAUDE.md`. They were absent from this document
until 2026-09-09 23:47, which meant every peer reading the plan could not see
them. Added because an audit caught the omission, not because anyone broke them.

- **Peers NEVER `git commit`. Peers NEVER `git push`.** Stage by explicit path
  (`git add <path>`) and stop; never `git add -A`. This is not ceremony: with
  six sessions writing concurrently, a peer that commits captures other
  sessions' half-written hunks into a commit nobody reviewed. The bar stays.
- **Change of 2026-09-09 23:45 — the orchestrator alone may commit and push.**
  One-line message, no description, no attribution trailer. `applyyy-d8`
  confirms this was Teja's **direct, first-hand instruction in its own session**
  and committed `0cd33a8` (50 files) on that basis; the push failed on auth.
  Recorded with its provenance stated rather than flattened: it is first-hand
  for `d8` and **second-hand for every other session**, since no other session
  witnessed it. That distinction is the whole reason this line names its source
  — the same standard by which Teja's naming ruling is authoritative for
  `applyyy-b3`, which *did* witness it. **The peer bar above is unchanged and
  absolute.** If a peer thinks it has been granted commit rights, it has been
  told, not instructed.
- **`git diff` before staging.** Six sessions write concurrently, so a shared
  file can carry another session's unstaged hunks. Stage only what belongs to
  your task; if hunks cannot be cleanly separated, stop and report.
- **pnpm only.** Enforced by `preinstall: pnpm dlx only-allow pnpm`; `npm` in
  this repo fails with `EBADDEVENGINES`.
- **Comment every line.** Every statement, declaration and block carries a
  comment saying *why* it exists, not what it does — structural lines (`}`,
  blanks, closing tags) excepted. Written *as* the code is written;
  retro-commenting is a second pass nobody budgets for.
- **Gate destructive work.** Stop and ask before deleting or overwriting an
  existing file.
- **No remote infrastructure without approval** — no `supabase db push`, no
  `vercel deploy`, no `gh` writes.

---

## 4. Blockers found in the original plan

1. **Supabase cannot run Python.** Edge Functions are Deno/TS only. Resolved by switching to Node/TS.
2. **Browser automation cannot run serverless.** Vercel Hobby caps at 60s and ships no browser binary. Needs a persistent worker → GitHub Actions.

   **The limits that actually bound the agents are Supabase's, not Vercel's** —
   an earlier draft cited only Vercel's 60s, which is misleading, because the
   agents run on Supabase Edge Functions and nothing of ours runs on Vercel
   except static assets. Verified 2026-09-09 against
   [Supabase's own docs](https://supabase.com/docs/guides/functions/limits) and
   [pricing page](https://supabase.com/pricing):

   | Free-tier limit | Value | What it constrains |
   |---|---|---|
   | Edge Function wall clock | **150 s** | total time one invocation may take |
   | Edge Function **CPU time** | **2 s** | *active computing* per request |
   | Database size | 500 MB | total Postgres storage |
   | Single file upload | 50 MB | resume PDFs — ample |
   | Project idle pause | 1 week | see §14 |

   *Do not mislabel these:* 500 MB is **database size**, not memory, and 50 MB
   is a **file-upload** ceiling, not a bundle size. Both were misquoted during
   coordination tonight.

   **The 2 s CPU limit is the binding one, and it dictates agent shape.** It
   measures active computing, so a 40-second wait on a Gemini response costs
   almost none of it — which is why Edge Functions make fine LLM orchestrators.
   But a loop over hundreds of job rows burns real CPU. **So every agent must
   claim a bounded batch per invocation and let `pg_cron` re-fire, never drain
   the queue in one run.** An agent written to "process all pending" will pass
   in testing on ten rows and fail in production on four hundred.
3. **LinkedIn auto-apply gets accounts restricted** — their User Agreement
   prohibits automated access. *No clause number is cited here on purpose: an
   earlier draft said "§8.2", which was asserted from memory during design and
   never checked against the live document. Do not reintroduce a section number
   without verifying it — a precise-looking citation that is wrong is worse than
   a general statement that is right.* Resolved by **ATS-first discovery** — Greenhouse, Lever, Ashby, Workable and SmartRecruiters expose free, public, unauthenticated JSON APIs:
   - `https://boards-api.greenhouse.io/v1/boards/{company}/jobs?content=true`
   - `https://api.lever.co/v0/postings/{company}?mode=json`
   - `https://api.ashbyhq.com/posting-api/job-board/{company}`

   Those same ATSs are where most real applications get submitted, so discovery *and* submission stay legitimate. LinkedIn becomes a human-in-loop lane, never automated.

   **Phasing, so the two deferred boards are not mistaken for dropped ones:**
   Phase 1 ships **Greenhouse, Lever and Ashby**; **Workable and SmartRecruiters
   are Phase 2.** All five expose free public APIs — the deferral is scheduling,
   not capability. They matter later because of §13's supply arithmetic: a 3-day
   window over ~50 companies yields single digits per day, and sustaining ~35/day
   needs 200–400 boards. `applyyy-d0`'s adapter interface is built so a fourth
   and fifth provider drop in without touching the Scout.
4. **Gemini limits are per GCP project, not per key** — confirmed in Google's docs. 15 keys in 15 projects = 15 real buckets. Same project would have been 1 bucket with 15 names.

---

## 5. Orchestration topology — database-as-queue

One `applications` table whose `status` column **is** the workflow. Each agent is stateless, claims rows in one status, does one job, writes the next status. `pg_cron` fires Edge Functions; the Actions worker polls for `approved` rows.

**Why this over a framework (LangGraph etc.):** the dashboard requirement and the orchestration requirement are the *same requirement*. State in Postgres means the dashboard is `select * from applications` with Realtime pushing changes — live tracking for free, and debugging is a SQL query instead of log archaeology. A framework would hide in memory exactly the state the dashboard needs to display.

Patterns in play:

- **Database-as-queue** with `SELECT … FOR UPDATE SKIP LOCKED` — concurrent claims without locking or double-processing.
- **Lease-based claiming** — `claimed_at` plus a sweeper that reclaims stale rows, so a crashed agent self-heals instead of stranding work.
- **Human-in-the-loop as a state, not a callback** — `awaiting_approval` is a durable row state, not a paused process. That is why an approval can sit for three days across a Supabase pause and a laptop reboot and still be there.

---

## 6. The Gemini key pool

**The trap:** an in-memory round-robin cursor does not work here. Edge Functions are stateless and horizontally scaled — each invocation may be a fresh isolate with a cursor pointing at key #1. Every agent then hammers key 1, exhausts it, and 15× quota behaves like 1× *while looking perfectly healthy in code review*.

So pool state lives in Postgres:

```
gemini_key_state (key_index, requests_today, quota_date,
                  cooldown_until, last_used_at, consecutive_failures)
```

Claiming is one atomic `UPDATE … RETURNING` picking the eligible key with the oldest `last_used_at` — **least-recently-used, not round-robin**, which self-balances when calls have uneven cost. On `429 RESOURCE_EXHAUSTED`, set `cooldown_until = now() + retry_after` and retry with the next key. When *all* keys are cooling the agent does not fail — the row returns to its prior status and is retried later. **Quota exhaustion is not an error.**

**Never hardcode a quota number.** Google stopped publishing free-tier figures (limits "depend on a variety of factors" and are viewable only in AI Studio), with credible reports of Flash being cut 250 → 20 RPD. Anything like `if (requests_today >= 250)` is a guess that silently breaks the day Google changes it. The pool is **purely reactive**: use a key until it 429s, believe its `retry_after`, move on. The system discovers its own capacity. `scripts/probe-quota.ts` reports real numbers per key.

**Naming:** rename `gemini1…gemini6` → `GEMINI_API_KEY_01…_15`. Zero-padded so string sort equals numeric sort (`gemini10` sorts before `gemini2` — a bug that appears at exactly 10 keys). The pool discovers keys by prefix scan, so adding key 16 needs no code change.

**Actual need at 35/day:**

```
35 jobs × 4 LLM calls (match, tailor, audit, cover letter) = 140
+ email classification                                     ≈  20
+ screening (deterministic, no LLM)                        =   0
                                                     total ≈ 160 calls/day
```

If free Flash gives even 100 requests/day per project, **two keys covers it.** Build the pool anyway — cheap, absorbs bursts, gives the observability panel — but expect to run on 2–3 keys and never touch the other 12.

**Grey area, stated honestly:** creating 15 GCP projects specifically to stack free-tier quota is against Google's API terms in spirit. The consequence would be losing API or project access — not the mailbox. At 35/day the pool is largely unnecessary anyway, which also keeps you nowhere near anything that looks like abuse.

---

## 7. Agent roster

| Agent | Runs on | Reads → Writes |
|---|---|---|
| **Scout-ATS** | Edge Fn, cron | watchlist → `discovered` |
| **Scout-Aggregator** | Edge Fn, cron | Adzuna/Jooble → `discovered` |
| **Normalizer** | Edge Fn | `discovered` → `deduped` / `dropped_duplicate` |
| **Screener** | Edge Fn, **no LLM** | `deduped` → `passed_filters` / `dropped_filter` |
| **Matcher** | Edge Fn, Gemini | `passed_filters` → `scored` |
| **Tailor** | Edge Fn, Gemini | `scored` → `tailored` |
| **Auditor** | Edge Fn, Gemini | `tailored` → `audit_clean` / `audit_flagged` |
| **Approval gate** | human, in dashboard | `audit_clean` \| `audit_flagged` → `awaiting_approval` → `approved` |
| **Applier** | GH Actions + Playwright | `approved` → `applying` → `applied` / `blocked_needs_human` |
| **Tracker** | Edge Fn, **push** | Apps Script POST → advances post-apply statuses |
| **Sweeper** | Edge Fn, cron | reclaims expired claim leases; `applying` → `needs_verification` |

Three corrections applied 2026-09-09 23:47 after this table drifted from the
shipped schema — recorded rather than silently fixed, because the drift itself
is the lesson:

- `screened` → **`passed_filters`** and `screening` → **`employer_screening`**.
  The old pair was one word apart with opposite meanings in the same enum:
  `screened` meant *we* passed it through our pre-apply filter, `screening`
  meant *the employer* is reviewing you post-apply. One name meaning two things.
- `audit_failed` did not exist; the real pair is `audit_clean | audit_flagged`.
  And `audit_clean` is a genuine intermediate state, not a synonym for
  `awaiting_approval` — this table previously collapsed them.
- **The Tracker is push-driven, not cron.** §12 rejected the Gmail API, so no
  component may poll Gmail. Apps Script POSTs in. This table said "cron" and
  contradicted §12.

Two deliberate design choices:

- **The Screener has no LLM.** Deterministic filters run *before* anything costs a Gemini call. Most discovered jobs die here. This is what makes free keys sufficient rather than merely hopeful.
- **`blocked_needs_human` is a real state.** Actions cannot solve a captcha, so the Applier screenshots the page, uploads it to Supabase Storage, and parks the row. The dashboard shows it with the screenshot and a "take it from here" link. Failure becomes a visible queue item instead of a lost application.

**PDF rendering is free.** Playwright is already there for form-filling, so `page.pdf()` costs nothing extra — no PDF service, no LaTeX toolchain. One HTML resume template lives in a shared package: React imports it to render the approval preview, the worker imports the *same* function to produce the submitted PDF. What you approved is byte-for-byte what gets sent.

**Known risk:** sharing that template package between Deno (Edge Functions) and Node (worker) is the fiddliest part of this stack. Verify with a 20-minute spike before committing to the monorepo layout.

---

## 8. The filter cascade

400 jobs discovered in a morning. Without filtering, all 400 go to Gemini — it reads a Senior Staff JD demanding 8 years of Kubernetes, thinks carefully, and correctly reports "poor match", having cost tokens, two seconds, and one slot of a daily quota you cannot see the size of.

With filtering, plain code checks first:

```
"Senior Backend Engineer · 5+ years required · Bangalore"
   ↓ title contains "Senior"  → DROP   (never parsed the rest)
cost: 0 tokens, ~1 millisecond
```

400 in → ~40 survive → **40 LLM calls instead of 400.** And it compounds: Tailor and Auditor also only ever see the 40, so you save 10× on three agents, not one.

The pattern is a **cascade** (short-circuit / cheap-test-first): order tests by cost, run the cheapest first, let each stage shrink the input for the next. Search engines rank this way — a cheap scorer over a million documents, an expensive one over the surviving hundred.

| Filter | Drops |
|---|---|
| Experience ceiling | JD says "5+ years", you want ≤ 1 |
| Title blocklist | Senior, Staff, Principal, Lead, Manager, Architect |
| Location allowlist | Hyderabad, Bangalore, Remote — nothing else |
| Employment type | intern / full-time / both |
| Already applied | fingerprint already in history |
| Company blocklist | consultancies, staffing firms, companies that ghosted you |
| Staleness | **posted more than 3 days ago** |
| Degree mismatch | requires a Master's or PhD |

**Every row is a settings field you control.** That is what the settings pages are for.

---

## 9. Data model

**Fourteen domain tables plus one config table — fifteen physical.** Authoritative
per `applyyy-aa`, who owns the migrations.

```
jobs                          -- a posting exists ONCE, globally
applications                  -- your application to a job; separate row
master_profiles               -- versioned, immutable snapshots
answer_bank                   -- standing answers, grows itself
gemini_key_state              -- the key pool
application_events            -- append-only audit log
agent_runs                    -- powers the health page
system_settings               -- kill switch, DRY_RUN, budgets, caps (singleton)
matcher_eval_cases            -- the §18.3 golden eval set
search_preferences
filter_rules
company_watchlist
company_blocklist
email_events
--- config ---
application_status_transitions -- the legal-edge table a trigger enforces
```

> **Columns are NOT specified here, on purpose.** The authoritative
> column-level contract is
> [`packages/shared-types/SCHEMA_CONTRACT.md`](packages/shared-types/SCHEMA_CONTRACT.md),
> owned by `applyyy-aa` and living in the same tree as the migration that
> creates it. An audit on 2026-09-09 found this section had listed twelve table
> *names* and zero columns, which left seven §18 items — including the
> safety-critical kill switch — with nowhere to live. The fix was to give the
> columns one home rather than two: **duplicated facts drift and then
> contradict each other.** Do not restate columns in this document.

Notes that belong here rather than in the contract:

- **`application_status_transitions` is global config**, not user data: RLS
  read-only for authenticated, no write policy. It backs a trigger that makes
  constraint #7 (never submit twice) structurally unviolatable rather than
  merely checked.
- **`jobs.discovered_via`** is a `discovery_source[]` recording which boards a
  deduped posting arrived from, and **`jobs.source_refs`** holds per-source
  presence windows. Together these replace the separately-planned
  `job_sightings` table — same provenance requirement, one fewer join.
- **`applications.previous_status` is informational only — never branch on it.**
  Trigger-maintained. It is *not* a rollback mechanism: the status graph has
  zero backward edges. A quota-exhausted agent releases its claim *lease*, so
  the row never left its status in the first place and has nothing to roll back
  to.

Three decisions carrying real weight:

- **`jobs` and `applications` are separate tables.** A posting found on Naukri, LinkedIn and Greenhouse is *one* `jobs` row (matched by fingerprint, unique index enforced) with *one* application. Dedupe becomes structural instead of a check someone might forget to run.
- **`UNIQUE(user_id, job_id)` on applications.** Constraint #7 becomes a database constraint — not a code check, which a race between two Actions runs would bypass. The database refuses, full stop.
- **`master_profiles` is versioned and immutable.** Editing creates version N+1; old versions never change. `applications` stores both the master version it derived from *and* a snapshot of the tailored JSON. That is what makes resume pinning true six months later, and what keeps the Auditor's verdict meaningful — it audited a specific version, and that version still exists.

Plus `tailored_hash = hash(master_version + selected_jd_keywords)` → identical inputs reuse the existing PDF. Constraint #8, implemented as a cache key.

**The dedupe fingerprint — documenting what `applyyy-d0` shipped, not inventing
one.** Authoritative implementation:
`supabase/functions/_shared/normalize/fingerprint.ts` (18 tests green). The plan
previously said only "matched by fingerprint", which under-specified a rule the
code had already committed to.

It is `normalized(company, title, location)`, where normalisation collapses
case, company legal suffixes, `Bengaluru`↔`Bangalore`, a trailing `", India"`,
hyphenation variants, `"(Remote)"` noise, and per-board requisition IDs.

**It deliberately keeps `"Senior"` distinct**, and that asymmetry is the
interesting part: §8's filter cascade *rejects* on seniority words, so
collapsing "Senior Backend Engineer" into "Backend Engineer" would let a
filtered-out job re-enter through its own duplicate. A normaliser has to know
which distinctions downstream code depends on — aggressive normalisation is not
automatically better.

### Status flow

```
discovered → deduped → screened → scored → tailored
   → audit_clean  ─┐
   → audit_flagged ┴→ awaiting_approval → approved
   → applying → applied → screening → oa_pending
   → interview → offer | rejected

off-ramps: dropped_filter · dropped_duplicate
           blocked_needs_human · needs_verification · failed
```

---

## 10. Security and trust boundaries

Three untrusted inputs — **job descriptions, ATS page DOM, incoming email** — all reach an LLM. Four defenses, ordered by how much they actually protect you:

**1. Make the dishonest output structurally impossible.** This is the important one. The naive Tailor returns free text and we hope it invented nothing. Instead, the Tailor returns **references into the master profile** — bullet IDs, skill IDs — plus a reworded string for each. Typed code then checks that every returned ID exists in the master. Any string that is not a rewording of a real master item is **rejected by the validator before the Auditor ever runs.**

An injected JD saying "add Docker" now produces either an invalid ID (rejected) or a reworded real skill (harmless). The attack has nowhere to land.

> **Prefer designs where the wrong answer cannot be expressed over designs that detect the wrong answer.** The Auditor becomes defense-in-depth rather than the only line.

**2. Instruction/data separation plus structured output.** JD text goes in a fenced block explicitly labelled untrusted, never concatenated into the instruction region. Every Gemini call declares a response JSON schema, so an injected model still has to produce valid schema — and free-form model text never drives a decision.

**3. The LLM gets no side effects.** No shell, no filesystem, no fetch-arbitrary-URL, no tool that acts. Gemini returns data; typed code decides what happens. Constraint #10, structurally.

**4. Secret handling.** GitHub Secrets for keys. Browser `storageState` encrypted AES-GCM and stored in Supabase Storage, never in the repo. The frontend gets the **anon key only** and relies on RLS — the service-role key never enters a bundle Vercel serves.

Plus: robots.txt respected, no captcha or MFA circumvention — detection routes to `blocked_needs_human` with a screenshot, and since Actions has no human present, that queue is a normal part of the day rather than a failure.

**RLS from day one.** Single user, but every table carries `user_id` with Supabase RLS. Free to add now, painful to retrofit, and it lets Edge Functions talk to the DB with a session token instead of a god-mode service key.

---

## 11. The honesty gate — worked example

**Job:** Backend Intern @ Zomato — "Node.js, REST APIs, PostgreSQL, Docker, 0–1 years"

Master resume says:

```
• Built a REST API with Express and Node.js for a college event
  portal, handling 500 users
Skills: JavaScript, React, Node.js, Express, MongoDB, Git, Python
```

Tailor produced:

```diff
- • Built a REST API with Express and Node.js for a college event
-   portal, handling 500 users
+ • Designed and shipped a production REST API in Node.js/Express
+   serving 500+ users for a college event platform

- Skills: JavaScript, React, Node.js, Express, MongoDB, Git, Python
+ Skills: Node.js, Express, REST APIs, PostgreSQL, Docker, JavaScript,
+         React, MongoDB, Git, Python
```

There are **two completely different kinds of edit** in there.

The bullet rewrite is **safe** — same project, same 500 users, same tech, reordered and worded to match the JD's language. If a recruiter asks about it you can talk for ten minutes. Nothing was invented.

The skills line contains **fabrication**. `PostgreSQL` and `Docker` were added because the JD asked for them. You never used them; your master says MongoDB. If this gets you the interview, the first technical question is *"tell me about your Docker setup"* and you are finished — worse off than if you had never applied. **That second kind is the entire reason the approval rule exists.**

The Auditor traces every line back to a source:

| Tailored line | Traces to | Verdict |
|---|---|---|
| "REST API in Node.js/Express, 500+ users" | master bullet 3 | traced |
| "Node.js, Express, REST APIs" | master skills line | traced |
| "PostgreSQL" | nothing | **flagged** |
| "Docker" | nothing | **flagged** |

**Bucket A** (every line traced) → batch-approve in one click. **Bucket B** (an untraceable claim) → individual review, always.

At ~35/day, reviewing every one costs about 12 minutes daily, which is sustainable — so the split is **not** about speed. It is about **putting your attention where the risk is.** One undifferentiated queue gives the dangerous ones the same three seconds as the safe ones.

Pattern: **generator–critic separation** — never let the model that produced the artifact be the one that approves it.

---

## 12. Email tracking — Gmail

**The obvious paths are broken:**

- **Gmail API + OAuth in "Testing" mode issues refresh tokens that expire after 7 days.** The Tracker would work for a week, silently stop, and need re-authorizing every Monday forever. `gmail.readonly` is a *restricted* scope, so publishing to production wants a verification review you do not want for a personal tool.
- **IMAP + app password is out.** Since 14 March 2025 Google Workspace requires OAuth for third-party Gmail access. `campushub@mlrit.ac.in` is a Workspace account, so that door is closed — and a college admin can block third-party OAuth apps anyway.

**The path that dodges all of it: Google Apps Script.** ~15 lines bound to your own account on a 15-minute time trigger:

```javascript
// runs AS you, inside your own mailbox — no OAuth app, no consent
// screen, no verification, no refresh token to expire
const threads = GmailApp.search('is:unread newer_than:1d');
UrlFetchApp.post(SUPABASE_FN_URL, { payload: ... }); // subject/from/snippet
```

No GCP project, no consent screen, no restricted-scope verification, no 7-day expiry. It runs on Google's infrastructure for free and pushes raw `from`/`subject`/`snippet` to a Supabase Edge Function, where **our** code does the Gemini classification — so the intelligence stays in the repo and Apps Script stays a dumb pipe.

> **When a platform's official integration path is heavy, check whether the platform has a first-party scripting surface that sidesteps the auth problem entirely by already running as you.** The same trick applies to Sheets, Calendar and Drive.

**DECIDED — the tracker mailbox is `tejamallam00@gmail.com`**, confirmed by
Teja directly on 2026-09-09. It survives graduation, no admin can block it, and
recruiters replying to an address he loses access to in a year is a real failure
mode. `campushub@mlrit.ac.in` is **not** a candidate and should not be revisited
as one: it is a Google Workspace account, which is one of the four reasons the
Gmail API path is dead. It appears in this project only as Teja's Claude Code
account identity.

**Ban risk: none.** Apps Script reading your own inbox is a first-party feature doing exactly what it was built for — no ToS surface. Applying to 35 jobs/day does not involve Google at all. What *would* risk the account is automated outbound sending at volume — which is precisely why the referral agent **drafts** and you send.

---

## 13. The 3-day freshness rule and its hidden bug

Filtering on posted-date is stronger than sorting by it. But `posted_at` is the least reliable field in the entire system:

| Source | What it gives you |
|---|---|
| Greenhouse | `updated_at` — **not** posted date; a description edit resets it |
| Lever | `createdAt`, epoch ms — genuine |
| Ashby | `publishedDate` — genuine |
| Adzuna | `created` — genuine |
| Aggregated LinkedIn/Naukri | sometimes relative text, sometimes nothing |

So every job carries `posted_at` **plus** `posted_at_source ∈ {exact, derived, unknown}`, and the 3-day filter behaves differently per confidence level.

**The bug, and it is the kind that quietly wastes a week of applications.** The natural fallback for an unknown date is `first_seen_at` — if you poll daily, anything you have never seen must be new. That reasoning is sound *in steady state* and wrong on **day one of any new board.** The moment you add a company to the watchlist, its entire back catalogue arrives with `first_seen_at = today`, and all 80 of its jobs — including one open since March — look three days old. You would spend a day's quota on stale postings.

**Fix — cold-start guard:** the first poll of any new board marks everything `posted_at_source = unknown` and *excludes* it from the 3-day filter, so the freshness rule only applies to jobs whose newness you actually observed. Boards become trustworthy from their second poll onward.

**Supply consequence:** 3-day window + fresher-only + a 50-company watchlist produces **single digits per day**, not 35. Freshness and volume trade directly against each other. Sustaining ~35/day inside a 3-day window needs roughly **200–400 ATS boards** plus the aggregators. Seed that watchlist in Phase 1.

---

## 14. Failure handling and the two silent deaths

- **Claiming.** Rows carry `claimed_at`/`claimed_by`; a sweeper reclaims anything stale, so a crashed agent self-heals.
- **Submission is the one non-idempotent action, so it never auto-retries.** The worker marks `applying`, submits, marks `applied`. If it crashes in between, the row is stuck at `applying` — and the sweeper routes it to **`needs_verification`**, not back to the queue. You check whether it went through. Retrying a submit blind is how you send two applications and violate constraint #7.
- **Quota exhaustion is not an error.** All keys cooling → the row returns to its previous status and gets picked up next run. Nothing fails, nothing is lost.

**Two things that die silently — both get a keepalive and a health-page indicator:**

- Supabase pauses a free project after **1 week** idle → the daily Actions cron DB query counts as activity.
- GitHub disables scheduled workflows after **60 days** of repo inactivity → a weekly workflow that touches a timestamp file.

Neither errors. They just stop. The health page must be able to say "Scout hasn't run in 9 days", because otherwise you believe the automation is working while getting no interviews.

---

## 15. Settings dashboard — nine pages

| Page | What you control |
|---|---|
| **Search Preferences** | Roles/titles to hunt, keywords, intern / full-time / both, experience range, locations, remote-only toggle, min salary |
| **Master Profile** | Parsed resume as editable structured fields — the single source of truth every tailored resume derives from |
| **Answer Bank** | Notice period, expected/current CTC, visa status, relocation, per-skill years, EEO answers. Grows itself as new ATS questions appear |
| **Filters** | Every row of the cascade as live toggles and thresholds |
| **Company Watchlist** | Greenhouse/Lever/Ashby board tokens to poll |
| **Blocklist** | Companies never to apply to |
| **Approval Queue** | The diff view — master vs tailored, side by side, changes highlighted. Approve / edit / reject |
| **Pipeline** | Kanban: discovered → approved → applied → screening → interview → offer/rejected, auto-advanced by the email Tracker |
| **System Health** | Gemini pool status, last successful run per agent, keepalive status, `blocked_needs_human` queue with screenshots |

---

## 16. The company blocklist — why it matters in the Indian market

- **Resume-harvesting consultancies.** Naukri is full of staffing firms posting evergreen or fabricated listings ("Hiring 500 freshers for MNC!") purely to collect resumes. You apply, get a call from an unrelated recruiter about an unrelated role, nothing happens. They post 30 near-identical listings a week — **without a blocklist your agent sends 30 applications to the same firm and you never notice**, because each looked like a different job.
- **"Sales internship" / MLM outfits** dressed up as marketing or BD internships.
- **Companies that already rejected you** in the last N months — reapplying immediately is a visible negative in most ATSs.
- **Places you simply would not join.** At 35 slots a day, every wasted slot is a real one.

One settings table, one `WHERE` clause. High value for the cost.

---

## 17. Rate multipliers — the four that change shortlist rate, not count

**1. Referral Outreach Agent — the biggest single lever.** Referred candidates convert several times better than cold applications; at big Indian product companies a referral often *is* the shortlist. For each job applied to, draft a short, specific note to a recruiter or employee (including MLRIT alumni) into a send queue. **You send it manually** — which sidesteps the LinkedIn automation ban entirely while capturing almost all the value. *Twenty applications with referral notes will outperform a hundred without.*

**2. ATS Parse Simulator.** After the PDF is generated, run it back through a real text extractor and show what an ATS actually reads. This catches the single most common silent fresher killer: a nicely designed two-column resume that parses into interleaved gibberish, so the machine never sees your skills and a human never sees your resume. The extractor runs in the worker, so it validates every resume you send instead of hoping.

**3. Freshness priority queue.** Recruiters review in arrival order and frequently stop reading around the 50th. Applying within 24 hours of posting is worth more than resume tweaks. Same applications, materially better position in every pile — the highest return per line of code on the list.

**4. Skill-Gap Aggregator.** Across every scored JD, count what you were missing: *"of 400 jobs, 172 wanted Docker, 130 wanted AWS, 88 wanted system design."* Nothing else in a job search tells you this, and it converts a month of rejections into a ranked list of what to learn next. The feedback loop that makes the system compound instead of churn.

### ⚠️ UNAPPROVED — needs Teja before any peer builds these

An audit on 2026-09-09 traced every feature in this plan back to the design
conversation. The items below were **offered to Teja and never accepted by
him.** They are kept, not deleted, because he may still want them — but no peer
should treat a line in this plan as an assignment until he says yes.

*Why this section exists:* six sessions build from this document, and none of
them can distinguish a decision Teja made from a suggestion that merely sounded
plausible. An unapproved feature that reaches the plan silently becomes
somebody's task. Provenance has to be visible, not remembered.

| Item | Status |
|---|---|
| A/B resume testing | **Unapproved.** Also conflicts with §9's single versioned-immutable `master_profiles` — two competing masters is a schema change, not a feature |
| Assessment detector (flag likely HackerRank) | **Unapproved** |
| Company research brief at interview stage | **Unapproved** |
| Google Calendar sync for interview invites | **Unapproved**, and it adds a whole new Google OAuth surface — the thing §12 spent four reasons avoiding |
| Portfolio project selector | **Unapproved** |
| Duplicate-company guard | **Approved in substance** — this is §18.5's per-company cap (2/week), already locked. Not a separate feature |
| **Freshness priority queue** (§17 item 3 above) | **Superseded.** Teja chose a hard 3-day *filter* (§13), which is stronger than a priority sort. Keep the arrival-order reasoning; drop the separate queue |

**Explicitly approved by Teja**, for contrast: interview prep packs, follow-up
nudges at day 7, cover letters without human approval but still Auditor-gated,
and all seven §18 items.

---

## 18. Additional locked logic

1. **Kill switch.** One row: `system_enabled = false` halts every agent on its next tick, checked first before any other work. Anything that submits real applications on your behalf needs a single place to stop it that does not require deleting a cron or revoking a key at 2am. **Safety-critical.**
2. **Daily Gemini budget with a circuit breaker.** Without a cap, one bug — a retry loop, a bad status transition — burns all keys before noon and the system is dead until Pacific midnight. Stored as `system_settings.gemini_daily_call_budget` (nullable; NULL means uncapped) with `.gemini_calls_today` and `.gemini_budget_date`.

   > **DOCUMENTED GOTCHA — do not "fix" this to `current_date`.** Both
   > `system_settings.gemini_budget_date` and `gemini_key_state.quota_date`
   > default to `(now() AT TIME ZONE 'America/Los_Angeles')::date`, and the key
   > claim function compares against the same expression. Gemini's RPD resets at
   > **Pacific** midnight. An IST-dated counter would reset 5½ hours *after* the
   > quota it tracks, so the breaker would open during exactly the window it
   > exists to protect — once a day, at night, presenting as flaky quota. That
   > is the hardest possible failure to notice, which is why it is written down
   > here rather than left to the schema.
3. **Golden eval set for the Matcher.** Hand-label ~20 jobs good-fit/bad-fit *before* tuning prompts. Every prompt change must still classify all 20 correctly. **Build the eval set before iterating on the prompt** — otherwise you tweak a prompt to fix one bad match and silently break scoring on everything else, with no way to notice.

   **A table alone does NOT satisfy this item.** The requirement is a CI gate,
   and CI has no database. So there are three parts, and it is only done when
   all three exist: `matcher_eval_cases` is the *labelling surface* (Teja labels
   in the dashboard) — owned by `applyyy-aa`; a harness *exports* those rows to
   a JSON fixture **committed to the repo** — owned by `applyyy-d0`; and CI runs
   against that fixture. Fixtures in git are diffable and reviewable in a pull
   request, fixtures in a database are neither. Flagged because "the table
   exists" would otherwise read as complete when the item is half built.
4. **Reposted-job signal.** A job that vanishes and reappears means they are still hiring and the last batch did not work out — a *stronger* signal than a fresh posting, and free to detect since boards are diffed daily.
5. **Per-company cap.** Max 2 applications per company per week. Five in a week from one candidate is a visible negative in most ATSs.
6. **Trust-building dry-run period.** The first three days run `DRY_RUN=true` — full pipeline, forms filled, screenshots saved, nothing submitted. Review the screenshots to see exactly what would have been sent, then flip the flag. Earning trust before granting authority, rather than after.
7. **ATS keyword coverage %** displayed on the diff view, so you can see whether the tailoring actually did anything.
8. **Cover letters need no human approval** — but the **Auditor still gates them**. Prose invents more freely than bullet points; a cover letter is exactly where a model writes *"during my time leading a team of five…"* about something that never happened. Anything flagged goes to the queue instead of out the door.

---

## 19. Testing strategy

**Never submit a real application to test** (constraint #16).

- **Static fixtures.** Real Greenhouse/Lever/Ashby application forms saved as HTML in the repo, served from localhost, the Applier run against them, filled values asserted. Real DOM, zero submissions.

### What the real DOM captures proved — and why hand-authored fixtures would have failed

`applyyy-21`'s captures found four things nobody would have guessed. This is the
concrete vindication of insisting on real fixtures, so it is recorded as fact
rather than anecdote:

- **Modern Greenhouse boards have NO `name` attributes.** The classic
  `job_application[first_name]` convention is gone; fields are keyed by `id`, and
  custom questions carry opaque ids like `question_36622854002` whose human
  meaning exists *only* in `aria-label`. **A hand-authored fixture would have
  encoded a convention no employer actually serves — and it would have looked
  correct in review.**
- **`aria-hidden`, `tabindex="-1"` inputs carry native `required`.** Sites use
  them to block browser-native submit behind custom dropdowns. Counting them as
  real fields would route **every** application to `blocked_needs_human`,
  turning the human queue from an occasional captcha into the entire day's work
  — and it would present as *"the automation doesn't work"* rather than as a
  parsing bug. Field extraction is accessibility-tree-driven because of this.
- **React-select `role="combobox"` widgets are not native `<select>`** and
  cannot be driven with `selectOption()`.
- **Ashby is a client-rendered SPA** — a plain GET returns zero form fields, so
  its fixture must be a Playwright-**rendered** snapshot. Worth stating
  explicitly: *a rendered snapshot proves something different from a raw
  response*, and a test built on the wrong one passes while proving nothing.

### `jobs.lever.co` robots.txt — a respected restriction, not an obstacle

`jobs.lever.co/robots.txt` contains `User-agent: ClaudeBot` → `Disallow: /`.
`applyyy-21` declined to reason its way around the user-directed-GET versus
crawler distinction with Teja away, and instead hand-authored the Lever fixture
as **synthetic and explicitly labelled**, with the exclusion enforced in
`capture-fixture.ts` and the reason written beside it.

This is recorded under **constraint #5** (don't bypass robots restrictions) as a
**live restriction being respected** — not a limitation to engineer around.
Revisiting it is Teja's call and nobody else's. Note the cost is honest and
small: a synthetic Lever fixture proves less than a real one, and it is labelled
so no one mistakes it for evidence about Lever's actual DOM.
- **`DRY_RUN=true` is the default.** The worker fills every field, screenshots the completed form, and stops. Submitting requires an explicit opt-in flag, so an accidental run costs nothing.
- **The most important test in the repo** is the Tailor validator rejecting invented skills. That test is the load-bearing wall under constraint #2.
- **An injection regression suite.** JDs carrying injection payloads must produce byte-identical Tailor output to the same JD without them.
- Table-driven unit tests for the filter cascade and fingerprint normalization — pure functions, cheap, high coverage.

---

## 20. Build order — Phase 1, TDD throughout

| # | Step | Why here |
|---|---|---|
| 0 | **Spike:** Deno↔Node code sharing for the resume template | The fiddliest unknown in the stack. Verify in 20 min, not week 2 |
| 1 | Supabase schema + RLS + migrations | Everything else reads it |
| 2 | Gemini pool + `probe-quota.ts` | **The probe reports numbers to Teja; the pool code never reads one.** Measurement tells him whether he needs 3 keys or 15. The runtime stays purely reactive to 429s per §6 — the probe must not write a threshold into config, code or the database. These are reconcilable, not contradictory, and the distinction is *who* the number is for |
| 3 | Master profile parse + settings pages | Nothing can be tailored without a master |
| 4 | Scout adapters (Greenhouse, Lever, Ashby) + dedupe | Supply |
| 5 | Filter cascade | Cheap rejection before expensive anything |
| 6 | Matcher → Tailor → **validator** → Auditor | The core; validator *before* Auditor |
| 7 | Diff view + two-bucket approval | The gate |
| 8 | Applier on fixtures, DRY_RUN | Proven without submitting |
| 9 | First real application, watched by you | One, manually, eyes open |
| 10 | Pipeline kanban + health page | Observability |

### Feature phasing (~22 features — nothing dropped, order matters)

| Phase | Contents |
|---|---|
| **1 — The loop** | Master profile, 9 settings pages, ATS + aggregator discovery, dedupe, filter cascade, Matcher, Tailor, Auditor, diff view + batch approval, Playwright applier, pipeline kanban, resume version pinning, answer bank, blocklist, Gemini pool, health page |
| **2 — Rate multipliers** | Freshness priority, ATS parse simulator, referral outreach queue, cover letters, email tracker, follow-up nudges |
| **3 — Compounding** | Skill-gap aggregator, interview prep packs. *(Company briefs, A/B resume testing, calendar sync, assessment detector and portfolio selector removed from this phase — see the UNAPPROVED table in §17. Do not schedule them.)* |

Deferral reasoning: each v2 item adds either a Gemini call per job or a whole new agent, and none helps until the core loop — *discover → score → tailor → approve → apply → track* — actually runs. Shipping a half-working loop with cover letters attached is worse for a job search than a working loop without them. **YAGNI** — build it when you feel its absence, not when you can imagine wanting it.

---

## 21. Peer partitioning (write-ownership)

No two workers ever write the same file. Shared reads are fine.

| Peer | Owns (exclusive write) | Depends on |
|---|---|---|
| **applyyy-aa** | `supabase/migrations/**`, `supabase/config.toml`, `packages/shared-types/**` | nothing — **goes first**; owns `SCHEMA_CONTRACT.md` |
| **applyyy-d0** | `supabase/functions/**` — Gemini pool, scouts, filter cascade, Matcher/Tailor/Auditor, eval-fixture export | schema contract |
| **applyyy-76** | `apps/web/**` — 9 settings pages, diff view, kanban, health page | schema contract |
| **applyyy-21** | `worker/**`, `.github/workflows/**` — Playwright applier, Actions | schema contract |
| **applyyy-04** | `packages/resume-template/**` + the Deno↔Node spike | — |
| **applyyy-b3** | `PROJECT_PLAN.md`, `docs/**`, root config (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.npmrc`, `.gitignore`, `README.md`) | — |
| **applyyy-d8** | orchestration; no file ownership | — |

Session-name history, because the plan previously listed peers that never
existed: the names `applyy-11`, `applyy-58` and `applyy-af` in earlier drafts
were **design-time placeholders invented before any peer was spawned**, not real
sessions. Orchestration moved from `applyyy-e5` to `applyyy-d8` on Teja's
instruction at 23:29; `applyyy-e5` died at ~23:34 having written the root
scaffold, and `applyyy-b3` inherited its stream. Session names keep the
three-`y` `applyyy-` prefix — that is the Claude session namespace, not the
product name, and it is correct as written.

Types live with the schema owner because types *derive* from schema — splitting them guarantees drift. Every peer gets the schema contract plus the "comment every line" rule up front, since retro-commenting is a second pass nobody budgets for.

---

## 22. Current infrastructure state (verified 2026-09-09 23:20 IST)

| Item | State |
|---|---|
| Supabase CLI | 2.117.0 at `C:\Users\tejam\tools\supabase\`, on user PATH |
| Supabase auth | `SUPABASE_ACCESS_TOKEN` set, verified via `supabase projects list` |
| Supabase project | `applyy`, ref `xynqxekcqizwhtskzqrq`, ACTIVE_HEALTHY, ap-southeast-2, PG 17.6.1 |
| Vercel CLI | 59.5.0, logged in as `mallamteja` |
| Vercel auth | `VERCEL_TOKEN` set, verified via `vercel whoami --token` |
| Vercel project | `applyyy` → `applyyy.vercel.app`, created 2026-09-09 |
| GitHub remote | `github.com/MallamTeja/applyy` as configured in `.git/config`. Private. **Whether the repo was actually renamed is UNCONFIRMED** — `git push` returns `Repository not found`, which GitHub also returns for a private repo you are not authenticated to, so it does not distinguish "renamed and unauthenticated" from "does not exist". Settle with `gh repo view MallamTeja/applyy` after `gh auth login` |
| `gh` CLI | 2.69.0 installed, **NOT authenticated** |
| Node / pnpm | v24.14.0 / 11.25.0 |
| Repo contents | `apps/`, `packages/`, `worker/`, `supabase/`, `.github/`, `docs/`, plus root config (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.npmrc`, `.gitignore`), `pnpm-lock.yaml`, `node_modules/`, `PROJECT_PLAN.md`, `README.md`, `.env` (untracked, ignored) |
| Code written | **Substantial, across five streams** — see [`docs/PROGRESS.md`](docs/PROGRESS.md) for the live per-stream state with evidence. This row previously read "none", which was already false when written; it is the reason `PROGRESS.md` exists as a separate live document rather than a section in here |
| `pnpm install` | **Passes** (exit 0) as of 23:50 IST |
| `pnpm -r run test` | **RED** (exit 1) — `packages/resume-template` has no test files yet. Do NOT wire this into a workflow as a green gate until it passes |
| Git | Commit `0cd33a8` exists **locally only**. Push **FAILED**, blocked on `gh auth login` |
| Gemini keys | **Six**, renamed `GEMINI_API_KEY_01…_06`. §6's "15 keys" is aspirational |
| Deno | Installed tonight via winget (`DenoLand.Deno` 2.9.6, user scope) — the machine changed |

---

## 23. Open items

### Blocking

1. **`gh auth login`** — needed to set Actions secrets and verify the Actions budget. Create a classic PAT with `repo`, `read:org`, `workflow`, `gist`, then `setx GH_TOKEN "..."`.
2. **Rotate `SUPABASE_ACCESS_TOKEN` and `VERCEL_TOKEN`** — both were pasted into chat and are in the local transcript. The Supabase PAT is org-wide across all 3 projects.

### Naming — standardize on `applyy` (two y's)

| Thing | Current | Action |
|---|---|---|
| Supabase project | `applyy` | already correct |
| Local folder | `applyyy` | rename (needs IDE closed — cannot rename a live CWD) |
| GitHub repo | `applyyy` | rename in Settings |
| Vercel project | `applyyy` | rename in dashboard |
| Claude state dir | `c--…-applyyy` | move, or session history is orphaned |

### Tasks still open

3. Whether to open a 4th peer for the worker + GitHub Actions stream.
4. Seed the 200–400 company ATS watchlist — **decided** ("seed a large ATS watchlist"), still to be built in Phase 1.
5. Rename `gemini1…gemini6` → `GEMINI_API_KEY_01…_15` in `.env`.
6. Run `scripts/probe-quota.ts` once written, to replace guessed quota with measured.

**Next artifact:** the spec at `docs/superpowers/specs/2026-09-09-applyy-design.md`, including the seventeen constraints verbatim as a checkable section. Then the implementation plan, then peer briefing.
