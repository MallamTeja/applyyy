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

import { useEffect, useState } from 'react';

import { supabase, supabaseStatus } from './supabase.ts';
import { classifyRead } from './readState.ts';
import type { ReadState } from './readState.ts';
import type { ApplicationStatus } from './contract';

/* One row of the count query. Only the status column is selected - the narrowest
 * projection that answers the question, so no personal field is ever fetched
 * into the browser to be counted and discarded. */
interface StatusRow {
  readonly status: ApplicationStatus;
}

/* Counts keyed by status. Partial because a status with no rows is ABSENT
 * rather than zero - the distinction the whole read layer is built on. A caller
 * that wants "zero" must decide that for itself, from a state it has checked. */
export type StatusCounts = Readonly<Partial<Record<ApplicationStatus, number>>>;

export interface ApplicationCounts {
  /* The classified read. A caller cannot reach counts without handling every
     not-an-answer case first. */
  readonly state: ReadState<StatusRow>;
  /* Tallied per status, and only meaningful when `state.kind` is 'rows'. Empty
     otherwise - never a map of zeroes, which would be a fabricated answer. */
  readonly counts: StatusCounts;
}

/* Read the counts once on mount.
 *
 * NO POLLING. The pipeline is meant to live-update through Supabase Realtime
 * (section 5), which pushes changes rather than asking for them - a poll would
 * burn the free tier's request budget to learn nothing most of the time. The
 * subscription is not wired yet; when it is, it replaces the refetch rather
 * than being added alongside it. */
export function useApplicationCounts(): ApplicationCounts {
  /* Raw facts, accumulated by the effect below and handed to the pure
     classifier on every render. Held separately from the classified state so
     the classification is never stale relative to the facts. */
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /* NULL, not []. Null means no successful read has completed; an empty array
     would claim the database was asked and answered nothing. */
  const [rows, setRows] = useState<readonly StatusRow[] | null>(null);
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

        /* The narrowest projection that answers the question. Counting client
           side rather than with one aggregate per status keeps this to a single
           request - eighteen statuses would otherwise be eighteen round trips
           on a free tier. */
        const { data, error: queryError } = await supabase
          .from('applications')
          .select('status');

        if (!live) return;

        if (queryError !== null) {
          /* The database's own message, passed through. Supabase reports an RLS
             refusal distinctly from a network failure, and that difference is
             exactly what someone debugging needs to see. */
          setError(queryError.message);
          setLoading(false);
          return;
        }

        /* `data` is typed as possibly-null by the client. Null here would mean
           no error and no data, which should not happen - but treating it as an
           empty array would manufacture a positive "there are none" answer out
           of a state we do not understand. So it stays null and classifies as
           still-loading rather than as empty. */
        setRows(data as readonly StatusRow[] | null);
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
  }, []);

  /* Classified on every render from the current facts, by the pure function
     that has a test for each branch. */
  const state = classifyRead<StatusRow>({
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
      /* `?? 0` is safe on the ACCUMULATOR - it is counting, not reporting an
         absence. The absence stays expressed by the key being missing. */
      counts[row.status] = (counts[row.status] ?? 0) + 1;
    }
  }

  return { state, counts };
}
