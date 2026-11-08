# The agents in `applyy`: what each one does

_Last verified against code: 2026-11-08 (2a9ac31)._

This page has one section per agent in the application status graph. Each section
says what status the agent reads, what status it writes, where its code is, and which
model it uses. It also keeps the *why* behind each design, because that is what stops
someone "simplifying" an agent back into a bug.

**Trust the code and the live database over this page.** Every count below is a
command, not a number. Rewritten on 2026-11-08; the 2026-09-10 original (written when
only two agents could run) is in git history: `git show dc46979:docs/architecture/agents.md`.

---

## 1. Summary table

| Agent (`agent_name`) | Code | Reads status | Writes status | Model | Started by |
|---|---|---|---|---|---|
| Scout-ATS (`scout_ats`) | `supabase/functions/scout-ats/`, `worker/src/cli/scout.ts` | none (creates rows) | inserts at `passed_filters` / `dropped_filter`, or `discovered` if screening is unavailable | none | `scout.yml` cron; dashboard |
| Remote-feed scout | `worker/src/cli/scout-remote.ts` | none (creates rows) | same as Scout-ATS | none | `scout-remote.yml` cron |
| Scout-web (`scout_aggregator`) | `supabase/functions/scout-web/` | none (creates rows) | inserts at `discovered` | Gemini | on demand |
| Normalizer (`normalizer`) | `supabase/functions/normalizer/` | `discovered` | `deduped` / `dropped_duplicate` / `failed` | none | `prescreen-drain.yml`; dashboard |
| Screener (`screener`) | `supabase/functions/screener/` | `deduped` | `passed_filters` / `dropped_filter` / `failed` | none, on purpose | `prescreen-drain.yml`; dashboard |
| Matcher (`matcher`) | `supabase/functions/matcher/` | `passed_filters` | `scored` / `dropped_filter` / `failed` | Gemini | `postscreen-drain.yml`, `run-one.yml`, `pregate-sweep.yml`, `job-link-intake` |
| Tailor (`tailor`) | `supabase/functions/tailor/` | `scored` | `tailored` / `failed` | Gemini | same as Matcher (not `pregate-sweep.yml`) |
| Auditor (`auditor`) | `supabase/functions/auditor/` | `tailored` (and stranded `audit_clean` / `audit_flagged`) | `audit_clean` / `audit_flagged` / `failed`, then `awaiting_approval` | none (deterministic) | same as Tailor |
| `human` | the dashboard (`apps/web/`) | `awaiting_approval` and others | `approved` and every other human edge | none | you |
| Applier (`applier`) | `worker/src/` (Playwright) | `approved` | `applying`, then `applied` / `blocked_needs_human` / `failed` | none | `apply.yml` cron and `dispatch-apply` |
| Tracker (`tracker`) | `supabase/functions/email-tracker-intake/` | `applying`, `applied` and later | `applied`, `employer_screening`, `oa_pending`, `interview`, `offer`, `rejected` | none (deterministic) | Gmail Apps Script push |
| Sweeper (`sweeper`) | SQL `sweep_stale_claims()` | stale claims; `applying` | `needs_verification` | none | start of every applier run |
| Keepalive (`keepalive`) | `worker/src/cli/keepalive.ts` | none | none | none | `keepalive.yml` cron |
| Jobs tombstone (`jobs_tombstone`) | `scripts/jobs-tombstone.mjs` | `dropped_filter` jobs | none (purges job text) | none | `jobs-tombstone.yml` cron |

The satellites (`cover-letter`, `follow-up`, `interview-prep`, `referral`, `skill-gap`)
and the helper functions (`job-link-intake`, `resume-assist`, `gmail-sync`,
`dispatch-apply`, `rls-proof`) move no status of their own, except `job-link-intake`,
which acts as `human`. See §5.

**Regenerate the facts in this table:**

```bash
ls -d supabase/functions/*/ | grep -v _shared        # every edge function
grep -n "cron:" .github/workflows/*.yml               # every schedule
```

```sql
-- Every machine edge, by agent (run with the Supabase MCP execute_sql, or
-- env -u SUPABASE_ACCESS_TOKEN supabase db query --linked "<select>").
select a.agent, string_agg(t.from_status || '>' || t.to_status, ', ')
from application_status_transitions t, unnest(t.allowed_agents) a(agent)
group by 1 order by 1;
```

**No agent runs on a database scheduler.** `pg_cron` is not used. The only schedules
are GitHub Actions crons. The pipeline agents (Normalizer to Auditor) run on demand:
from the dashboard (`apps/web/src/data/pipelineRunner.ts`), from the drain workflows,
from `run-one.yml` (one row), or from `job-link-intake` (one pasted link).

---

## 2. The kill switch

**Every agent checks `system_settings.system_enabled` first, before any other work.**
One row halts the whole system on the next run. You do not need to delete a cron or
revoke a key at 2 am. Code: `supabase/functions/_shared/agent/kill-switch.ts`.

**It does not stop the `human` identity**, and it should not. Approving a row in the
dashboard is not something the kill switch exists to prevent.

The switch has **three "off" states**, and only one is obvious:

| Reason | Meaning | Remedy |
|---|---|---|
| `disabled` | `system_enabled = false`. The deliberate stop. | none needed |
| `no_settings_row` | the account was never bootstrapped | one RPC call |
| `unreadable` | the read failed (network, RLS, paused project) | a real incident |

All three halt, under **different names**, because the remedies differ. A health page
that could not tell them apart would report an outage every time you paused the system.

The natural code gets states 2 and 3 wrong **in the same direction**: an absent row
reads as "no objection", and a failed read looks like something to retry past. Both
would let an agent act while it cannot confirm it is allowed to. So it fails **closed**.

**Belt and braces:** `claim_applications()` and `claim_gemini_key()` also check
`system_enabled` in SQL. An agent that skipped the check would still claim nothing.
But the SQL check alone looks like "the queue is empty". The explicit check turns the
same condition into a named, visible reason.

---

## 3. How an agent is allowed to move a row

Every status change goes through `advance_application_status()`. It checks the edge
against `public.application_status_transitions` **and** checks the `agent_name` the
caller passed. A `BEFORE UPDATE` trigger enforces the same graph. So the "writes
status" column in §1 is not documentation: it is enforced by the database.

The agent name alone cannot tell a browser from an agent, because both sign in as the
same app user. Machine agents also send the `x-applyy-agent-key` header, which
`applyy_internal.agent_key_state()` checks. See the repo `CLAUDE.md` §7.

Every pipeline edge function signs in as the ordinary app user, so every query runs
under RLS (for example `supabase/functions/matcher/index.ts`, header comment).

---

## 4. Each agent

### 4.1 Scout-ATS: finds jobs on company boards

- **Code:** `supabase/functions/scout-ats/` (manual, from the dashboard) and
  `worker/src/cli/scout.ts` (the cron path, `.github/workflows/scout.yml`).
- **Providers:** Greenhouse, Lever, Ashby and Workday, registered in
  `supabase/functions/_shared/ats/registry.ts`. SmartRecruiters is registered but off:
  its robots.txt says `Disallow: /` (ruling of 2026-11-01).
- **Status:** creates rows instead of moving them, so it has no edge in the
  transition table. It screens each new job at insert
  (`supabase/functions/_shared/screen/screen-batch.ts`), so the row is born at
  `passed_filters` or `dropped_filter`. It falls back to `discovered` only when
  screening is unavailable.
- **Model:** none.

**Why one board per run in the edge function:** a Greenhouse `content=true` response
returns every full job description at once. A multi-megabyte `JSON.parse` is the real
CPU risk on the edge runtime's small CPU budget.

**Remote-feed scout** (`worker/src/cli/scout-remote.ts`, `.github/workflows/scout-remote.yml`)
reads three public remote-job feeds (RemoteOK, Jobicy, Arbeitnow). It uses the same
dedupe and insert-time screening path, so its rows also land at `passed_filters` or
`dropped_filter`.

### 4.2 Scout-web (`scout_aggregator`): finds jobs with web search

- **Code:** `supabase/functions/scout-web/` (`core.ts`, `handler.ts`).
- **Status:** inserts at `discovered`.
- **Model:** Gemini with web search proposes Greenhouse, Lever and Ashby URLs.
  Deterministic code then checks each one against the live board, behind the robots
  gate (`scout-web/fetch-board.ts`). The model proposes; code decides.

The older Adzuna, Jooble and Workable adapters in `_shared/scout/adapters/` are not
reached by any entry point. Check: `grep -rn "scout/tiers" supabase/functions worker/src | grep -v test`.

### 4.3 Normalizer: removes duplicates and dates each job

- **Code:** `supabase/functions/normalizer/index.ts`, with
  `supabase/functions/_shared/normalize/fingerprint.ts` and `posted-at.ts`.
- **Status:** `discovered` to `deduped`, `dropped_duplicate` or `failed`.
- **Model:** none.

It fingerprints each job, so the same role found on three boards becomes one row.

**Why `posted_at` needs care:** it is the least reliable field in the system.
Greenhouse gives `updated_at`, and a description edit resets it. Lever and Ashby give
real dates. Aggregators sometimes give relative text. So each job carries
`posted_at_source` (`exact`, `derived` or `unknown`), and the freshness filter treats
each level differently.

**The cold-start guard:** the obvious fallback for an unknown date is "we have never
seen it, so it is new". That is right in steady state and wrong on day one of a new
board, where the whole back catalogue arrives looking new. So a board's *first* poll
marks everything `unknown`. A board becomes trustworthy from its second poll.

Most rows never reach the Normalizer now, because the scouts screen at insert.
`.github/workflows/prescreen-drain.yml` drains rows inserted before that change.

### 4.4 Screener: throws most jobs away, cheaply

- **Code:** `supabase/functions/screener/index.ts`, logic in
  `supabase/functions/_shared/filter/cascade.ts`. The same logic runs inside both
  scouts through `_shared/screen/screen-batch.ts`.
- **Status:** `deduped` to `passed_filters`, `dropped_filter` or `failed`.
- **Model:** none, on purpose.

**Why no LLM:** deterministic filters run *before* anything costs a model call, and
most discovered jobs die here. That is what makes free Gemini keys enough. The gates
include the tech-role gate, the work-authorization (country) gate and the experience
ceiling.

### 4.5 Matcher: scores fit

- **Code:** `supabase/functions/matcher/index.ts`, scoring in
  `supabase/functions/_shared/match/scorer.ts`.
- **Status:** `passed_filters` to `scored`, `dropped_filter` or `failed`.
- **Model:** Gemini (see §6).

**The score floor.** A score at or above `MATCH_ADVANCE_FLOOR`
(`supabase/functions/_shared/match/score-threshold.ts`) moves the row to `scored`;
below it, the row goes to `dropped_filter`. The floor is 30 since Teja's ruling of
2026-11-07; it was 45 before. Never remove the floor. Fix leaks upstream in the
screener instead.

**The pre-gate** (`matcher/tech-pregate.ts`) re-runs the screener's gates (tech role,
then work authorization, then experience ceiling) with *today's* config before any
Gemini call. A row that passed an older screener is judged again at zero cost.
`.github/workflows/pregate-sweep.yml` runs it alone over the backlog
(`?mode=pregate_only`). A job Teja pasted himself skips every automatic gate.

**Write order:** the score is written first, then the status moves. Both steps are
guarded (`matcher/write-score.ts`): the write lands only while the row is still at
`passed_filters`, and the move lands only if nobody changed the row since. Without
this order, a downstream agent could see an unscored row at `scored`.

**The eval gate (rationale):** `PROJECT_PLAN.md` §18.3 says not to tune the Matcher's
prompt until about 20 hand-labelled jobs exist in `matcher_eval_cases`. Without labels,
fixing one bad match can silently break scoring for everything else. Check the label
count with `select count(*) from matcher_eval_cases`.

### 4.6 Tailor: rewrites the resume for one job

- **Code:** `supabase/functions/tailor/index.ts`, logic in
  `supabase/functions/_shared/tailor/` (`validator.ts`, `persist.ts`).
- **Status:** `scored` to `tailored` or `failed`.
- **Model:** Gemini. It lives in Deno, not the worker, because the Gemini key pool
  (`_shared/gemini/pool.ts`) reads `Deno.env` and cannot load in Node.

**It cannot invent anything, by construction.** The master profile is JSON where every
node has a stable id. The Tailor returns **references to those ids**, not free text.
An invented skill is not "detected and rejected": it cannot be expressed, because there
is no id to point at. A validator then checks that every reference resolves, sits under
the right parent, and adds no unbacked technology or metric.

**The attack it defends against is `misattributed_bullet`:** a bullet that really
belongs to a personal project, placed by the model under a named employer. Every single
claim is true, yet the resume now credits your side project to a company. That is why
references are checked for *parent scope*, not only for existence.

It writes `tailored_profile`, `tailor_refs` and `master_version` before it moves the row
(`_shared/tailor/persist.ts`). `tailor/page-counts.ts` counts every row it read into one
bucket, so the post-screen drain can tell "queue empty" from "ran out of time".

The resume must fit **one page** (Teja's rule of 2026-11-07). The renderer has two dense
typography steps for this (commit `dc8ac5c`), and the approval editor fits every save
to one page (commit `7a78d05`).

### 4.7 Auditor: the second opinion

- **Code:** `supabase/functions/auditor/index.ts`, logic in
  `supabase/functions/_shared/audit/`.
- **Status:** `tailored` to `audit_clean`, `audit_flagged` or `failed`, then both
  verdicts to `awaiting_approval`.
- **Model:** none. The anti-fabrication check is deterministic.

**Why it exists: generator–critic separation.** The part that produced the resume must
not be the part that approves it. It checks the tailored resume against the master
pinned in `tailored_profile.master_version` (`_shared/audit/pinned-master.ts`), not
against today's master.

**Self-healing:** the verdict and the move to `awaiting_approval` are two RPCs. A crash
between them strands a row at `audit_clean` or `audit_flagged`. So the queue also reads
those two statuses and retries only the second move.

**The pre-gate re-check** (`auditor/pregate.ts`, since 2026-11-05): the Auditor is the
last agent before a human, so it re-runs the Matcher's pre-gate with today's config.
A row that fails goes to `failed`, not `dropped_filter`, because the graph gives the
Auditor no edge into `dropped_filter`. A human can still send it back
(`failed` to `passed_filters`).

### 4.8 `human`: you, the most powerful identity

Every edge into `approved` is human-only. That invariant is stronger than an edge count,
because it survives a new edge being added. Nothing reaches `approved` without you.

```sql
select count(*) filter (where 'human' = any(allowed_agents)) as human_allowed,
       count(*) filter (where allowed_agents = '{human}')    as human_only,
       count(*)                                              as all_edges
from application_status_transitions;
```

"Edges a human may take" and "edges only a human may take" are different facts.
Mixing them up once caused a UI bug: a completeness check reported full coverage while
the control for `applying` to `needs_verification` was missing.

`job-link-intake` also acts as `human`, because a pasted link is Teja's own choice. It is
the only caller of `discovered` to `passed_filters`; no agent may take that edge.

### 4.9 Applier: submits the application

- **Code:** `worker/src/` (claim loop in `worker/src/claim-loop.ts`, one row in
  `worker/src/apply-one.ts`, CLI `worker/src/cli/apply.ts`). Playwright on GitHub
  Actions, not an edge function.
- **Status:** `approved` to `applying`, then `applied`, `blocked_needs_human` or
  `failed`. It may also park `approved` to `blocked_needs_human` before it starts.
- **Model:** none.
- **Started by:** the `apply.yml` cron, and `dispatch-apply` after you approve rows (§5).

**`approved` to `applying` is the only edge into `applying`, and only `applier` may take
it.** Nothing else can put a row into the submitting state.

**Submission is real and bounded.** `SUBMISSION_IMPLEMENTED = true`
(`worker/src/playwright-page.ts`). `DRY_RUN` defaults to true at every layer. Each run
is capped by `APPLY_MAX_SUBMITS` (default `DEFAULT_MAX_SUBMITS` in
`worker/src/claim-loop.ts`; the manual drain raises it, see `.github/workflows/apply.yml`)
behind a circuit breaker. A robots.txt gate runs before the apply page opens. A scheduled
run submits only while the repo variable `APPLYY_CRON_LIVE` is `true`.

**Submission never auto-retries**, because it is the one action that is not idempotent.
If the worker dies between `applying` and `applied`, the Sweeper sends the row to
`needs_verification`, not back to the queue. A blind retry is how you send two
applications.

**`blocked_needs_human` is a real state, not an error.** Actions cannot solve a captcha,
so the Applier takes a screenshot and parks the row. The failure becomes a visible queue
item instead of a lost application.

**One Actions job runs the whole queue.** A parallel matrix looks faster but multiplies
billed minutes, because GitHub rounds every job up to a whole minute.

Related worker paths that never move status:
- `worker/src/cli/assist.ts`: a headed, local single-row run where the human clicks Submit.
- `worker/src/apply-kit.ts` (`.github/workflows/apply-kit.yml`): builds manual apply
  kits. It never claims, fills or submits a row.

### 4.10 Tracker: reads your inbox so the pipeline moves itself

- **Code:** `supabase/functions/email-tracker-intake/` (`index.ts`, `decide.ts`,
  `replay.ts`), classifier in `supabase/functions/_shared/email/classifier.ts`.
- **Status:** `applying` to `applied` (receipt confirmation), and the post-apply
  edges `applied` to `employer_screening`, `oa_pending`, `interview`, `rejected`, then
  onward to `offer`.
- **Model:** none. Classification is deterministic.

**Push, not polling.** A Google Apps Script in your own mailbox
(`supabase/functions/_shared/apps-script/email-tracker.gs`) POSTs each message to the
function. No GCP project and no OAuth consent screen, because the script already runs
as you. The function runs with `verify_jwt = false`, because Apps Script cannot hold a
Supabase JWT; it checks a shared secret (`EMAIL_INTAKE_SHARED_SECRET`) instead.
`gmail-sync` (§5) lets the dashboard trigger a sync on demand.

Two load-bearing details:
- It uses a **dedicated Gmail label, not `is:unread`**. Opening a recruiter email on
  your phone first would otherwise mean it is never ingested.
- `message_id` is the dedupe key, because Apps Script time triggers can fire twice.

**Two paths since 2026-11-01** (`email-tracker-intake/index.ts`, the comment above the
transition loop): receipt confirmations (`applying` to `applied`) run in the intake
call, because they need fields `email_events` does not store. Every outcome move runs
through the replay sweep (`replay.ts`), so fresh and owed moves share one staleness rule.

**It is the only agent that may move a status backwards by machine**
(`interview` to `oa_pending`). That is correct: an employer really can move a candidate
back a stage. Every other backward edge is human-only.

### 4.11 Sweeper: cleans up after crashes

- **Code:** the SQL function `sweep_stale_claims()`. The applier calls it at the start of
  each run (`worker/src/claim-loop.ts`, `worker/src/supabase-gateway.ts`), and the gateway
  writes the sweeper's own `agent_runs` row.
- **Status:** one edge, `applying` to `needs_verification`.
- **Model:** none.

Rows carry `claimed_at` and `claimed_by`. The sweeper releases any claim whose lease
expired, so a crashed agent heals itself. A row stuck in `applying` goes to a human,
never back to the queue, for the reason in §4.9.

### 4.12 Keepalive and jobs tombstone: ops agents

Neither moves an application status. Both exist so that *nothing stops silently*.

- **Keepalive** (`worker/src/cli/keepalive.ts`, `.github/workflows/keepalive.yml`).
  Supabase pauses a free project after about a week idle, and GitHub disables scheduled
  workflows after 60 days without repo activity. The workflow pings the database, writes
  a `keepalive` `agent_runs` row, and pushes a timestamp commit to the
  `automation-keepalive` branch (never `main`).
- **Jobs tombstone** (`scripts/jobs-tombstone.mjs`, `.github/workflows/jobs-tombstone.yml`,
  weekly). The Free Plan database has a size limit. This calls
  `tombstone_dropped_jobs()` to purge the heavy text of old `dropped_filter` jobs, in
  small batches, and logs the count as `jobs_tombstone`. Policy:
  `docs/db/2026-11-05-jobs-tombstone-policy.md`.

**Neither failure shows an error. Things just stop.** That is why these agents write
`agent_runs` rows, so the health page can say "this has not run in 9 days".

---

## 5. Satellites and helper functions

These are edge functions that do **not** move an application status (except
`job-link-intake`, which acts as `human`).

| Function | What it does | Model | Started by |
|---|---|---|---|
| `cover-letter` | writes `applications.cover_letter` for rows with a tailored resume and no letter | Gemini | `satellites.yml` |
| `follow-up` | drafts nudge emails for `applied` rows older than seven days into `follow_up_nudges` | Gemini | `satellites.yml` |
| `interview-prep` | writes a prep pack into `interview_prep_packs` for rows at `interview` | Gemini | `satellites.yml` |
| `referral` | drafts referral outreach for rows at `awaiting_approval` or `approved` (`referral/eligible-queue.ts`), logged as an `application_events` row | Gemini | `satellites.yml` |
| `skill-gap` | counts required skills the master lacks across scored and applied jobs, into `skill_gap_reports` | none | `satellites.yml` |
| `job-link-intake` | a pasted job link: reads the page, creates or revives the row at `passed_filters` as `human`, then runs Matcher, Tailor and Auditor in the background | Gemini | dashboard "Add a job by link"; `ingest-links.yml` |
| `resume-assist` | the AI edit box on the resume editor | Gemini | dashboard |
| `gmail-sync` | proxies the dashboard's "sync now" to the Apps Script, so its secret stays server-side | none | dashboard |
| `dispatch-apply` | after an approve, dispatches `apply-kit.yml` and a live drain of `apply.yml` | none | approval page (`apps/web/src/features/approval/dispatchApply.ts`) |
| `rls-proof` | one-shot diagnostic: proves RLS scopes a real user JWT | none | by hand |

**Why the satellites never store a fallback template:** each one skips rows that already
have an output. A stored placeholder would therefore be permanent, and Gemini would never
be asked again. On failure they store nothing and the next run retries
(see the header of `supabase/functions/interview-prep/index.ts`).

**Why each has its own `agent_name`** (migration `20261004210000`): before that they
borrowed other agents' names, which made the health page credit the wrong agent.

---

## 6. Which agents spend Gemini calls

The callers are Matcher, Tailor, `scout-web`, `job-link-intake`, `resume-assist` and the
four Gemini satellites (`cover-letter`, `follow-up`, `interview-prep`, `referral`). The
Screener, Auditor and Tracker are deterministic. Regenerate:

```bash
grep -rlE "_shared/gemini|gemini/client" supabase/functions/*/index.ts
```

**The model.** All callers use `supabase/functions/_shared/gemini/client.ts`. The live
model is the `GEMINI_MODEL` secret; `GEMINI_DEFAULT_MODEL` in that file is only the
fallback when the secret is unset. Check the live value with `supabase secrets list`
(it shows a digest, not the value).

**The key pool** (`_shared/gemini/pool.ts`) claims keys through `claim_gemini_key()`,
with a daily budget and a circuit breaker. Without a cap, one retry loop could burn every
key before noon. Count the keys:
`select user_id, count(*), count(*) filter (where enabled) from gemini_key_state group by 1`.

**A quota-exhausted pool is not an error.** When every key is cooling down, the row stays
where it is and the next run picks it up. Nothing fails and nothing is lost.
