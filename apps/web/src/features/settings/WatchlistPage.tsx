/* Company watchlist - PROJECT_PLAN.md section 15, row "Company Watchlist".
 *
 * WHAT THIS PAGE CONTROLS. The Scout does not crawl the web; it polls named
 * job boards through their own APIs. Each row here is one company's board on
 * one ATS provider, identified by that provider's board token - the short
 * string in a careers URL, such as the `stripe` in
 * `boards.greenhouse.io/stripe`. No token, no jobs: this list IS the funnel,
 * and everything downstream can only be as good as what enters here.
 *
 * WHY THIS PAGE MATTERS MORE THAN IT LOOKS. The three-day freshness rule
 * (section 13) throws away anything posted more than a few days ago, which is
 * correct - recruiters read in arrival order and often stop around the
 * fiftieth application - but it means each board only yields whatever it posted
 * this week. A small watchlist plus a tight freshness window is how the
 * pipeline runs dry while every agent reports itself perfectly healthy. That is
 * the trade-off to understand before tuning either: FRESHNESS AND VOLUME PULL
 * AGAINST EACH OTHER, and the watchlist is the dial that buys back volume
 * without loosening honesty or freshness.
 *
 * WHY POLLING STATS BELONG ON THIS PAGE. `CompanyWatchlistRow` carries
 * `last_polled_at`, `last_poll_job_count` and `consecutive_failures`. A board
 * whose token has gone stale - the company moved ATS, or renamed itself -
 * returns zero jobs rather than an error, so it keeps being polled forever and
 * contributes nothing. Zero-yield and failure counts are the only way to see
 * that. Same shape as section 14's silent deaths, one level down: the thing
 * that stops does not complain.
 */

import type { ReactElement } from 'react';

import { PageHeader } from '../../app/PageHeader';
/* The provider vocabulary comes from the schema: the Applier routes submissions
   on `ats_provider`, so a token stored against the wrong provider is polled
   with the wrong API and submitted through the wrong adapter. */
import { ATS_PROVIDERS } from '../../data/contract';
import type { AtsProvider } from '../../data/contract';

import './settings.css';

/* --- What a board token looks like per provider ----------------------- */

/* Guidance per ATS, because the single most likely mistake on this page is
 * pasting a full careers URL into a field that wants only the token - and the
 * failure mode is a board that silently yields nothing rather than an error
 * anybody sees.
 *
 * Keyed by the schema's `AtsProvider` and PARTIAL on purpose: a provider added
 * upstream still renders here with its raw name instead of disappearing from
 * the guidance table. A missing hint is cosmetic; a missing provider would mean
 * an operator cannot tell whether it is supported. */
interface ProviderHint {
  /* Where the operator finds the token, in concrete terms. */
  readonly where: string;
  /* A real example of the URL shape, with the token part called out. Concrete
     beats abstract here - "the slug" means nothing until you have seen one. */
  readonly example: string;
}

const PROVIDER_HINTS: Readonly<Partial<Record<AtsProvider, ProviderHint>>> = {
  greenhouse: {
    where: 'The last path segment of the public board URL.',
    example: 'boards.greenhouse.io/EXAMPLECO -> token is EXAMPLECO',
  },
  lever: {
    where: 'The company segment of the Lever jobs URL.',
    example: 'jobs.lever.co/EXAMPLECO -> token is EXAMPLECO',
  },
  ashby: {
    where: 'The board name in the Ashby hosted jobs URL.',
    example: 'jobs.ashbyhq.com/EXAMPLECO -> token is EXAMPLECO',
  },
  workable: {
    where: 'The company subdomain of the Workable-hosted careers site.',
    example: 'apply.workable.com/EXAMPLECO -> token is EXAMPLECO',
  },
  smartrecruiters: {
    where: 'The company identifier in the SmartRecruiters careers URL. Note it is usually the company name with spaces removed rather than hyphenated.',
    example: 'careers.smartrecruiters.com/ExampleCo -> token is ExampleCo',
  },
  unknown: {
    where: 'Not a board to poll, and nothing to enter here. This value means a discovered job has an apply URL that no adapter recognises, so it routes to a person instead of being submitted.',
    example: 'Never entered on this page.',
  },
  other: {
    where: 'A board the Scout can reach but that has no dedicated adapter. Entering one here is only useful once an adapter exists, since polling and submitting are separate capabilities.',
    example: 'Not a URL shape - depends on the board.',
  },
};

/* --- The page --------------------------------------------------------- */

export function WatchlistPage(): ReactElement {
  return (
    <div className="page">
      <PageHeader path="watchlist" />

      {/* Honest state first, in the shared idiom. */}
      <p className="not-wired">
        This page is laid out but not yet reading or writing{' '}
        <span className="identifier">company_watchlist</span>. Nothing typed
        here is stored, and no board is being polled.
      </p>

      {/* The trade-off, stated up front, because it is the one thing that will
          make the operator want to add boards rather than treat this as a
          set-and-forget list. */}
      <section className="settings-group">
        <h2 className="settings-group__title">Freshness and volume pull against each other</h2>
        <p className="settings-group__note">
          Only jobs posted in the last few days survive the staleness filter,
          and that rule is worth keeping - applying inside a day of a posting
          beats any amount of resume tweaking, because recruiters read in
          arrival order and often stop around the fiftieth.
        </p>
        <p className="settings-group__note">
          But it means each board only ever yields what it posted this week. A
          short watchlist plus a tight window is how the pipeline quietly runs
          dry while every agent reports itself healthy. If you are seeing very
          few applications a day, add boards here before you loosen the
          freshness rule on the Filters page.
        </p>
      </section>

      {/* Token guidance, driven off the provider enum. */}
      <section className="settings-group">
        <h2 className="settings-group__title">Where to find a board token</h2>
        <p className="settings-group__note">
          A board token is the short company identifier in a careers URL, not
          the URL itself. Pasting a whole URL is the usual mistake, and it fails
          quietly: the board returns nothing and keeps returning nothing, which
          looks exactly like a company that is not hiring.
        </p>
        <div className="settings-table-wrap">
          <table className="settings-table">
            <thead>
              <tr>
                {/* The schema's own provider value, so what is shown here
                    matches what gets stored and what the Applier routes on. */}
                <th scope="col">Provider</th>
                <th scope="col">Where the token is</th>
                <th scope="col">Example</th>
              </tr>
            </thead>
            <tbody>
              {ATS_PROVIDERS.map((provider) => {
                /* Undefined for a provider the schema added and this page has
                   not been taught about - stated rather than blank. */
                const hint = PROVIDER_HINTS[provider];
                return (
                  <tr key={provider}>
                    <th scope="row" className="identifier">
                      {provider}
                    </th>
                    <td>
                      {hint === undefined ? (
                        <span className="unknown">
                          Supported by the schema but not yet documented on this
                          page.
                        </span>
                      ) : (
                        hint.where
                      )}
                    </td>
                    <td>
                      {hint === undefined ? (
                        <span className="unknown">&mdash;</span>
                      ) : (
                        /* Rendered as plain text. Every example here is ours
                           rather than fetched, but the field this describes is
                           operator input that ends up next to untrusted board
                           data, and keeping one rendering rule for the column
                           is cheaper than remembering which cell is safe. */
                        <span className="identifier">{hint.example}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* The stats panel: what to look at once boards are actually polling. */}
      <section className="settings-group">
        <h2 className="settings-group__title">Boards that have stopped yielding</h2>
        <p className="settings-group__note">
          A token goes stale when a company moves ATS or renames itself. The
          board then returns zero jobs rather than an error, so it keeps being
          polled forever and contributes nothing - indistinguishable from a
          company that simply is not hiring.
        </p>
        <p className="settings-group__note">
          The two numbers that separate those cases are the jobs returned on the
          last poll and the consecutive failure count. A board with a long run of
          zero-yield polls is worth re-checking by hand; one with rising
          failures has a token that no longer resolves.
        </p>
        <p className="not-wired">
          Reads <span className="identifier">last_polled_at</span>,{' '}
          <span className="identifier">last_poll_job_count</span> and{' '}
          <span className="identifier">consecutive_failures</span> from{' '}
          <span className="identifier">company_watchlist</span>. Not wired up
          yet.
        </p>
      </section>

      {/* The discovery lane that is decided but unassigned. Recorded in the UI
          because it is the operator's own open question, and because the answer
          changes what this page needs to offer. */}
      <section className="settings-group">
        <h2 className="settings-group__title">Not built: paste a job URL</h2>
        <p className="settings-group__note">
          A box to paste one job URL is the only discovery lane that reaches a
          posting the ATS APIs and the aggregators both miss, and it is the
          manual escape hatch for night one - before a real watchlist exists.
          It was decided in the design conversation and then appeared in no
          roster, page or phase, so it is recorded here as open rather than
          quietly built.
        </p>
      </section>
    </div>
  );
}
