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

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

/* The title mapping lives beside the route table so the tab title and the rail
   label cannot name the same page two different ways. */
import { CONSOLE_SECTIONS, documentTitleFor } from './routes';
import { CommandPalette } from './CommandPalette';
import { ThemeToggle } from './ThemeToggle';
import {
  MISSING_HUMAN_CONTROLS,
  UNBUILT_HUMAN_CONTROLS,
} from '../data/humanLanes';
// The badge arithmetic: the Manual apply page's row count, or the lane counts when that read is unavailable.
import { manualApplyCount } from '../features/manual-apply/applyKit';
// The page's own loader, so the badge counts the very rows the page lists (no second formula to drift).
import { loadManualApply } from '../features/manual-apply/manualApplyData';
// Type only: the page's row, for the badge state.
import type { ManualApplyRow } from '../features/manual-apply/manualApplyData';
import { useAuth } from '../data/useAuth';
// Per-status counts from the application_status_counts RPC, read once here for the rail badge.
import { useApplicationCounts } from '../data/useApplicationCounts';
import { LoginPage } from '../features/auth/LoginPage';

import './AppShell.css';

export function AppShell(): ReactElement {
  const auth = useAuth();
  const [paletteOpen, setPaletteOpen] = useState(false);
  /* Whether the collapsed phone menu is showing. Starts closed so a phone lands
     on content, not on fourteen links (~500px of nav at 390px wide). Ignored
     above the breakpoint, where CSS always shows the rail. */
  const [menuOpen, setMenuOpen] = useState(false);
  /* Focus returns here on Escape, so a keyboard user is not dropped onto
     <body> when the menu that held focus disappears. */
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  /* The route drives both the tab title and closing the menu after a tap. */
  const { pathname } = useLocation();
  /* The "needs you" badge's source (2026-10-24). Called here, above the early returns, because the
     shell renders once for every route: one ~20-row RPC for the whole console, not one per nav item. */
  const { state: countState, counts, refetch: refetchCounts } = useApplicationCounts();
  /* Re-read on every navigation and on sign-in: the hook's first read can land before the session
     exists (it then reports no_session), and a resolve on System health changes the count. The extra
     read on mount is one tiny aggregate, cheaper than code to skip it. */
  /* The rows the Manual apply page lists (lanes + every approved row, kit or not + open kit rows); null
     until read and null on a failed read, so the badge falls back to the lane counts instead of a 0. */
  const [pageRows, setPageRows] = useState<readonly ManualApplyRow[] | null>(null);
  useEffect(() => {
    /* No operator yet (the stored session is still being read, or signed out): nothing to count,
       and the shell shows its gate, not the badge. Until 2026-11-05 this ran once here AND again
       when the session arrived, so every cold load paid the Manual apply reads twice. */
    if (auth.user?.id === undefined) return;
    // A fresh count for the page the operator just opened.
    refetchCounts();
    // Guards against a slow earlier read landing after a newer one.
    let live = true;
    // The page's own reads; a reported error or a throw both become null (unknown), never an empty list.
    void loadManualApply('badge').then((r) => { if (live) setPageRows('error' in r ? null : r.rows); }).catch(() => { if (live) setPageRows(null); });
    // A newer navigation supersedes this read.
    return () => { live = false; };
  }, [pathname, auth.user?.id, refetchCounts]);
  /* Jobs to apply to or check by hand: the page's row count when it was read, else the RPC's lane counts
     when THAT read succeeded, else no badge rather than a made-up zero or a stale number. */
  const needsYou = manualApplyCount(countState.kind === 'rows' ? counts : null, pageRows);

  /* Per-route tab title. Applied here rather than in each page because the
     shell is the one component every route renders through, so no page can
     forget it; and here rather than App.tsx, which another fixer owns. */
  useEffect(() => {
    /* Fourteen tabs all reading "application console" were indistinguishable. */
    document.title = documentTitleFor(pathname);
    /* Choosing a destination is the end of the menu's job; leaving it open
       would cover the page the operator just asked for. */
    setMenuOpen(false);
  }, [pathname]);

  /* Escape closes the open menu - the standard disclosure contract, and the
     only exit a keyboard user has without tabbing through every link. */
  useEffect(() => {
    /* No listener while closed, so Escape keeps its meaning elsewhere. */
    if (!menuOpen) return;
    /* Named so the cleanup below removes this exact handler. */
    const handleEscape = (e: KeyboardEvent) => {
      /* Only Escape; every other key belongs to the page or the palette. */
      if (e.key !== 'Escape') return;
      /* Close first, then hand focus back to the control that opened it. */
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    /* Window-level so Escape works wherever focus sits inside the menu. */
    window.addEventListener('keydown', handleEscape);
    /* Removed on close or unmount so stale handlers never stack. */
    return () => window.removeEventListener('keydown', handleEscape);
  }, [menuOpen]);

  // Global Cmd + K / Ctrl + K shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

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
      <CommandPalette isOpen={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <nav className="rail" aria-label="Console sections">
        {/* Brand and the phone menu toggle share one row, so on a narrow
            screen the only nav chrome above the content is this single line. */}
        <div className="rail__top">
          <div className="rail__brand">
            <span className="rail__name">applyy</span>
            <span className="rail__role">application console</span>
          </div>

          {/* Disclosure button, shown only below the breakpoint by CSS.
              aria-expanded tells assistive tech the menu's state; aria-controls
              ties the button to the region it shows and hides. */}
          <button
            type="button"
            ref={menuButtonRef}
            className="rail__menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="rail-menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {/* A word, not a bare hamburger glyph: the label is the accessible
                name and reads unambiguously to everyone. */}
            {menuOpen ? 'Close menu' : 'Menu'}
          </button>
        </div>

        {/* Everything collapsible. On wide screens CSS gives this
            `display: contents`, so the rail lays out exactly as before; below
            the breakpoint it is hidden until the toggle opens it. */}
        <div
          id="rail-menu"
          className={menuOpen ? 'rail__menu rail__menu--open' : 'rail__menu'}
        >

        {/* Quick Search / Command Palette Trigger */}
        <button
          type="button"
          className="rail-search-btn"
          onClick={() => setPaletteOpen(true)}
          title="Open Command Palette (Cmd + K)"
        >
          <span>Search screens...</span>
          <span className="palette-kbd-hint">⌘K</span>
        </button>

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
                    {/* The badge sits on Manual apply, where every such job is listed with its kit and its
                        resolves (the queues also stay on System health); hidden at zero so it only means "act". */}
                    {route.path === NEEDS_YOU_ROUTE && needsYou > 0 ? (
                      /* The visible number for the eye; the sentence below is what a screen reader hears. */
                      <span className="rail__count">
                        {/* The count alone, hidden from assistive tech so it is not read twice. */}
                        <span aria-hidden="true">{needsYou}</span>
                        {/* The full meaning, for screen readers only. */}
                        <span className="visually-hidden">{`, ${needsYou} ${needsYou === 1 ? 'job needs' : 'jobs need'} you to apply or verify by hand`}</span>
                      </span>
                    ) : null}
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
              {/* Generic fallback, never a hard-coded address: an account with
                  no email (phone auth) must not be shown as someone else's. */}
              {auth.user.email ?? 'Signed in'}
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

/* The rail item that lists every job to apply to by hand: the manual-action lanes plus open kit rows. */
const NEEDS_YOU_ROUTE = 'manual-apply';
