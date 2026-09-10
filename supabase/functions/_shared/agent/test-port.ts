// A RECORDING TEST DOUBLE for every port in `port.ts`.
//
// WHY A RECORDER AND NOT A STUB, because it is the difference between the tests in this
// directory proving something and proving nothing: almost every rule the agent runtime
// has to obey is a rule about the ORDER and PRESENCE of calls, not about a return value.
//
//   - "check the kill switch FIRST"        → a claim must not appear before a settings read
//   - "sweep before claim"                 → an ordering
//   - "call canTransition before a write"  → the ABSENCE of a write
//   - "release the claim when keys cool"   → the PRESENCE of a release
//
// A stub that only returns values cannot witness any of those. So this double appends
// every call to `calls`, and the tests assert against that transcript.
//
// It lives in a plain `.ts` file rather than inside a `_test.ts` so all five agents'
// suites share one double. A second, divergent double is how two suites end up agreeing
// with each other and disagreeing with production.

// Every port this double satisfies, plus the row and outcome shapes they exchange.
import type {
  ApplicationPatch,
  GeminiPort,
  GenerateRequest,
  GenerateResult,
  JobPort,
  MasterPort,
  MasterSnapshot,
  PortResult,
  QueuePort,
  RunOutcome,
  RunPort,
  ScreenPort,
  SettingsSnapshot,
  SweepCounts,
} from "./port.ts";
// Row and enum shapes from the schema owner. Never redefined, even in a test double —
// a double that drifts from the real row shape tests the double.
import type {
  AgentName,
  AgentRunStatus,
  ApplicationRow,
  ApplicationStatus,
  FilterRuleRow,
  JobRow,
} from "../contracts/shared-types.ts";

// One recorded interaction.
export interface RecordedCall {
  // The port method's name, which is what ordering assertions compare.
  readonly name: string;
  // Its arguments, so a test can assert WHICH row was released and with what reason.
  readonly args: readonly unknown[];
}

// What the double should answer with. Every field optional: a test configures only the
// answers its own scenario depends on, so an unrelated schema change touches one place.
export interface FakePortOptions {
  // The settings row, or `null` to simulate an account that was never bootstrapped.
  readonly settings?: SettingsSnapshot | null;
  // Force `readSettings` to fail, to prove the kill switch fails CLOSED on an
  // unreadable control panel rather than assuming "no objection".
  readonly settingsError?: string;
  // Rows to hand back per claimed status, so a stage can be driven with a real batch.
  readonly claims?: Readonly<Record<string, readonly ApplicationRow[]>>;
  // Force the claim itself to fail.
  readonly claimError?: string;
  // What the sweeper reports.
  readonly sweep?: SweepCounts;
  // Force `openRun` to fail, to prove losing the run row does not lose the work.
  readonly openRunError?: string;
  // Force a status write to fail, to prove a failed advance is counted rather than lost.
  readonly advanceError?: string;
  // Jobs behind the claimed applications, keyed by id.
  readonly jobs?: readonly JobRow[];
  // Fingerprint → existing job id, for the Normalizer's duplicate lookup.
  readonly fingerprintOwners?: Readonly<Record<string, string>>;
  // The cascade's rules.
  readonly filterRules?: readonly FilterRuleRow[];
  // Screening context.
  readonly blockedCompanySlugs?: readonly string[];
  readonly appliedFingerprints?: readonly string[];
  readonly weeklyCounts?: Readonly<Record<string, number>>;
  // Master profiles by version, plus which version is latest.
  readonly masters?: readonly MasterSnapshot[];
  // Queued Gemini answers, consumed in order — one per `generate` call, so a test can
  // make the second call fail while the first succeeds.
  readonly generateResults?: readonly GenerateResult[];
}

// The double: every port at once, plus the transcript.
export interface FakePort extends RunPort, QueuePort, JobPort, ScreenPort, MasterPort, GeminiPort {
  // The transcript, in call order.
  readonly calls: RecordedCall[];
  // Just the method names, which is what most ordering assertions want.
  names(): readonly string[];
  // Every recorded call to one method, for asserting arguments.
  callsTo(name: string): readonly RecordedCall[];
  // The requests handed to `generate`, so a test can assert the fence is intact.
  readonly generateRequests: GenerateRequest[];
  // The run outcome `closeRun` was given, which is what the health page would show.
  readonly closed: RunOutcome[];
}

// Build a double. A factory rather than a class because `erasableSyntaxOnly` forbids
// constructor parameter properties, and a closure over `calls` is simpler anyway.
export function makeFakePort(options: FakePortOptions = {}): FakePort {
  // The transcript.
  const calls: RecordedCall[] = [];
  // Prompts, kept separately so injection assertions do not have to dig through args.
  const generateRequests: GenerateRequest[] = [];
  // Run closures, for asserting the health-page record.
  const closed: RunOutcome[] = [];
  // A cursor into `generateResults`, so consecutive calls get consecutive answers.
  let generateCursor = 0;

  // Record one call and return whatever the scenario configured.
  function record(name: string, ...args: readonly unknown[]): void {
    // Appended rather than counted, because ordering is the property under test.
    calls.push({ name, args });
  }

  return {
    // ---- RunPort ------------------------------------------------------------------
    // The kill switch read. Every agent's first call, and the tests assert exactly that.
    readSettings(): Promise<PortResult<SettingsSnapshot | null>> {
      // Transcript first, so a failure path is still recorded.
      record("readSettings");
      // A configured failure proves the fail-closed path.
      if (options.settingsError !== undefined) {
        return Promise.resolve({ ok: false, reason: options.settingsError });
      }
      // `undefined` in the options means "not configured"; `null` means "no row exists",
      // and those are deliberately different answers.
      return Promise.resolve({ ok: true, value: options.settings ?? null });
    },
    // Opening the run row.
    openRun(agent: AgentName, status?: AgentRunStatus): Promise<PortResult<string | null>> {
      // Both arguments are asserted: the health page's value depends on the status.
      record("openRun", agent, status);
      // A failed insert must not stop the work.
      if (options.openRunError !== undefined) {
        return Promise.resolve({ ok: false, reason: options.openRunError });
      }
      // A stable fake id, so `claimed_by` assertions can be exact.
      return Promise.resolve({ ok: true, value: "run-1" });
    },
    // Closing it out.
    closeRun(runId: string | null, outcome: RunOutcome): Promise<PortResult<void>> {
      // Recorded twice on purpose — once in the transcript for ordering, once in
      // `closed` so outcome assertions do not need to cast an `unknown` argument.
      record("closeRun", runId, outcome);
      // Kept for direct inspection.
      closed.push(outcome);
      // Closing never fails in the double; a failure here would only hide the outcome.
      return Promise.resolve({ ok: true, value: undefined });
    },
    // The lease reclaimer.
    sweepStaleClaims(): Promise<PortResult<SweepCounts>> {
      // Ordering matters: it must appear before the claim.
      record("sweepStaleClaims");
      // Zeroes are the ordinary answer on a healthy queue.
      return Promise.resolve({
        ok: true,
        value: options.sweep ?? { releasedCount: 0, needsVerificationCount: 0 },
      });
    },

    // ---- QueuePort ----------------------------------------------------------------
    // Claiming a bounded batch.
    claimApplications(
      status: ApplicationStatus,
      claimedBy: string,
      limit: number,
    ): Promise<PortResult<readonly ApplicationRow[]>> {
      // `limit` is asserted against the batch table, and `claimedBy` against §6's
      // `agent:runId` convention.
      record("claimApplications", status, claimedBy, limit);
      // A configured failure proves the run is closed as failed rather than silently.
      if (options.claimError !== undefined) {
        return Promise.resolve({ ok: false, reason: options.claimError });
      }
      // Rows for this status, honouring the limit so a test cannot accidentally assert
      // against more rows than the batch size would really have returned.
      const rows = options.claims?.[status] ?? [];
      // Truncated exactly as `claim_applications`' own `limit` would.
      return Promise.resolve({ ok: true, value: rows.slice(0, limit) });
    },
    // Moving a row.
    advanceStatus(
      applicationId: string,
      toStatus: ApplicationStatus,
      agent: AgentName,
      detail?: Record<string, unknown>,
    ): Promise<PortResult<void>> {
      // THE CALL THE TRANSITION GUARD TESTS ASSERT THE ABSENCE OF. An illegal edge must
      // never reach this method — failing fast in TypeScript is the whole point.
      record("advanceStatus", applicationId, toStatus, agent, detail);
      // A configured failure simulates the trigger refusing the write.
      if (options.advanceError !== undefined) {
        return Promise.resolve({ ok: false, reason: options.advanceError });
      }
      // Moved.
      return Promise.resolve({ ok: true, value: undefined });
    },
    // Giving a row back untouched.
    releaseClaim(applicationId: string, agent: AgentName, reason: string): Promise<PortResult<void>> {
      // The presence of this call is the quota-exhaustion assertion.
      record("releaseClaim", applicationId, agent, reason);
      // Always succeeds; a failure would only obscure the property being tested.
      return Promise.resolve({ ok: true, value: undefined });
    },
    // Writing non-status columns.
    patchApplication(applicationId: string, patch: ApplicationPatch): Promise<PortResult<void>> {
      // Asserted so a test can prove the score, the refs and the findings were stored.
      record("patchApplication", applicationId, patch);
      // Stored.
      return Promise.resolve({ ok: true, value: undefined });
    },

    // ---- JobPort ------------------------------------------------------------------
    // The postings behind a batch.
    loadJobs(jobIds: readonly string[]): Promise<PortResult<readonly JobRow[]>> {
      // Recorded so "one round trip, not N" is assertable.
      record("loadJobs", jobIds);
      // Only the requested ids, so a stage cannot accidentally read a job it did not ask
      // for and pass a test that production would fail.
      const wanted = new Set(jobIds);
      // Filtered from the configured set.
      return Promise.resolve({ ok: true, value: (options.jobs ?? []).filter((job) => wanted.has(job.id)) });
    },
    // The duplicate lookup.
    findJobIdByFingerprint(fingerprint: string): Promise<PortResult<string | null>> {
      // Recorded so the Normalizer's "look before you write" order is assertable.
      record("findJobIdByFingerprint", fingerprint);
      // A configured owner means a genuine duplicate; absence means the key is new.
      return Promise.resolve({ ok: true, value: options.fingerprintOwners?.[fingerprint] ?? null });
    },
    // Writing the canonical key back.
    patchJobFingerprint(jobId: string, fingerprint: string): Promise<PortResult<void>> {
      // Recorded so a test can prove the canonical key reached the database.
      record("patchJobFingerprint", jobId, fingerprint);
      // Written.
      return Promise.resolve({ ok: true, value: undefined });
    },

    // ---- ScreenPort ---------------------------------------------------------------
    // The cascade's rules.
    loadFilterRules(): Promise<PortResult<readonly FilterRuleRow[]>> {
      // Recorded, because a Screener that never read its rules would otherwise pass.
      record("loadFilterRules");
      // An empty rule set is a legitimate configuration — everything passes.
      return Promise.resolve({ ok: true, value: options.filterRules ?? [] });
    },
    // Blocked companies.
    loadBlockedCompanySlugs(): Promise<PortResult<ReadonlySet<string>>> {
      // Recorded for completeness of the transcript.
      record("loadBlockedCompanySlugs");
      // Wrapped in a Set, exactly as the real adapter does.
      return Promise.resolve({ ok: true, value: new Set(options.blockedCompanySlugs ?? []) });
    },
    // Already-applied fingerprints.
    loadAppliedFingerprints(): Promise<PortResult<ReadonlySet<string>>> {
      // Recorded.
      record("loadAppliedFingerprints");
      // Same wrapping.
      return Promise.resolve({ ok: true, value: new Set(options.appliedFingerprints ?? []) });
    },
    // The per-company weekly counts behind §18.5's cap.
    loadWeeklyApplicationCounts(): Promise<PortResult<ReadonlyMap<string, number>>> {
      // Recorded.
      record("loadWeeklyApplicationCounts");
      // Converted to a Map, exactly as the real adapter does.
      return Promise.resolve({ ok: true, value: new Map(Object.entries(options.weeklyCounts ?? {})) });
    },

    // ---- MasterPort ---------------------------------------------------------------
    // The newest profile, for a fresh tailoring.
    loadLatestMaster(): Promise<PortResult<MasterSnapshot | null>> {
      // Recorded so "the Tailor pinned a version" is assertable.
      record("loadLatestMaster");
      // Highest version wins, mirroring `order by version desc limit 1`.
      const sorted = [...(options.masters ?? [])].sort((left, right) => right.version - left.version);
      // `null` when no master exists at all, which must block tailoring rather than
      // produce a resume from nothing.
      return Promise.resolve({ ok: true, value: sorted[0] ?? null });
    },
    // A specific pinned version, for auditing.
    loadMasterVersion(version: number): Promise<PortResult<MasterSnapshot | null>> {
      // Recorded WITH the version, because auditing against the latest instead of the
      // pin is exactly the bug this method exists to make visible.
      record("loadMasterVersion", version);
      // Exact match only.
      return Promise.resolve({
        ok: true,
        value: (options.masters ?? []).find((master) => master.version === version) ?? null,
      });
    },

    // ---- GeminiPort ---------------------------------------------------------------
    // The one route to a model.
    generate(request: GenerateRequest): Promise<GenerateResult> {
      // Recorded in the transcript for ordering...
      record("generate");
      // ...and kept in full so injection tests can inspect the assembled prompt.
      generateRequests.push(request);
      // Consumed in order, so a test can make the third call cool while the first two
      // succeed — the shape a real quota exhaustion actually has.
      const next = options.generateResults?.[generateCursor];
      // Advance regardless, so a missing entry is a distinct failure rather than a
      // silently repeated answer.
      generateCursor += 1;
      // An unconfigured call is a test bug, and saying so beats a confusing assertion
      // failure three layers away.
      if (next === undefined) {
        return Promise.resolve({ ok: false, reason: "call_failed", detail: "no fake generate result configured" });
      }
      // The configured answer.
      return Promise.resolve(next);
    },

    // ---- inspection ---------------------------------------------------------------
    // The transcript itself.
    calls,
    // Method names in order.
    names(): readonly string[] {
      return calls.map((call) => call.name);
    },
    // Every call to one method.
    callsTo(name: string): readonly RecordedCall[] {
      return calls.filter((call) => call.name === name);
    },
    // Assembled prompts.
    generateRequests,
    // Run outcomes.
    closed,
  };
}
