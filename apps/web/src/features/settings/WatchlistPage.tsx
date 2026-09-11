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

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

import { PageHeader } from '../../app/PageHeader';
/* The provider vocabulary comes from the schema: the Applier routes submissions
   on `ats_provider`, so a token stored against the wrong provider is polled
   with the wrong API and submitted through the wrong adapter. */
import { ATS_PROVIDERS } from '../../data/contract';
import type { AtsProvider, CompanyWatchlistRow } from '../../data/contract';
import { supabase } from '../../data/supabase';

import { CompanySuggestionsModal } from './CompanySuggestionsModal';
import type { SuggestedCompany } from './companyCatalog';

import './settings.css';

/* Supported direct-poll ATS providers */
const SELECTABLE_ATS_PROVIDERS: readonly AtsProvider[] = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'smartrecruiters',
];

/* --- What a board token looks like per provider ----------------------- */

interface ProviderHint {
  readonly where: string;
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
    where: 'The company identifier in the SmartRecruiters careers URL.',
    example: 'careers.smartrecruiters.com/ExampleCo -> token is ExampleCo',
  },
  unknown: {
    where: 'Not a board to poll.',
    example: 'Never entered on this page.',
  },
  other: {
    where: 'Custom board without standard adapter.',
    example: 'Not a URL shape.',
  },
};

/* --- The page --------------------------------------------------------- */

export function WatchlistPage(): ReactElement {
  const [rows, setRows] = useState<readonly CompanyWatchlistRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState<boolean>(false);

  /* Form state */
  const [companyName, setCompanyName] = useState<string>('');
  const [atsProvider, setAtsProvider] = useState<AtsProvider>('greenhouse');
  const [boardToken, setBoardToken] = useState<string>('');

  const loadWatchlist = useCallback(async () => {
    if (supabase === null) {
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const { data, error: fetchErr } = await supabase
        .from('company_watchlist')
        .select('*')
        .order('company_name', { ascending: true });

      if (fetchErr) {
        setError(`Failed to fetch watchlist: ${fetchErr.message}`);
      } else if (data) {
        setRows(data as CompanyWatchlistRow[]);
      }
    } catch (err) {
      setError(`Unexpected error: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWatchlist();
  }, [loadWatchlist]);

  /* Handle add target company board */
  const handleAddBoard = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (supabase === null) {
      setError('Supabase is not configured in this environment.');
      return;
    }

    const trimmedName = companyName.trim();
    const trimmedToken = boardToken.trim();

    if (!trimmedName || !trimmedToken) {
      setError('Company name and board token are required.');
      return;
    }

    const slug = trimmedName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    try {
      setSubmitting(true);
      setError(null);
      setSuccess(null);

      const { error: insertErr } = await supabase.from('company_watchlist').insert({
        company_name: trimmedName,
        company_slug: slug,
        ats_provider: atsProvider,
        board_token: trimmedToken,
        enabled: true,
      });

      if (insertErr) {
        if (insertErr.code === '23505') {
          setError(`Board token "${trimmedToken}" is already registered under ${atsProvider}.`);
        } else {
          setError(`Insert failed: ${insertErr.message}`);
        }
        return;
      }

      setSuccess(`Added ${trimmedName} (${atsProvider}) to company watchlist.`);
      setCompanyName('');
      setBoardToken('');
      await loadWatchlist();
    } catch (err) {
      setError(`Insert failed: ${String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  /* Handle 1-click add from suggestions modal */
  const handleAddSuggestedCompany = async (company: SuggestedCompany): Promise<boolean> => {
    if (supabase === null) {
      setError('Supabase is not configured in this environment.');
      return false;
    }

    const trimmedName = company.name.trim();
    const trimmedToken = company.atsIdentifier.trim();

    if (!trimmedName || !trimmedToken) {
      setError('Company name and board token are required.');
      return false;
    }

    const slug = trimmedName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    try {
      setError(null);
      setSuccess(null);

      const { error: insertErr } = await supabase.from('company_watchlist').insert({
        company_name: trimmedName,
        company_slug: slug,
        ats_provider: company.atsProvider,
        board_token: trimmedToken,
        enabled: true,
      });

      if (insertErr) {
        if (insertErr.code === '23505') {
          setError(`Board token "${trimmedToken}" is already registered under ${company.atsProvider}.`);
        } else {
          setError(`Insert failed: ${insertErr.message}`);
        }
        return false;
      }

      setSuccess(`Added ${trimmedName} (${company.atsProvider}) to company watchlist.`);
      await loadWatchlist();
      return true;
    } catch (err) {
      setError(`Insert failed: ${String(err)}`);
      return false;
    }
  };

  /* Handle toggle enabled/paused status */
  const handleToggle = async (id: string, currentlyEnabled: boolean): Promise<void> => {
    if (supabase === null) return;

    // Optimistic local state update
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, enabled: !currentlyEnabled } : r)),
    );

    const { error: updateErr } = await supabase
      .from('company_watchlist')
      .update({ enabled: !currentlyEnabled })
      .eq('id', id);

    if (updateErr) {
      setError(`Failed to update board status: ${updateErr.message}`);
      await loadWatchlist();
    }
  };

  /* Handle delete board */
  const handleDelete = async (id: string, name: string): Promise<void> => {
    if (supabase === null) return;

    const { error: delErr } = await supabase
      .from('company_watchlist')
      .delete()
      .eq('id', id);

    if (delErr) {
      setError(`Failed to remove ${name}: ${delErr.message}`);
    } else {
      setRows((prev) => prev.filter((r) => r.id !== id));
      setSuccess(`Removed ${name} from watchlist.`);
    }
  };

  const activeCount = rows.filter((r) => r.enabled).length;
  const totalPolls = rows.reduce((acc, r) => acc + (r.poll_count || 0), 0);

  return (
    <div className="page">
      <PageHeader path="watchlist" />

      {/* Overview Stat Counters */}
      <div className="watchlist-stats">
        <div className="watchlist-stat-card">
          <span className="watchlist-stat-card__val">{rows.length}</span>
          <span className="watchlist-stat-card__label">Target Boards</span>
        </div>
        <div className="watchlist-stat-card">
          <span className="watchlist-stat-card__val">{activeCount}</span>
          <span className="watchlist-stat-card__label">Active Polling</span>
        </div>
        <div className="watchlist-stat-card">
          <span className="watchlist-stat-card__val">{totalPolls}</span>
          <span className="watchlist-stat-card__label">Historical Polls</span>
        </div>
      </div>

      {/* Add Board Form */}
      <section className="settings-group">
        <div className="settings-group__header-row">
          <div>
            <h2 className="settings-group__title">Add Company Target Board</h2>
            <p className="settings-group__note">
              Register a company careers board for autonomous job discovery. The Scout polls
              each board&apos;s direct API endpoint rather than scraping HTML.
            </p>
          </div>
          <button
            type="button"
            className="button button--suggest"
            onClick={() => setSuggestionsOpen(true)}
          >
            ✨ Suggest Companies
          </button>
        </div>

        {error && <div className="watchlist-feedback watchlist-feedback--error">{error}</div>}
        {success && (
          <div className="watchlist-feedback watchlist-feedback--success">{success}</div>
        )}

        <form onSubmit={handleAddBoard} className="watchlist-add-form">
          <div className="watchlist-add-row">
            <label className="field">
              <span className="field__label">Company Name</span>
              <input
                type="text"
                className="field__control"
                placeholder="e.g. Stripe, OpenAI, Figma"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                disabled={submitting}
                required
              />
            </label>

            <label className="field">
              <span className="field__label">ATS Provider</span>
              <select
                className="field__control"
                value={atsProvider}
                onChange={(e) => setAtsProvider(e.target.value as AtsProvider)}
                disabled={submitting}
              >
                {SELECTABLE_ATS_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field__label">ATS Identifier (Board Slug)</span>
              <input
                type="text"
                className="field__control identifier"
                placeholder="e.g. stripe, openai, figma"
                value={boardToken}
                onChange={(e) => setBoardToken(e.target.value)}
                disabled={submitting}
                required
              />
            </label>

            <button
              type="submit"
              className="button button--approve"
              disabled={submitting}
            >
              {submitting ? 'Adding...' : 'Add Board'}
            </button>
          </div>

          <p className="field__help">
            <strong>What ATS Identifier does:</strong> The exact company slug or board token on the ATS provider (e.g. &quot;stripe&quot; in boards.greenhouse.io/stripe or &quot;figma&quot; in jobs.ashbyhq.com/figma). The Scout agent uses this to query official JSON API endpoints directly without scraping. {PROVIDER_HINTS[atsProvider]?.example ? `Example: ${PROVIDER_HINTS[atsProvider]?.example}` : ''}
          </p>
        </form>
      </section>

      {/* Active Watchlist Table */}
      <section className="settings-group">
        <h2 className="settings-group__title">Watched Company Boards</h2>
        <p className="settings-group__note">
          Boards currently registered in Supabase. The Scout polls enabled boards on cron.
        </p>

        {loading ? (
          <p className="watchlist-empty-state">Loading company watchlist from Supabase...</p>
        ) : rows.length === 0 ? (
          <div className="watchlist-empty-state">
            No company boards added yet. Use the form above to register target employers.
          </div>
        ) : (
          <div className="settings-table-wrap">
            <table className="settings-table">
              <thead>
                <tr>
                  <th scope="col">Company</th>
                  <th scope="col">ATS Provider</th>
                  <th scope="col">Board Token</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last Poll</th>
                  <th scope="col">Poll Count</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.company_name}</strong>
                      <div className="identifier" style={{ fontSize: '0.75rem', color: 'var(--ink-muted)' }}>
                        {row.company_slug}
                      </div>
                    </td>
                    <td>
                      <span className="badge-ats">{row.ats_provider}</span>
                    </td>
                    <td>
                      <code className="identifier">{row.board_token}</code>
                    </td>
                    <td>
                      <span
                        className={
                          row.enabled
                            ? 'badge-status badge-status--active'
                            : 'badge-status badge-status--paused'
                        }
                      >
                        {row.enabled ? '● Polling' : '○ Paused'}
                      </span>
                    </td>
                    <td>
                      {row.last_polled_at ? (
                        new Date(row.last_polled_at).toLocaleDateString()
                      ) : (
                        <span className="unknown">Never polled</span>
                      )}
                      {row.consecutive_failures > 0 && (
                        <span
                          className="identifier"
                          style={{ color: 'var(--fabricated)', marginLeft: '6px', fontSize: '0.75rem' }}
                          title="Consecutive failures"
                        >
                          ({row.consecutive_failures} fail)
                        </span>
                      )}
                    </td>
                    <td className="identifier">{row.poll_count}</td>
                    <td>
                      <div className="watchlist-actions">
                        <button
                          type="button"
                          className="button--toggle"
                          onClick={() => handleToggle(row.id, row.enabled)}
                          title={row.enabled ? 'Pause polling for this company' : 'Resume polling for this company'}
                        >
                          {row.enabled ? 'Pause' : 'Enable'}
                        </button>
                        <button
                          type="button"
                          className="button--danger-outline"
                          onClick={() => handleDelete(row.id, row.company_name)}
                          title="Delete company from watchlist"
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Freshness vs Volume Architecture Principle */}
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

      {/* Cooldown Periods & Re-application Protection */}
      <section className="settings-group">
        <h2 className="settings-group__title">Application cooldown periods & lockout protection</h2>
        <p className="settings-group__note">
          <strong>What Cooldown does:</strong> Employers and ATS systems track candidate submission history. Following a screening or interview rejection, companies enforce a mandatory cooldown window (typically 3 to 6 months) during which subsequent applications are automatically filtered or discarded.
        </p>
        <p className="settings-group__note">
          The system checks your historical application log and active blocklist before submitting, preventing wasted quota on locked-out boards and protecting your candidate profile.
        </p>
      </section>

      {/* Token Guidance per ATS */}
      <section className="settings-group">
        <h2 className="settings-group__title">Where to find an ATS identifier slug</h2>
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
                <th scope="col">Provider</th>
                <th scope="col">Where the token is</th>
                <th scope="col">Example</th>
              </tr>
            </thead>
            <tbody>
              {ATS_PROVIDERS.map((provider) => {
                const hint = PROVIDER_HINTS[provider];
                return (
                  <tr key={provider}>
                    <th scope="row" className="identifier">
                      {provider}
                    </th>
                    <td>
                      {hint === undefined ? (
                        <span className="unknown">
                          Supported by the schema but not yet documented on this page.
                        </span>
                      ) : (
                        hint.where
                      )}
                    </td>
                    <td>
                      {hint === undefined ? (
                        <span className="unknown">&mdash;</span>
                      ) : (
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
      <CompanySuggestionsModal
        isOpen={suggestionsOpen}
        onClose={() => setSuggestionsOpen(false)}
        existingRows={rows}
        onAddCompany={handleAddSuggestedCompany}
      />
    </div>
  );
}

