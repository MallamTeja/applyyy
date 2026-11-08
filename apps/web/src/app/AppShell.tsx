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

import { useCallback, useEffect, useRef, useState } from 'react';
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
// The shared store's two triggers: read once per operator, and re-read when data moved.
import { ensureApplicationCounts, refreshApplicationCounts } from '../data/useApplicationCounts';
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
  const { state: countState, counts } = useApplicationCounts();
  /* Re-read on every navigation and on sign-in: the hook's first read can land before the session
     exists (it then reports no_session), and a resolve on System health changes the count. The extra
     read on mount is one tiny aggregate, cheaper than code to skip it. */
  /* SUPERSEDED 2026-11-08: the per-navigation re-read above cost 3-5 requests in two ~0.4 s rounds on
     EVERY sidebar click (the project is in Sydney), racing the page's own reads. Now the counts and the
     badge are read once per operator and re-read only when data moved; the three triggers are below. */
  /* The rows the Manual apply page lists (lanes + every approved row, kit or not + open kit rows); null
     until read and null on a failed read, so the badge falls back to the lane counts instead of a 0. */
  const [pageRows, setPageRows] = useState<readonly ManualApplyRow[] | null>(null);
  /* When the last counts+badge read started, for the tab-return and navigation freshness checks below. A ref, not state:
     changing it must not re-render the rail. Seeded with the mount time, not 0: a fresh page can fire
     visibilitychange before its first read is stamped, and 0 would read as "away for 56 years". */
  const lastReadAt = useRef(Date.now());
  /* Bumped by the shell's own data-moved triggers (2 and 3 below) to re-read the badge. Its own counter,
     not the counts store's: a page's refetch() (Pipeline's Refresh, the run modal opening) moves no row,
     so it re-reads the counts alone instead of paying the badge's 3-4 reads too (split 2026-11-08). */
  const [badgeRevision, setBadgeRevision] = useState(0);
  /* Counts and badge together: the one action every shell data-moved trigger takes. useCallback with no
     deps because both calls are stable (a module function and a state setter), so effects that use it
     never re-subscribe on a render. */
  const refreshShell = useCallback(() => {
    // Every hook caller's counts, re-read once.
    refreshApplicationCounts();
    // And the badge with them (the badge effect below).
    setBadgeRevision((r) => r + 1);
  }, []);
  /* TRIGGER 1: the operator became known (or changed). The store skips the read when it already holds
     this operator's counts, so a re-render or a remount never re-reads. Signed out forgets them. */
  useEffect(() => {
    // undefined while the stored session is read and when signed out; the store handles both.
    ensureApplicationCounts(auth.user?.id);
  }, [auth.user?.id]);
  /* The badge: read when the operator becomes known (TRIGGER 1) and on each shell data-moved trigger,
     which re-reads the counts in the same call (refreshShell above), so the two cannot drift apart on a
     move. A page's counts-only refetch deliberately does not reach here. */
  useEffect(() => {
    /* No operator yet (the stored session is still being read, or signed out): nothing to count,
       and the shell shows its gate, not the badge. Until 2026-11-05 this ran once here AND again
       when the session arrived, so every cold load paid the Manual apply reads twice. */
    if (auth.user?.id === undefined) return;
    // Stamped here because this is the one effect every read passes through.
    lastReadAt.current = Date.now();
    // Guards against a slow earlier read landing after a newer one.
    let live = true;
    // The page's own reads; a reported error or a throw both become null (unknown), never an empty list.
    void loadManualApply('badge').then((r) => { if (live) setPageRows('error' in r ? null : r.rows); if ('error' in r) lastReadAt.current = 0; }).catch(() => { if (live) setPageRows(null); lastReadAt.current = 0; });
    // A failed read un-stamps itself (= 0 above), so the next click or tab return retries instead of waiting out the window.
    // A newer read supersedes this one.
    return () => { live = false; };
  }, [badgeRevision, auth.user?.id]);
  /* TRIGGERS 2 AND 3: data moved, so re-read the counts (and with them the badge).
   *
   * 2. A WRITE THIS TAB MADE. Every status move in this console is a POST to /rest/v1/rpc/<fn>
   *    (advance_application_status from Approvals, Applied, Discovered, System health and Manual apply;
   *    track_email_as_applied from Emails), and the server-side movers (intake, pipeline runs, scouts,
   *    gmail-sync, the kit rebuild) are /functions/v1/<fn> calls. Rather than make each of those pages
   *    remember to say "I moved something" (five rpc call sites plus every edge call, and the one that forgets leaves a stale
   *    badge), the shell watches the platform's own record of finished requests: a PerformanceObserver
   *    on 'resource' entries fires after each response lands, so the write is committed before the
   *    re-read. Fail-safe by design: ANY rpc except the counts read itself, and ANY edge function, counts
   *    as a possible move, so a new mover is covered without touching this file. The price is an extra
   *    read after a read-only function call (an AI resume edit), a cheap over-refresh, never a stale one.
   *    ponytail: URL matching, because resource entries carry no HTTP method; a fetch wrapper in
   *    data/supabase.ts would see the method and could match writes exactly, if this ever over-reads.
   * 3. A RETURN TO THE TAB after more than a minute away: agents move rows on their own schedule (the
   *    worker, the cron sweeps), and before 2026-11-08 the next click picked that up. Re-reading on
   *    return keeps that freshness for the cost of one read per absence, not one per click. */
  useEffect(() => {
    // Nothing to keep fresh without an operator; the gate is showing.
    if (auth.user?.id === undefined) return;
    // Pending coalesced re-read: an "approve all" sends many moves, and one re-read after the last is enough.
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Each batch of finished requests, checked for a possible move.
    const observer = new PerformanceObserver((list) => {
      // Only a request that can change a status or a kit matters; the shell's own reads must not loop.
      if (!list.getEntries().some((entry) => mayMoveData(entry.name))) return;
      // Restart the wait, so a burst of moves costs one re-read.
      clearTimeout(timer);
      // 300 ms: long enough to coalesce a burst, short enough that the badge looks immediate.
      timer = setTimeout(refreshShell, 300);
    });
    // Only requests that finish from now on; earlier ones were already reflected in the first read.
    observer.observe({ type: 'resource' });
    // The tab came back into view.
    const onVisibility = () => {
      // Hidden is the tab going away; only the return can show stale numbers.
      if (document.visibilityState !== 'visible') return;
      // Away for a minute or less: the last read is still a fair picture, so skip the round trips.
      if (Date.now() - lastReadAt.current <= SHELL_READ_STALE_MS) return;
      // Away longer: agents may have moved rows meanwhile.
      refreshShell();
    };
    // Document-level: visibilitychange fires on document, not window.
    document.addEventListener('visibilitychange', onVisibility);
    // Sign-out or unmount: stop watching, and drop a re-read that has not fired yet.
    return () => {
      // No more entries delivered.
      observer.disconnect();
      // A pending re-read for a signed-out operator would be wasted.
      clearTimeout(timer);
      // The listener goes with the effect that added it.
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [auth.user?.id, refreshShell]);
  /* TRIGGER 4: a navigation after the last read went stale. Background agents (the worker, the cron
     sweeps) move statuses all day, and until 2026-11-08 every click re-read the counts, so Teja never saw
     a number older than his last click. Re-reading only past the window keeps that promise to within a
     minute while clicks inside it cost 0 requests (the whole point of the store). Keyed on pathname only:
     the user id is read from the render that changed the path, and adding it would re-read on sign-in
     on top of TRIGGER 1. The mount run is a no-op, because lastReadAt is seeded with the mount time. */
  useEffect(() => {
    // No operator: the gate is showing, nothing to refresh.
    if (auth.user?.id === undefined) return;
    // Read within the window: still a fair picture, so this click costs nothing.
    if (Date.now() - lastReadAt.current <= SHELL_READ_STALE_MS) return;
    // Stale: one re-read of the counts and the badge for this click; the next clicks ride on it.
    refreshShell();
  }, [pathname]);
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

/* How old the last counts+badge read may be before a tab return (TRIGGER 3) or a navigation (TRIGGER 4)
   re-reads them. One constant: both answer "how stale may the rail be". A minute: shorter re-reads on
   nearly every click again, longer lets an agent's moves sit unseen through a coffee break. */
const SHELL_READ_STALE_MS = 60_000;

/* Whether a finished request (a resource entry's absolute URL) could have moved a status or a kit
   (TRIGGER 2 above). Any edge function, and any RPC but the counts read, which would otherwise re-trigger
   itself forever. Plain table reads (GET /rest/v1/<table>) never match, so page loads cost nothing. */
function mayMoveData(url: string): boolean {
  // A non-URL entry name (none expected) cannot be a Supabase call.
  if (!URL.canParse(url)) return false;
  // Only the path matters; the host is the one Supabase project.
  const { pathname } = new URL(url);
  // Edge functions: intake, pipeline runs, scouts, gmail-sync, the kit rebuild all move data server-side.
  if (pathname.startsWith('/functions/v1/')) return true;
  // Every RPC except the counts read itself.
  return pathname.startsWith('/rest/v1/rpc/') && pathname !== '/rest/v1/rpc/application_status_counts';
}
