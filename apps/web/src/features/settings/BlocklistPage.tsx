/* The company blocklist - manage excluded companies and agencies. */

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

import { PageHeader } from '../../app/PageHeader';
import { BLOCKLIST_REASONS } from '../../data/contract';
import type { BlocklistReason, CompanyBlocklistRow } from '../../data/contract';
import { supabase } from '../../data/supabase';

import './settings.css';

const REASON_LABELS: Record<BlocklistReason, string> = {
  consultancy: 'Staffing Firm / Consultancy',
  mlm: 'MLM / Unpaid Role',
  ghosted: 'No Response / Ghosted',
  rejected_recently: 'Rejected Recently',
  personal_choice: 'Personal Preference',
  other: 'Other',
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export function BlocklistPage(): ReactElement {
  const [rows, setRows] = useState<readonly CompanyBlocklistRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [companyName, setCompanyName] = useState('');
  const [reason, setReason] = useState<BlocklistReason>('consultancy');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadBlocklist = useCallback(async () => {
    if (supabase === null) {
      setLoading(false);
      return;
    }

    try {
      const { data, error: queryError } = await supabase
        .from('company_blocklist')
        .select('*')
        .order('created_at', { ascending: false });

      if (queryError) {
        setError(queryError.message);
      } else {
        setRows((data as CompanyBlocklistRow[]) ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to query blocklist');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBlocklist();
  }, [loadBlocklist]);

  const handleAddBlock = async (e: FormEvent) => {
    e.preventDefault();
    if (!companyName.trim()) return;

    if (supabase === null) {
      setError('Supabase client is unconfigured.');
      return;
    }

    setSubmitting(true);
    setError(null);
    setSuccess(null);

    const slug = slugify(companyName);

    try {
      const { error: insertError } = await supabase
        .from('company_blocklist')
        .insert({
          company_name: companyName.trim(),
          company_slug: slug,
          reason,
          note: note.trim() || null,
        });

      if (insertError) {
        if (insertError.code === '23505') {
          setError(`"${companyName}" is already on your blocklist.`);
        } else {
          setError(insertError.message);
        }
      } else {
        setSuccess(`Blocked "${companyName}".`);
        setCompanyName('');
        setNote('');
        await loadBlocklist();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to block company');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemoveBlock = async (id: string, name: string) => {
    if (supabase === null) return;
    setError(null);

    try {
      const { error: deleteError } = await supabase
        .from('company_blocklist')
        .delete()
        .eq('id', id);

      if (deleteError) {
        setError(deleteError.message);
      } else {
        setSuccess(`Removed "${name}" from blocklist.`);
        await loadBlocklist();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove block');
    }
  };

  return (
    <div className="page">
      <PageHeader path="blocklist" />

      {/* Add Block Form */}
      <section className="settings-group">
        <h2 className="settings-group__title">Block an Employer or Agency</h2>
        <p className="settings-group__note">
          Excluded companies are skipped automatically during discovery and screening.
        </p>

        {error && <div className="watchlist-feedback watchlist-feedback--error">{error}</div>}
        {success && <div className="watchlist-feedback watchlist-feedback--success">{success}</div>}

        <form onSubmit={handleAddBlock} className="watchlist-add-form">
          <div className="watchlist-add-row">
            <label className="field">
              <span className="field__label">Company Name</span>
              <input
                type="text"
                className="field__control"
                placeholder="e.g. Acme Staffing"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                disabled={submitting}
                required
              />
            </label>

            <label className="field">
              <span className="field__label">Block Reason</span>
              <select
                className="field__control"
                value={reason}
                onChange={(e) => setReason(e.target.value as BlocklistReason)}
                disabled={submitting}
              >
                {BLOCKLIST_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {REASON_LABELS[r] ?? r}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field__label">Note (Optional)</span>
              <input
                type="text"
                className="field__control"
                placeholder="e.g. Mass resume harvester"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={submitting}
              />
            </label>

            <button
              type="submit"
              className="button button--approve"
              disabled={submitting || !companyName.trim()}
            >
              {submitting ? 'Blocking...' : 'Block Company'}
            </button>
          </div>
        </form>
      </section>

      {/* Active Blocklist Table */}
      <section className="settings-group">
        <h2 className="settings-group__title">Blocked Companies ({rows.length})</h2>
        <p className="settings-group__note">
          Jobs matching these company identifiers are dropped before reaching Tailor or Applier.
        </p>

        {loading ? (
          <p className="watchlist-empty-state">Loading blocklist...</p>
        ) : rows.length === 0 ? (
          <div className="watchlist-empty-state">
            No companies are currently blocked.
          </div>
        ) : (
          <div className="settings-table-wrap">
            <table className="settings-table">
              <thead>
                <tr>
                  <th scope="col">Company</th>
                  <th scope="col">Slug</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Note</th>
                  <th scope="col">Added</th>
                  <th scope="col" style={{ textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">{row.company_name}</th>
                    <td>
                      <code className="identifier">{row.company_slug}</code>
                    </td>
                    <td>
                      <span className="status-badge status-badge--stale">
                        <span className="status-badge__dot" />
                        {REASON_LABELS[row.reason] ?? row.reason}
                      </span>
                    </td>
                    <td>{row.note ?? '—'}</td>
                    <td className="identifier">
                      {new Date(row.created_at).toLocaleDateString()}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        className="button button--small"
                        onClick={() => handleRemoveBlock(row.id, row.company_name)}
                      >
                        Unblock
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
