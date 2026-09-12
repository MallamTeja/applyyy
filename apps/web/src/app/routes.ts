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
