import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { ApplicationStatus } from '../../data/contract';
import { StatusBadge } from '../../app/StatusBadge';
import { SourceBadge } from '../../app/SourceBadge';
import { supabase } from '../../data/supabase';

import './PipelineDrawer.css';

interface DrawerAppItem {
  readonly id: string;
  readonly role: string;
  readonly company: string;
  readonly createdAt: string;
  readonly discoveredVia?: readonly string[] | null;
  readonly score?: number | null;
}

export function PipelineDrawer({
  status,
  count,
  onClose,
}: {
  readonly status: ApplicationStatus;
  readonly count: number;
  readonly onClose: () => void;
}): ReactElement {
  const [items, setItems] = useState<readonly DrawerAppItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    async function fetchStatusRows() {
      if (supabase === null) {
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from('applications')
          .select('id, created_at, fit_score, jobs:job_id(title, company_name, discovered_via, source_refs)')
          .eq('status', status)
          .order('created_at', { ascending: false })
          .limit(25);

        if (error || !data || !active) {
          setItems([]);
          return;
        }

        const mapped: DrawerAppItem[] = data.map((row: any) => ({
          id: row.id,
          role: row.jobs?.title ?? 'Untitled Role',
          company: row.jobs?.company_name ?? 'Unknown Company',
          createdAt: row.created_at,
          discoveredVia: row.jobs?.discovered_via ?? null,
          score: row.fit_score ?? null,
        }));

        setItems(mapped);
      } finally {
        if (active) setLoading(false);
      }
    }

    void fetchStatusRows();
    return () => {
      active = false;
    };
  }, [status]);

  // Handle ESC key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="drawer-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={`Applications in ${status}`}
    >
      <div className="drawer">
        <header className="drawer__header">
          <div className="drawer__title-group">
            <StatusBadge status={status} />
            <h2 className="drawer__title">{count} Application{count === 1 ? '' : 's'}</h2>
          </div>
          <button
            type="button"
            className="drawer__close-btn"
            onClick={onClose}
            aria-label="Close drawer"
          >
            ✕ Close
          </button>
        </header>

        <div className="drawer__content">
          <p className="drawer__summary">
            Active application records currently in <span className="identifier">{status}</span> status.
          </p>

          {loading ? (
            <div className="drawer__empty">
              <span>Loading applications...</span>
            </div>
          ) : items.length > 0 ? (
            items.map((app) => (
              <article key={app.id} className="drawer__app-card">
                <div className="drawer__app-top">
                  <div>
                    <h3 className="drawer__app-role">{app.role}</h3>
                    <span className="drawer__app-company">{app.company}</span>
                  </div>
                  {app.discoveredVia && app.discoveredVia.length > 0 && (
                    <SourceBadge discoveredVia={app.discoveredVia as any} />
                  )}
                </div>
                <div className="drawer__app-meta">
                  <span className="identifier">{app.id.slice(0, 8)}</span>
                  <span>{new Date(app.createdAt).toLocaleDateString()}</span>
                  {app.score !== null && <span>Match: {app.score}%</span>}
                </div>
              </article>
            ))
          ) : (
            <div className="drawer__empty">
              <span className="drawer__empty-icon">📭</span>
              <span>No applications currently in this status stage.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
