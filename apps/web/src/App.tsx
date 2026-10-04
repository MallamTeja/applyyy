/* The router. One route per section-15 page, all nested inside the shell so the
 * nav rail persists across navigation instead of remounting. */

import type { ReactElement } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { BrowserRouter } from 'react-router-dom';

import { AppShell } from './app/AppShell';
import { DEFAULT_ROUTE } from './app/routes';
// Per-page crash containment, so one page's render error cannot blank the whole app.
import { ErrorBoundary } from './app/ErrorBoundary';

/* The daily screens. */
import { ApprovalQueuePage } from './features/approval/ApprovalQueuePage';
import { PipelinePage } from './features/pipeline/PipelinePage';
import { DiscoveredJobsPage } from './features/discovery/DiscoveredJobsPage';
import { HealthPage } from './features/health/HealthPage';
import { EmailMonitoringPage } from './features/emails/EmailMonitoringPage';

/* Import the ReferralOutreachPage for cold outreach routing. */
import { ReferralOutreachPage } from './features/referral/ReferralOutreachPage';
/* Import the FollowUpNudgesPage for day-7 nudges routing. */
import { FollowUpNudgesPage } from './features/followup/FollowUpNudgesPage';
/* Import the SkillGapPage for analytics routing. */
import { SkillGapPage } from './features/analytics/SkillGapPage';

/* The six configuration screens. */
import { SearchPreferencesPage } from './features/settings/SearchPreferencesPage';
import { MasterProfilePage } from './features/settings/MasterProfilePage';
import { AnswerBankPage } from './features/settings/AnswerBankPage';
import { FiltersPage } from './features/settings/FiltersPage';
import { WatchlistPage } from './features/settings/WatchlistPage';
import { BlocklistPage } from './features/settings/BlocklistPage';

import { ToastProvider } from './app/Toast';

/* Wraps one page in its own boundary. One boundary PER ROUTE rather than one around
   <Routes>: the shell (nav rail) sits outside every boundary and survives a crash, and
   navigating away mounts a different boundary, so the error state resets for free. */
function guarded(page: ReactElement): ReactElement {
  // The page is the boundary's only child.
  return <ErrorBoundary>{page}</ErrorBoundary>;
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
          <Route path="discovered" element={guarded(<DiscoveredJobsPage />)} />
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
