/* The router. One route per section-15 page, all nested inside the shell so the
 * nav rail persists across navigation instead of remounting. */

import type { ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { BrowserRouter } from 'react-router-dom';

import { AppShell } from './app/AppShell';
import { DEFAULT_ROUTE } from './app/routes';

/* The three daily screens. */
import { ApprovalQueuePage } from './features/approval/ApprovalQueuePage';
import { PipelinePage } from './features/pipeline/PipelinePage';
import { HealthPage } from './features/health/HealthPage';

/* The six configuration screens. */
import { SearchPreferencesPage } from './features/settings/SearchPreferencesPage';
import { MasterProfilePage } from './features/settings/MasterProfilePage';
import { AnswerBankPage } from './features/settings/AnswerBankPage';
import { FiltersPage } from './features/settings/FiltersPage';
import { WatchlistPage } from './features/settings/WatchlistPage';
import { BlocklistPage } from './features/settings/BlocklistPage';

export function App(): ReactElement {
  return (
    /* BrowserRouter rather than HashRouter because apps/web/vercel.json
       rewrites every path to index.html, so real URLs work and can be
       bookmarked - the operator will want a link straight to the queue. */
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

          <Route path="approvals" element={<ApprovalQueuePage />} />
          <Route path="pipeline" element={<PipelinePage />} />
          <Route path="health" element={<HealthPage />} />

          <Route path="search-preferences" element={<SearchPreferencesPage />} />
          <Route path="master-profile" element={<MasterProfilePage />} />
          <Route path="answer-bank" element={<AnswerBankPage />} />
          <Route path="filters" element={<FiltersPage />} />
          <Route path="watchlist" element={<WatchlistPage />} />
          <Route path="blocklist" element={<BlocklistPage />} />

          {/* Anything else is a mistyped or stale URL. Redirecting rather than
              rendering a dead end, because there is no useful 404 in a console
              with ten screens - the operator wanted one of them. */}
          <Route path="*" element={<Navigate to={'/' + DEFAULT_ROUTE} replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
