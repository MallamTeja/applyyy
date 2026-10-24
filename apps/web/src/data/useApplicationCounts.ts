/* How many applications sit in each status, read from the database.
 *
 * THE FIRST REAL READ IN THIS CONSOLE, and it is deliberately the least
 * dangerous one available: counts per status. No row content reaches the screen,
 * so nothing untrusted is rendered, nothing personal is displayed, and a wrong
 * answer misleads about volume rather than about the content of an application.
 * Starting the read path with the query whose failure costs least.
 *
 * WHY IT DOES NOT TRUST ITS OWN RESULTS YET, and this is not caution for its
 * own sake. The RLS policies in this project are confirmed to EXIST but have
 * never been exercised as `authenticated` - every verifying query so far ran as
 * `postgres`, which holds BYPASSRLS. A policy with an inverted predicate would
 * look identical when listed in `pg_policies`. So a number coming back from
 * here is evidence that the database answered, and is NOT yet evidence that it
 * answered with the right rows. `readState.ts` draws exactly that line, and the
 * connection panel on System health states the caveat where the operator will
 * see it.
 *
 * WHY THE CLASSIFICATION IS NOT DONE HERE. This module does the side effects -
 * a network call, a session lookup, React state - and hands the raw facts to
 * `classifyRead`. Same seam as everywhere else in this package: the decision
 * about what an empty result MEANS is pure and tested against every branch,
 * including ones that are hard to produce against a live database, like a
 * session disappearing mid-flight.
 *
 * READ-ONLY, DELIBERATELY. Nothing in this file writes, and nothing in it can
 * advance a status. `awaiting_approval -> approved` is `allowedAgents:
 * ['human']` and is the only door into the submit path; a counting hook has no
 * business anywhere near it.
 */

import { useCallback, useEffect, useState } from 'react';

import { supabase, supabaseStatus } from './supabase.ts';
import { classifyRead } from './readState.ts';
import type { ReadState } from './readState.ts';
import type { ApplicationStatus } from './contract';
// The RPC's shape check, kept in its own module so node --test can reach it without the client.
import { parseStatusCountRows } from './statusCounts.ts';
// One validated row of the RPC: a status and its server-side count.
import type { StatusCountRow } from './statusCounts.ts';

/* Counts keyed by status. Partial because a status with no rows is ABSENT
 * rather than zero - the distinction the whole read layer is built on. A caller
 * that wants "zero" must decide that for itself, from a state it has checked. */
export type StatusCounts = Readonly<Partial<Record<ApplicationStatus, number>>>;

export interface ApplicationCounts {
  /* The classified read. A caller cannot reach counts without handling every
     not-an-answer case first. */
  readonly state: ReadState<StatusCountRow>;
  /* Tallied per status, and only meaningful when `state.kind` is 'rows'. Empty
     otherwise - never a map of zeroes, which would be a fabricated answer. */
  readonly counts: StatusCounts;
  readonly refetch: () => void;
}

/* Read the counts on mount and on refetch. */
export function useApplicationCounts(): ApplicationCounts {
  const [revision, setRevision] = useState(0);
  const refetch = useCallback(() => setRevision((r) => r + 1), []);

  /* Raw facts, accumulated by the effect below and handed to the pure
     classifier on every render. Held separately from the classified state so
     the classification is never stale relative to the facts. */
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<readonly StatusCountRow[] | null>(null);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    /* No client means nothing to do. The console is unconfigured, which the
       classifier reports without any query being attempted. */
    if (supabase === null) {
      setLoading(false);
      return;
    }

    /* Guards against setting state after unmount, which React warns about and
       which would also let a slow first request overwrite a faster second one.
       Flipped in the cleanup below. */
    let live = true;

    void (async () => {
      try {
        /* SESSION FIRST. With no session, RLS has nothing to scope to and the
           query would correctly return nothing - and reporting that as "no
           applications" is the exact lie this layer exists to prevent. Checking
           first means the honest state is reported without a pointless round
           trip. */
        const { data: sessionData } = await supabase.auth.getSession();
        if (!live) return;

        const hasSession = sessionData.session !== null;
        setSignedIn(hasSession);

        /* There is no Auth user in this system yet, so this is the branch that
           actually runs today. Not an error, and not empty. */
        if (!hasSession) {
          setLoading(false);
          return;
        }

        /* ONE AGGREGATE ON THE SERVER, one row per status (2026-10-24). This used to
           fetch `select=status` for every row and tally here, but hosted PostgREST
           cuts every response at max_rows = 1000 WITHOUT an error, so at 21,560 rows
           the page counted 1,000 of them: silently wrong. The GROUP BY returns at most
           ~20 rows, which no cap can truncate, in one round trip. Defined in
           supabase/migrations/20261024113000_dashboard_read_paths.sql (SECURITY
           INVOKER, so RLS still scopes it to this user). */
        const { data, error: queryError } = await supabase.rpc('application_status_counts');

        if (!live) return;

        if (queryError !== null) {
          /* The database's own message, passed through. Supabase reports an RLS
             refusal distinctly from a network failure, and that difference is
             exactly what someone debugging needs to see. */
          setError(queryError.message);
          setLoading(false);
          return;
        }

        /* The exact shape or a failed read: a malformed answer must never become a
           smaller count. Null data with no error is not this RPC's answer either,
           so it fails the same check instead of reading as "no applications". */
        const parsed = parseStatusCountRows(data);
        // A shape failure is reported like any failed read, with the reason.
        if (!parsed.ok) {
          // The banner text names which row broke the contract.
          setError(parsed.reason);
          // The read is over; it failed.
          setLoading(false);
          // Nothing to tally.
          return;
        }
        // Validated rows; an empty list is a real "no applications" and classifies as empty.
        setRows(parsed.rows);
        setLoading(false);
      } catch (thrown) {
        if (!live) return;
        /* A thrown error rather than a returned one - a DNS failure, an aborted
           request. Same destination: reported as a failed read, never as an
           empty one. */
        setError(thrown instanceof Error ? thrown.message : 'unknown read error');
        setLoading(false);
      }
    })();

    return () => {
      live = false;
    };
  }, [revision]);

  /* Classified on every render from the current facts, by the pure function
     that has a test for each branch. */
  const state = classifyRead<StatusCountRow>({
    clientPresent: supabase !== null,
    missingEnv: supabaseStatus.connected ? [] : supabaseStatus.missing,
    signedIn,
    loading,
    error,
    rows,
  });

  /* Tally only when there is genuinely something to tally. Any other state
     yields an empty map rather than a map of zeroes: a zero here would be
     indistinguishable from a real count of zero, which is the confusion this
     entire layer is built to prevent. */
  const counts: Record<string, number> = {};
  if (state.kind === 'rows') {
    for (const row of state.rows) {
      /* The server already counted; each status arrives once (parseStatusCountRows
         refuses a repeat), so this is an assignment, never a sum. A status with no
         rows is absent from the GROUP BY, so its key stays missing, not zero. */
      counts[row.status] = row.row_count;
    }
  }

  return { state, counts, refetch };
}
