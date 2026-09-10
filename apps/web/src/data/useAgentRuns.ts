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
 * stream's file to write, not this one's. 200 comfortably covers the newest run
 * of every agent even when the busiest one has run many times today, and the
 * page is honest about the window in the note it renders. */
export const RUN_WINDOW = 200;

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
  const [rows, setRows] = useState<readonly AgentRunFacts[] | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  /* Captured when the rows arrive rather than read at render time. Ages must be
     measured against a fixed instant: recomputing `Date.now()` on every render
     would make an age creep upward while the page sits open, which looks like
     live data and is not - the underlying read is minutes old. */
  const [measuredAt, setMeasuredAt] = useState<number | null>(null);

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

        /* FOUR COLUMNS, which is every column this panel reads and no more.
           A `select('*')` here would pull counters and a `user_id` into the
           browser to be discarded, and the narrowest projection that answers
           the question is the one that cannot leak a column somebody later adds
           to this table. */
        const { data, error: queryError } = await supabase
          .from('agent_runs')
          .select('agent, status, started_at, finished_at')
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
        setRows(data as readonly AgentRunFacts[] | null);
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
        )
      : [];

  return { state, freshness, measuredAt };
}
