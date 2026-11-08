/* Read `agent_runs` so the health page can report how long each agent has been
 * silent.
 *
 * WHY THIS TABLE IS THE RIGHT ONE TO WIRE FIRST, and it is a deliberate
 * ordering rather than convenience. `agent_runs` carries no personal content at
 * all: an agent name, an outcome, two timestamps and a handful of counters.
 * There is no resume, no job description, no answer bank, no CTC. So the worst
 * case if the read is wrong is a misleading age on one panel - whereas the
 * approval queue renders tailored resume content, which is the
 * highest-consequence thing this console displays. Build the read path on the
 * table whose failure costs least, prove the pattern, then move up.
 *
 * WHAT THIS READ IS AND IS NOT EVIDENCE OF. It is evidence that the database
 * answered. It is NOT evidence that it answered with the right rows: the RLS
 * policies in this project are confirmed to EXIST but have never been exercised
 * as `authenticated` - every verifying query so far ran as `postgres`, which
 * holds BYPASSRLS, so a policy with an inverted predicate would look identical
 * when listed in `pg_policies`. The connection panel states that caveat where
 * the operator will see it, and it stays stated until row scoping is proven
 * under a real session.
 *
 * AND THERE IS NO AUTH USER YET, so today this hook legitimately reports
 * `no_session` and no rows. That is CORRECT BEHAVIOUR, not a bug, and it is
 * emphatically not a reason to reach for a service-role key - `supabase.ts`
 * throws at import time on any key whose JWT role claim is not "anon", and it
 * is right to.
 *
 * THE SHAPE OF THIS FILE IS COPIED FROM `useApplicationCounts.ts` ON PURPOSE.
 * Side effects here, decisions in a pure module: this file performs the network
 * call, the session lookup and the React state, then hands raw facts to
 * `classifyRead` and the rows to `summarizeAgentRuns`. Both of those are pure
 * and have a test per branch, including branches that are hard or impossible to
 * produce against a live database - a nine-day silence, a clock skewed into the
 * future, a session that vanishes mid-flight.
 *
 * READ-ONLY, DELIBERATELY. Nothing in this file writes anything. It cannot
 * advance a status, and in particular it is nowhere near
 * `awaiting_approval -> approved`, which is `allowedAgents: ['human']` and the
 * only door into the submit path (constraint #15).
 */

import { useEffect, useState } from 'react';

import { supabase, supabaseStatus } from './supabase.ts';
import { classifyRead } from './readState.ts';
import type { ReadState } from './readState.ts';
import { summarizeAgentRuns } from './agentFreshness.ts';
import type { AgentFreshness, AgentRunFacts } from './agentFreshness.ts';
/* The roster the table shows (AGENT_NAMES minus `human`), so the per-agent lookups
   (W9) check exactly those agents and spend no reads on an identity that never runs. */
import { HEALTH_ROSTER } from './agentFreshness.ts';
import type { AgentName } from './contract.ts';
/* Picks which run's error_detail answers "which rules were skipped". */
import { pickRuleWarningRun } from './ruleWarnings.ts';

/* How many run rows to pull.
 *
 * A CAP RATHER THAN EVERYTHING, because `agent_runs` grows with every tick of
 * every agent forever - roughly a dozen agents on daily-or-tighter schedules is
 * thousands of rows a year, and this panel only ever needs the newest run per
 * agent. Ordered newest-first and capped, so the rows that answer the question
 * are guaranteed to be in the window.
 *
 * WHY NOT `.limit(1)` PER AGENT: that is twelve round trips on a free tier to
 * answer one question. And why not a `DISTINCT ON` view: that is the schema
 * stream's file to write, not this one's.
 *
 * CORRECTED 2026-11-01 (wiring audit W9). This comment used to say 200 always
 * covers the newest run of every agent and that the page renders a note about
 * the window. Neither was true: live, tracker (170 rows) and scout_ats (177)
 * filled the window, the screener's newest run sat at rank 253, and no window
 * note was ever rendered. So the window still answers the busy agents in one
 * trip, and `readNewestBeyondWindow` below looks up only what it missed: the
 * newest run of each agent outside it, and the newest success of each agent
 * with none in hand (code-review finding #4). */
export const RUN_WINDOW = 200;

/* SEVEN COLUMNS, which is every column this page reads and no more.
   `error_count` is the one counter admitted: pipeline agents mark a run
   `succeeded` when any row succeeded, so Health needs it to say "succeeded with
   N errors". `error_detail` is admitted (2026-10-08) because it is the only
   carrier of the screener's "rule skipped" warnings (`withRuleWarnings`,
   supabase/functions/_shared/screen/run-summary.ts) - without it the operator
   sees a run that dropped every row and no reason. It is free text written by
   our own agents, never user content, and the page renders it only through
   `parseRuleWarnings`. `rows_in` is admitted with it, because a run that
   screened nothing (an empty queue is normal) has a clean detail that says
   nothing about rules - only a closed run with rows_in > 0 may stand for "the
   warnings went away" (`pickRuleWarningRun`). Still no `select('*')` and no
   `user_id` - the narrowest projection that answers the question cannot leak a
   column somebody later adds to this table. Exported so a test can assert the
   list rather than trust this comment. */
export const AGENT_RUN_COLUMNS =
  'agent, status, started_at, finished_at, error_count, error_detail, rows_in';

/* One `agent_runs` row as this read returns it. Extends the freshness module's
   facts rather than editing them, because that module needs only the timing
   columns and owns its own type. `unknown`-safe: optional so a fixture or an
   older row without the column still type-checks, and the page never trusts it
   without `parseRuleWarnings`. */
export interface AgentRunRow extends AgentRunFacts {
  /* The run's failure summary and/or `rule_warnings:` segment; null on a clean run. */
  readonly error_detail?: string | null;
  /* Rows the run took in; `not null default 0` in the schema, optional here
     for fixtures. Validated at use, never trusted. */
  readonly rows_in?: number | null;
}

/* The newest run of each roster agent the window MISSED, one agent at a time.
 *
 * WHY (2026-11-01, wiring audit W9). The window is the newest RUN_WINDOW rows
 * across ALL agents, so busy agents push quiet ones out of it, and an agent
 * outside it used to be summarised from zero rows as "has never run". Here each
 * missing agent gets its own `.limit(1)` read, all in parallel. Only an agent
 * whose lookup answers with zero rows has truly never run.
 *
 * Every missing agent is looked up, even when the window came back short of
 * the cap. A short window should mean "that is every row", but a server-side
 * row cap would make it look the same, and trusting that would be the fail-open
 * this fix removes. The cost is a few empty reads on a young table.
 *
 * A lookup that returns an error or throws puts the agent in `failed`, never in
 * "no rows": a failed read is not evidence of absence (CLAUDE.md section 6).
 *
 * THE LAST SUCCESS TOO (2026-11-01, code-review finding #4). The freshness
 * table derives "last success" from the rows in hand. With only the newest run
 * in hand, an agent whose newest run failed read "never once succeeded" though
 * it succeeded hours earlier. So every agent with no `succeeded` row in hand -
 * outside the window, or inside it with only failures there - also gets its
 * newest success read. If either read for an agent fails, none of its lookup
 * rows are kept: a newest run without its success would pose as the whole story.
 *
 * ONE READ FIRST, PER-AGENT ONLY FOR WHAT IT LEAVES OPEN (2026-11-08). The
 * per-agent reads cost up to two requests per roster agent (35 on one Health
 * load with an empty window, at 0.3-0.5 s each from India to Sydney). So the
 * agents still owed an answer are first read together in ONE request
 * (`readOwedAgents`). That read answers an agent's question when it holds a
 * matching row, and answers "none" only when it PROVES it returned every
 * matching row (row count equals the exact count). Anything it leaves open
 * falls back to the per-agent read below, so a bounded read never turns
 * "not in this page" into "never ran" (CLAUDE.md section 6).
 *
 * Exported so a unit test can drive it with a fake client. */
export async function readNewestBeyondWindow(
  /* The configured client; the caller has already ruled out null. */
  client: NonNullable<typeof supabase>,
  /* The window's rows, to know which agents it already covers. */
  windowRows: readonly AgentRunRow[],
): Promise<{ rows: AgentRunRow[]; failed: Set<AgentName> }> {
  // Runs found beyond the window, at most two per agent (newest, newest success).
  const rows: AgentRunRow[] = [];
  // Agents whose lookup could not answer.
  const failed = new Set<AgentName>();
  // The agents the window already covers need no newest-run read.
  const seen = new Set(windowRows.map((row) => row.agent));
  // The agents with a success in hand need no success read.
  const succeeded = new Set(windowRows.filter((row) => row.status === 'succeeded').map((row) => row.agent));
  // Owed = no success in hand; a seen-set agent without one is owed too (seen is a superset of succeeded).
  const owed = HEALTH_ROSTER.filter((agent) => !succeeded.has(agent));
  // The window covers every agent: no further request at all.
  if (owed.length === 0) return { rows, failed };
  // One request for every owed agent; what it settles needs no per-agent read.
  const bulk = await readOwedAgents(client, owed);
  // Every owed agent, all at once; only questions the bulk read left open make a read.
  await Promise.all(
    // The owed list drives this; it is the roster minus agents the window fully answers.
    owed.map(async (agent) => {
      // Both questions in parallel; null where the window already answers that question.
      const [newest, success] = await Promise.all([
        // Its newest run of any outcome, only when the window missed it; the bulk answer if it has one.
        seen.has(agent) ? null : (bulk.newest.get(agent) ?? readNewestRun(client, agent, false)),
        // Its newest success (none in hand by construction); the bulk answer if it has one.
        bulk.success.get(agent) ?? readNewestRun(client, agent, true),
      ]);
      // Either read failing makes the agent unknown, and drops both (see above).
      if (newest?.ok === false || success?.ok === false) {
        // Unknown, not absent.
        failed.add(agent);
        // Nothing to add for this agent.
        return;
      }
      // Zero rows is a real answer (never ran); one row is its newest run.
      if (newest?.row) rows.push(newest.row);
      // A newest run that succeeded IS the newest success, so it is not added twice.
      if (success?.row && newest?.row?.status !== 'succeeded') rows.push(success.row);
    }),
  );
  // Both halves together, so the caller sets them from one result.
  return { rows, failed };
}

/* One lookup's closed result: `ok: false` for a read that could not answer,
 * else the row or null for none. A closed union rather than null-vs-undefined,
 * so "failed" and "no rows" can never be confused by a truthiness check
 * (CLAUDE.md section 6). Named because the bulk read and the per-agent read
 * both produce it. */
type RunLookup = { ok: true; row: AgentRunRow | null } | { ok: false };

/* The owed agents' answers from ONE request, keyed by agent; an agent ABSENT
 * from a map is an open question the caller must still read on its own.
 *
 * WHY IT CAN SAY "NONE" AT ALL: an agent with no row in this page has no row at
 * all only if the page is every matching row. That is proven, not assumed: the
 * request asks for the exact count, and only `rows === count` closes the
 * absent agents as `row: null`. A short page is NOT proof (a server-side row
 * cap looks the same), and a failed or thrown read settles nothing, so every
 * question falls back to the per-agent read rather than to "never ran".
 *
 * ponytail: one page of RUN_WINDOW rows across the owed agents; an owed agent
 * that fails every tick can fill that page and push the others back to
 * per-agent reads (correct, just slower). Narrow the filter to
 * "succeeded OR unseen agent" if that is ever measured. */
async function readOwedAgents(
  /* The configured client, as above. */
  client: NonNullable<typeof supabase>,
  /* The agents with no success in the window; never empty (the caller returns first). */
  owed: readonly AgentName[],
): Promise<{ newest: Map<AgentName, RunLookup>; success: Map<AgentName, RunLookup> }> {
  // Settled newest-run answers; absent = still open.
  const newest = new Map<AgentName, RunLookup>();
  // Settled newest-success answers; absent = still open.
  const success = new Map<AgentName, RunLookup>();
  try {
    // Same columns as the window, owed agents only, with the exact count that can prove completeness.
    const { data, error, count } = await client
      // The same table as the window.
      .from('agent_runs')
      // Exact count so "every matching row is in hand" is measured, never inferred from a short page.
      .select(AGENT_RUN_COLUMNS, { count: 'exact' })
      // Only the agents still owed an answer; the window's busy agents cannot crowd them out.
      .in('agent', [...owed])
      // Newest first, so the first row per agent is its newest (same crashed-run reason as the window).
      .order('started_at', { ascending: false })
      // Bounded like the window; the count check below decides whether that bound hid anything.
      .limit(RUN_WINDOW);
    // supabase-js reports failures as { error }; leave every question open for the per-agent read.
    if (error !== null || !Array.isArray(data)) return { newest, success };
    // Newest-first rows: the first row seen per agent is its newest, the first success its newest success.
    for (const row of data as AgentRunRow[]) {
      // First row for this agent is its newest run.
      if (!newest.has(row.agent)) newest.set(row.agent, { ok: true, row });
      // First succeeded row for this agent is its newest success.
      if (row.status === 'succeeded' && !success.has(row.agent)) success.set(row.agent, { ok: true, row });
    }
    // Only a proven-complete page may close the remaining questions as "none".
    if (typeof count === 'number' && data.length === count) {
      // Each owed agent the page did not answer truly has no such row.
      for (const agent of owed) {
        // No row at all: it never ran.
        if (!newest.has(agent)) newest.set(agent, { ok: true, row: null });
        // No succeeded row: it never succeeded.
        if (!success.has(agent)) success.set(agent, { ok: true, row: null });
      }
    }
  } catch {
    // A thrown network failure settles nothing; the per-agent reads still run.
  }
  // Whatever was settled; the caller reads the rest per agent.
  return { newest, success };
}

/* One agent's newest run, or its newest SUCCEEDED run, as a `RunLookup`.
 * Now the fallback for questions the bulk read left open. */
async function readNewestRun(
  /* The configured client, as above. */
  client: NonNullable<typeof supabase>,
  /* The roster agent to read. */
  agent: AgentName,
  /* True to read the newest `succeeded` run instead of the newest of any outcome. */
  onlySucceeded: boolean,
): Promise<RunLookup> {
  try {
    // Same columns as the window, for one agent only.
    let query = client.from('agent_runs').select(AGENT_RUN_COLUMNS).eq('agent', agent);
    // The success clock reads successes only, so a newer failure cannot hide it.
    if (onlySucceeded) query = query.eq('status', 'succeeded');
    // Newest first, for the same crashed-run reason as the window; one row answers.
    const { data, error } = await query.order('started_at', { ascending: false }).limit(1);
    // supabase-js reports failures as { error }; an array is the only answer shape.
    if (error !== null || !Array.isArray(data)) return { ok: false };
    // Zero rows is a real answer; one row is the newest.
    return { ok: true, row: (data[0] as AgentRunRow | undefined) ?? null };
  } catch {
    // A thrown network failure is unknown, the same as a returned error.
    return { ok: false };
  }
}

export interface AgentRunsRead {
  /* The classified read. A caller cannot reach rows without having handled
     every not-an-answer case first - the compiler enforces the honesty. */
  readonly state: ReadState<AgentRunFacts>;
  /* One entry per agent in roster order, ALWAYS the full roster.
   *
   * Present even when the read returned nothing, and that is the important
   * part: an empty `agent_runs` table is a real, conclusive answer meaning
   * "nothing has ever run", and the honest rendering of it is twelve rows
   * saying "has never run" rather than a blank panel. It is empty only when the
   * read was NOT conclusive - unconfigured, no session, failed, still loading -
   * because in those cases the console genuinely does not know, and claiming
   * "never run" would be a fabrication rather than a measurement. */
  readonly freshness: readonly AgentFreshness[];
  /* The instant the ages were measured against, so the panel can show it. An
     age with no "as of" is unfalsifiable: the operator cannot tell a nine-day
     silence from a nine-day-old page. */
  readonly measuredAt: number | null;
  /* Per agent, the run whose error_detail says which rules it skipped: the
     newest CLOSED run that took in rows (`pickRuleWarningRun`). NOT simply the
     latest run - an idle or still-open run is newer and says nothing about
     rules. Absent for an agent with no such run, and empty whenever the read
     was not conclusive, for the same reason `freshness` is. */
  readonly ruleWarningRuns: ReadonlyMap<string, AgentRunRow>;
}

export function useAgentRuns(): AgentRunsRead {
  /* Raw facts, accumulated by the effect and handed to the pure classifier on
     every render. Held separately from the classified state so classification
     is never stale relative to the facts it was computed from. */
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /* NULL, NOT []. Null means no successful read has completed; `[]` would claim
     the database was asked and answered nothing. That distinction is the whole
     reason `readState.ts` exists. */
  /* Typed as the full row, so `error_detail` rides through to the page. */
  const [rows, setRows] = useState<readonly AgentRunRow[] | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  /* Captured when the rows arrive rather than read at render time. Ages must be
     measured against a fixed instant: recomputing `Date.now()` on every render
     would make an age creep upward while the page sits open, which looks like
     live data and is not - the underlying read is minutes old. */
  const [measuredAt, setMeasuredAt] = useState<number | null>(null);
  /* Agents whose own newest-run or newest-success lookup failed (W9, #4). Empty
     until the lookups settle; summarised as `lookup_failed`, never as "never
     run" or "never succeeded". */
  const [lookupFailed, setLookupFailed] = useState<ReadonlySet<AgentName>>(new Set());

  useEffect(() => {
    /* No client at all: the console is unconfigured, which the classifier
       reports without any query being attempted. */
    if (supabase === null) {
      setLoading(false);
      return;
    }

    /* Guards against setting state after unmount, and also against a slow
       first request overwriting a faster second one. Flipped in the cleanup. */
    let live = true;

    void (async () => {
      try {
        /* SESSION FIRST. With no session, RLS has nothing to scope to and the
           query correctly returns nothing - and reporting that as "no agent has
           ever run" would be the exact lie this layer exists to prevent, made
           worse here because it is indistinguishable from the real failure the
           page is watching for. */
        const { data: sessionData } = await supabase.auth.getSession();
        if (!live) return;

        const hasSession = sessionData.session !== null;
        setSignedIn(hasSession);

        /* The branch that actually runs today: there is no Auth user in this
           system yet. Not an error, and specifically not empty. */
        if (!hasSession) {
          setLoading(false);
          return;
        }

        /* The explicit column list, defined once above with its reasons. */
        const { data, error: queryError } = await supabase
          .from('agent_runs')
          .select(AGENT_RUN_COLUMNS)
          /* Newest first, so the cap below keeps the rows that matter. Ordering
             on `started_at` rather than `finished_at` because a crashed run has
             no `finished_at` at all and must not sort to the bottom - a run
             that opened and never closed is precisely the evidence of a mid-run
             death that the stuck-run check is looking for. */
          .order('started_at', { ascending: false })
          .limit(RUN_WINDOW);

        if (!live) return;

        if (queryError !== null) {
          /* The database's own message, passed through unedited. Supabase
             reports an RLS refusal distinctly from a network failure, and that
             difference is exactly what somebody debugging needs. */
          setError(queryError.message);
          setLoading(false);
          return;
        }

        /* Null with no error should not happen. Treating it as `[]` would
           manufacture a positive "nothing has ever run" answer out of a state
           we do not understand - so it stays null and classifies as still
           loading rather than as a conclusive empty. */
        const windowRows = data as readonly AgentRunRow[] | null;
        /* W9: the agents the window missed, each read on its own. Skipped for
           a null window, which stays "still loading" as explained above.
           Since 2026-11-08 they are read together in one request first, and
           on their own only where that request could not settle them. */
        const beyond =
          windowRows === null ? null : await readNewestBeyondWindow(supabase, windowRows);
        // The lookups were awaited; the component may have unmounted meanwhile.
        if (!live) return;
        // Window rows plus the newest run of each agent it missed.
        setRows(beyond === null ? windowRows : [...(windowRows ?? []), ...beyond.rows]);
        // Set with the rows, so no render pairs new rows with old failures.
        setLookupFailed(beyond === null ? new Set() : beyond.failed);
        /* Stamped at the same moment as the rows, so the ages on screen and the
           "as of" label can never disagree. */
        setMeasuredAt(Date.now());
        setLoading(false);
      } catch (thrown) {
        if (!live) return;
        /* A thrown error rather than a returned one - DNS failure, aborted
           request. Same destination: reported as a failed read, never as an
           empty one. */
        setError(
          thrown instanceof Error ? thrown.message : 'unknown read error',
        );
        setLoading(false);
      }
    })();

    return () => {
      live = false;
    };
  }, []);

  /* Classified on every render from the current facts, by the pure function
     that has a test for each branch. */
  const state = classifyRead<AgentRunFacts>({
    clientPresent: supabase !== null,
    missingEnv: supabaseStatus.connected ? [] : supabaseStatus.missing,
    signedIn,
    loading,
    error,
    rows,
  });

  /* SUMMARISE ONLY FROM A CONCLUSIVE READ, and note that `empty` counts as
     conclusive. This is the one place in the console where an empty result is
     genuinely informative: the roster is known independently of the rows, so
     zero rows means every agent reports "has never run", which is a true and
     alarming statement rather than a fabricated zero.
     Any other state yields an empty array, and the panel renders the read
     state's own phrase in place of ages - never a number, never "just now". */
  const conclusive = state.kind === 'rows' || state.kind === 'empty';
  const freshness =
    conclusive && measuredAt !== null
      ? summarizeAgentRuns(
          state.kind === 'rows' ? state.rows : [],
          measuredAt,
          /* W9: a failed lookup must read as unknown, never as "never run". */
          lookupFailed,
        )
      : [];

  /* Built from the same conclusive read, from the typed rows (which carry
     error_detail and rows_in), keyed by the roster the freshness entries use. */
  const ruleWarningRuns = new Map<string, AgentRunRow>();
  // Only a conclusive read can name a run; otherwise the map stays empty.
  if (state.kind === 'rows' && rows !== null) {
    // One lookup per roster agent; the read is capped, so this is cheap.
    for (const entry of freshness) {
      // The newest closed run that screened rows, or null when there is none.
      const run = pickRuleWarningRun(rows, entry.agent);
      // Absent rather than null in the map, so `.get()` has one "none" value.
      if (run !== null) ruleWarningRuns.set(entry.agent, run);
    }
  }

  return { state, freshness, measuredAt, ruleWarningRuns };
}
