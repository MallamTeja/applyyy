/* The router. One route per section-15 page, all nested inside the shell so the
 * nav rail persists across navigation instead of remounting. */

// lazy + Suspense: each page is its own chunk, fetched on first visit (2026-11-08, see lazyPage below).
import { lazy, Suspense } from 'react';
// Types for the route table and the lazy adapter.
import type { ComponentType, LazyExoticComponent, ReactElement } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { BrowserRouter } from 'react-router-dom';

import { AppShell } from './app/AppShell';
import { DEFAULT_ROUTE } from './app/routes';
// Per-page crash containment, so one page's render error cannot blank the whole app.
import { ErrorBoundary } from './app/ErrorBoundary';
// The Approval queue's first read, startable before its lazy chunk arrives (2026-11-09).
import { startQueuePrefetch } from './features/approval/queuePrefetch';

/* Kicked once, at module load: before React renders, before the session gate, before the lazy chunk is
   even requested. The queue read then rides the same ~1 s Sydney hop as the chunk download instead of
   waiting behind it (measured: the read left ~115 ms after the shell's first request, right after the
   chunk). It does nothing unless this load opens /approvals (or "/") with a stored session. */
startQueuePrefetch(window.location.pathname);

/* The daily screens. */
const ApprovalQueuePage = lazyPage(() => import('./features/approval/ApprovalQueuePage'), 'ApprovalQueuePage');
// Its own chunk: fetched the first time this route opens, never with the shell.
const PipelinePage = lazyPage(() => import('./features/pipeline/PipelinePage'), 'PipelinePage');
// Its own chunk: fetched the first time this route opens, never with the shell.
const DiscoveredJobsPage = lazyPage(() => import('./features/discovery/DiscoveredJobsPage'), 'DiscoveredJobsPage');
// Its own chunk: fetched the first time this route opens, never with the shell.
const HealthPage = lazyPage(() => import('./features/health/HealthPage'), 'HealthPage');
// The manual-apply kits: jobs Teja applies to by hand, with the form pre-answered.
const ManualApplyPage = lazyPage(() => import('./features/manual-apply/ManualApplyPage'), 'ManualApplyPage');
// Its own chunk: fetched the first time this route opens, never with the shell.
const EmailMonitoringPage = lazyPage(() => import('./features/emails/EmailMonitoringPage'), 'EmailMonitoringPage');
// Every application past a confirmed submission, with its stage and what was sent (2026-11-04).
const AppliedJobsPage = lazyPage(() => import('./features/applied/AppliedJobsPage'), 'AppliedJobsPage');

/* Import the ReferralOutreachPage for cold outreach routing. */
const ReferralOutreachPage = lazyPage(() => import('./features/referral/ReferralOutreachPage'), 'ReferralOutreachPage');
/* Import the FollowUpNudgesPage for day-7 nudges routing. */
const FollowUpNudgesPage = lazyPage(() => import('./features/followup/FollowUpNudgesPage'), 'FollowUpNudgesPage');
/* Import the SkillGapPage for analytics routing. */
const SkillGapPage = lazyPage(() => import('./features/analytics/SkillGapPage'), 'SkillGapPage');

/* The six configuration screens. */
const SearchPreferencesPage = lazyPage(() => import('./features/settings/SearchPreferencesPage'), 'SearchPreferencesPage');
// Its own chunk: fetched the first time this route opens, never with the shell.
const MasterProfilePage = lazyPage(() => import('./features/settings/MasterProfilePage'), 'MasterProfilePage');
// Its own chunk: fetched the first time this route opens, never with the shell.
const AnswerBankPage = lazyPage(() => import('./features/settings/AnswerBankPage'), 'AnswerBankPage');
// Its own chunk: fetched the first time this route opens, never with the shell.
const FiltersPage = lazyPage(() => import('./features/settings/FiltersPage'), 'FiltersPage');
// Its own chunk: fetched the first time this route opens, never with the shell.
const WatchlistPage = lazyPage(() => import('./features/settings/WatchlistPage'), 'WatchlistPage');
// Its own chunk: fetched the first time this route opens, never with the shell.
const BlocklistPage = lazyPage(() => import('./features/settings/BlocklistPage'), 'BlocklistPage');

// The toast host wraps the whole app; it is shell, not a page, so it stays eager.
import { ToastProvider } from './app/Toast';

/* ONE CHUNK PER PAGE (Teja 2026-11-08, "pages are slow"). Every route used to ship in one 862 KB chunk, so
   opening any page parsed all sixteen, Settings (155 KB) and Approval (112 KB) included. React.lazy wants a
   default export and the pages export by name, so this adapts one named export. A function declaration, so
   the page consts above can call it (hoisted). The shell, the boundary and NotFound stay eager: they draw
   before any page and must never wait for a fetch. */
function lazyPage<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K): LazyExoticComponent<ComponentType> {
  // The module promise mapped to the shape lazy() needs; the import() itself is what Vite splits on.
  // The return type is spelled out so the generic index narrows to ComponentType without a cast.
  return lazy(() => load().then((module): { default: ComponentType } => ({ default: module[name] })));
}

/* Wraps one page in its own boundary. One boundary PER ROUTE rather than one around
   <Routes>: the shell (nav rail) sits outside every boundary and survives a crash, and
   navigating away mounts a different boundary, so the error state resets for free. */
function guarded(page: ReactElement): ReactElement {
  // The boundary OUTSIDE the Suspense: a page chunk that fails to load (offline, a deploy replaced it)
  // throws like a page crash, so it is contained the same way and the rail stays usable.
  return (
    <ErrorBoundary>
      {/* While the page's chunk loads: the pages' own loading line in the page frame, so the first paint
          has the same box and wording style as the page's own data-loading state (no new spinner design). */}
      <Suspense fallback={<div className="page"><p className="queue__empty" role="status">Loading…</p></div>}>
        {page}
      </Suspense>
    </ErrorBoundary>
  );
}

/* Shown for any URL that matches no screen. It used to redirect silently to the
   approvals queue, which hid broken links: the operator could not tell a typo from
   a page that had been removed. */
function NotFound(): ReactElement {
  // Inside the shell, so the nav rail is still there to pick a real page.
  return (
    <div className="page">
      {/* Says plainly what happened. */}
      <h1>Page not found</h1>
      {/* One obvious way back to where the daily work is. */}
      <p>
        No screen lives at this address.{' '}
        <Link to={'/' + DEFAULT_ROUTE}>Go to the approval queue</Link>.
      </p>
    </div>
  );
}

export function App(): ReactElement {
  return (
    <ToastProvider>
      <BrowserRouter>
      <Routes>
        {/* The shell is the layout route: it renders the rail plus an Outlet,
            so switching pages never remounts the navigation. */}
        <Route element={<AppShell />}>
          {/* Root sends the operator where the time-sensitive work is. `replace`
              keeps the redirect out of history, so Back does not bounce. */}
          <Route
            index
            element={<Navigate to={'/' + DEFAULT_ROUTE} replace />}
          />

          <Route path="approvals" element={guarded(<ApprovalQueuePage />)} />
          <Route path="pipeline" element={guarded(<PipelinePage />)} />
          {/* Same path string as the PageHeader lookup, so the route and its heading cannot disagree. */}
          <Route path="applied" element={guarded(<AppliedJobsPage />)} />
          <Route path="discovered" element={guarded(<DiscoveredJobsPage />)} />
          {/* Same path string as routes.ts, so the rail item and the route cannot disagree. */}
          <Route path="manual-apply" element={guarded(<ManualApplyPage />)} />
          <Route path="health" element={guarded(<HealthPage />)} />
          <Route path="emails" element={guarded(<EmailMonitoringPage />)} />

          {/* Add route for referrals so users can review outreach drafts. */}
          <Route path="referrals" element={guarded(<ReferralOutreachPage />)} />
          {/* Add route for nudges to manage follow-up emails. */}
          <Route path="nudges" element={guarded(<FollowUpNudgesPage />)} />
          {/* Add route for skill gap to view analytics on missing skills. */}
          <Route path="skill-gap" element={guarded(<SkillGapPage />)} />

          <Route path="search-preferences" element={guarded(<SearchPreferencesPage />)} />
          <Route path="master-profile" element={guarded(<MasterProfilePage />)} />
          <Route path="answer-bank" element={guarded(<AnswerBankPage />)} />
          <Route path="filters" element={guarded(<FiltersPage />)} />
          <Route path="watchlist" element={guarded(<WatchlistPage />)} />
          <Route path="blocklist" element={guarded(<BlocklistPage />)} />

          {/* Anything else is a mistyped or stale URL. A visible not-found page,
              not a silent redirect: redirecting hid broken links, and the nav rail
              is still on screen to choose the page the operator wanted. */}
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
      </BrowserRouter>
    </ToastProvider>
  );
}
