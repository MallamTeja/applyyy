/* Discovered Jobs Explorer — PROJECT_PLAN.md section 15.
 *
 * Allows the operator to directly inspect all raw discovered jobs captured by the
 * Scout engine across watched career pages and ATS feeds.
 *
 * Enforces:
 *   - Tech & Software Engineering roles only (auto-drops Sales, Marketing, HR, Finance)
 *   - Live Filter Cascade (Experience ceiling, Senior/Staff Title Blocklist, Location allowlist)
 *   - View Tabs: Matched Tech Jobs, All Discovered, and Filtered Out
 *   - Fast client-side search across title, company, locations, and descriptions
 *
 * THIS PAGE CREATES DISCOVERED ROWS; IT NEVER ADVANCES ONE. The Scout modal upserts
 * jobs and applications at status `discovered`, and that is the page's whole write
 * surface. The one-click fast path that used to advance a row six statuses to the
 * approval queue was deleted on 2026-09-17 by Teja's ruling: it named six agents and
 * ran none of them, two of those agents have never been written, and the rows it
 * produced were read downstream as audited and safe to batch-approve. Status
 * transitions belong to the pipeline agents. A new affordance here needs a new ruling.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { PageHeader } from '../../app/PageHeader';
import { SourceBadge } from '../../app/SourceBadge';
import type { DiscoverySource, JobRow } from '../../data/contract.ts';
import { supabase } from '../../data/supabase.ts';
import { DiscoveryModal } from '../pipeline/DiscoveryModal';
import { getCompanyCooldownInfo } from '../settings/companyCatalog.ts';
import {
  evaluateJobMatch,
  getTechOnlyPreference,
  isTechRole,
  loadFilterRules,
  setTechOnlyPreference,
} from '../settings/filtersStore.ts';
import type { FilterRuleConfig } from '../settings/filtersStore.ts';

import './DiscoveredJobsPage.css';

interface DiscoveredItem {
  readonly applicationId?: string;
  readonly job: JobRow;
}

interface EvaluatedDiscoveredItem extends DiscoveredItem {
  readonly passed: boolean;
  readonly isTech: boolean;
  readonly dropReason?: string | undefined;
}

export function DiscoveredJobsPage(): ReactElement {
  const [items, setItems] = useState<readonly DiscoveredItem[]>([]);
  const [filterRules, setFilterRules] = useState<readonly FilterRuleConfig[]>([]);
  const [techOnly, setTechOnly] = useState<boolean>(() => getTechOnlyPreference());
  const [enforceCascade, setEnforceCascade] = useState<boolean>(true);
  const [viewTab, setViewTab] = useState<'matched' | 'all' | 'dropped'>('matched');

  const [loading, setLoading] = useState<boolean>(true);
  const [search, setSearch] = useState<string>('');
  const [selectedProvider, setSelectedProvider] = useState<string>('all');
  const [selectedArrangement, setSelectedArrangement] = useState<string>('all');
  const [selectedType, setSelectedType] = useState<string>('all');
  const [selectedCompany, setSelectedCompany] = useState<string>('all');
  const [activeJdModal, setActiveJdModal] = useState<JobRow | null>(null);
  const [discoveryModalMode, setDiscoveryModalMode] = useState<'remote' | 'watchlist' | null>(null);

  /* Load discovered jobs & filter rules */
  const loadData = useCallback(async () => {
    try {
      setLoading(true);

      // Load filter rules
      const rules = await loadFilterRules();
      setFilterRules(rules);

      if (supabase === null) {
        setLoading(false);
        return;
      }

      // Query applications in 'discovered' or raw jobs
      const { data: appsData, error: appsErr } = await supabase!
        .from('applications')
        .select('id, status, job:job_id(*)')
        .eq('status', 'discovered')
        .order('created_at', { ascending: false })
        .limit(300);

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

        if (jobsErr || !jobsData) return;

        setItems(
          jobsData.map((j) => ({
            job: j as unknown as JobRow,
          })),
        );
      }
    } catch (e) {
      console.error('Failed to load discovered jobs:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleToggleTechOnly = () => {
    const next = !techOnly;
    setTechOnly(next);
    setTechOnlyPreference(next);
  };

  /* Evaluate each job against Tech constraint and Filter Cascade */
  const evaluatedItems: readonly EvaluatedDiscoveredItem[] = useMemo(() => {
    return items.map((item) => {
      const techCheck = isTechRole(item.job.title);
      const cascadeEval = evaluateJobMatch(item.job, filterRules, techOnly);

      const passed = enforceCascade
        ? cascadeEval.passed
        : techOnly
          ? techCheck.isTech
          : true;

      const dropReason = !techCheck.isTech
        ? `Non-tech role (${techCheck.reason})`
        : cascadeEval.dropReason;

      return {
        ...item,
        passed,
        isTech: techCheck.isTech,
        dropReason,
      };
    });
  }, [items, filterRules, techOnly, enforceCascade]);

  /* Unique companies for filter dropdown */
  const uniqueCompanies = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) {
      if (item.job.company_name) set.add(item.job.company_name);
    }
    return Array.from(set).sort();
  }, [items]);

  /* Summary counts */
  const matchedCount = useMemo(
    () => evaluatedItems.filter((i) => i.passed).length,
    [evaluatedItems],
  );
  const droppedCount = useMemo(
    () => evaluatedItems.filter((i) => !i.passed).length,
    [evaluatedItems],
  );

  /* Filtered list based on viewTab, search, and dropdown selections */
  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();

    return evaluatedItems.filter((item) => {
      const { job, passed } = item;

      // View Tab gating
      if (viewTab === 'matched' && !passed) return false;
      if (viewTab === 'dropped' && passed) return false;

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
  }, [evaluatedItems, viewTab, search, selectedProvider, selectedArrangement, selectedType, selectedCompany]);

  return (
    <div className="page page--wide discovery">
      <PageHeader path="discovered" />

      {/* Filter Cascade & Tech Constraint Control Bar */}
      <section className="discovery__cascade-header" aria-label="Filter rules and constraint controls">
        <div className="discovery__view-tabs" role="tablist">
          <button
            type="button"
            className={`discovery__tab-btn ${viewTab === 'matched' ? 'discovery__tab-btn--active' : ''}`}
            onClick={() => setViewTab('matched')}
            role="tab"
            aria-selected={viewTab === 'matched'}
          >
            🎯 Matched Tech Jobs (<strong>{matchedCount}</strong>)
          </button>
          <button
            type="button"
            className={`discovery__tab-btn ${viewTab === 'all' ? 'discovery__tab-btn--active' : ''}`}
            onClick={() => setViewTab('all')}
            role="tab"
            aria-selected={viewTab === 'all'}
          >
            📋 All Discovered ({items.length})
          </button>
          <button
            type="button"
            className={`discovery__tab-btn ${viewTab === 'dropped' ? 'discovery__tab-btn--active-dropped' : ''}`}
            onClick={() => setViewTab('dropped')}
            role="tab"
            aria-selected={viewTab === 'dropped'}
            title="Jobs dropped due to non-tech title, senior experience, or location mismatch"
          >
            🚫 Filtered Out (<strong>{droppedCount}</strong>)
          </button>
        </div>

        <div className="discovery__toggle-group">
          <button
            type="button"
            className={`discovery__toggle-pill ${techOnly ? 'discovery__toggle-pill--active' : 'discovery__toggle-pill--inactive'}`}
            onClick={handleToggleTechOnly}
            title="When active, filters out Sales, Marketing, HR, Finance, Operations"
          >
            {techOnly ? '✓ Tech Only' : '✕ Tech Only (Off)'}
          </button>

          <button
            type="button"
            className={`discovery__toggle-pill ${enforceCascade ? 'discovery__toggle-pill--active' : 'discovery__toggle-pill--inactive'}`}
            onClick={() => setEnforceCascade(!enforceCascade)}
            title="Enforce Experience Ceiling, Title Blocklist (Senior/Staff), and Locations"
          >
            {enforceCascade ? '⚡ Cascade Active' : '✕ Cascade (Off)'}
          </button>

          <Link
            to="/filters"
            className="chip-btn"
            style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            title="Configure filter rules and thresholds"
          >
            ⚙️ Rules
          </Link>

          <button
            type="button"
            className="chip-btn"
            style={{ fontWeight: 600, color: 'var(--accent, #6366f1)', borderColor: 'var(--accent, #6366f1)' }}
            onClick={() => setDiscoveryModalMode('watchlist')}
            title="Scan Greenhouse, Lever, and Ashby boards on your Company Watchlist"
          >
            ⚡ Scout Watchlist
          </button>

          <button
            type="button"
            className="chip-btn"
            style={{ fontWeight: 600, color: 'var(--accent, #6366f1)', borderColor: 'var(--accent, #6366f1)' }}
            onClick={() => setDiscoveryModalMode('remote')}
            title="Discover international remote jobs from open tech feeds"
          >
            🌐 Scout Remote Feeds
          </button>
        </div>
      </section>

      {/* Search and Metadata Filters Bar */}
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
            <option value="workable">Workable</option>
            <option value="smartrecruiters">SmartRecruiters</option>
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
            <option value="full_time">Full-time (FTE)</option>
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
            {viewTab === 'matched' ? (
              <span>
                Showing <strong>{filteredItems.length}</strong> clean tech jobs ({droppedCount} dropped by filters)
              </span>
            ) : viewTab === 'dropped' ? (
              <span style={{ color: '#dc2626' }}>
                Showing <strong>{filteredItems.length}</strong> dropped/irrelevant jobs
              </span>
            ) : (
              <span>
                Showing <strong>{filteredItems.length}</strong> of {items.length} total jobs
              </span>
            )}
          </span>
        </div>
      </section>

      {/* Grid of Job Cards */}
      {loading ? (
        <div className="discovery__empty">
          <p>Evaluating discovered jobs against Tech constraints and Filter Cascade...</p>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="discovery__empty">
          <p>
            {viewTab === 'matched'
              ? 'No jobs match your active Tech constraint and Filter Cascade rules. Try adjusting your search or checking "Filtered Out" to inspect dropped postings.'
              : 'No discovered jobs match your current criteria.'}
          </p>
        </div>
      ) : (
        <div className="discovery__grid">
          {filteredItems.map(({ applicationId, job, passed, dropReason }) => (
            <article key={job.id} className={`job-card ${!passed ? 'job-card--dropped' : ''}`}>
              {/* If dropped, display clear reason banner */}
              {!passed && dropReason && (
                <div className="job-card__drop-banner" title={dropReason}>
                  <span aria-hidden="true">🚫</span>
                  <div>
                    <strong>Filtered:</strong> {dropReason}
                  </div>
                </div>
              )}

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
                      {/* Name the dimension in full: this pill carries only the interview
                          cool-off, and the old "int." abbreviation made readers decode it */}
                      {/* toLowerCase folds the catalog's "6 Months" into the sentence so the
                          pill reads as one phrase, not two capitalised fragments */}
                      ⏳ Interview cooldown: {cooldown.interview.toLowerCase()}
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

                {/* Replaces the removed "Tailor & Queue" fast path. That button walked six
                    status transitions naming six agents and ran none of them — including the
                    Auditor, which does not exist as code — so it stamped rows `audit_clean`
                    and sent the operator to the batch-approve screen holding a verdict nobody
                    had produced. This line states what is true instead: the row is discovered,
                    and nothing can advance it until the agents exist. Static copy, not a
                    disabled control, because a greyed-out button still claims the capability
                    is there and merely unavailable right now. */}
                {applicationId && (
                  <span className="job-card__pipeline-note">
                    Awaiting pipeline agents
                  </span>
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
      {discoveryModalMode !== null && (
        <DiscoveryModal
          mode={discoveryModalMode}
          onClose={() => setDiscoveryModalMode(null)}
          onRefresh={() => {
            void loadData();
          }}
        />
      )}
    </div>
  );
}
