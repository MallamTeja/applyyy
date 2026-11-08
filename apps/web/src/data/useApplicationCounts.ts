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

// useSyncExternalStore: every caller of the hook reads ONE module-level store instead of owning its own read.
import { useSyncExternalStore } from 'react';

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

/* ONE STORE FOR THE WHOLE CONSOLE (2026-11-08). Until then every caller owned its own read: the shell
 * re-read on every sidebar click, and Pipeline and Discovered each read again on top of it, so a click
 * there paid the RPC twice (~0.4 s each from India to the Sydney project). Now the facts live here, once,
 * and every hook caller subscribes. WHO READS: the shell calls ensureApplicationCounts when the operator
 * is known, and refreshApplicationCounts when data moved (a write it saw, a return to the tab); a page's
 * Refresh button calls the same refresh through `refetch`. Mounting the hook reads nothing by itself. */

/* Raw facts, handed to the pure classifier on every render. Held separately from the classified state so
   the classification is never stale relative to the facts. Replaced whole on each change, never mutated,
   because useSyncExternalStore re-renders only when the snapshot's identity changes. */
interface CountFacts {
  // True until the first read lands; a refresh keeps the last answer on screen rather than flashing.
  readonly loading: boolean;
  // The failed read's reason, or null.
  readonly error: string | null;
  // The validated RPC rows, or null before any answer.
  readonly rows: readonly StatusCountRow[] | null;
  // Whether the last read found a session; with none, RLS would answer "nothing", which is not "empty".
  readonly signedIn: boolean;
  // Bumped each time a read STARTS: the latest-wins token for in-flight reads.
  readonly revision: number;
}

// Loading until a read lands: the shell starts one as soon as the operator is known.
let facts: CountFacts = { loading: true, error: null, rows: null, signedIn: false, revision: 0 };
// Every mounted hook's re-render callback.
const listeners = new Set<() => void>();
// The operator the counts were last read for; a different (or returning) operator means a fresh read.
let loadedFor: string | undefined;

// Swap in the new facts and tell every subscriber; one place, so no caller can forget to notify.
function publish(next: Partial<CountFacts>): void {
  // A new object, so useSyncExternalStore sees the change.
  facts = { ...facts, ...next };
  // Each mounted hook re-renders with the new snapshot.
  for (const listener of listeners) listener();
}

// useSyncExternalStore's subscribe: register, and hand back the unregister it calls on unmount.
function subscribe(listener: () => void): () => void {
  // Registered until the component unmounts.
  listeners.add(listener);
  // React calls this on unmount, so a gone page is never notified.
  return () => listeners.delete(listener);
}

// useSyncExternalStore's snapshot: the current facts object, stable between publishes.
function getFacts(): CountFacts {
  // Same identity until publish replaces it, which is what keeps React from looping.
  return facts;
}

/* Read the counts for this operator once: nothing when they are already read (or being read) for this
   operator, a fresh read for a new one. `undefined` (signed out) forgets, so signing back in re-reads
   rather than showing the counts from before. */
export function ensureApplicationCounts(userId: string | undefined): void {
  // Signed out: forget whose counts these were, so the next sign-in reads again.
  if (userId === undefined) {
    // Cleared, not re-read: the shell shows its login gate, not the counts.
    loadedFor = undefined;
    // Nothing to read without an operator.
    return;
  }
  // Already read, or in flight, for this operator: the whole point of the store.
  if (loadedFor === userId) return;
  // Claimed before the read starts, so a second caller in the same tick does not start another.
  loadedFor = userId;
  // The one read for this operator.
  refreshApplicationCounts();
}

/* Re-read the counts now, for every caller at once. A newer call supersedes an older in-flight read: only
   the read whose revision is still the latest may publish, so a slow first answer never overwrites a
   faster second one (the job the per-effect `live` flag used to do). */
export function refreshApplicationCounts(): void {
  // This read's token, published before any await.
  const revision = facts.revision + 1;
  // Bumped now, before any await, so two refreshes in one tick get two distinct tokens.
  publish({ revision });
  // Whether this read is still the newest; checked after every await.
  const current = () => facts.revision === revision;

  /* No client means nothing to do. The console is unconfigured, which the
     classifier reports without any query being attempted. */
  if (supabase === null) {
    // Done loading: the classifier turns a missing client into "not configured".
    publish({ loading: false });
    // No query to send.
    return;
  }
  // Narrowed once, so the async body below needs no non-null assertions.
  const client = supabase;

  void (async () => {
      try {
        /* SESSION FIRST. With no session, RLS has nothing to scope to and the
           query would correctly return nothing - and reporting that as "no
           applications" is the exact lie this layer exists to prevent. Checking
           first means the honest state is reported without a pointless round
           trip. */
        const { data: sessionData } = await client.auth.getSession();
        // A newer refresh owns the store now; this answer is stale.
        if (!current()) return;

        // Whether there is anyone for RLS to scope the count to.
        const hasSession = sessionData.session !== null;
        // Recorded either way, so the classifier can say "signed out" rather than "empty".
        publish({ signedIn: hasSession });

        /* There is no Auth user in this system yet, so this is the branch that
           actually runs today. Not an error, and not empty. */
        if (!hasSession) {
          // Done: the classifier reports no_session from signedIn false.
          publish({ loading: false });
          // No query without a session.
          return;
        }

        /* ONE AGGREGATE ON THE SERVER, one row per status (2026-10-24). This used to
           fetch `select=status` for every row and tally here, but hosted PostgREST
           cuts every response at max_rows = 1000 WITHOUT an error, so at 21,560 rows
           the page counted 1,000 of them: silently wrong. The GROUP BY returns at most
           ~20 rows, which no cap can truncate, in one round trip. Defined in
           supabase/migrations/20261024113000_dashboard_read_paths.sql (SECURITY
           INVOKER, so RLS still scopes it to this user). */
        const { data, error: queryError } = await client.rpc('application_status_counts');

        // Superseded while the RPC was in flight: the newer read publishes instead.
        if (!current()) return;

        if (queryError !== null) {
          /* The database's own message, passed through. Supabase reports an RLS
             refusal distinctly from a network failure, and that difference is
             exactly what someone debugging needs to see. */
          publish({ error: queryError.message, loading: false });
          // Nothing to tally.
          return;
        }

        /* The exact shape or a failed read: a malformed answer must never become a
           smaller count. Null data with no error is not this RPC's answer either,
           so it fails the same check instead of reading as "no applications". */
        const parsed = parseStatusCountRows(data);
        // A shape failure is reported like any failed read, with the reason.
        if (!parsed.ok) {
          // The banner text names which row broke the contract; the read is over, and it failed.
          publish({ error: parsed.reason, loading: false });
          // Nothing to tally.
          return;
        }
        // Validated rows; an empty list is a real "no applications" and classifies as empty.
        // error cleared too: a store outlives one read, so a past failure must not shadow a fresh answer.
        publish({ rows: parsed.rows, error: null, loading: false });
      } catch (thrown) {
        // A superseded read's failure is not news either.
        if (!current()) return;
        /* A thrown error rather than a returned one - a DNS failure, an aborted
           request. Same destination: reported as a failed read, never as an
           empty one. */
        publish({ error: thrown instanceof Error ? thrown.message : 'unknown read error', loading: false });
      }
    })();
}

/* The counts, from the shared store. Reads nothing on mount (see the store's header): the shell has
   already started the read for this operator, and `refetch` re-reads for every caller at once. */
export function useApplicationCounts(): ApplicationCounts {
  // The current facts; React re-renders this caller whenever publish replaces them.
  const { loading, error, rows, signedIn } = useSyncExternalStore(subscribe, getFacts);

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

  // refetch is the module function, so its identity is stable across renders and callers.
  return { state, counts, refetch: refreshApplicationCounts };
}
