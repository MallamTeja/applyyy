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
~40–70 s *before any work happens*.

**Measured, ten applications through the real loop** (real Chromium, real
captured GitLab Greenhouse DOM, fixture server, full-page screenshot, dry-run):
**1407 ms per application amortised**, 2839 ms cold. So **35/day is ≈49 SECONDS
of in-process work.**

Minute-rounding is applied **per job**, which is the entire point of it:

| Shape | Per job | Billed/job | Total/day | Verdict |
|---|---|---|---|---|
| 35 separate runs | 41–71 s | 1–2 min | **≈35–70 min** | at or over the 66 min budget |
| **1 batched run** | 89–119 s | 2 min | **≈2 min** | **fits with ~64 min/day spare** |

**Batching survives decisively — ~2 min against ~35–70 min.** The reasoning
(per-run overhead plus minute-rounding, not per-application work) was right all
along; only the magnitude was wrong, and it was wrong by a factor of about 25.

*Caveat, and it does not change the decision:* the loop above runs against a
localhost fixture, so it excludes real-site latency, TLS and resume PDF upload.
Per-application cost will rise in the wild. The batching conclusion is unaffected
either way **because the overhead being optimised is per-run, not
per-application** — that is why this argument is robust to the measurement being
wrong, which the two earlier versions of it were not.

`.github/workflows/apply.yml` processes the whole day's queue in a single run,
and the reasoning is written in a comment beside it, because **the change that
breaks this will look like an improvement**: splitting one job into a matrix of
parallel jobs is the obvious "speed-up" and it multiplies the billed minutes by
35.

### Two figures this section previously got wrong, recorded rather than quietly replaced

1. **"one application ≈ 90 s"** was a design-time estimate, superseded by
   measurement (1407 ms). Not presented as still standing.
2. **"≈53 min of work per day"** appeared in this section's own table *after*
   the prose above had already discarded the 90 s figure — because 53 min **is**
   35 × 90 s. A document that corrects a figure in one place and keeps it in
   another is **worse than one that never corrected it**, because the correction
   makes the stale number look reviewed. The lesson is to sweep every *derived*
   figure, not just the headline one.

### THE ~35/DAY CEILING IS NOT BUDGET-BOUND — this section used to imply it was

At ~2 min/day, a batched run leaves **~64 of the 66 min/day unused.** GitHub
Actions minutes are **no longer the binding constraint on volume**, and any
statement that ~35/day is forced by the Actions budget is now false.

The ceiling is real, but it rests on two entirely different reasons:

- **Supply.** §13: a 3-day freshness window over ~50 watchlisted companies yields
  **single digits per day**, not 35. Sustaining ~35/day inside that window needs
  roughly **200–400 ATS boards** plus the aggregators. Freshness and volume trade
  directly against each other.
- **Deliberate choice.** Constraint #1 — quality over volume, on purpose.
  Response rate on mass low-fit applications is 1–2%, so 100/day ≈ 1–2
  callbacks. The §17 rate multipliers change the *rate*, not the count.

Both are good reasons. Neither is a minutes budget. **Stated explicitly because
the previous framing risked accepting a volume cap that does not exist** — if
more volume is ever wanted, the thing to buy is *supply* (more boards), not
Actions minutes.

### The auth consequence, with its magnitude also corrected

Batching makes the daily run long enough to be worth checking against the
Supabase access token, and an earlier version of this analysis put that at **~10%
headroom** — derived from the stale 53 min figure and therefore **wrong by the
same factor of 25**. The true figure: a batched run is ~2 min of billed time
against a `jwt_expiry` of 3600 s, i.e. roughly **97% headroom**.

So mid-run token expiry is **not** the near-certain failure it briefly appeared
to be. The worker nonetheless refreshes **proactively before each application**
rather than reactively on a 401, and that is still the right design — as
*insurance against an unmeasured risk* (real-site latency and upload are excluded
from the measurement above) rather than as a fix for a near-certain failure. The
reason to prefer proactive refresh is unchanged: a 401 caught at the wrong moment
is indistinguishable from the dangerous case. Raising `jwt_expiry` remains the
wrong fix — it trades a bounded, testable refresh path for a longer-lived
credential sitting in an Actions runner.

Related and structural: the status guard requires `applyy.acting_agent`, which is
**per-connection** state. `advance_application_status()` calls
`set_config(..., true)` to scope it to the transaction, so it is re-established
on every call rather than assumed from setup — which is what makes a silent
reconnect safe rather than merely unlikely.

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
