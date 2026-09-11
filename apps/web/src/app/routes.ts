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
  heading: 'Every day',
  routes: [
    {
      /* The default landing route: if there is anything waiting, this is what
       * the operator opened the console to do. */
      path: 'approvals',
      label: 'Approval queue',
      lede: 'Check what the Tailor wrote before it goes out. Clean applications batch-approve together; anything the Auditor could not trace is reviewed one at a time.',
    },
    {
      path: 'pipeline',
      label: 'Pipeline',
      lede: 'Where every application stands. The email Tracker advances these on its own - this board reports, it does not drive.',
    },
    {
      path: 'health',
      label: 'System health',
      lede: 'Whether the automation is actually running. Nothing here fails loudly, so this page exists to notice when something has quietly stopped.',
    },
    {
      path: 'emails',
      label: 'Email monitoring',
      lede: 'Live feed of inbound recruiter emails, classification status, detected companies, and linked application stages.',
    },
  ],
};

/* The configuration surface. Nothing in this system is hardcoded: every filter
 * threshold, every search term and every standing answer lives in one of these
 * pages, which is why there are six of them rather than one settings screen. */
export const CONFIGURATION_SECTION: ConsoleSection = {
  heading: 'How it decides',
  routes: [
    {
      path: 'search-preferences',
      label: 'Search preferences',
      lede: 'What counts as a job worth finding: titles, keywords, locations, experience range and the salary floor.',
    },
    {
      path: 'master-profile',
      label: 'Master profile',
      lede: 'Your resume as structured fields. Every tailored resume is a selection and rewording of these, and nothing else. Editing creates a new version rather than changing an old one.',
    },
    {
      path: 'answer-bank',
      label: 'Answer bank',
      lede: 'Standing answers to the questions application forms ask. New questions land here for you to answer once, and then never again.',
    },
    {
      path: 'filters',
      label: 'Filters',
      lede: 'The cheap checks that run before any AI does. Most discovered jobs are rejected here, which is what keeps the running cost near zero.',
    },
    {
      path: 'watchlist',
      label: 'Company watchlist',
      lede: 'The job boards to poll. Freshness and volume trade against each other, so a three-day window needs a lot of boards.',
    },
    {
      path: 'blocklist',
      label: 'Blocklist',
      lede: 'Companies never to apply to. Without this, one staffing firm posting thirty near-identical listings gets thirty applications.',
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
