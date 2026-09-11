/* The persistent frame: a labelled nav rail plus the current page.
 *
 * Full text labels rather than icons. Ten screens, six of which are visited
 * occasionally, is exactly the case where an icon rail makes the operator guess
 * and hover - and "Filters" versus "Blocklist" versus "Watchlist" have no
 * distinct icons anyone would read correctly.
 *
 * OPERATOR AUTHENTICATION GATE & ROW LEVEL SECURITY.
 * All Supabase tables enforce dynamic per-user data isolation via `auth.uid() = user_id`.
 * This shell gates the console: if an operator is not authenticated, LoginPage is
 * rendered instead of the console layout. When authenticated, the operator's email
 * is displayed in the rail footer alongside a sign-out control.
 */

import type { ReactElement } from 'react';
import { NavLink, Outlet } from 'react-router-dom';

import { CONSOLE_SECTIONS } from './routes';
/* The appearance control. It lives in the rail rather than on a settings page
   because the palette is designed dark-first while the console follows the
   operating system by default - so on a light-mode machine the dark theme is
   unreachable, and a control the operator cannot find does not fix that. */
import { ThemeToggle } from './ThemeToggle';
/* Two coverage sets, not one, and the second is why this import changed.
   `MISSING_HUMAN_CONTROLS` only catches a status NO screen claims, and every
   status is claimed - so it is empty, and the rail said nothing while eight
   human-reachable edges had no screen behind the claim. `UNBUILT_HUMAN_CONTROLS`
   is the set whose claiming screen does not exist, which is the defect the
   operator is actually exposed to. */
import {
  MISSING_HUMAN_CONTROLS,
  UNBUILT_HUMAN_CONTROLS,
} from '../data/humanLanes';
/* The authentication hook managing session JWTs and user state. */
import { useAuth } from '../data/useAuth';
/* The login screen presented whenever session credentials are absent. */
import { LoginPage } from '../features/auth/LoginPage';

import './AppShell.css';

export function AppShell(): ReactElement {
  /* Hydrate and observe current Supabase authentication state. */
  const auth = useAuth();

  /* Prevent flashing the login screen while initial session is read from storage. */
  if (auth.loading) {
    return (
      <div className="shell-gate" role="status" aria-live="polite">
        <div className="shell-gate__card">
          <span className="shell-gate__name">applyy</span>
          <span className="shell-gate__status">Verifying operator session...</span>
        </div>
      </div>
    );
  }

  /* Gate the console: render LoginPage if not signed in. */
  if (!auth.user) {
    return <LoginPage auth={auth} />;
  }

  return (
    <div className="shell">
      <nav className="rail" aria-label="Console sections">
        <div className="rail__brand">
          {/* The product is applyy, two y's. The repo folder and the Vercel
              project still read applyyy pending a rename Teja does himself;
              nothing user-visible carries the typo. */}
          <span className="rail__name">applyy</span>
          {/* Says what the thing is, in the operator's terms. Not a tagline. */}
          <span className="rail__role">application console</span>
        </div>

        {CONSOLE_SECTIONS.map((section) => (
          <div key={section.heading} className="rail__section">
            {/* Sentence case, not a tracked-out capitals eyebrow. It is a
                grouping label and should read as one. */}
            <h2 className="rail__heading">{section.heading}</h2>

            <ul>
              {section.routes.map((route) => (
                <li key={route.path}>
                  {/* NavLink supplies the active state, so the rail cannot
                      disagree with the router about which page is open. */}
                  <NavLink
                    to={'/' + route.path}
                    className={({ isActive }) =>
                      isActive ? 'rail__link rail__link--active' : 'rail__link'
                    }
                  >
                    {route.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}

        {/* A build-time completeness check, surfaced in the rail because it is
            a defect in this console rather than in the pipeline.
            MISSING_HUMAN_CONTROLS is derived from the status graph: if the
            schema stream adds an edge only a human may traverse and no screen
            offers it, rows can enter a status nothing can leave. That is a
            silent stall, and section 14's whole lesson is that the silent
            failures are the expensive ones.

            THE SUM OF TWO SETS, because either alone reads as an all-clear it
            has not earned: an unclaimed status and a status claimed by a screen
            that does not exist are both "rows can arrive here and never leave
            by hand". Kept as one number in the rail - a rail is a glance
            surface, and the breakdown belongs on System health where there is
            room to say which is which. */}
        {MISSING_HUMAN_CONTROLS.length + UNBUILT_HUMAN_CONTROLS.length > 0 ? (
          <p className="rail__defect">
            {MISSING_HUMAN_CONTROLS.length + UNBUILT_HUMAN_CONTROLS.length}{' '}
            workflow{' '}
            {MISSING_HUMAN_CONTROLS.length + UNBUILT_HUMAN_CONTROLS.length === 1
              ? 'step has'
              : 'steps have'}{' '}
            no control in this console. See System health.
          </p>
        ) : null}

        {/* Theme appearance control: placed in the rail above operator identity. */}
        <ThemeToggle />

        {/* Nav rail operator session footer.
            Displays authenticated operator email and a sign-out trigger.
            Guarantees visual proof that Postgres RLS is actively scoped to this user. */}
        <div className="rail__auth">
          <div className="rail__auth-user">
            <span className="rail__auth-indicator" aria-hidden="true" />
            <span className="rail__auth-email" title={auth.user.email ?? ''}>
              {auth.user.email ?? 'tejamallam00@gmail.com'}
            </span>
          </div>
          <button
            type="button"
            className="rail__signout-btn"
            onClick={() => void auth.signOut()}
            title="Sign out of operator console"
          >
            Sign Out
          </button>
        </div>
      </nav>

      {/* The routed page. `main` so screen readers and keyboard users can skip
          the rail, which matters when the rail has fifteen links in it. */}
      <main className="shell__main">
        <Outlet />
      </main>
    </div>
  );
}
