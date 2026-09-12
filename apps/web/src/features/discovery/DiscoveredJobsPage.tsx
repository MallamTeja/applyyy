/* Discovered Jobs Explorer — PROJECT_PLAN.md section 15.
 *
 * Allows the operator to directly inspect all raw discovered jobs captured by the
 * Scout engine across watched career pages and ATS feeds.
 *
 * Provides:
 *   - Fast client-side search across title, company, locations, and descriptions
 *   - Filter controls: ATS Provider, Work Arrangement, Employment Type, and Company
 *   - Tier 1/2/3 Source Origin Badges
 *   - Full Job Description modal viewer
 *   - One-click "Tailor & Queue" action to advance a discovered job directly into
 *     the Approval Queue
 */

import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { PageHeader } from '../../app/PageHeader';
import { SourceBadge } from '../../app/SourceBadge';
import { useToast } from '../../app/Toast';
import type {
  DiscoverySource,
  JobRow,
} from '../../data/contract';
import { supabase } from '../../data/supabase';
import { getCompanyCooldownInfo } from '../settings/companyCatalog';

import './DiscoveredJobsPage.css';

interface DiscoveredItem {
  readonly applicationId?: string;
  readonly job: JobRow;
}

export function DiscoveredJobsPage(): ReactElement {
  const navigate = useNavigate();
  const toast = useToast();

  const [items, setItems] = useState<readonly DiscoveredItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [search, setSearch] = useState<string>('');
  const [selectedProvider, setSelectedProvider] = useState<string>('all');
  const [selectedArrangement, setSelectedArrangement] = useState<string>('all');
  const [selectedType, setSelectedType] = useState<string>('all');
  const [selectedCompany, setSelectedCompany] = useState<string>('all');
  const [activeJdModal, setActiveJdModal] = useState<JobRow | null>(null);
  const [tailoringId, setTailoringId] = useState<string | null>(null);

  /* Load discovered jobs & applications */
  useEffect(() => {
    if (supabase === null) {
      setLoading(false);
      return;
    }

    let live = true;
    async function loadDiscovered() {
      try {
        setLoading(true);
        // Query applications in 'discovered' or raw jobs
        const { data: appsData, error: appsErr } = await supabase!
          .from('applications')
          .select('id, status, job:job_id(*)')
          .eq('status', 'discovered')
          .order('created_at', { ascending: false })
          .limit(300);

        if (!live) return;

        if (!appsErr && appsData && appsData.length > 0) {
          const mapped: DiscoveredItem[] = [];
          for (const app of appsData) {
            if (app.job) {
              mapped.push({
                applicationId: app.id,
                job: app.job as unknown as JobRow,
              });
            }
          }
          setItems(mapped);
        } else {
          // Fallback: Query directly from jobs if applications were not joined
          const { data: jobsData, error: jobsErr } = await supabase!
            .from('jobs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(300);

          if (!live || jobsErr || !jobsData) return;

          setItems(
            jobsData.map((j) => ({
              job: j as unknown as JobRow,
            })),
          );
        }
      } catch (e) {
        console.error('Failed to load discovered jobs:', e);
      } finally {
        if (live) setLoading(false);
      }
    }

    void loadDiscovered();
    return () => {
      live = false;
    };
  }, []);

  /* Unique companies for filter dropdown */
  const uniqueCompanies = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) {
      if (item.job.company_name) set.add(item.job.company_name);
    }
    return Array.from(set).sort();
  }, [items]);

  /* Filtered list based on search and dropdown selections */
  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();

    return items.filter(({ job }) => {
      // Search match
      if (q.length > 0) {
        const titleMatch = job.title?.toLowerCase().includes(q) ?? false;
        const companyMatch = job.company_name?.toLowerCase().includes(q) ?? false;
        const descMatch = job.description_raw?.toLowerCase().includes(q) ?? false;
        const locMatch = (job.locations || []).some((l) => l.toLowerCase().includes(q));
        if (!titleMatch && !companyMatch && !descMatch && !locMatch) {
          return false;
        }
      }

      // Provider filter
      if (selectedProvider !== 'all' && job.ats_provider !== selectedProvider) {
        return false;
      }

      // Work arrangement filter
      if (selectedArrangement !== 'all' && job.work_arrangement !== selectedArrangement) {
        return false;
      }

      // Employment type filter
      if (selectedType !== 'all' && job.employment_type !== selectedType) {
        return false;
      }

      // Company filter
      if (selectedCompany !== 'all' && job.company_name !== selectedCompany) {
        return false;
      }

      return true;
    });
  }, [items, search, selectedProvider, selectedArrangement, selectedType, selectedCompany]);

  /* One-click action: Fast Tailor & advance to approval queue */
  async function handleFastTailor(item: DiscoveredItem) {
    const targetId = item.applicationId;
    if (!targetId || supabase === null) {
      toast.error('Cannot tailor: Application ID missing');
      return;
    }

    try {
      setTailoringId(targetId);
      // Advance status to awaiting_approval
      const { error } = await supabase
        .from('applications')
        .update({
          status: 'awaiting_approval',
          updated_at: new Date().toISOString(),
        })
        .eq('id', targetId);

      if (error) {
        toast.error(`Failed to queue: ${error.message}`);
        return;
      }

      toast.success(`Tailored & queued ${item.job.title} for review!`);

      // Remove from discovered list
      setItems((prev) => prev.filter((i) => i.applicationId !== targetId));

      // Offer immediate jump to Approvals
      navigate('/approvals');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Tailoring failed');
    } finally {
      setTailoringId(null);
    }
  }

  return (
    <div className="page page--wide discovery">
      <PageHeader path="discovered" />

      {/* Interactive Controls Bar */}
      <section className="discovery__controls" aria-label="Job search and filters">
        <div className="discovery__search-row">
          <input
            type="search"
            className="discovery__search-input"
            placeholder="Search discovered jobs by title, company, skills, or location..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="discovery__filters">
          {/* Provider Filter */}
          <select
            className="discovery__filter-select"
            value={selectedProvider}
            onChange={(e) => setSelectedProvider(e.target.value)}
            aria-label="Filter by ATS Provider"
          >
            <option value="all">All ATS Providers</option>
            <option value="greenhouse">Greenhouse</option>
            <option value="lever">Lever</option>
            <option value="ashby">Ashby</option>
          </select>

          {/* Work Arrangement Filter */}
          <select
            className="discovery__filter-select"
            value={selectedArrangement}
            onChange={(e) => setSelectedArrangement(e.target.value)}
            aria-label="Filter by Work Arrangement"
          >
            <option value="all">All Work Arrangements</option>
            <option value="remote">Remote</option>
            <option value="hybrid">Hybrid</option>
            <option value="onsite">Onsite</option>
          </select>

          {/* Employment Type Filter */}
          <select
            className="discovery__filter-select"
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value)}
            aria-label="Filter by Employment Type"
          >
            <option value="all">All Employment Types</option>
            <option value="full_time">Full-time</option>
            <option value="internship">Internship</option>
            <option value="contract">Contract</option>
            <option value="part_time">Part-time</option>
          </select>

          {/* Company Filter */}
          <select
            className="discovery__filter-select"
            value={selectedCompany}
            onChange={(e) => setSelectedCompany(e.target.value)}
            aria-label="Filter by Company"
          >
            <option value="all">All Companies ({uniqueCompanies.length})</option>
            {uniqueCompanies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <span className="discovery__meta-count">
            Showing {filteredItems.length} of {items.length} discovered jobs
          </span>
        </div>
      </section>

      {/* Grid of Job Cards */}
      {loading ? (
        <div className="discovery__empty">
          <p>Loading discovered jobs from ATS career pages...</p>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="discovery__empty">
          <p>No discovered jobs match your current search or filter criteria.</p>
        </div>
      ) : (
        <div className="discovery__grid">
          {filteredItems.map(({ applicationId, job }) => (
            <article key={job.id} className="job-card">
              <div className="job-card__header">
                <div className="job-card__top-bar">
                  <span className="job-card__company">{job.company_name}</span>
                  <SourceBadge
                    discoveredVia={job.discovered_via as readonly DiscoverySource[]}
                    sourceRefs={job.source_refs}
                  />
                </div>
                <h3 className="job-card__title" title={job.title}>
                  {job.title}
                </h3>
              </div>

              {/* Metadata Pills */}
              <div className="job-card__pills">
                {job.employment_type && job.employment_type !== 'unknown' && (
                  <span className="job-pill">
                    {job.employment_type.replace('_', ' ')}
                  </span>
                )}
                {job.work_arrangement && job.work_arrangement !== 'unknown' && (
                  <span className="job-pill">
                    {job.work_arrangement}
                  </span>
                )}
                {job.location_raw && (
                  <span className="job-pill" title={job.location_raw}>
                    📍 {job.location_raw.length > 28 ? `${job.location_raw.slice(0, 26)}…` : job.location_raw}
                  </span>
                )}
                {((job.salary_min !== null && job.salary_min !== undefined) ||
                  (job.salary_max !== null && job.salary_max !== undefined)) && (
                  <span className="job-pill job-pill--salary">
                    💰 {job.salary_currency ?? 'INR'}{' '}
                    {job.salary_min ? Number(job.salary_min).toLocaleString() : '0'}
                    {job.salary_max ? ` – ${Number(job.salary_max).toLocaleString()}` : '+'}
                  </span>
                )}
                {(() => {
                  const cooldown = getCompanyCooldownInfo(job.company_name);
                  if (!cooldown) return null;
                  return (
                    <span
                      className="job-pill job-pill--cooldown"
                      title={`Cool-off period for ${job.company_name}:\n• Interview Cooldown: ${cooldown.interview}\n• Screening Cooldown: ${cooldown.screening}${cooldown.notes ? `\n• Notes: ${cooldown.notes}` : ''}`}
                    >
                      ⏳ Cooldown: {cooldown.interview} int.
                    </span>
                  );
                })()}
              </div>

              {/* Job Description Excerpt */}
              {job.description_raw && (
                <div
                  className="job-card__description"
                  onClick={() => setActiveJdModal(job)}
                  title="Click to view full job description"
                >
                  {job.description_raw.replace(/<[^>]*>?/gm, ' ').slice(0, 220)}...
                </div>
              )}

              {/* Card Footer Actions */}
              <div className="job-card__footer">
                <a
                  href={job.apply_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="job-card__link"
                  title="Open original job posting on career page"
                >
                  <span>Apply Link ↗</span>
                </a>

                {applicationId && (
                  <button
                    type="button"
                    className="job-card__tailor-btn"
                    disabled={tailoringId === applicationId}
                    onClick={() => handleFastTailor({ applicationId, job })}
                  >
                    {tailoringId === applicationId ? 'Tailoring…' : '⚡ Tailor & Queue'}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {/* Full Job Description Modal */}
      {activeJdModal && (
        <div
          className="jd-modal-backdrop"
          onClick={() => setActiveJdModal(null)}
          role="dialog"
          aria-modal="true"
        >
          <div className="jd-modal" onClick={(e) => e.stopPropagation()}>
            <header className="jd-modal__header">
              <div>
                <span className="job-card__company">{activeJdModal.company_name}</span>
                <h2 className="job-card__title">{activeJdModal.title}</h2>
              </div>
              <button
                type="button"
                className="button button--ghost"
                onClick={() => setActiveJdModal(null)}
              >
                ✕ Close
              </button>
            </header>

            <div className="jd-modal__body">
              {activeJdModal.description_raw ? (
                <div>{activeJdModal.description_raw}</div>
              ) : (
                <p>No description text provided for this posting.</p>
              )}
            </div>

            <footer className="jd-modal__footer">
              <a
                href={activeJdModal.apply_url}
                target="_blank"
                rel="noopener noreferrer"
                className="button button--secondary"
              >
                Open Career Page ↗
              </a>
              <button
                type="button"
                className="button button--primary"
                onClick={() => setActiveJdModal(null)}
              >
                Done
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
