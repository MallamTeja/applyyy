// THE DEPENDENCY SEAM every agent in this stream is written against.
//
// WHY THE AGENTS DO NOT TOUCH `SupabaseClient` DIRECTLY, which is the whole reason
// this file exists: the interesting logic in an agent is the ORDER it does things in —
// kill switch before anything, sweep before claim, `canTransition` before every status
// write, `release_application_claim` when no key is free. Every one of those is a
// property of a SEQUENCE OF CALLS, and a sequence of calls can only be asserted
// against a recording double. A `SupabaseClient` cannot be built under `node --test`
// (no `Deno.env`, no network, no project), so an agent that reaches for one directly is
// an agent whose ordering is untestable — and ordering is exactly where rule 1 lives.
//
// So each agent takes only the NARROW PORTS it needs, and that narrowness carries a
// guarantee the comments could not: the Screener's signature has no `GeminiPort`, so
// "the Screener has no LLM" is enforced by the type checker rather than by review.
// PROJECT_PLAN §8's economics depend on that being true, and a reviewer's memory is a
// poor place to keep a load-bearing invariant.
//
// The real implementation lives in `supabase-port.ts`, which is Deno-only and is the
// one module in the agent runtime that no test imports.

// Row and enum shapes from the schema owner. Imported, NEVER redefined: a redefined
// row type does not fail, it DRIFTS, and drift between the row shape and the code
// writing that row is invisible until production.
import type {
  // What an agent may legally call itself when it writes a status.
  AgentName,
  // The run-outcome vocabulary the health page reads.
  AgentRunStatus,
  // The queue row itself.
  ApplicationRow,
  // The workflow position.
  ApplicationStatus,
  // The cascade's rule rows, read by the Screener.
  FilterRuleRow,
  // The posting.
  JobRow,
  // Teja's own profile, the only source of fact the Tailor may select from.
  MasterProfile,
} from "../contracts/shared-types.ts";

// Every port call returns this rather than throwing.
//
// A UNION RATHER THAN AN EXCEPTION, and the reason is operational: half of what can go
// wrong here is not exceptional at all. A missing `system_settings` row, an empty key
// pool and a claimed batch of zero rows are all NORMAL states with specific correct
// responses. Flattening them into a thrown error would put "the account was never
// bootstrapped" and "Postgres is unreachable" on the same code path, and the agent
// would then have to reconstruct the difference from a message string.
export type PortResult<T> =
  // The call succeeded and carries its value.
  | { readonly ok: true; readonly value: T }
  // The call failed. `reason` is for the function log and `agent_runs.error_detail`.
  | { readonly ok: false; readonly reason: string };

// The subset of `system_settings` the agent runtime reads.
//
// A PROJECTION RATHER THAN `SystemSettingsRow` ON PURPOSE: it documents exactly what
// the runtime depends on, so adding a dependency is a visible edit here. It also keeps
// every test fixture a five-field literal instead of a twelve-column row.
export interface SettingsSnapshot {
  // THE KILL SWITCH (§18.1). Defaults FALSE in the schema so a fresh deploy cannot
  // start submitting.
  readonly systemEnabled: boolean;
  // Whether the worker may actually submit. Read here only so a run can record it.
  readonly dryRun: boolean;
  // NULL = uncapped. The only number in the schema permitted to stop work — and note
  // it is a HUMAN-SET budget, not a guess about Google's quota (§18.2, and rule 5).
  readonly geminiDailyCallBudget: number | null;
  // §18.5's knob. The count itself is always derived by query, never stored.
  readonly maxApplicationsPerCompanyPerWeek: number;
  // §13's window, in days.
  readonly freshnessWindowDays: number;
}

// What `sweep_stale_claims()` returned.
//
// NAMED FIELDS BECAUSE THE RPC'S SHAPE IS A KNOWN TRAP: it is `returns table (...)`,
// so over PostgREST it resolves to an ARRAY even though it can only ever yield one
// row. `data.released_count` is `undefined`; `data[0].released_count` is the number.
// The unpacking happens once, in the adapter, so no agent can get it wrong.
export interface SweepCounts {
  // Leases dropped. Disjoint from `needsVerificationCount` since migration
  // `20260910190000_fix_sweep_count_bootstrap_seed_and_blocked_edge.sql` (FIX 1, :27):
  // before 2026-09-10 the SQL double-counted rows its own first statement had just
  // moved to `needs_verification`. Safe to build a metric on now.
  readonly releasedCount: number;
  // Stale `applying` rows routed to `needs_verification`. Safety-critical: a blind
  // retry of a possibly-submitted application is how constraint #7 gets violated.
  readonly needsVerificationCount: number;
}

// How a run ends, for `agent_runs`.
export interface RunOutcome {
  // `succeeded` / `failed` / `skipped_disabled` / `skipped_quota` — the health page's
  // vocabulary, imported rather than restated.
  readonly status: AgentRunStatus;
  // Rows claimed.
  readonly rowsIn: number;
  // Rows successfully advanced.
  readonly rowsOut: number;
  // Rows that errored. Distinct from `rowsIn - rowsOut`, because a row released for
  // quota is neither advanced nor failed.
  readonly errorCount: number;
  // Human-readable detail, including filter misconfiguration warnings.
  readonly errorDetail: string | null;
  // Gemini calls actually spent, for the observability panel.
  readonly geminiCalls: number;
}

// Settings, run bookkeeping and the sweeper. Needed by EVERY agent, which is why the
// kill switch lives on the port every agent is forced to take.
export interface RunPort {
  // Read the control panel. `null` means there is no row at all — the account was
  // never bootstrapped, which must read as "off" and never as "no objection".
  readSettings(): Promise<PortResult<SettingsSnapshot | null>>;
  // Open a run row BEFORE doing work, so a crash leaves a visible `running` row. A
  // missing row and a successful run look identical, which is the §14 silent death.
  openRun(agent: AgentName, status?: AgentRunStatus): Promise<PortResult<string | null>>;
  // Close it out. Takes the id `openRun` returned, which may be null if that insert
  // failed — losing the run row must not lose the work.
  closeRun(runId: string | null, outcome: RunOutcome): Promise<PortResult<void>>;
  // Reclaim expired leases so a crashed peer self-heals.
  sweepStaleClaims(): Promise<PortResult<SweepCounts>>;
}

// The non-status columns an agent may write.
//
// `status` IS DELIBERATELY ABSENT AND THAT IS THE POINT. §6's rule — never write
// `status` with a bare `.update()` — is enforced here by the type having no field for
// it, so the mistake cannot be made rather than being caught in review.
export interface ApplicationPatch {
  // Matcher output.
  readonly match_score?: number;
  readonly match_reasoning?: string;
  readonly selected_jd_keywords?: readonly string[];
  // Tailor output: the pin, the raw refs and the resolved snapshot.
  readonly master_version?: number;
  readonly tailor_refs?: unknown;
  readonly tailored_profile?: unknown;
  readonly tailored_hash?: string;
  // Auditor output.
  readonly audit_findings?: readonly unknown[];
  // Why a row was dropped or could not be processed. Free text for the dashboard.
  readonly drop_reason?: string;
  readonly failure_reason?: string;
}

// Claiming rows and moving them. The queue IS the `applications` table (§5).
export interface QueuePort {
  // Lease-based claim. Returns [] when the kill switch is off, which is not an error —
  // the SQL checks the switch internally so no agent can forget it.
  claimApplications(
    status: ApplicationStatus,
    claimedBy: string,
    limit: number,
  ): Promise<PortResult<readonly ApplicationRow[]>>;
  // Move a row. Goes through `advance_application_status()`, which validates the edge,
  // declares the actor, records the event and releases the lease in ONE transaction.
  // Never a bare `.update({status})`: that passes the guard but strands the lease.
  advanceStatus(
    applicationId: string,
    toStatus: ApplicationStatus,
    agent: AgentName,
    detail?: Record<string, unknown>,
  ): Promise<PortResult<void>>;
  // Give a claimed row back UNTOUCHED. The only correct response to "every Gemini key
  // is cooling" — there is no rollback because claiming never advanced the status.
  releaseClaim(applicationId: string, agent: AgentName, reason: string): Promise<PortResult<void>>;
  // Write non-status columns (score, tailored profile, findings).
  patchApplication(applicationId: string, patch: ApplicationPatch): Promise<PortResult<void>>;
}

// Reading and correcting `jobs`.
export interface JobPort {
  // Load the postings behind a claimed batch, in one round trip rather than N.
  loadJobs(jobIds: readonly string[]): Promise<PortResult<readonly JobRow[]>>;
  // Is this canonical fingerprint already held by a job? Used by the Normalizer to
  // detect a duplicate the Scout's weaker key let through.
  findJobIdByFingerprint(fingerprint: string): Promise<PortResult<string | null>>;
  // Write the canonical fingerprint back, so the `UNIQUE(user_id, fingerprint)`
  // constraint starts doing the deduplication work from the next poll onward.
  patchJobFingerprint(jobId: string, fingerprint: string): Promise<PortResult<void>>;
}

// Everything the deterministic cascade needs that is not on the job row.
export interface ScreenPort {
  // The cascade's rules, thresholds and ORDER. Nothing is hardcoded: §8 says every
  // row is a settings field, and `sort_order` means re-ordering is a settings change.
  loadFilterRules(): Promise<PortResult<readonly FilterRuleRow[]>>;
  // Slugs currently blocked. `blocked_until` is honoured by the adapter so a
  // time-limited block expires without anyone remembering to remove it.
  loadBlockedCompanySlugs(): Promise<PortResult<ReadonlySet<string>>>;
  // Fingerprints already in the application history — a cheap pre-check ahead of the
  // `UNIQUE(user_id, job_id)` constraint, which remains the real guarantee.
  loadAppliedFingerprints(): Promise<PortResult<ReadonlySet<string>>>;
  // Applications sent per company in the trailing week, for §18.5's cap. DERIVED BY
  // QUERY, never a stored counter: a `COUNT(*)` cannot drift from the rows it counts.
  loadWeeklyApplicationCounts(): Promise<PortResult<ReadonlyMap<string, number>>>;
}

// One versioned, immutable master profile.
export interface MasterSnapshot {
  // `master_profiles.version`. The pin an application carries, and the value the
  // model must echo back so a tailoring computed against another snapshot is caught.
  readonly version: number;
  // The profile itself — the only source of fact a tailored resume may draw on.
  readonly profile: MasterProfile;
}

// Reading the master. Needed by the Tailor (to select from) and the Auditor (to trace
// against) — and the Auditor reads THE SAME PINNED VERSION, not the latest, or it
// would audit against a profile the tailoring never saw.
export interface MasterPort {
  // The newest version, for a fresh tailoring.
  loadLatestMaster(): Promise<PortResult<MasterSnapshot | null>>;
  // A specific version, for auditing an existing tailoring against its own pin.
  loadMasterVersion(version: number): Promise<PortResult<MasterSnapshot | null>>;
}

// What one Gemini call needs. Assembled and inspectable BEFORE anything is sent, which
// is what makes the injection regression suite possible at all.
export interface GenerateRequest {
  // TRUSTED region: policy plus master profile. No scraped field is ever interpolated
  // here — that is the property the regression suite asserts byte-for-byte.
  readonly systemInstruction: string;
  // UNTRUSTED region: fenced, labelled, and nothing else.
  readonly userContent: string;
  // §10 defense 2. EVERY call declares a schema, so free-form model text cannot drive
  // a decision even if the model is entirely compromised.
  readonly responseSchema: Record<string, unknown>;
}

// The outcome of one Gemini call.
export type GenerateResult =
  // Parsed JSON matching the declared schema's top-level type. Still untrusted DATA —
  // it is validated by typed code before anything acts on it.
  | { readonly ok: true; readonly value: unknown; readonly keyIndex: number }
  // Quota. NOT AN ERROR (§14): release the claim and let the next run pick the row up.
  | { readonly ok: false; readonly reason: "all_keys_cooling" }
  // The pool is empty because nothing ever seeded it. Needs a human, immediately, and
  // is a completely different condition from the line above despite the same SQL NULL.
  | { readonly ok: false; readonly reason: "no_keys_configured" }
  // A genuine failure: transport, a non-429 status, or an unparseable body.
  | { readonly ok: false; readonly reason: "call_failed"; readonly detail: string };

// The only route to a model in this stream.
//
// THE SCREENER DOES NOT TAKE THIS PORT, and that absence is load-bearing rather than
// tidy: §8's whole economic argument is that deterministic filters run BEFORE anything
// costs a call, so "the Screener has no LLM" must be a fact about the type system and
// not a promise in a comment.
export interface GeminiPort {
  // Claim a key, call the model, report the outcome back to the pool. One method,
  // because a caller that could claim without reporting would leave
  // `consecutive_failures` permanently non-zero after a single bad call.
  generate(request: GenerateRequest): Promise<GenerateResult>;
}
