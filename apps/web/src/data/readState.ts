/* What a read from the database actually came back as.
 *
 * THE PROBLEM THIS SOLVES, and it is the central honesty problem of the whole
 * console. An empty table on screen has at least four distinct causes:
 *
 *   1. The console is not configured - no Supabase client exists at all.
 *   2. It is configured but nobody is signed in, so RLS correctly returns
 *      nothing. (This is the state the project is in RIGHT NOW: the schema is
 *      live and there is no Auth user yet, so zero rows is CORRECT behaviour
 *      and not a bug.)
 *   3. The query failed - network, permissions, a malformed filter.
 *   4. It genuinely succeeded and there are no rows.
 *
 * Only the fourth means "you have no applications". The other three mean "this
 * console cannot tell you how many applications you have", which is a
 * completely different sentence and demands a different response from the
 * operator. Rendering `0` for all four is the single most misleading thing this
 * app could do - and it is the DEFAULT behaviour of almost every data-fetching
 * hook, because `rows ?? []` collapses every one of those cases into an empty
 * array.
 *
 * That default is exactly the failure section 14 is about, one layer up: not an
 * error, not a crash, just a confident zero that means nothing. Teja would read
 * an empty pipeline as "the automation found nothing today" when the truth was
 * "nobody is signed in", and the two look identical.
 *
 * So this module makes the distinction unrepresentable-if-ignored: the result is
 * a discriminated union, and a caller cannot get at rows without having handled
 * every other case first. The compiler enforces the honesty.
 *
 * Naming the pattern: this is the same move as `IngestResult` and
 * `SupabaseConfig` - MAKE THE AMBIGUOUS STATE A SEPARATE VARIANT rather than a
 * falsy value. A nullable array cannot express why it is empty.
 *
 * WHY IT IS PURE. It classifies inputs it is handed; it performs no query. That
 * is what lets every branch be tested, including ones that are hard to produce
 * against a real database - a failed query, or a session that vanished
 * mid-flight. Same reasoning as keyRole.ts and supabaseConfig.ts.
 */

/* --- What a caller must be given to classify a read ------------------ */

/* The raw facts about one attempted read. Deliberately primitive - booleans and
 * a nullable array - so this module never needs to know about Supabase types,
 * and so a test can construct any combination including impossible-looking
 * ones. */
export interface ReadFacts<T> {
  /* Is there a client at all? False when the console is unconfigured. */
  readonly clientPresent: boolean;
  /* Which env vars are missing, for the unconfigured message. Empty when the
     client is present. */
  readonly missingEnv: readonly string[];
  /* Is somebody signed in? RLS scopes every row by `auth.uid()`, so with no
     session there is nothing to return and that is correct rather than
     broken. */
  readonly signedIn: boolean;
  /* Still in flight. Checked before the others, because a loading read has no
     meaningful answer yet. */
  readonly loading: boolean;
  /* The error the query returned, if it failed. */
  readonly error: string | null;
  /* The rows, or null when there was nothing to read. NULL AND EMPTY ARE
     DIFFERENT: null means "no successful read happened", `[]` means "a read
     succeeded and found nothing". Collapsing them is the bug this whole file
     exists to prevent. */
  readonly rows: readonly T[] | null;
}

/* --- The classified outcome ------------------------------------------ */

export type ReadState<T> =
  /* Nothing is configured. Not a failure - the normal state of a fresh clone. */
  | { readonly kind: 'unconfigured'; readonly missingEnv: readonly string[] }
  /* In flight. */
  | { readonly kind: 'loading' }
  /* Configured, but nobody is signed in. RLS returns nothing, correctly.
   * A SEPARATE VARIANT FROM `empty` on purpose: the operator's action differs
   * completely - sign in, versus accept that there is no work today. */
  | { readonly kind: 'no_session' }
  /* The read failed. Carries the message, because "something went wrong" sends
   * nobody anywhere useful. */
  | { readonly kind: 'failed'; readonly message: string }
  /* A read genuinely succeeded and returned nothing. THE ONLY STATE THAT MAY
   * BE RENDERED AS "you have none". */
  | { readonly kind: 'empty' }
  /* A read succeeded and returned rows. */
  | { readonly kind: 'rows'; readonly rows: readonly T[] };

/* Classify one attempted read.
 *
 * ORDER MATTERS HERE and each step is ordered by what it would be dishonest to
 * skip. Configuration before session, session before error, error before rows:
 * an unconfigured console has no session to report on, and a failed query's
 * empty row array is not evidence of anything. Getting this order wrong is how
 * a "no rows" message ends up shown to someone whose query actually errored. */
export function classifyRead<T>(facts: ReadFacts<T>): ReadState<T> {
  /* First, because with no client nothing below is meaningful - there was no
     query to succeed, fail or return nothing. */
  if (!facts.clientPresent) {
    return { kind: 'unconfigured', missingEnv: facts.missingEnv };
  }

  /* Before the session check: while a read is in flight we do not yet know
     whether it will fail or return nothing, and guessing either would flicker a
     wrong answer onto the screen for a moment. A brief wrong answer is still a
     wrong answer, and on this console it is the kind someone might act on. */
  if (facts.loading) {
    return { kind: 'loading' };
  }

  /* An error takes precedence over the session state: a query that failed for a
     network reason should say so rather than blaming a missing sign-in, which
     would send the operator to fix the wrong thing. */
  if (facts.error !== null) {
    return { kind: 'failed', message: facts.error };
  }

  /* No session means RLS had nothing to scope to. Reported as its own state
     rather than as zero rows - "sign in" and "no work today" are different
     sentences and only one of them is actionable. */
  if (!facts.signedIn) {
    return { kind: 'no_session' };
  }

  /* NULL, NOT EMPTY. No successful read has happened, so there is nothing to
     report - and specifically we must not report `empty`, which is a positive
     claim that the database was asked and answered. */
  if (facts.rows === null) {
    return { kind: 'loading' };
  }

  /* Now, and only now, an empty array is a real answer: configured, signed in,
     query succeeded, nothing there. */
  if (facts.rows.length === 0) {
    return { kind: 'empty' };
  }

  return { kind: 'rows', rows: facts.rows };
}

/* --- Rendering helpers ----------------------------------------------- */

/* One short phrase for a state that has no rows to show.
 *
 * Returns null for `rows`, because a caller with rows should render them rather
 * than a phrase. Centralised so the same state never gets two different
 * wordings on two different pages - the operator learns one vocabulary, and
 * "not connected" always means the same thing.
 *
 * Every phrase is written to be unmistakable at a glance in a table cell, and
 * NONE of them is the digit zero. */
export function describeEmptyState<T>(state: ReadState<T>): string | null {
  switch (state.kind) {
    case 'unconfigured':
      /* Named variables rather than "check your config". */
      return 'not connected — ' + state.missingEnv.join(', ') + ' not set';
    case 'loading':
      return 'reading…';
    case 'no_session':
      /* Says the cause AND that it is expected, because right now it is: there
         is no Auth user in this system yet. Without that clause the operator
         would reasonably think something is broken. */
      return 'not signed in — no rows are visible until you are';
    case 'failed':
      return 'could not read: ' + state.message;
    case 'empty':
      /* The one honest "there are none". Still words rather than 0, so that a
         glance cannot mistake it for one of the states above. */
      return 'none';
    case 'rows':
      return null;
  }
}

/* Is this state safe to draw a conclusion from?
 *
 * A NAMED PREDICATE, for the reason `humanLanes.ts` taught this codebase: a
 * check whose name does not state its predicate invites two readers to assume
 * different ones. Used to decide whether a count may be shown as a number at
 * all, or whether it must be shown as a phrase.
 *
 * Note what this does NOT claim. It says the console received a real answer -
 * not that the answer is correctly row-scoped. RLS policies in this project are
 * confirmed to EXIST but have never been exercised as `authenticated`; every
 * verifying query ran as `postgres`, which holds BYPASSRLS, so a policy with an
 * inverted predicate would look identical when listed. Until that proof lands,
 * "conclusive" means "the database answered", which is strictly weaker than
 * "the answer is right". */
export function isConclusive<T>(state: ReadState<T>): boolean {
  return state.kind === 'rows' || state.kind === 'empty';
}
