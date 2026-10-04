/* The console's navigation map.
 *
 * Declared as data rather than as JSX so the nav rail and the router read the
 * same list. Two hand-maintained copies is how a page ends up reachable by URL
 * but absent from the rail, or listed in the rail and 404 when clicked.
 *
 * The nine pages are PROJECT_PLAN.md section 15. They are grouped because they
 * are not peers: six configure the system and are visited occasionally, three
 * are worked daily. A flat list of nine would give the Approval Queue - which
 * Teja opens every day - the same prominence as the Blocklist, which he will
 * touch once a month.
 */

/* One entry in the rail. `path` is relative to the app root and doubles as the
 * route path, so there is no second string to keep in step. */
export interface ConsoleRoute {
  readonly path: string;
  /* What the operator calls this screen. Named for what it does rather than
   * for the table behind it: "Answer Bank", not "answer_bank rows". */
  readonly label: string;
  /* One line of orientation, shown under the page title. Written from the
   * operator's perspective and in plain terms. */
  readonly lede: string;
}

export interface ConsoleSection {
  readonly heading: string;
  readonly routes: readonly ConsoleRoute[];
}

/* The daily work. These three are where the operator spends the ~12 minutes a
 * day the whole system is built around, so they come first. */
export const OPERATIONS_SECTION: ConsoleSection = {
  heading: 'Operations',
  routes: [
    {
      path: 'approvals',
      label: 'Approval queue',
      lede: 'Review and approve tailored applications before submission.',
    },
    {
      path: 'pipeline',
      label: 'Pipeline',
      lede: 'Status tracking across active and submitted applications.',
    },
    {
      path: 'discovered',
      label: 'Discovered jobs',
      lede: 'Explore discovered jobs across watched ATS career pages and hiring feeds.',
    },
    {
      path: 'health',
      label: 'System health',
      lede: 'Automation status, worker freshness, and database connectivity.',
    },
    {
      path: 'emails',
      label: 'Email monitoring',
      lede: 'Recruiter communication feed, interview detection, and application stages.',
    },
    /* Added referral queue route so users can review cold outreach drafts. */
    {
      path: 'referrals',
      label: 'Referral queue',
      lede: 'Review and send cold referral outreach drafts to company contacts.',
    },
    /* Added follow-up nudges route to manage day-7 emails. */
    {
      path: 'nudges',
      label: 'Follow-up nudges',
      lede: 'Manage Day-7 post-application follow-up email drafts.',
    },
    /* Added skill gap analytics route to review missing technologies. */
    {
      path: 'skill-gap',
      label: 'Skill gap analytics',
      lede: 'Ranked missing technologies across scored and rejected applications.',
    },
  ],
};

export const CONFIGURATION_SECTION: ConsoleSection = {
  heading: 'Configuration',
  routes: [
    {
      path: 'search-preferences',
      label: 'Search preferences',
      lede: 'Target job titles, required skills, locations, and compensation limits.',
    },
    {
      path: 'master-profile',
      label: 'Master profile',
      lede: 'Structured source resume data used for generating tailored applications.',
    },
    {
      path: 'answer-bank',
      label: 'Answer bank',
      lede: 'Reusable answers for common application and screening questions.',
    },
    {
      path: 'filters',
      label: 'Filters',
      lede: 'Automated pre-screening rules and discard thresholds.',
    },
    {
      path: 'watchlist',
      label: 'Company watchlist',
      lede: 'Target company career pages and ATS boards to monitor.',
    },
    {
      path: 'blocklist',
      label: 'Blocklist',
      lede: 'Excluded companies and recruitment agencies.',
    },
  ],
};

/* Rail order. Operations above configuration, matching how often each is used. */
export const CONSOLE_SECTIONS: readonly ConsoleSection[] = [
  OPERATIONS_SECTION,
  CONFIGURATION_SECTION,
];

/* Flat list, for the router and for the "is this a real route" check. Derived
 * so adding a page to a section is the only edit needed. */
export const ALL_ROUTES: readonly ConsoleRoute[] = CONSOLE_SECTIONS.flatMap(
  (section) => section.routes,
);

/* Where `/` sends the operator. The approval queue, because a waiting approval
 * is time-sensitive in a way that a settings page never is - and because at 35
 * applications a day, something is usually waiting. */
export const DEFAULT_ROUTE = 'approvals';

/* The tab title when no route matches, kept identical to index.html's <title>
 * so a 404 or the bare `/` redirect reads the same as the first paint. */
export const DEFAULT_DOCUMENT_TITLE = 'applyy — application console';

/* The browser-tab title for a pathname, e.g. "/approvals" -> "Approval queue · applyy".
 * Derived from ALL_ROUTES rather than a second table, for the same reason the
 * rail and router share this file: a title map kept by hand drifts from the
 * routes it names. Pure, so the mapping is testable without a DOM. */
export function documentTitleFor(pathname: string): string {
  /* First segment only, so a nested path (a detail view under a page) keeps
     its parent page's title instead of falling back to the generic one. */
  const segment = pathname.replace(/^\/+/, '').split('/')[0] ?? '';
  /* Exact match against the declared paths: a prefix match would let a future
     "filters-archive" borrow the "Filters" title. */
  const route = ALL_ROUTES.find((candidate) => candidate.path === segment);
  /* Label first, product second: the tab strip truncates from the right, and
     with fourteen screens open the page name is the part that must survive. */
  return route === undefined ? DEFAULT_DOCUMENT_TITLE : `${route.label} · applyy`;
}
