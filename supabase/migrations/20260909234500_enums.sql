-- =============================================================================
-- applyy — 00: enum types.
--
-- These land in their own migration, before any table, for one reason: every other
-- migration depends on them and nothing depends on the tables. Splitting the type
-- vocabulary from the storage makes the schema readable in the order you would
-- explain it to a person — here is the language, then here is what it describes.
--
-- Each type here has a TypeScript twin in packages/shared-types/src/enums.ts.
-- Add a value in one place and you MUST add it in the other; the checklist in
-- packages/shared-types/SCHEMA_CONTRACT.md is what guards that, not codegen.
--
-- Note on adding values later: Postgres 17 allows `ALTER TYPE ... ADD VALUE` and
-- `RENAME VALUE` cheaply, so an enum here is not the one-way door it used to be.
-- Enums are preferred over text+CHECK because they sort in declaration order, which
-- is what makes `ORDER BY status` produce pipeline order on the kanban for free.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The workflow itself. `applications.status` IS the queue: each agent claims rows
-- in one status, does one job, writes the next status. There is no broker and no
-- separate queue table, because the dashboard requirement and the orchestration
-- requirement are the same requirement — state lives where the dashboard reads it.
--
-- DECLARATION ORDER IS SIGNIFICANT: it is this type's sort order, so it is written
-- as the happy path followed by the off-ramps.
-- -----------------------------------------------------------------------------
create type public.application_status as enum (
  -- A Scout wrote the row; nothing has looked at it yet.
  'discovered',
  -- The Normalizer confirmed this is not a duplicate of a job already stored.
  'deduped',
  -- Survived OUR deterministic filter cascade. No LLM spent yet — this gate is what
  -- makes free Gemini keys sufficient rather than merely hopeful.
  'passed_filters',
  -- The Matcher attached a fit score and reasoning.
  'scored',
  -- The Tailor produced a tailored profile, validated against the pinned master.
  'tailored',
  -- The Auditor traced every tailored line back to a master node. Nothing invented.
  'audit_clean',
  -- The Auditor found at least one untraceable claim. Individual review, never batched.
  'audit_flagged',
  -- In the human approval queue. A durable row state, not a paused process — which is
  -- why an approval can sit for three days across a Supabase pause and a laptop reboot.
  'awaiting_approval',
  -- A human said yes. The only status from which `applying` is reachable.
  'approved',
  -- The worker has begun submitting. THE ONE NON-IDEMPOTENT STATE IN THE SYSTEM.
  'applying',
  -- Submission confirmed.
  'applied',
  -- Post-apply: the EMPLOYER is reviewing. (Renamed from the plan's `screening`, which
  -- sat one letter from `screened` and meant the opposite.)
  'employer_screening',
  -- An online assessment has been sent.
  'oa_pending',
  -- An interview is scheduled or has happened.
  'interview',
  -- Terminal, good.
  'offer',
  -- Terminal, bad. Also feeds the blocklist's rejected-recently rule.
  'rejected',
  -- Off-ramp: a filter cascade rule dropped it. `drop_reason` names which.
  'dropped_filter',
  -- Off-ramp: the fingerprint matched a job already stored.
  'dropped_duplicate',
  -- Off-ramp: captcha / MFA / anti-bot wall. NOT a failure — a normal daily queue item
  -- with a screenshot, because Actions has no human present to solve one.
  'blocked_needs_human',
  -- Off-ramp: a stale `applying` lease was swept. A human must confirm whether the
  -- submit landed before anything else touches this row.
  'needs_verification',
  -- Off-ramp: an unrecoverable error. `failure_reason` carries the detail.
  'failed'
);

-- -----------------------------------------------------------------------------
-- How much to believe `jobs.posted_at`. This type exists because posted_at is the
-- least reliable field in the system and a bare timestamp cannot say so.
--
-- SEMANTIC GUARANTEE, because no type can express it: `unknown` has exactly ONE
-- cause — the cold-start guard, meaning "this board is not yet trusted". It NEVER
-- means a parse failure. Every degraded input resolves to `derived` via first_seen_at.
-- -----------------------------------------------------------------------------
create type public.posted_at_source as enum (
  -- The board gave a real publish timestamp (Lever createdAt, Ashby publishedDate).
  -- Safe to apply the freshness filter.
  'exact',
  -- Inferred from first_seen_at on a board polled before, so "never seen it" genuinely
  -- means "it is new". Also where every degraded parse lands.
  'derived',
  -- Board not yet trusted. EXCLUDED from the freshness filter rather than assumed
  -- fresh — this is the cold-start guard, and it stops a newly-added board's entire
  -- back catalogue from looking three days old and burning a day's quota.
  'unknown'
);

-- -----------------------------------------------------------------------------
-- Where a posting was FOUND. Deliberately separate from ats_provider (where you
-- APPLY) — a Greenhouse job is routinely discovered through Adzuna, and conflating
-- the two would make "which adapter submits this?" unanswerable.
-- -----------------------------------------------------------------------------
create type public.discovery_source as enum (
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'smartrecruiters',
  'adzuna',
  'jooble',
  -- Discovery only, human applies. LinkedIn auto-apply gets accounts restricted under
  -- their User Agreement, so this value must never become a submit path.
  'linkedin',
  'naukri',
  'company_career_page',
  -- A human pasted a URL into the dashboard.
  'manual',
  'other'
);

-- -----------------------------------------------------------------------------
-- Which ATS receives the submission. This selects the Playwright adapter, which is
-- why `unknown` is a value rather than NULL: an unroutable job is a real state the
-- dashboard has to show, not missing data.
-- -----------------------------------------------------------------------------
create type public.ats_provider as enum (
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'smartrecruiters',
  -- We have an apply URL but no adapter recognises it. Routes to a human.
  'unknown',
  'other'
);

-- -----------------------------------------------------------------------------
-- Employment shape. Both a job attribute and a search preference, so one type.
-- -----------------------------------------------------------------------------
create type public.employment_type as enum (
  'internship',
  'full_time',
  'part_time',
  'contract',
  -- Most JD text does not say plainly; absent is a real answer, not a missing one.
  'unknown'
);

-- -----------------------------------------------------------------------------
-- Onsite / remote shape.
-- -----------------------------------------------------------------------------
create type public.work_arrangement as enum (
  'onsite',
  'hybrid',
  'remote',
  'unknown'
);

-- -----------------------------------------------------------------------------
-- The agents. Used by agent_runs, application_events, and — critically — by the
-- transition guard's allowed_agents check, which is what keeps the human-only
-- recovery lanes closed to automation.
-- -----------------------------------------------------------------------------
create type public.agent_name as enum (
  'scout_ats',
  'scout_aggregator',
  'normalizer',
  -- Deterministic, no LLM, on purpose: most discovered jobs die here before costing
  -- a Gemini call.
  'screener',
  'matcher',
  'tailor',
  'auditor',
  -- GitHub Actions + Playwright, not an Edge Function.
  'applier',
  'tracker',
  -- Not in the plan's roster, but it writes rows so it needs an identity.
  'sweeper',
  -- A human acting through the dashboard. Approvals are events too, and several
  -- transitions are restricted to this value alone.
  'human'
);

-- -----------------------------------------------------------------------------
-- Outcome of one agent invocation. The health page exists because both silent
-- deaths (a paused Supabase project, a disabled scheduled workflow) produce no
-- error at all — they just stop.
-- -----------------------------------------------------------------------------
create type public.agent_run_status as enum (
  'running',
  'succeeded',
  'failed',
  -- The kill switch was off. Not a failure — recorded so the health page can say WHY
  -- nothing happened, instead of looking identical to a dead cron.
  'skipped_disabled',
  -- Every key was cooling, or the daily budget was spent. Quota exhaustion is not an
  -- error: the row keeps its status and is picked up next run.
  'skipped_quota'
);

-- -----------------------------------------------------------------------------
-- What an inbound email means. Classified by Gemini inside the Edge Function, never
-- by Apps Script — Apps Script stays a dumb pipe so the intelligence stays in the repo.
-- -----------------------------------------------------------------------------
create type public.email_classification as enum (
  'application_received',
  'rejection',
  'oa_invite',
  'interview_invite',
  'offer',
  'recruiter_outreach',
  'other',
  -- Default on insert, so the row exists before it is classified and a Gemini outage
  -- delays mail rather than losing it.
  'unclassified'
);

-- -----------------------------------------------------------------------------
-- The rows of the filter cascade — a cheap-test-first short circuit. Order tests by
-- cost, run the cheapest first, let each stage shrink the input for the next.
-- 400 discovered becomes ~40 scored, and the saving compounds because the Tailor and
-- Auditor also only ever see the 40.
-- -----------------------------------------------------------------------------
create type public.filter_rule_type as enum (
  -- The JD demands more years than the user wants.
  'experience_ceiling',
  -- Senior, Staff, Principal, Lead, Manager, Architect.
  'title_blocklist',
  'location_allowlist',
  'employment_type',
  -- Fingerprint already in history: a cheap pre-check ahead of the UNIQUE constraint.
  'already_applied',
  'company_blocklist',
  -- Posted more than N days ago. Skips jobs whose posted_at_source is `unknown`.
  'staleness',
  -- Requires a Master's or PhD.
  'degree_mismatch',
  -- Max N applications to one company per rolling week.
  'per_company_weekly_cap'
);

-- -----------------------------------------------------------------------------
-- Why a company is blocked. Drives whether the block expires: `rejected_recently`
-- normally carries a blocked_until, `consultancy` normally does not.
-- -----------------------------------------------------------------------------
create type public.blocklist_reason as enum (
  -- Resume-harvesting staffing firms posting 30 near-identical evergreen listings a
  -- week. Without a blocklist the agent sends 30 applications to one firm and you
  -- never notice, because each looked like a different job.
  'consultancy',
  -- Sales-internship / MLM outfits dressed as marketing or BD.
  'mlm',
  'ghosted',
  -- Reapplying immediately is a visible negative in most ATSs.
  'rejected_recently',
  -- At 35 slots a day, every wasted slot is a real one.
  'personal_choice',
  'other'
);

-- -----------------------------------------------------------------------------
-- Shape of a stored answer, so the Applier knows which form control to drive.
-- -----------------------------------------------------------------------------
create type public.answer_type as enum (
  'text',
  'long_text',
  'number',
  'boolean',
  'single_select',
  'multi_select',
  'date',
  'file'
);

-- -----------------------------------------------------------------------------
-- What is being recorded in the append-only audit log.
-- -----------------------------------------------------------------------------
create type public.application_event_type as enum (
  -- Written automatically by a trigger on every status change, so no agent can forget
  -- to log one and no status change can happen unwitnessed.
  'status_change',
  'claim',
  'release',
  'note',
  'error',
  'llm_call'
);

-- -----------------------------------------------------------------------------
-- The golden eval set's label. ~20 hand-labelled jobs that every prompt change must
-- still classify correctly — build the eval set BEFORE iterating on the prompt,
-- otherwise you tweak a prompt to fix one bad match and silently break scoring on
-- everything else with no way to notice.
-- -----------------------------------------------------------------------------
create type public.eval_label as enum (
  'good_fit',
  'bad_fit',
  -- Deliberately present: a two-way forced choice would push genuinely ambiguous jobs
  -- into one bucket and make the eval set lie about the model's accuracy.
  'borderline'
);

-- -----------------------------------------------------------------------------
-- WHY a row is parked at `blocked_needs_human`.
--
-- Added to close constraint 4 ("don't guess when an application question cannot be
-- answered from the profile") without growing the state machine. An unanswerable
-- question and a captcha need the SAME operator action — a human takes it from here —
-- so a separate status would add a node to the graph without adding meaning. A reason
-- code discriminates the causes for the UI instead.
--
-- The rule of thumb this follows: add a STATE when the handler differs; add a REASON
-- when only the explanation differs.
-- -----------------------------------------------------------------------------
create type public.block_reason as enum (
  -- Anti-bot challenge. We do not solve these; constraint 5 forbids circumvention.
  'captcha',
  -- Multi-factor or an identity challenge on the employer's portal.
  'mfa',
  -- CONSTRAINT 4. A required field has no answer in the answer bank and the system
  -- refuses to guess. `block_detail` carries the question_key so the dashboard can
  -- deep-link straight to the answer that needs writing.
  'unanswerable_question',
  -- The form shape is one no adapter handles. Not a failure of the run, a gap in coverage.
  'unsupported_form',
  -- The board demands an account before it will show the form.
  'login_required',
  -- The submit button was reached but the outcome could not be confirmed from the page.
  'submission_unconfirmed',
  'other'
);
