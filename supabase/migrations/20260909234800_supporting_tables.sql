-- =============================================================================
-- applyy — 03: the ten supporting tables.
--
--   application_events   append-only audit log
--   agent_runs           powers the health page
--   gemini_key_state     the LLM key pool
--   search_preferences   what to hunt for
--   filter_rules         the cascade, as live toggles
--   company_watchlist    boards to poll — AND the cold-start guard's state
--   company_blocklist    companies never to apply to
--   answer_bank          standing answers that grow themselves
--   email_events         the Gmail tracker's raw feed
--   matcher_eval_cases   the golden eval set
--
-- Same discipline as migration 02: RLS enabled here, policies in migration 05, so
-- the gap between the two is deny-everyone rather than allow-everyone.
-- =============================================================================

-- =============================================================================
-- application_events — APPEND-ONLY. The audit log.
--
-- Status-change rows are written by a TRIGGER, not by agents. That is the whole
-- point: an agent cannot forget to log, and a status cannot change unwitnessed.
-- =============================================================================
create table public.application_events (
  -- bigint identity rather than uuid: this is the highest-volume table in the schema,
  -- it is always read in time order, and a monotonic key keeps inserts appending to
  -- the end of the index instead of scattering writes across it the way a random
  -- uuid does.
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  -- Cascade: an application's history dies with the application.
  application_id uuid not null references public.applications (id) on delete cascade,

  event_type public.application_event_type not null,
  -- NULL for non-status events such as a note or an llm_call.
  from_status public.application_status,
  to_status public.application_status,
  -- Who did it. NULL only for rows the database itself wrote before an actor was known.
  agent public.agent_name,
  -- Anything structured worth keeping: token counts, the key index used, error payloads.
  detail jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now()
);

alter table public.application_events enable row level security;
alter table public.application_events force row level security;

-- APPEND-ONLY, HALF ONE OF TWO. Like master_profiles, the trigger catches everyone
-- including a service-role key; the RLS policy in migration 05 catches the API roles.
-- An audit log that can be rewritten is not an audit log.
create trigger forbid_update
  before update on public.application_events
  for each row execute function applyy_internal.forbid_mutation();

create trigger forbid_delete
  before delete on public.application_events
  for each row execute function applyy_internal.forbid_mutation();

-- The only read this table gets: one application's history, newest first.
create index application_events_application_created_idx
  on public.application_events (application_id, created_at desc);

comment on table public.application_events is
  'Append-only. UPDATE and DELETE raise, including under the service-role key. Status-change rows are trigger-written so no agent can skip logging.';

-- =============================================================================
-- agent_runs — the health page.
--
-- This table exists because the two ways this system dies are both SILENT: Supabase
-- pauses a free project after a week idle, and GitHub disables scheduled workflows
-- after 60 days of repo inactivity. Neither errors. They just stop. Without this
-- table you believe the automation is working while getting no interviews.
-- =============================================================================
create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),

  agent public.agent_name not null,
  -- Opened as 'running' BEFORE the work starts, so a crash leaves a visible stuck run
  -- rather than no row at all. A missing row and a successful run look identical.
  status public.agent_run_status not null default 'running',

  started_at timestamptz not null default now(),
  finished_at timestamptz,
  -- Generated rather than written by the agent: a duration the agent computes can
  -- disagree with the timestamps beside it, and then you have two numbers and no truth.
  duration_ms integer generated always as (
    (extract(epoch from (finished_at - started_at)) * 1000)::integer
  ) stored,

  rows_in integer not null default 0 check (rows_in >= 0),
  rows_out integer not null default 0 check (rows_out >= 0),
  error_count integer not null default 0 check (error_count >= 0),
  error_detail text,
  -- Gemini calls this run spent, for the observability panel.
  gemini_calls integer not null default 0 check (gemini_calls >= 0)
);

alter table public.agent_runs enable row level security;
alter table public.agent_runs force row level security;

-- "When did each agent last succeed?" — the health page's only real query.
create index agent_runs_user_agent_started_idx
  on public.agent_runs (user_id, agent, started_at desc);

-- =============================================================================
-- gemini_key_state — the pool.
--
-- Pool state lives in Postgres and NOT in memory because Edge Functions are stateless,
-- horizontally-scaled isolates. An in-memory round-robin cursor would start at key 1
-- on every invocation, hammer it, and make 15x quota behave like 1x — while looking
-- perfectly healthy in code review. That is the trap this table exists to avoid.
-- =============================================================================
create table public.gemini_key_state (
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),

  -- Matches the env var suffix: key_index 1 is GEMINI_API_KEY_01. Zero-padded in the
  -- env name so string sort equals numeric sort — 'gemini10' sorts before 'gemini2',
  -- a bug that appears at exactly ten keys.
  key_index smallint not null check (key_index > 0),

  -- OBSERVABILITY ONLY. NEVER A GATE. THERE IS DELIBERATELY NO CHECK CONSTRAINT AND
  -- NO CEILING ON THIS COLUMN.
  --
  -- Google stopped publishing free-tier figures, and there are credible reports of
  -- Flash being cut from 250 to 20 RPD. Any number here — a check, a default, an
  -- `if (requests_today >= N)` anywhere in the codebase — is a guess that breaks
  -- silently the day Google changes it. The pool is purely REACTIVE: use a key until
  -- it 429s, believe its retry_after, move on. The system discovers its own capacity.
  requests_today integer not null default 0 check (requests_today >= 0),

  -- The date requests_today counts, IN PACIFIC, because that is when Google's quota
  -- resets. See public.pacific_today() for why this must not be current_date.
  quota_date date not null default public.pacific_today(),

  -- Set from a 429's retry_after. A key is ineligible until this passes. Believe the
  -- server's number rather than inventing a backoff — the server knows.
  cooldown_until timestamptz,

  -- THE LRU SORT KEY. Claiming picks the eligible key with the OLDEST last_used_at:
  -- least-recently-used, not round-robin, which self-balances when calls have uneven
  -- cost. Defaulting to -infinity means a never-used key always sorts first.
  last_used_at timestamptz not null default '-infinity'::timestamptz,

  -- Consecutive NON-quota failures. A high value suggests a revoked or invalid key
  -- rather than a busy one, which is a different problem with a different fix.
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),

  -- Manual off switch for one key without deleting its history.
  enabled boolean not null default true,
  last_error text,

  -- Natural key: one row per key per user. No surrogate id, because there is no
  -- second thing that could identify a key.
  primary key (user_id, key_index)
);

alter table public.gemini_key_state enable row level security;
alter table public.gemini_key_state force row level security;

-- THE CLAIM QUERY'S INDEX: eligible keys, oldest first. Partial on `enabled` so a
-- disabled key never occupies a slot in the hot index.
create index gemini_key_state_lru_idx
  on public.gemini_key_state (user_id, last_used_at)
  where enabled;

comment on column public.gemini_key_state.requests_today is
  'OBSERVABILITY ONLY, NEVER A GATE. No ceiling here on purpose: Google no longer publishes free-tier limits, so any hardcoded number breaks silently. The only gate is system_settings.gemini_daily_call_budget, which a human set.';

-- =============================================================================
-- search_preferences — one row per user. What to hunt for.
-- =============================================================================
create table public.search_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade default auth.uid(),

  -- Role titles to search for.
  titles text[] not null default '{}',
  -- Keywords that make a posting more interesting.
  keywords text[] not null default '{}',
  -- Keywords that make it less interesting — the cheapest test in the cascade.
  excluded_keywords text[] not null default '{}',

  employment_types public.employment_type[] not null default '{}',
  min_experience_years numeric(4, 1),
  -- The experience ceiling: reject a JD demanding more than this.
  max_experience_years numeric(4, 1),

  locations text[] not null default '{}',
  remote_only boolean not null default false,
  min_salary numeric(14, 2),
  -- INR default: the market this is aimed at.
  salary_currency text not null default 'INR',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.search_preferences enable row level security;
alter table public.search_preferences force row level security;

create trigger set_updated_at
  before update on public.search_preferences
  for each row execute function applyy_internal.set_updated_at();

-- =============================================================================
-- filter_rules — the cascade as live toggles.
--
-- Every row of the cascade is a settings field the user controls. That is what the
-- settings pages are for, and it is why thresholds live in `config` jsonb rather than
-- as columns: adding a rule must not require a migration.
-- =============================================================================
create table public.filter_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),

  rule_type public.filter_rule_type not null,
  -- Off means the rule is skipped entirely. This is the settings-page switch.
  enabled boolean not null default true,
  -- Rule-specific thresholds, e.g. {"max_years": 1} or {"blocked_titles": ["Senior"]}.
  -- For `staleness` it also carries {"treat_unknown_posted_at_as_fresh": false} — the
  -- policy that a cold-start board's postings FAIL the freshness check rather than
  -- bypassing it, exposed as a setting rather than buried in the Screener.
  config jsonb not null default '{}'::jsonb,
  -- Evaluation order. Lower runs first, so the cheapest tests go at the top — that
  -- ordering IS the cascade's economics.
  sort_order smallint not null default 100,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One rule of each kind per user. Two rows of the same type would make "is the
  -- staleness filter on?" ambiguous.
  constraint filter_rules_user_type_key unique (user_id, rule_type)
);

alter table public.filter_rules enable row level security;
alter table public.filter_rules force row level security;

create trigger set_updated_at
  before update on public.filter_rules
  for each row execute function applyy_internal.set_updated_at();

-- The Screener reads the whole enabled cascade in order, every run.
create index filter_rules_user_order_idx
  on public.filter_rules (user_id, sort_order)
  where enabled;

-- =============================================================================
-- company_watchlist — boards to poll, AND THE HOME OF THE COLD-START GUARD.
--
-- THE BUG THIS TABLE FIXES: the natural fallback for an unknown posting date is
-- first_seen_at — if you poll daily, anything never seen must be new. Sound in steady
-- state, WRONG on day one of any new board, when the whole back catalogue arrives
-- with first_seen_at = today and eighty stale postings all look three days old. A
-- day's quota goes on jobs open since March.
--
-- The counter below is the fix, and it is a COLUMN rather than application code so
-- that no peer has to remember it.
-- =============================================================================
create table public.company_watchlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),

  ats_provider public.ats_provider not null,
  -- The token the ATS API wants — the company slug in the board URL.
  board_token text not null,
  company_name text not null,
  -- Normalised, so the blocklist and the weekly cap can join against jobs.
  company_slug text not null,
  enabled boolean not null default true,

  -- How many times this board has been polled to completion. Zero means never.
  poll_count integer not null default 0 check (poll_count >= 0),
  first_polled_at timestamptz,
  last_polled_at timestamptz,
  -- A sudden drop to zero usually means the board token changed, not that hiring stopped.
  last_poll_job_count integer,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),

  -- THE GENERATED COLUMN THAT MAKES THE GUARD UNFORGETTABLE.
  --
  -- False means everything found on this board must be stored with
  -- posted_at_source = 'unknown' and excluded from the freshness filter. Generated
  -- rather than computed by each caller so the answer is ALREADY ON THE ROW — a peer
  -- cannot forget to work it out, because there is nothing to work out.
  first_seen_at_is_trustworthy boolean generated always as (poll_count >= 1) stored,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One row per board per user. The same company on Greenhouse and Lever is two rows,
  -- correctly — they are two boards with two independent cold-start states.
  constraint company_watchlist_user_board_key unique (user_id, ats_provider, board_token)
);

alter table public.company_watchlist enable row level security;
alter table public.company_watchlist force row level security;

create trigger set_updated_at
  before update on public.company_watchlist
  for each row execute function applyy_internal.set_updated_at();

-- The Scout's query: enabled boards, least recently polled first, so a 400-board
-- watchlist round-robins itself without any cursor to keep.
create index company_watchlist_user_due_idx
  on public.company_watchlist (user_id, last_polled_at nulls first)
  where enabled;

comment on column public.company_watchlist.first_seen_at_is_trustworthy is
  'Generated: poll_count >= 1. FALSE means store everything from this board as posted_at_source=unknown and exclude it from the freshness filter. Generated so no caller can forget the cold-start guard.';

-- =============================================================================
-- company_blocklist — one table, one WHERE clause, high value.
--
-- Without it, a staffing firm posting 30 near-identical listings a week collects 30
-- applications and you never notice, because each one looked like a different job.
-- =============================================================================
create table public.company_blocklist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),

  -- Normalised. THIS is what joins to jobs.company_slug — blocking by display name
  -- would miss "Acme Corp." vs "Acme Corp".
  company_slug text not null,
  -- Display name, as typed, for the settings page.
  company_name text not null,

  reason public.blocklist_reason not null default 'personal_choice',
  note text,
  -- NULL means blocked forever. A timestamp means it expires — which is what
  -- "rejected in the last N months" actually needs, and why this is not a boolean.
  blocked_until timestamptz,

  created_at timestamptz not null default now(),

  constraint company_blocklist_user_slug_key unique (user_id, company_slug)
);

alter table public.company_blocklist enable row level security;
alter table public.company_blocklist force row level security;

-- The filter's lookup: is this slug blocked right now? Partial on live blocks so
-- expired ones do not bloat the index the Screener hits on every job.
create index company_blocklist_active_idx
  on public.company_blocklist (user_id, company_slug)
  where blocked_until is null or blocked_until > now();

-- =============================================================================
-- answer_bank — standing answers, growing themselves.
--
-- `needs_human` is constraint 4 made concrete: when a question cannot be answered
-- from the profile, the system does not guess — it parks the application and asks.
-- =============================================================================
create table public.answer_bank (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),

  -- Normalised key, e.g. 'notice_period_days'. The join key, so the same question
  -- phrased differently on two ATSs hits one row.
  question_key text not null,
  -- UNTRUSTED: scraped from the ATS page DOM. Display escaped; never interpolate.
  question_text text not null,

  answer_type public.answer_type not null default 'text',
  -- jsonb because a multi-select answer is an array and a number should stay a number.
  -- Storing everything as text would push parsing into the Applier, where a wrong
  -- guess becomes a wrong answer on a real application (constraint 3).
  answer_value jsonb not null default 'null'::jsonb,

  -- TRUE means this is a placeholder awaiting a human. The Applier refuses to guess
  -- and parks the row at blocked_needs_human instead.
  needs_human boolean not null default false,

  times_used integer not null default 0 check (times_used >= 0),
  last_used_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint answer_bank_user_question_key unique (user_id, question_key)
);

alter table public.answer_bank enable row level security;
alter table public.answer_bank force row level security;

create trigger set_updated_at
  before update on public.answer_bank
  for each row execute function applyy_internal.set_updated_at();

-- The settings page's "these need your attention" list.
create index answer_bank_user_needs_human_idx
  on public.answer_bank (user_id)
  where needs_human;

comment on column public.answer_bank.question_text is
  'UNTRUSTED INPUT: scraped ATS page DOM. Escape on display, never interpolate into a prompt instruction.';

-- =============================================================================
-- email_events — the Gmail tracker's raw feed.
--
-- Pushed by a ~15-line Apps Script bound to the user's own mailbox, which runs AS the
-- user: no OAuth app, no consent screen, no restricted-scope verification, and no
-- refresh token to expire after seven days. Apps Script stays a DUMB PIPE — it posts
-- from/subject/snippet and nothing else, so the intelligence stays in this repo.
-- =============================================================================
create table public.email_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),

  -- Gmail's own message id. The UNIQUE below is what makes ingest IDEMPOTENT: Apps
  -- Script can re-post the same message after a retry and the second insert is a
  -- harmless conflict rather than a duplicate row.
  provider_message_id text not null,

  -- UNTRUSTED. Attacker-controlled in the general case — anyone can email you, and
  -- this text reaches Gemini.
  from_address text not null,
  -- UNTRUSTED.
  subject text not null,
  -- UNTRUSTED.
  snippet text not null,

  received_at timestamptz not null,

  -- Default 'unclassified' so the row exists before it is classified: a Gemini outage
  -- delays mail rather than losing it.
  classification public.email_classification not null default 'unclassified',
  classification_confidence numeric(4, 3)
    check (classification_confidence is null or (classification_confidence >= 0 and classification_confidence <= 1)),

  -- Which application this is about, once matched. May legitimately stay NULL —
  -- plenty of mail is not about an application at all. `set null` on delete rather
  -- than cascade: the email really did arrive, even if the application is gone.
  matched_application_id uuid references public.applications (id) on delete set null,

  -- NULL means still queued for classification.
  processed_at timestamptz,

  created_at timestamptz not null default now(),

  constraint email_events_user_message_key unique (user_id, provider_message_id)
);

alter table public.email_events enable row level security;
alter table public.email_events force row level security;

-- The Tracker's work queue: unclassified mail, oldest first.
create index email_events_unprocessed_idx
  on public.email_events (user_id, received_at)
  where processed_at is null;

comment on column public.email_events.snippet is
  'UNTRUSTED INPUT: inbound email reaches Gemini. Fenced untrusted block only, never concatenated into an instruction.';

-- =============================================================================
-- matcher_eval_cases — the golden eval set.
--
-- ~20 hand-labelled jobs. Every prompt change must still classify all of them
-- correctly. BUILD THE SET BEFORE ITERATING ON THE PROMPT: otherwise you tweak a
-- prompt to fix one bad match and silently break scoring on everything else, with no
-- way to notice.
--
-- THIS TABLE IS THE LABELLING SURFACE, NOT THE TEST FIXTURE. The CI gate has no
-- database, so the harness must export these rows to a JSON fixture committed to the
-- repo, and CI runs against that file. Fixtures in git are diffable and reviewable in
-- a pull request; fixtures in a database are neither.
-- =============================================================================
create table public.matcher_eval_cases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),

  -- The job being labelled. `set null` rather than cascade: the label is the valuable
  -- artefact and it survives the posting being pruned, because job_snapshot below
  -- holds everything the eval actually needs.
  job_id uuid references public.jobs (id) on delete set null,

  -- A frozen copy of the job at labelling time — title, company, description, parsed
  -- requirements. UNTRUSTED, same as its source. Frozen because an eval case whose
  -- input can change is not a regression test.
  job_snapshot jsonb not null,

  -- The human verdict.
  label public.eval_label not null,
  -- Why. Read by whoever is debugging a prompt regression six weeks from now, and
  -- worth more than the label itself when the two disagree.
  rationale text,

  -- Which master version the label was judged against. Fit is relative to a resume,
  -- so a label taken against an old master may not hold against a new one.
  master_version integer,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One label per job. Two labels for one job is a contradiction, not extra data.
  constraint matcher_eval_cases_user_job_key unique (user_id, job_id),

  -- Same pinning guarantee as applications: the judged-against version must exist.
  constraint matcher_eval_cases_master_version_fkey
    foreign key (user_id, master_version)
    references public.master_profiles (user_id, version)
    on delete restrict
);

alter table public.matcher_eval_cases enable row level security;
alter table public.matcher_eval_cases force row level security;

create trigger set_updated_at
  before update on public.matcher_eval_cases
  for each row execute function applyy_internal.set_updated_at();

comment on table public.matcher_eval_cases is
  'Labelling surface for the golden eval set. NOT the CI fixture — CI has no database, so the harness must export these to a JSON file committed to the repo.';
