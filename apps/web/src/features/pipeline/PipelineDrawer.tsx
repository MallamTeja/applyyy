import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { ApplicationStatus } from '../../data/contract';
import { StatusBadge } from '../../app/StatusBadge';
import { SourceBadge } from '../../app/SourceBadge';
import { supabase, supabaseStatus } from '../../data/supabase';
/* THE HOUSE CLASSIFIER, not a local boolean. This drawer was the last reader in
   apps/web still hand-rolling its own empty state while its OWN PARENT,
   PipelinePage.tsx:38, already imported this module. Rewriting it by hand would
   have been a second implementation of a solved problem — and the hand-rolled
   version I first wrote collapsed `no_session` into "none", which is precisely
   the conflation readState.ts exists to prevent. */
import { classifyRead, describeEmptyState, isConclusive } from '../../data/readState.ts';

import './PipelineDrawer.css';

interface DrawerAppItem {
  readonly id: string;
  readonly role: string;
  readonly company: string;
  readonly createdAt: string;
  readonly discoveredVia?: readonly string[] | null;
  readonly score?: number | null;
}

export function PipelineDrawer({
  status,
  count,
  onClose,
}: {
  readonly status: ApplicationStatus;
  readonly count: number;
  readonly onClose: () => void;
}): ReactElement {
  /* NULL, NOT []. Null means no successful read has happened; `[]` means a read
     succeeded and found nothing. The previous code used `[]` for both, which is
     what let a failed read render as "No applications" — and `[]` is not a
     defensible default here, because it asserts a result nobody obtained. */
  const [rows, setRows] = useState<readonly DrawerAppItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  /* The query's own error, kept apart from the row array so the two facts cannot
     overwrite each other. */
  const [error, setError] = useState<string | null>(null);
  /* Checked before querying: with no session RLS scopes to nothing and returns
     zero rows CORRECTLY, so reporting that as "no applications" is a lie about
     the pipeline rather than a fact about it. There is no Auth user in this
     system yet, so today this is the branch that actually runs. */
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let active = true;

    /* No client means no query was attempted, so there is nothing to report but
       the configuration. The classifier says so without a round trip. */
    if (supabase === null) {
      setLoading(false);
      return;
    }

    async function fetchStatusRows() {
      /* Narrowed for TypeScript; the null case returned above. */
      const client = supabase;
      if (client === null) return;

      setLoading(true);
      /* Cleared per attempt so a failure against one status does not persist
         onto the next status the operator opens. */
      setError(null);

      try {
        /* SESSION FIRST, matching useApplicationCounts.ts:88-105. Querying
           without one produces an empty result that is indistinguishable from a
           real empty result, so the honest answer is cheaper AND truer. */
        const { data: sessionData } = await client.auth.getSession();
        if (!active) return;

        const hasSession = sessionData.session !== null;
        setSignedIn(hasSession);
        if (!hasSession) {
          setLoading(false);
          return;
        }

        const { data, error: queryError } = await client
          .from('applications')
          .select('id, created_at, fit_score, jobs:job_id(title, company_name, discovered_via, source_refs)')
          .eq('status', status)
          .order('created_at', { ascending: false })
          .limit(25);

        /* A STALE RESPONSE IS NOT A FAILURE. `!active` means the drawer closed or
           the status changed while this was in flight. The previous code folded
           this into the same branch as `error` and wrote an empty array — state
           written on behalf of a request nobody is waiting for, to a component
           that may already be unmounted. */
        if (!active) return;

        /* THE SWALLOWED READ, which was the reported bug. This was previously
           `setRows([])`, so an outage and a genuinely empty status produced
           byte-identical UI. */
        if (queryError || !data) {
          setError(queryError?.message ?? 'the query returned no result');
          return;
        }

        const mapped: DrawerAppItem[] = data.map((row: any) => ({
          id: row.id,
          role: row.jobs?.title ?? 'Untitled Role',
          company: row.jobs?.company_name ?? 'Unknown Company',
          createdAt: row.created_at,
          discoveredVia: row.jobs?.discovered_via ?? null,
          score: row.fit_score ?? null,
        }));

        setRows(mapped);
      } catch (cause) {
        /* THERE WAS NO CATCH AT ALL — only try/finally. A THROWN failure (offline,
           DNS, a CORS rejection, a malformed row breaking the .map above) escaped
           into `void fetchStatusRows()` as an unhandled rejection while `finally`
           cleared `loading` and the rows stayed empty. The loudest failure
           produced the quietest UI: a tidy "No applications", with the error
           visible only in a console nobody has open. A returned `error` and a
           thrown exception are different mechanisms; the old code handled one. */
        if (!active) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (active) setLoading(false);
      }
    }

    void fetchStatusRows();
    return () => {
      active = false;
    };
  }, [status]);

  // Handle ESC key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  /* Classified on every render from the current facts, by the pure function that
     has a test per branch in test/readState.test.ts. Six distinct outcomes where
     this component previously had two. */
  const state = classifyRead<DrawerAppItem>({
    clientPresent: supabase !== null,
    missingEnv: supabaseStatus.connected ? [] : supabaseStatus.missing,
    signedIn,
    loading,
    error,
    rows,
  });

  /* Non-null for every state except `rows`, and it is the ONE string rendered in
     place of a list — so a new unreadable state cannot reach the screen wearing
     the "none" wording. */
  const unreadable = describeEmptyState(state);

  return (
    <div
      className="drawer-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={`Applications in ${status}`}
    >
      <div className="drawer">
        <header className="drawer__header">
          <div className="drawer__title-group">
            <StatusBadge status={status} />
            {/* THE HEADER WAS HALF THE CONTRADICTION, so fixing only the body
                would leave the drawer still disagreeing with itself: it printed
                the board's count above "No applications" on a failed read.
                `count` is the BOARD'S number, arriving as a prop from a different
                query than the one this drawer runs, so when our own read did not
                conclude we have no standing to repeat it.
                `isConclusive` is the house predicate for exactly this — its own
                comment says it decides "whether a count may be shown as a number
                at all, or whether it must be shown as a phrase".
                Dropping the number rather than showing 0: zero would be the same
                falsehood in the other direction. */}
            <h2 className="drawer__title">
              {isConclusive(state) ? `${count} Application${count === 1 ? '' : 's'}` : 'Applications'}
            </h2>
          </div>
          <button
            type="button"
            className="drawer__close-btn"
            onClick={onClose}
            aria-label="Close drawer"
          >
            ✕ Close
          </button>
        </header>

        <div className="drawer__content">
          <p className="drawer__summary">
            Active application records currently in <span className="identifier">{status}</span> status.
          </p>

          {/* ORDER IS THE FIX, and it is the whole bug. On a failed read BOTH
              conditions are true — the list is empty precisely BECAUSE we could
              not fill it — so whichever branch is tested first decides what the
              operator is told. A failed-read branch added BELOW the empty test
              changes nothing while looking exactly like a fix.
              Branching on the DISCRIMINANT collapses that risk structurally:
              there is no longer a separate "empty" branch to get ahead of,
              because `describeEmptyState` owns every non-row outcome including
              the genuinely-empty one. A seventh state added to ReadState lands
              in this branch automatically rather than falling through to the
              list, so the ordering cannot be got wrong again.
              Written as `!== 'rows'` rather than `unreadable !== null` — the two
              are equivalent, but only the discriminant narrows `state.rows`
              below for TypeScript, and a narrowing the compiler can check is
              worth more than one a reader has to trust. */}
          {state.kind !== 'rows' ? (
            <div
              className="drawer__empty"
              /* Announced only when it is a problem. A genuinely empty status is
                 information, not an alert, and marking it as one would train the
                 operator to ignore the role. */
              role={state.kind === 'failed' || state.kind === 'unconfigured' ? 'alert' : undefined}
            >
              {/* NOT SIGNALLING BY COLOUR — which this branch could not do anyway:
                  PipelineDrawer.css is outside this parcel's write partition and
                  carries no failure treatment to reach for. The glyph, the wording
                  and the ARIA role carry it instead. A `drawer__failed` style
                  matching ApprovalQueuePage's is the obvious follow-up for whoever
                  owns that stylesheet. */}
              <span className="drawer__empty-icon">{state.kind === 'empty' ? '📭' : '⚠️'}</span>
              <span>{unreadable}</span>
            </div>
          ) : (
            state.rows.map((app) => (
              <article key={app.id} className="drawer__app-card">
                <div className="drawer__app-top">
                  <div>
                    <h3 className="drawer__app-role">{app.role}</h3>
                    <span className="drawer__app-company">{app.company}</span>
                  </div>
                  {app.discoveredVia && app.discoveredVia.length > 0 && (
                    <SourceBadge discoveredVia={app.discoveredVia as any} />
                  )}
                </div>
                <div className="drawer__app-meta">
                  <span className="identifier">{app.id.slice(0, 8)}</span>
                  <span>{new Date(app.createdAt).toLocaleDateString()}</span>
                  {app.score !== null && <span>Match: {app.score}%</span>}
                </div>
              </article>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
