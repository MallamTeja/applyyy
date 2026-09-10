/**
 * applyy — Postgres enum mirrors.
 *
 * Every export here is intended as the TypeScript twin of a `CREATE TYPE ... AS ENUM`
 * in supabase/migrations. STATE OF THAT CLAIM, 2026-09-10 — read it before relying on
 * it, because "twin" is two separate assertions and only one of them is settled:
 *
 *   1. MIRRORS THE MIGRATION SOURCE — VERIFIED, and verified continuously. Every tuple
 *      below matches its `create type` in 20260909234500_enums.sql by value AND by
 *      declaration order. Order matters as much as membership: Postgres sorts an enum
 *      by declaration order, so `ORDER BY status` is only pipeline order if these two
 *      agree. Proven by `test/enum-parity.test.ts`, which parses the migration and
 *      diffs it against this file — so this paragraph cannot quietly go stale.
 *   2. THE MIGRATION LOADS INTO POSTGRES — NOT YET TRUE. As of 2026-09-10 the SQL has
 *      never been executed anywhere: no local `supabase start`, no remote push (gated
 *      on Teja, constraint: no remote infrastructure). So nothing has confirmed that
 *      Postgres ACCEPTS these declarations. A typo in the SQL would be invisible to
 *      the parity test, which reads the file rather than the database.
 *
 * Consequence for a consumer: import these freely — they are the agreed vocabulary
 * and four streams already build on them. Just do not read a comment here as evidence
 * that a database exists. When applyyy-8c reports the migrations executing, assertion
 * 2 becomes true and this block should shrink to one sentence.
 *
 * The pattern throughout is: a `const` tuple (runtime value, iterable, usable to build
 * a dropdown or to validate an untrusted string) plus a union type derived from it with
 * `[number]` (compile-time value, exhaustively checkable in a switch). Declaring the
 * type by hand alongside the tuple would let the two drift apart silently — deriving
 * one from the other makes that impossible.
 *
 * If you add a value here you MUST add it to the migration, and vice versa. That rule
 * used to be guarded only by a checklist in SCHEMA_CONTRACT.md; it is now guarded by
 * `pnpm --filter @applyy/shared-types test`, which fails on any drift in either
 * direction. Prefer the executable guard — a checklist is a guard nobody runs.
 */

/**
 * The workflow itself. `applications.status` IS the queue (PROJECT_PLAN section 5):
 * each agent claims rows in one status, does one job, writes the next status.
 *
 * Order below is the happy path then the off-ramps, matching the migration's
 * declaration order — which is also Postgres's sort order for this type, so
 * `ORDER BY status` yields pipeline order for free on the kanban board.
 *
 * TWO RENAMES vs PROJECT_PLAN section 9 (ruled by peer applyyy-e5, 2026-09-09,
 * before any code existed): the plan wrote `screened` and `screening` — one letter
 * apart, opposite meanings, in the same enum. They are now `passed_filters` (WE
 * filtered it, pre-apply) and `employer_screening` (THEY are reviewing you, post-apply).
 */
export const APPLICATION_STATUSES = [
  /** Scout wrote a row; nothing has looked at it yet. */
  'discovered',
  /** Normalizer confirmed this is not a duplicate of a job already in the table. */
  'deduped',
  /** Passed OUR deterministic filter cascade. No LLM spent yet — this gate is what makes free Gemini keys sufficient rather than merely hopeful. */
  'passed_filters',
  /** Matcher (Gemini) attached a fit score and reasoning. */
  'scored',
  /** Tailor produced a tailored profile snapshot, validated against the master. */
  'tailored',
  /** Auditor traced every tailored line back to a master node. Nothing invented. */
  'audit_clean',
  /** Auditor found at least one untraceable claim. Individual human review, never batch-approved. */
  'audit_flagged',
  /** Sitting in the human approval queue. A durable row state, not a paused process — it survives a Supabase pause and a laptop reboot. */
  'awaiting_approval',
  /**
   * A human said yes. The ONLY status from which `applying` is reachable.
   *
   * WHERE THAT IS ENFORCED, 2026-09-10 — the distinction is safety-relevant, so it is
   * spelled out rather than implied. The single-door property is DECLARED twice: in
   * `application_status_transitions` + its BEFORE UPDATE trigger
   * (20260909234900_status_transition_guard.sql) and in status-flow.ts. Only the
   * second is currently RUNNING, because the migration has not been executed. A
   * client-side mirror is advisory: today a buggy agent that writes `applying`
   * directly would succeed, and constraint 15 rests on code review plus this comment
   * rather than on Postgres refusing the write. Executing the migration is what turns
   * "by convention" into "by the transition table" — until then, do not describe the
   * gate as unbypassable.
   */
  'approved',
  /** The worker has begun submitting. THE ONE NON-IDEMPOTENT STATE — see NON_RETRYABLE_STATUSES below. */
  'applying',
  /** Submission confirmed. */
  'applied',
  /** Post-apply: the EMPLOYER is reviewing. Advanced by the email Tracker. */
  'employer_screening',
  /** An online assessment / HackerRank has been sent. */
  'oa_pending',
  /** An interview is scheduled or has happened. */
  'interview',
  /** Terminal, good. */
  'offer',
  /** Terminal, bad. Also feeds the blocklist's rejected-recently rule. */
  'rejected',
  /** Off-ramp: a filter cascade rule dropped it. `drop_reason` says which rule. */
  'dropped_filter',
  /** Off-ramp: fingerprint matched a job already in the table. */
  'dropped_duplicate',
  /** Off-ramp: the worker hit a captcha / MFA / anti-bot wall. NOT a failure — a normal daily queue item with a screenshot (constraint 5). */
  'blocked_needs_human',
  /** Off-ramp: a stale `applying` lease was swept. A human must confirm whether the submit actually landed before anything else touches this row. */
  'needs_verification',
  /** Off-ramp: an unrecoverable error the system could not classify. `failure_reason` carries the detail. */
  'failed',
] as const;
/** Union of every legal `applications.status` value. */
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/**
 * How much to believe `jobs.posted_at` (PROJECT_PLAN section 13).
 *
 * This exists because posted_at is the least reliable field in the system:
 * Greenhouse returns `updated_at` (a description edit resets it), Lever and Ashby
 * return genuine publish dates, and aggregated LinkedIn/Naukri sometimes return
 * relative text or nothing. The freshness filter behaves differently per level.
 */
export const POSTED_AT_SOURCES = [
  /** The board gave us a real publish timestamp. Safe to apply the freshness filter. */
  'exact',
  /** Inferred from first_seen_at on a board polled before, so "never seen it" genuinely means "it is new". */
  'derived',
  /** We do not know. EXCLUDED from the freshness filter rather than assumed fresh — the cold-start guard that stops a new board's entire back catalogue from looking three days old. */
  'unknown',
] as const;
/** Union of every legal `jobs.posted_at_source` value. */
export type PostedAtSource = (typeof POSTED_AT_SOURCES)[number];

/**
 * Where a posting was FOUND. Deliberately distinct from AtsProvider (where you
 * APPLY) — a Greenhouse job is routinely discovered through Adzuna, and conflating
 * the two would make "which adapter submits this?" unanswerable.
 */
export const DISCOVERY_SOURCES = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'smartrecruiters',
  'adzuna',
  'jooble',
  /** Discovery only, human applies — LinkedIn auto-apply gets accounts restricted. */
  'linkedin',
  'naukri',
  'company_career_page',
  /** A human pasted a URL into the dashboard. */
  'manual',
  'other',
] as const;
/** Union of every legal element of the `jobs.discovered_via` array. */
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];

/**
 * Which ATS actually receives the submission. This selects the Playwright adapter,
 * which is why `unknown` is a value rather than NULL — an unroutable job is a real
 * state the dashboard must show, not missing data.
 */
export const ATS_PROVIDERS = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'smartrecruiters',
  /** We have an apply URL but no adapter recognises it. Routes to a human. */
  'unknown',
  'other',
] as const;
/** Union of every legal `jobs.ats_provider` / `company_watchlist.ats_provider` value. */
export type AtsProvider = (typeof ATS_PROVIDERS)[number];

/** Employment shape — both a job attribute and a search preference. */
export const EMPLOYMENT_TYPES = ['internship', 'full_time', 'part_time', 'contract', 'unknown'] as const;
/** Union of every legal employment type. */
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

/** Onsite / remote shape. `unknown` because most JD text does not say plainly. */
export const WORK_ARRANGEMENTS = ['onsite', 'hybrid', 'remote', 'unknown'] as const;
/** Union of every legal work arrangement. */
export type WorkArrangement = (typeof WORK_ARRANGEMENTS)[number];

/**
 * The agents. Used by `agent_runs.agent`, `application_events.agent`, and as the
 * `claimed_by` prefix — so the health page can say "Scout has not run in 9 days",
 * which is the silent failure mode PROJECT_PLAN section 14 calls out as expensive.
 */
export const AGENT_NAMES = [
  'scout_ats',
  'scout_aggregator',
  'normalizer',
  /** Deterministic, no LLM. Deliberate: most discovered jobs die here before costing a Gemini call. */
  'screener',
  'matcher',
  'tailor',
  'auditor',
  /** GitHub Actions + Playwright, not an Edge Function. */
  'applier',
  'tracker',
  /** Not in the plan's roster, but it writes rows so it needs an identity: the lease reclaimer. */
  'sweeper',
  /** A human acting through the dashboard. Approvals and manual edits are events too. */
  'human',
] as const;
/** Union of every legal agent identity. */
export type AgentName = (typeof AGENT_NAMES)[number];

/** Outcome of one agent invocation, for the health page. */
export const AGENT_RUN_STATUSES = [
  'running',
  'succeeded',
  'failed',
  /** The kill switch was off. Not a failure — recorded so the health page can say WHY nothing happened. */
  'skipped_disabled',
  /** Every Gemini key was cooling, or the daily budget was spent. Quota exhaustion is not an error. */
  'skipped_quota',
] as const;
/** Union of every legal `agent_runs.status` value. */
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/**
 * What an incoming email means. Produced by Gemini inside the Edge Function, NOT by
 * Apps Script — Apps Script stays a dumb pipe so the intelligence stays in the repo.
 */
export const EMAIL_CLASSIFICATIONS = [
  'application_received',
  'rejection',
  'oa_invite',
  'interview_invite',
  'offer',
  'recruiter_outreach',
  'other',
  /** Default on insert: the row exists before it is classified, so a Gemini outage loses no mail. */
  'unclassified',
] as const;
/** Union of every legal `email_events.classification` value. */
export type EmailClassification = (typeof EMAIL_CLASSIFICATIONS)[number];

/** The rows of the filter cascade, one per toggleable rule. */
export const FILTER_RULE_TYPES = [
  /** JD demands more years than the user wants. */
  'experience_ceiling',
  /** Senior, Staff, Principal, Lead, Manager, Architect. */
  'title_blocklist',
  'location_allowlist',
  'employment_type',
  /** Fingerprint already in history — a cheap pre-check ahead of the UNIQUE constraint. */
  'already_applied',
  'company_blocklist',
  /** Posted more than N days ago. Skips jobs whose posted_at_source is `unknown`. */
  'staleness',
  /** Requires a Master's or PhD. */
  'degree_mismatch',
  /** Max N applications per company per week. */
  'per_company_weekly_cap',
] as const;
/** Union of every legal `filter_rules.rule_type` value. */
export type FilterRuleType = (typeof FILTER_RULE_TYPES)[number];

/** Why a company is blocked — drives whether the block expires. */
export const BLOCKLIST_REASONS = [
  /** Resume-harvesting staffing firms posting 30 near-identical evergreen listings a week. */
  'consultancy',
  /** Sales-internship / MLM outfits dressed as marketing or BD. */
  'mlm',
  /** Applied, never heard back. */
  'ghosted',
  /** Rejected recently — reapplying immediately is a visible negative in most ATSs. Normally time-boxed via blocked_until. */
  'rejected_recently',
  /** Places the user simply would not join. At 35 slots a day every wasted slot is a real one. */
  'personal_choice',
  'other',
] as const;
/** Union of every legal `company_blocklist.reason` value. */
export type BlocklistReason = (typeof BLOCKLIST_REASONS)[number];

/** Shape of a stored answer, so the Applier knows which form control to drive. */
export const ANSWER_TYPES = [
  'text',
  'long_text',
  'number',
  'boolean',
  'single_select',
  'multi_select',
  'date',
  'file',
] as const;
/** Union of every legal `answer_bank.answer_type` value. */
export type AnswerType = (typeof ANSWER_TYPES)[number];

/** What is being recorded in the append-only audit log. */
export const APPLICATION_EVENT_TYPES = [
  /**
   * Logged on every status change.
   *
   * INTENDED to be written by a trigger, so that no agent can forget to log one —
   * that trigger is written (20260909234900_status_transition_guard.sql) but has
   * never run, so as of 2026-09-10 an agent CAN forget. Write the event explicitly
   * (or go through the `advance_application_status` RPC, which does both in one
   * transaction) until applyyy-8c reports the migration loading; then the automatic
   * write becomes real and a hand-written event becomes a duplicate. Both halves of
   * that sentence matter: the trigger's absence is a gap now, and its arrival is a
   * behaviour change to code written against the gap.
   */
  'status_change',
  'claim',
  'release',
  'note',
  'error',
  'llm_call',
] as const;
/** Union of every legal `application_events.event_type` value. */
export type ApplicationEventType = (typeof APPLICATION_EVENT_TYPES)[number];

/**
 * WHY an application is parked at `blocked_needs_human`.
 *
 * Exists so constraint 4 ("don't guess when an application question cannot be
 * answered from the profile") has storage WITHOUT adding a status. An unanswerable
 * question and a captcha need the identical operator action — a human takes it from
 * here — so a separate state would add a node to the graph without adding meaning.
 *
 * The rule of thumb: add a STATE when the handler differs; add a REASON when only the
 * explanation differs.
 */
export const BLOCK_REASONS = [
  /** Anti-bot challenge. We do not solve these — constraint 5 forbids circumvention. */
  'captcha',
  /** Multi-factor or identity challenge on the employer's portal. */
  'mfa',
  /** CONSTRAINT 4: a required field has no answer in the bank and the system refuses to guess. `block_detail.question_key` says which. */
  'unanswerable_question',
  /** No adapter handles this form shape. A coverage gap, not a run failure. */
  'unsupported_form',
  /** The board demands an account before showing the form. */
  'login_required',
  /** Submit was reached but the outcome could not be confirmed from the page. */
  'submission_unconfirmed',
  'other',
] as const;
/** Union of every legal `applications.block_reason` value. */
export type BlockReason = (typeof BLOCK_REASONS)[number];

/**
 * WHICH KIND of unanswerable a single form FIELD is. The one reason vocabulary for
 * per-field refusals, replacing worker/src/plan-fill.ts's local union.
 *
 * ── WHY THIS IS A SECOND ENUM AND NOT MORE VALUES IN BLOCK_REASONS ──────────────
 * The two are at different GRANULARITIES and type different columns, so merging them
 * would mean one enum whose values are legal in one column and illegal in the other:
 *
 *   BLOCK_REASONS         types `applications.block_reason` — a real Postgres enum
 *                         column. ROW-level: why is this whole application parked?
 *   ANSWER_BLOCK_REASONS  lives inside `applications.block_detail` (jsonb). FIELD-
 *                         level: which of possibly several questions stopped it, and
 *                         which kind of stop each one is.
 *
 * The relationship is fixed and total: if any field carries one of these, the row's
 * `block_reason` is `'unanswerable_question'`. Never `'captcha'` or `'mfa'` — those
 * are page-level walls with no field attached, which is exactly why they belong only
 * in the row-level enum and are deliberately NOT repeated here. Repeating them is the
 * duplication this enum exists to prevent: two spellings of one concept is how the
 * `no_answer` / `answer_missing` drift started.
 *
 * ── ONE VOCABULARY: the rename that closes the drift ────────────────────────────
 * worker/src/plan-fill.ts:33 declares `'no_answer' | 'awaiting_human_answer'` locally.
 * Import this instead and apply the mapping (applyyy-ef, applyyy-20, applyyy-f8):
 *   no_answer            -> answer_missing         (same concept, two names — the drift)
 *   awaiting_human_answer -> answer_low_confidence  (bank row exists, needs_human = true)
 * As of 2026-09-10 that rename has NOT been applied in the worker; this enum is the
 * agreed target, not a description of shipped code.
 *
 * ── WHY THREE CASES AND NOT TWO ────────────────────────────────────────────────
 * Because the operator action and the ANSWER-BANK EFFECT differ per case, and the bank
 * growing itself is the whole value of the answer bank (PROJECT_PLAN section 15).
 * Collapsing `answer_missing` into `answer_low_confidence` would lose the INSERT
 * trigger — the system would stop learning new questions, which is the feature.
 */
export const ANSWER_BLOCK_REASONS = [
  /**
   * No row in the answer bank matches this question at all — never seen it before.
   * Operator action: answer it once. Bank effect: INSERT a new row, so this question
   * is answered automatically forever after. THIS is the bank growing itself.
   */
  'answer_missing',
  /**
   * A bank row exists but is not trustworthy enough to submit — `needs_human` is
   * true, i.e. a placeholder or a guess awaiting confirmation. Operator action:
   * confirm or correct the existing value. Bank effect: UPDATE in place and clear
   * `needs_human`. Distinct from `answer_missing` because there is already a value to
   * react to, and because the write is an update rather than an insert.
   */
  'answer_low_confidence',
  /**
   * The system has an answer, or could compose one, and REFUSES to submit it
   * automatically. Two grounds: the honest answer is not among the options the widget
   * offers (a yes/no control where the truthful answer is neither), or the question is
   * one no automation should answer on someone's behalf — EEO and self-identification,
   * disability, veteran status, sponsorship, expected CTC.
   *
   * Operator action: the human answers this one on the real form, every time. Bank
   * effect: NONE, deliberately — never write back. Caching a legal or demographic
   * declaration for silent reuse is a decision that belongs to the human on each
   * application, and it is constraint 3 (never falsely answer) at its sharpest: the
   * failure here is not a gap in the bank, so filling the gap is the wrong fix.
   */
  'answer_refused',
] as const;
/** Union of every legal per-field answer-block reason. Carried inside `block_detail`, never in a column. */
export type AnswerBlockReason = (typeof ANSWER_BLOCK_REASONS)[number];

/**
 * The golden eval set's verdict — `matcher_eval_cases.label`.
 *
 * ~20 hand-labelled jobs that every Matcher prompt change must still classify
 * correctly. Build the eval set BEFORE iterating on the prompt: otherwise you tweak a
 * prompt to fix one bad match and silently break scoring on everything else, with no
 * way to notice.
 *
 * ADDED 2026-09-10, and worth knowing why it was missing: `eval_label` was the only
 * one of the 15 enums in the migration with no TypeScript twin, and
 * `matcher_eval_cases` the only one of 15 tables with no Row type. The eval-set work
 * landed in SQL and was never mirrored here, so anyone building the Matcher would have
 * hand-declared both — the exact drift this package exists to prevent. Found by
 * diffing the migration against this file, which is now `test/enum-parity.test.ts`.
 */
export const EVAL_LABELS = [
  'good_fit',
  'bad_fit',
  /**
   * Deliberately present. A two-way forced choice would push genuinely ambiguous jobs
   * into one bucket and make the eval set lie about the model's accuracy — a regression
   * suite that overstates its own precision is worse than none, because it is trusted.
   */
  'borderline',
] as const;
/** Union of every legal `matcher_eval_cases.label` value. */
export type EvalLabel = (typeof EVAL_LABELS)[number];
