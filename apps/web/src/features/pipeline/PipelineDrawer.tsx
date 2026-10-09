/* useCallback (2026-10-09): one loader shared by the open effect and the post-run refresh. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { ApplicationStatus } from '../../data/contract';
import { StatusBadge } from '../../app/StatusBadge';
import { supabase, supabaseStatus } from '../../data/supabase';
/* THE HOUSE CLASSIFIER, not a local boolean. This drawer was the last reader in
   apps/web still hand-rolling its own empty state while its OWN PARENT,
   PipelinePage.tsx:38, already imported this module. Rewriting it by hand would
   have been a second implementation of a solved problem — and the hand-rolled
   version I first wrote collapsed `no_session` into "none", which is precisely
   the conflation readState.ts exists to prevent. */
import { classifyRead, describeEmptyState, isConclusive } from '../../data/readState.ts';

/* Import the prep panel to display when the user is viewing the 'interview' stage applications. */
import { InterviewPrepPanel } from './InterviewPrepPanel';
/* The card, split out so its one decision (offer View resume or not) is testable without a client. */
import { DrawerAppCard, type DrawerAppItem } from './DrawerAppCard';
/* The heading wording (pure, tested), the outcome sentence the drawer now shows itself once it takes
   onSettled, and that result's type. */
import { OutcomeNote, drawerHeading, type SendResult } from './DrawerAppCard';

/* Rows per read. A lane can hold thousands, so the heading must say when this is not all of them. */
const DRAWER_PAGE_SIZE = 25;
/* Shape check on tailored_profile: anything that is not a real snapshot becomes null, never a guess. */
import { readResumeSnapshot } from './resumeSnapshot';
/* The real invoke/read deps for "Send through pipeline"; null when Supabase is unconfigured. */
import { liveRowPipelineDeps } from './rowPipelineDeps';
/* The shared tailored-vs-master view (owned by resume-preview/); imported, never modified here. */
import { ResumePreview } from '../resume-preview/ResumePreview';

import './PipelineDrawer.css';

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
  /* State to manage whether to show applications list or interview prep section. */
  const [activeTab, setActiveTab] = useState<'applications' | 'prep'>('applications');
  /* The query's own error, kept apart from the row array so the two facts cannot
     overwrite each other. */
  const [error, setError] = useState<string | null>(null);
  /* Checked before querying: with no session RLS scopes to nothing and returns
     zero rows CORRECTLY, so reporting that as "no applications" is a lie about
     the pipeline rather than a fact about it. There is no Auth user in this
     system yet, so today this is the branch that actually runs. */
  const [signedIn, setSignedIn] = useState(false);
  /* The row whose resume is open, or null. One at a time: the preview is a full-width
     side-by-side, so two would not fit and would not be comparable anyway. */
  const [viewing, setViewing] = useState<DrawerAppItem | null>(null);
  /* Finished "Send through pipeline" runs, newest first. Held HERE, not on the card: the refresh
     after a run drops the row from this lane, which unmounts its card and its outcome with it. */
  const [sendResults, setSendResults] = useState<readonly { readonly applicationId: string; readonly label: string; readonly result: SendResult }[]>([]);
  /* The lane's exact count, re-read on each post-run refresh. The `count` prop is the board's and is
     never refetched here, so after a run it goes stale. Null = not read (or the read failed): the
     heading then falls back to the board's count, never to a number nobody read. */
  const [liveCount, setLiveCount] = useState<number | null>(null);
  /* The overlay's Close button, focused on open so keyboard users land INSIDE the modal
     rather than behind its scrim (aria-modal promises they cannot reach what is behind). */
  const closeResumeRef = useRef<HTMLButtonElement | null>(null);
  /* Whatever had focus when the overlay opened (the card's View resume), so closing returns
     the keyboard user to where they were instead of to the top of the page. */
  const resumeOpenerRef = useRef<HTMLElement | null>(null);

  /* Remembers the opener BEFORE the overlay renders, since the click target is the opener. */
  function openResume(app: DrawerAppItem): void {
    /* activeElement is the clicked button at this instant; captured before focus moves. */
    resumeOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    /* Rendering the overlay is what the effect below reacts to. */
    setViewing(app);
  }

  /* Focus follows the overlay: into it on open, back to the opener on close. */
  useEffect(() => {
    /* Open: the Close button exists now that the overlay has rendered. */
    if (viewing !== null) closeResumeRef.current?.focus();
    /* Closed after having been opened: hand focus back once, then forget the opener. */
    else if (resumeOpenerRef.current !== null) {
      /* Back to the card's View resume, which is still mounted under the drawer. */
      resumeOpenerRef.current.focus();
      /* Cleared so a later re-render cannot steal focus back to a stale button. */
      resumeOpenerRef.current = null;
    }
  }, [viewing]);

  /* REQUEST SEQUENCE (2026-10-09). The list is now read more than once per status: on open, and
     again each time a "Send through pipeline" run settles. Two reads can overlap and finish out of
     order, so each read takes a number and only the LATEST one may write state. The effect cleanup
     bumps it too, which is what the old per-effect `active` flag did for a closed drawer. */
  const readSeqRef = useRef(0);

  /* One read of this lane. silent=true is the post-run refresh: the list stays on screen while it
     loads (no "Loading" flash replacing every card), and only the answer replaces it. */
  const loadRows = useCallback(async (silent: boolean): Promise<void> => {
    /* This read's number; any later read makes it stale. */
    const seq = ++readSeqRef.current;
    /* Checked after every await: a stale read writes nothing. */
    const isLatest = (): boolean => seq === readSeqRef.current;

    /* No client means no query was attempted, so there is nothing to report but
       the configuration. The classifier says so without a round trip. */
    const client = supabase;
    if (client === null) {
      setLoading(false);
      return;
    }

    /* A silent refresh keeps the current list and error on screen until its answer arrives. */
    if (!silent) {
      setLoading(true);
      /* Cleared per attempt so a failure against one status does not persist
         onto the next status the operator opens. */
      setError(null);
    }

      try {
        /* SESSION FIRST, matching useApplicationCounts.ts:88-105. Querying
           without one produces an empty result that is indistinguishable from a
           real empty result, so the honest answer is cheaper AND truer. */
        const { data: sessionData } = await client.auth.getSession();
        if (!isLatest()) return;

        const hasSession = sessionData.session !== null;
        setSignedIn(hasSession);
        if (!hasSession) {
          setLoading(false);
          return;
        }

        const { data, error: queryError } = await client
          .from('applications')
          /* tailored_profile added 2026-10-06 so any row, in any status, can reopen the resume
             tailored for it ("sent" is only true from `applied` on, so it is not claimed here).
             Read-only: this drawer never writes a status.
             match_score, NOT fit_score (2026-10-08): fit_score exists in no migration and not in the live
             table, so PostgREST refused this select and the drawer listed nothing for EVERY status. */
          .select('id, created_at, match_score, tailored_profile, jobs:job_id(title, company_name, discovered_via, source_refs)')
          .eq('status', status)
          .order('created_at', { ascending: false })
          /* One page; the heading says "showing N of M" when the lane holds more (drawerHeading). */
          .limit(DRAWER_PAGE_SIZE);

        /* A STALE RESPONSE IS NOT A FAILURE. A stale read means the drawer closed,
           the status changed, or a newer refresh started while this was in flight.
           The previous code folded this into the same branch as `error` and wrote
           an empty array — state written on behalf of a request nobody is waiting
           for, to a component that may already be unmounted. */
        if (!isLatest()) return;

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
          // A finite number or nothing: the card prints it as a percentage, so a non-number must never reach it.
          score: typeof row.match_score === 'number' && Number.isFinite(row.match_score) ? row.match_score : null,
          /* Null unless it is a real snapshot, so a malformed jsonb row offers nothing rather than an empty resume. */
          resume: readResumeSnapshot(row.tailored_profile),
        }));

        setRows(mapped);
        /* A successful silent refresh clears an earlier refresh's error, since it skipped the reset above. */
        setError(null);
        /* Post-run only: the lane just changed, so the board's count prop is stale. */
        if (silent) {
          /* Its own try: a failed COUNT must not mark the list, which did load, as failed. */
          try {
            /* HEAD + exact: a number with no rows, for this lane, scoped by RLS like the list. */
            const { count: exact, error: countError } = await client
              .from('applications')
              .select('id', { count: 'exact', head: true })
              .eq('status', status);
            /* Same sequence guard as the list: a newer read owns the state. */
            if (!isLatest()) return;
            /* Only a real non-negative integer is a count; anything else is "not read" (board floor). */
            setLiveCount(!countError && typeof exact === 'number' && Number.isInteger(exact) && exact >= 0 ? exact : null);
          } catch {
            /* A thrown count read is not read either, unless a newer read has taken over. */
            if (isLatest()) setLiveCount(null);
          }
        }
      } catch (cause) {
        /* THERE WAS NO CATCH AT ALL — only try/finally. A THROWN failure (offline,
           DNS, a CORS rejection, a malformed row breaking the .map above) escaped
           into `void fetchStatusRows()` as an unhandled rejection while `finally`
           cleared `loading` and the rows stayed empty. The loudest failure
           produced the quietest UI: a tidy "No applications", with the error
           visible only in a console nobody has open. A returned `error` and a
           thrown exception are different mechanisms; the old code handled one. */
        if (!isLatest()) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        /* Only the latest read ends the loading state; a stale one must not clear a newer one's. */
        if (isLatest()) setLoading(false);
      }
    /* status is the only input the query reads; a new status is a new loader. */
  }, [status]);

  /* Load on open and on every status change; the cleanup makes any in-flight read stale. */
  useEffect(() => {
    /* A full (non-silent) read: the operator just opened this lane. */
    void loadRows(false);
    /* Bumping the sequence is the "this drawer stopped listening" signal. */
    return () => {
      /* Any read still in flight now fails isLatest() and writes nothing. */
      readSeqRef.current += 1;
    };
  }, [loadRows]);

  // Handle ESC key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        /* Innermost layer first: Escape over an open resume closes the resume, not the
           whole drawer underneath it. */
        if (viewing !== null) setViewing(null);
        /* Nothing open above the drawer, so Escape closes the drawer as before. */
        else onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    /* viewing is a dependency because the handler reads it; a stale closure would always close the drawer. */
  }, [onClose, viewing]);

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
              {/* "Showing N of M" whenever this page is not the whole lane (2026-10-09). */}
              {/* The lane's live count after a run, else the board's (floored by drawerHeading at the rows shown). */}
              {drawerHeading({ count: liveCount ?? count, shown: state.kind === 'rows' ? state.rows.length : 0, conclusive: isConclusive(state) })}
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
          {/* We render a tab group when the status is interview so the user can switch views. */}
          {status === 'interview' && (
            <div className="drawer__tabs" style={{ display: 'flex', gap: '16px', marginBottom: '16px', /* Rule token: #e2e8f0 drew a bright line across the dark drawer. */ borderBottom: '1px solid var(--rule)', paddingBottom: '8px' }}>
              {/* Button to view the raw list of applications. */}
              <button type="button" onClick={() => setActiveTab('applications')} style={{ fontWeight: activeTab === 'applications' ? 'bold' : 'normal', background: 'none', border: 'none', cursor: 'pointer' }}>
                {/* Text for the applications tab. */}
                Applications
              </button>
              {/* Button to view the interview prep panel. */}
              <button type="button" onClick={() => setActiveTab('prep')} style={{ fontWeight: activeTab === 'prep' ? 'bold' : 'normal', background: 'none', border: 'none', cursor: 'pointer' }}>
                {/* Text for the prep tab. */}
                Interview Prep
              </button>
            </div>
          )}

          {/* Render the core application list if the applications tab is active or if we aren't in interview mode. */}
          {(status !== 'interview' || activeTab === 'applications') && (
            <>
              <p className="drawer__summary">
                Active application records currently in <span className="identifier">{status}</span> status.
              </p>

              {/* The finished runs' sentences, outliving their cards. Always mounted and polite, so a
                  result is announced when it arrives rather than when the region first appears. */}
              <div className="drawer__send-results" aria-live="polite">
                {/* One line per row sent, newest first. */}
                {sendResults.map(({ applicationId, label, result }) => (
                  <div key={applicationId} className="drawer__send-result">
                    {/* Names the job, since its card may be gone from the list by now. */}
                    <strong className="drawer__send-result-label">{label}</strong>
                    {/* The same sentence and queue link the card would have shown. */}
                    <OutcomeNote outcome={result.outcome} httpStatus={result.httpStatus} errorText={result.errorText} />
                  </div>
                ))}
              </div>

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
              /* The card owns the View resume decision; the drawer only owns which row is open. */
              /* The card decides from `status` whether to offer "Send through pipeline" (passed_filters only). */
              /* onSettled: keep the outcome here, then silently re-read the lane so the finished row leaves it. */
              <DrawerAppCard
                /* Stable per row, so a silent refresh keeps the cards that stay in the lane mounted. */
                key={app.id}
                /* The row this card draws. */
                app={app}
                /* The drawer owns the resume overlay. */
                onViewResume={openResume}
                sendThroughPipeline={{
                  /* The lane; the card shows the button only in passed_filters. */
                  status,
                  /* The real deps, or null when Supabase is unconfigured. */
                  deps: liveRowPipelineDeps,
                  /* Called after the lock is released, so the reloaded card is never stuck disabled. */
                  onSettled: (result) => {
                    /* Null is a refused/locked click (nothing ran) or a throw; the card shows that note
                       itself, and nothing moved, so no reload (same as the Discovered page). */
                    if (result === null) return;
                    /* Newest first, one line per row: a re-send replaces that row's older line. */
                    setSendResults((prev) => [{ applicationId: app.id, label: `${app.company} — ${app.role}`, result }, ...prev.filter((r) => r.applicationId !== app.id)]);
                    /* Silent: the list stays up; the sequence guard drops any older read still in flight. */
                    void loadRows(true);
                  },
                }}
              />
            ))
          )}
            </>
          )}

          {/* Render the interview prep panel if the prep tab is active and we are in interview mode. */}
          {status === 'interview' && activeTab === 'prep' && state.kind === 'rows' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              {/* Map over all applications to render a prep panel for each. */}
              {state.rows.map(app => (
                <div key={app.id}>
                  {/* Title for the individual application prep section. */}
                  <h4 style={{ margin: '0 0 8px 0' }}>{app.role} at {app.company}</h4>
                  {/* Provide the application ID to the prep panel component. */}
                  <InterviewPrepPanel applicationId={app.id} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* THE RESUME, ABOVE THE DRAWER, NOT INSIDE IT. The preview is a side-by-side of
          tailored and master, which needs the viewport's width; inside the drawer's
          column it would be two unreadable slivers. Rendered only for a row whose
          snapshot passed readResumeSnapshot, so `viewing.resume` is never null here. */}
      {viewing !== null && viewing.resume !== null && (
        <div className="drawer__resume-overlay" role="dialog" aria-modal="true" aria-label={`Resume for ${viewing.role} at ${viewing.company}`}>
          <div className="drawer__resume-panel">
            <header className="drawer__resume-header">
              <h2 className="drawer__title">{viewing.role} · {viewing.company}</h2>
              <button ref={closeResumeRef} type="button" className="drawer__close-btn" onClick={() => setViewing(null)} aria-label="Close resume">
                ✕ Close
              </button>
            </header>
            <ResumePreview
              applicationId={viewing.id}
              tailoredProfile={viewing.resume}
              /* The PINNED version this resume was tailored against, never the latest master:
                 the comparison must show what the tailoring actually started from. */
              masterVersion={viewing.resume.master_version}
              jobTitle={viewing.role}
              companyName={viewing.company}
            />
          </div>
        </div>
      )}
    </div>
  );
}
