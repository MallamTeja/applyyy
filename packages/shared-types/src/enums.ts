/**
 * applyy — Postgres enum mirrors.
 *
 * Every export here is the TypeScript twin of a `CREATE TYPE ... AS ENUM` in
 * supabase/migrations. Both halves of that claim are now verified — and they are two
 * separate claims, which is why they are stated separately:
 *
 *   1. MIRRORS THE MIGRATION SOURCE — verified continuously. Every tuple below matches
 *      its `create type` in 20260909234500_enums.sql by value AND by declaration
 *      order. Order matters as much as membership: Postgres sorts an enum by
 *      declaration order, so `ORDER BY status` is only pipeline order if these two
 *      agree. Proven by `test/enum-parity.test.ts`, which parses the migration and
 *      diffs it against this file — so this paragraph cannot quietly go stale.
 *   2. THE MIGRATION LOADS INTO POSTGRES — verified 2026-09-10 by applyyy-8c: all 7
 *      migrations apply cleanly to a LOCAL Postgres 17.6, 15/15 tables present, all 7
 *      RPCs present, 44 transition edges seeded. It took a fix to get there (a partial
 *      index whose predicate called `now()` was rejected as not IMMUTABLE, which had
 *      been aborting the run at file 4 of 7 and leaving the guard, the RLS policies and
 *      the RPCs unexecuted).
 *
 * REMOTE STATE, and the provenance matters as much as the fact: the project IS now
 * linked — `supabase/.temp/linked-project.json` and `project-ref` exist, written
 * 2026-09-10 18:40 — and Teja is reported to have pushed all 7 migrations at 18:45.
 * WHAT I VERIFIED MYSELF is the link state on disk; I did NOT query the remote, so
 * "the hosted project has these enums" is a second-hand claim, not one this comment
 * proves. Treat it accordingly, and re-verify against the remote before depending on
 * it. (The link files are gitignored, so no project identifier is committed —
 * constraint 11.)
 *
 * ONE FURTHER LIMIT ON "VERIFIED", because the general claim would mislead: the role
 * that ran the local verification had `rolbypassrls=TRUE`. The `SECURITY DEFINER` audit
 * trigger did write its witness row through FORCE RLS, but it did so BECAUSE of
 * BYPASSRLS — FORCE RLS does not exempt table owners. So "the audit trigger works"
 * holds for that deployment and is unproven for a plain-owner one.
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
   * ENFORCED BY THE TRANSITION TABLE, not by convention — and that is now verified
   * against a running Postgres rather than asserted. applyyy-8c confirmed on
   * 2026-09-10 that `approved → applying` is the ONLY row in
   * `application_status_transitions` whose `to_status` is `applying`, with
   * `allowed_agents = {applier}`, and that the BEFORE UPDATE guard rejects the illegal
   * jump with `illegal status transition tailored -> applying`.
   *
   * The control is what makes that evidence worth anything: the legal
   * `approved → applying` move with the same agent SUCCEEDED and set
   * `previous_status = approved`. So the guard is discriminating between edges, not
   * blanket-refusing writes — which a test that only checked the rejection could not
   * have distinguished.
   *
   * Constraint 15 is therefore unreachable-by-construction: no second door into
   * `applying` exists to be reached by a buggy agent.
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
  /** Public founder or recruiter hiring post on LinkedIn (Tier 2 discovery). */
  'linkedin_post',
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
  /**
   * The keepalive workflow, which exists to stop GitHub disabling the scheduled
   * workflows after 60 days of repository inactivity.
   *
   * IT NEEDS ITS OWN IDENTITY RATHER THAN BORROWING ONE, and the reason generalises:
   * `agent_runs` is what the health page reads to say "this stopped running", so a
   * keepalive logging itself as, say, the Applier produces a health page that lies
   * CONFIDENTLY — strictly worse than one with a missing row, because a gap prompts
   * someone to look and a wrong row does not. **Agent identities must be one-to-one
   * with real agents, because the health page's only job is detecting absence.**
   *
   * APPENDED LAST, deliberately. `alter type ... add value` without BEFORE/AFTER
   * appends, and declaration order is what Postgres sorts by — inserting mid-list would
   * silently change `ORDER BY agent` for every existing query. Added by migration
   * 20260910185900, which as of 2026-09-10 is LOCAL-ONLY: an `agent_runs` insert using
   * this value will fail against the remote database until that migration is pushed.
   */
  'keepalive',
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
   * Written automatically by a trigger on every status change, so no agent can forget
   * to log one. The trigger is live as of 2026-09-10 (verified locally: it wrote its
   * witness row into `application_events` during 8c's guard test).
   *
   * SO DO NOT ALSO WRITE ONE BY HAND — a manual insert alongside the trigger is a
   * duplicate event, not a belt-and-braces safeguard. Use
   * `advance_application_status`, which moves the row, writes the event and releases
   * the claim in one transaction.
   *
   * One caveat on the verification, because stating it generally would overclaim: the
   * trigger is `SECURITY DEFINER` and the role that proved it had `rolbypassrls=TRUE`.
   * FORCE RLS does not exempt table owners, so the write succeeded because of BYPASSRLS
   * rather than because FORCE RLS permits it. On a plain-owner deployment this is
   * unproven and should be re-tested before anyone relies on it.
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
 * WHAT KIND of untraceable claim the Auditor found. Carried inside
 * `applications.audit_findings` (jsonb), so TS-only by design — same granularity
 * argument as ANSWER_BLOCK_REASONS: this describes one finding, not the whole row.
 *
 * WHY A KIND IS NEEDED AT ALL. `AuditFinding` used to be `{path, claim, reason,
 * confidence}` with no discriminant, which collapsed two questions a human reviewer
 * must answer differently:
 *
 *   "Did I do this at all?"        -> the model invented something. Reject it.
 *   "Did I do this at THAT job?"   -> every fact is true; the ATTRIBUTION is false.
 *
 * The second is the dangerous one and the reason this enum exists. See
 * `misattributed_bullet` below.
 */
export const AUDIT_FINDING_KINDS = [
  /**
   * A ref that resolves to nothing in the pinned master version. The model invented an
   * id. Caught by the validator BEFORE the Auditor runs, so a finding of this kind in
   * production means the validator was bypassed — treat it as a bug, not a review item.
   */
  'unresolved_ref',
  /**
   * THE QUIET ONE. A ref that genuinely exists, nested under the WRONG PARENT: a bullet
   * that really belongs to a personal project, emitted under a named employer.
   *
   * Every individual claim survives a fact-check. The work happened, the numbers are
   * real, the wording is faithful — and the resume now credits a personal project to an
   * employer. This is FABRICATED EXPERIENCE ASSEMBLED ENTIRELY OUT OF TRUE PARTS, which
   * is why line-by-line tracing passes it and why existence-only ref checking cannot
   * see it: the fabrication is in the STRUCTURE, not in any string.
   *
   * It needs its own kind because the fix differs. `unresolved_ref` means the model is
   * INVENTING and the answer is to reject the output. This means the model is
   * REASSEMBLING TRUTH, and the answer is to re-parent the bullet. Same severity in the
   * interview room, opposite remedies.
   *
   * Findings of this kind MUST name both parents — see the discriminated union in
   * tables.ts, which makes a nameless misattribution unrepresentable rather than merely
   * discouraged.
   */
  'misattributed_bullet',
  /**
   * The ref resolves, the parent is right, but the rewording asserts something the
   * master text does not support — scope inflation ("led" for "contributed to"), a
   * number that grew, a technology swapped for the one the JD asked for.
   */
  'unfaithful_rewording',
  /**
   * The summary's prose is not supported by the master nodes it declared in `refs`.
   * Prose cannot be constrained by refs the way a bullet can, which profile-nodes.ts
   * names as the weakest point in the whole design — so this kind is expected to fire
   * more often than the others and must never be auto-cleared.
   */
  'summary_unsupported',
  /** Anything the Auditor could not classify. `reason` carries the detail. */
  'other',
] as const;
/** Union of every legal `AuditFinding.kind`. Lives inside `audit_findings` jsonb, never in a column. */
export type AuditFindingKind = (typeof AUDIT_FINDING_KINDS)[number];

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
