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
import type { AtsProvider, CompanyWatchlistRow } from '../../data/contract';
import { supabase } from '../../data/supabase';

import { CompanySuggestionsModal } from './CompanySuggestionsModal';
/* The dropdown offers only providers the Scout polls; the list and its registry parity
   test live in companyCatalog.ts, because node --test cannot import this .tsx (W24). */
// ADDABLE, not SELECTABLE: SmartRecruiters is still polled but never added (robots ruling 2026-11-01).
import { ADDABLE_ATS_PROVIDERS, isAddableCompany, type SuggestedCompany } from './companyCatalog';
import { DiscoveryModal } from '../pipeline/DiscoveryModal';

import './settings.css';

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
  // No `workable` hint: Workable is not selectable until its scout adapter is registered
  // (companyCatalog.ts SELECTABLE_ATS_PROVIDERS). Restore the hint when it is.
  // No `smartrecruiters` hint: SR boards are never added (robots ruling 2026-11-01), and this
  // hint only served the add-board select. Existing SR rows render from their own row data.
  // Workday's token packs three URL parts (tenant, wd number, site); the scout parses
  // it with one strict shape, so the hint spells that shape out exactly. An optional
  // `?facet=id,id` narrows a big board, but it is not hand-entered here.
  workday: {
    where: 'Tenant, wd number and site from the Workday careers URL, as tenant.wdN/site.',
    example: 'exampleco.wd5.myworkdayjobs.com/en-US/ExampleCareers -> token is exampleco.wd5/ExampleCareers',
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
  const [discoveryModalOpen, setDiscoveryModalOpen] = useState<boolean>(false);

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

    // The control behind the modal's display filter: a non-addable (SmartRecruiters) suggestion
    // is refused here even if one reaches this handler (robots ruling 2026-11-01).
    if (!isAddableCompany(company)) {
      // Says why, so the refusal is not mistaken for a network error.
      setError(`${company.atsProvider} boards are not added: robots.txt disallows them.`);
      // Nothing was written.
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
              Register company careers boards for automated job discovery.
            </p>
          </div>
          <button
            type="button"
            className="button button--suggest"
            onClick={() => setSuggestionsOpen(true)}
          >
            Suggest Target Companies
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
                {/* Addable providers only: SmartRecruiters is never offered for a new board (robots ruling 2026-11-01). */}
                {ADDABLE_ATS_PROVIDERS.map((p) => (
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
            Company identifier slug (e.g. &quot;stripe&quot; or &quot;figma&quot;). {PROVIDER_HINTS[atsProvider]?.example ? `Example: ${PROVIDER_HINTS[atsProvider]?.example}` : ''}
          </p>
        </form>
      </section>

      {/* Active Watchlist Table */}
      <section className="settings-group">
        <div className="settings-group__header-row">
          <div>
            <h2 className="settings-group__title">Watched Company Boards</h2>
            <p className="settings-group__note">
              Registered company boards monitored for new job postings.
            </p>
          </div>
          <button
            type="button"
            className="button button--primary"
            onClick={() => setDiscoveryModalOpen(true)}
            disabled={rows.length === 0}
            title="Scan active company ATS boards directly from browser"
          >
            Scan Watchlist Boards Now
          </button>
        </div>

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
                      <div className="identifier" style={{ color: 'var(--ink-muted)' }}>
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
                        {row.enabled ? 'Polling' : 'Paused'}
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
                          style={{ color: 'var(--fabricated)', marginLeft: '6px', fontSize: 'var(--size-xs)' }}
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

      {discoveryModalOpen && (
        <DiscoveryModal
          mode="watchlist"
          onClose={() => setDiscoveryModalOpen(false)}
          onRefresh={() => {
            loadWatchlist();
          }}
        />
      )}

      <CompanySuggestionsModal
        isOpen={suggestionsOpen}
        onClose={() => setSuggestionsOpen(false)}
        existingRows={rows}
        onAddCompany={handleAddSuggestedCompany}
      />
    </div>
  );
}

