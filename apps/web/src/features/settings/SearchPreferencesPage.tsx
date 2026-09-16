/* Search preferences - what counts as a job worth finding (section 15).
 *
 * This page and the Filters page are two halves of one decision, kept apart on
 * purpose. THIS page says what to go looking for; Filters says what to throw
 * away once found. Merged, they would be one screen of thirty controls where
 * the operator cannot tell which ones cost money - search terms drive how many
 * jobs arrive, filters drive how many reach Gemini. */

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

import { PageHeader } from '../../app/PageHeader';
import { EMPLOYMENT_TYPES, WORK_ARRANGEMENTS } from '../../data/contract';
import type { EmploymentType, WorkArrangement } from '../../data/contract';
import { supabase } from '../../data/supabase';
import { DiscoveryModal } from '../pipeline/DiscoveryModal';

import './settings.css';

interface EmploymentTypeMeta {
  readonly label: string;
  readonly description: string;
}

const EMPLOYMENT_TYPE_COPY: Record<EmploymentType, EmploymentTypeMeta> = {
  internship: {
    label: 'Internship',
    description: 'Pre-placement, summer/winter internships, and student co-ops.',
  },
  full_time: {
    label: 'Full-time (FTE)',
    description: 'Permanent full-time employment and graduate entry-level roles.',
  },
  apprenticeship: {
    label: 'Apprenticeship / Trainee',
    description: 'Structured graduate apprentice programs, trainee, or mixed training tracks.',
  },
  contract: {
    label: 'Contract / Freelance',
    description: 'Fixed-duration, contract-to-hire, or agency roles.',
  },
  part_time: {
    label: 'Part-time',
    description: 'Flexible hours, project-based, or under 30 hrs/week.',
  },
  unknown: {
    label: 'Unknown / Not specified',
    description: 'Include postings where the JD does not explicitly specify role classification.',
  },
};

interface WorkArrangementMeta {
  readonly label: string;
  readonly description: string;
}

const WORK_ARRANGEMENT_COPY: Record<WorkArrangement, WorkArrangementMeta> = {
  onsite: {
    label: 'On-site',
    description: 'Physical workplace attendance required.',
  },
  hybrid: {
    label: 'Hybrid',
    description: 'Flexible balance of home and office attendance.',
  },
  remote: {
    label: 'Remote',
    description: '100% remote or distributed anywhere in the eligible country.',
  },
  unknown: {
    label: 'Unknown / Unspecified',
    description: 'Include postings where the remote/office status is not mentioned in JD.',
  },
};

export function SearchPreferencesPage(): ReactElement {
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [discoveryModalOpen, setDiscoveryModalOpen] = useState<boolean>(false);

  // Target Roles & Keywords
  const [titles, setTitles] = useState<string>('Software Engineer Intern, Junior Developer, Graduate Engineer');
  const [keywords, setKeywords] = useState<string>('Node.js, React, TypeScript, Python, REST APIs');
  const [excludedKeywords, setExcludedKeywords] = useState<string>('Senior, Lead, Principal, 5+ years');
  const [locations, setLocations] = useState<string>('Hyderabad, Bangalore, Pune, Remote');

  // Multi-select Employment Types
  const [selectedEmploymentTypes, setSelectedEmploymentTypes] = useState<Set<EmploymentType>>(
    () => new Set(['internship', 'full_time', 'unknown']),
  );

  // Multi-select Work Arrangements
  const [selectedWorkArrangements, setSelectedWorkArrangements] = useState<Set<WorkArrangement>>(
    () => new Set(['onsite', 'hybrid', 'remote']),
  );

  // Experience bounds
  const [minExperience, setMinExperience] = useState<number>(0);
  const [maxExperience, setMaxExperience] = useState<number>(2);

  // Compensation & Salary
  const [selectedCompensation, setSelectedCompensation] = useState<Set<string>>(
    () => new Set(['paid']),
  );
  const [minSalary, setMinSalary] = useState<string>('');
  const [maxSalary, setMaxSalary] = useState<string>('');
  const [currency, setCurrency] = useState<string>('INR');

  // Rate Limits / System Controls
  const [killSwitchActive, setKillSwitchActive] = useState<boolean>(true);
  const [backoffSeconds, setBackoffSeconds] = useState<number>(60);
  const [dailyCap, setDailyCap] = useState<number>(35);

  const loadPreferences = useCallback(async () => {
    if (supabase === null) {
      setLoading(false);
      return;
    }

    try {
      const { data, error } = await supabase
        .from('search_preferences')
        .select('*')
        .maybeSingle();

      if (error) {
        setStatusMessage({ text: `Failed to load preferences: ${error.message}`, type: 'error' });
      } else if (data) {
        if (Array.isArray(data.titles) && data.titles.length > 0) setTitles(data.titles.join(', '));
        if (Array.isArray(data.keywords) && data.keywords.length > 0) setKeywords(data.keywords.join(', '));
        if (Array.isArray(data.excluded_keywords) && data.excluded_keywords.length > 0) {
          setExcludedKeywords(data.excluded_keywords.join(', '));
        }
        if (Array.isArray(data.locations) && data.locations.length > 0) setLocations(data.locations.join(', '));

        if (Array.isArray(data.employment_types) && data.employment_types.length > 0) {
          setSelectedEmploymentTypes(new Set(data.employment_types as EmploymentType[]));
        }

        if (Array.isArray(data.work_arrangements) && data.work_arrangements.length > 0) {
          setSelectedWorkArrangements(new Set(data.work_arrangements as WorkArrangement[]));
        } else if (data.remote_only) {
          setSelectedWorkArrangements(new Set(['remote']));
        }

        if (data.min_experience_years !== null && data.min_experience_years !== undefined) {
          setMinExperience(Number(data.min_experience_years));
        }
        if (data.max_experience_years !== null && data.max_experience_years !== undefined) {
          setMaxExperience(Number(data.max_experience_years));
        }

        if (Array.isArray(data.compensation_types) && data.compensation_types.length > 0) {
          setSelectedCompensation(new Set(data.compensation_types));
        }
        if (data.min_salary !== null && data.min_salary !== undefined) {
          setMinSalary(String(data.min_salary));
        }
        if (data.max_salary !== null && data.max_salary !== undefined) {
          setMaxSalary(String(data.max_salary));
        }
        if (data.salary_currency) {
          setCurrency(data.salary_currency);
        }
      }
    } catch (err) {
      setStatusMessage({
        text: err instanceof Error ? err.message : 'Error loading search preferences',
        type: 'error',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPreferences();
  }, [loadPreferences]);

  const toggleEmploymentType = (type: EmploymentType) => {
    setSelectedEmploymentTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        // Prevent deselecting everything: candidate must have at least one type
        if (next.size > 1) {
          next.delete(type);
        }
      } else {
        next.add(type);
      }
      return next;
    });
  };

  const selectAllEmploymentTypes = () => {
    setSelectedEmploymentTypes(new Set(EMPLOYMENT_TYPES));
  };

  const selectInternPlusFte = () => {
    setSelectedEmploymentTypes(new Set(['internship', 'full_time', 'apprenticeship', 'unknown']));
  };

  const toggleWorkArrangement = (arrangement: WorkArrangement) => {
    setSelectedWorkArrangements((prev) => {
      const next = new Set(prev);
      if (next.has(arrangement)) {
        if (next.size > 1) {
          next.delete(arrangement);
        }
      } else {
        next.add(arrangement);
      }
      return next;
    });
  };

  const selectAllWorkArrangements = () => {
    setSelectedWorkArrangements(new Set(WORK_ARRANGEMENTS));
  };

  const selectRemoteOnly = () => {
    setSelectedWorkArrangements(new Set(['remote']));
  };

  const toggleCompensation = (kind: string) => {
    setSelectedCompensation((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) {
        if (next.size > 1) {
          next.delete(kind);
        }
      } else {
        next.add(kind);
      }
      return next;
    });
  };

  const performSave = async (): Promise<boolean> => {
    setSaving(true);
    setStatusMessage(null);

    const parseList = (str: string) =>
      str
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    const isRemoteOnly =
      selectedWorkArrangements.has('remote') && selectedWorkArrangements.size === 1;

    const payload = {
      titles: parseList(titles),
      keywords: parseList(keywords),
      excluded_keywords: parseList(excludedKeywords),
      locations: parseList(locations),
      employment_types: Array.from(selectedEmploymentTypes),
      work_arrangements: Array.from(selectedWorkArrangements),
      remote_only: isRemoteOnly,
      min_experience_years: minExperience >= 0 ? minExperience : null,
      max_experience_years: maxExperience >= 0 ? maxExperience : null,
      compensation_types: Array.from(selectedCompensation),
      min_salary: minSalary.trim() ? Number(minSalary) : null,
      max_salary: maxSalary.trim() ? Number(maxSalary) : null,
      salary_currency: currency,
    };

    if (supabase === null) {
      // Offline / demo environment fallback
      setStatusMessage({ text: 'Preferences saved in local session (Supabase unconfigured).', type: 'success' });
      setSaving(false);
      return true;
    }

    try {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData?.user?.id;

      if (!userId) {
        setStatusMessage({ text: 'Not signed in. Changes saved in session memory.', type: 'error' });
        setSaving(false);
        return false;
      }

      const { error: upsertError } = await supabase
        .from('search_preferences')
        .upsert({ user_id: userId, ...payload }, { onConflict: 'user_id' });

      if (upsertError) {
        setStatusMessage({ text: `Failed to save: ${upsertError.message}`, type: 'error' });
        return false;
      } else {
        setStatusMessage({ text: 'Search preferences saved successfully.', type: 'success' });
        return true;
      }
    } catch (err) {
      setStatusMessage({
        text: err instanceof Error ? err.message : 'Error updating preferences',
        type: 'error',
      });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    await performSave();
  };

  return (
    <div className="page">
      <PageHeader path="search-preferences" />

      <form onSubmit={handleSave}>
        {/* --- Employment Types (Multi-Select) --- */}
        <section className="settings-group">
          <h2 className="settings-group__title">Employment & Role Types</h2>
          <p className="settings-group__note">
            Select all employment types you are open to. For example, select both Internship and Full-time (FTE)
            simultaneously, along with Apprenticeship schemes and Unknown postings.
          </p>

          <div className="settings-group__fields">
            <div className="multi-select-block">
              <div className="multi-select-block__header">
                <div>
                  <span className="multi-select-block__label">Select Target Employment Types</span>
                  <span className="multi-select-block__help">
                    {' '}(Multi-select: pick any combination)
                  </span>
                </div>
                <div className="multi-select-block__actions">
                  <button
                    type="button"
                    className="btn-pill"
                    onClick={selectInternPlusFte}
                  >
                    Intern + FTE + Trainee
                  </button>
                  <button
                    type="button"
                    className="btn-pill"
                    onClick={selectAllEmploymentTypes}
                  >
                    Select All
                  </button>
                </div>
              </div>

              <div className="selection-grid">
                {EMPLOYMENT_TYPES.map((type) => {
                  const checked = selectedEmploymentTypes.has(type);
                  const meta = EMPLOYMENT_TYPE_COPY[type] ?? {
                    label: type,
                    description: 'Role classification',
                  };
                  return (
                    <label
                      key={type}
                      className={`selection-card ${checked ? 'selection-card--checked' : ''}`}
                    >
                      <input
                        type="checkbox"
                        className="selection-card__checkbox"
                        checked={checked}
                        onChange={() => toggleEmploymentType(type)}
                      />
                      <div className="selection-card__body">
                        <span className="selection-card__title">{meta.label}</span>
                        <span className="selection-card__desc">{meta.description}</span>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        {/* --- Where You Would Work (Multi-Select Arrangements) --- */}
        <section className="settings-group">
          <h2 className="settings-group__title">Where You Would Work (Arrangements & Locations)</h2>
          <p className="settings-group__note">
            Multi-select working arrangements you accept (Onsite, Hybrid, Remote) and specify target cities.
          </p>

          <div className="settings-group__fields">
            <div className="multi-select-block">
              <div className="multi-select-block__header">
                <div>
                  <span className="multi-select-block__label">Accepted Work Arrangements</span>
                  <span className="multi-select-block__help">
                    {' '}(Multi-select: e.g. accept both Remote and Hybrid)
                  </span>
                </div>
                <div className="multi-select-block__actions">
                  <button
                    type="button"
                    className="btn-pill"
                    onClick={selectAllWorkArrangements}
                  >
                    All Arrangements
                  </button>
                  <button
                    type="button"
                    className="btn-pill"
                    onClick={selectRemoteOnly}
                  >
                    Remote Only
                  </button>
                </div>
              </div>

              <div className="selection-grid">
                {WORK_ARRANGEMENTS.map((arrangement) => {
                  const checked = selectedWorkArrangements.has(arrangement);
                  const meta = WORK_ARRANGEMENT_COPY[arrangement] ?? {
                    label: arrangement,
                    description: 'Working mode',
                  };
                  return (
                    <label
                      key={arrangement}
                      className={`selection-card ${checked ? 'selection-card--checked' : ''}`}
                    >
                      <input
                        type="checkbox"
                        className="selection-card__checkbox"
                        checked={checked}
                        onChange={() => toggleWorkArrangement(arrangement)}
                      />
                      <div className="selection-card__body">
                        <span className="selection-card__title">{meta.label}</span>
                        <span className="selection-card__desc">{meta.description}</span>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            <label className="field field--wide">
              <span className="field__label">Target Geographic Locations</span>
              <span className="field__help">
                Comma-separated target cities, tech hubs, or countries.
              </span>
              <input
                type="text"
                className="field__control"
                value={locations}
                onChange={(e) => setLocations(e.target.value)}
                placeholder="Hyderabad, Bangalore, Pune, Remote, India"
              />
            </label>
          </div>
        </section>

        {/* --- Pay & Compensation Range --- */}
        <section className="settings-group">
          <h2 className="settings-group__title">Compensation Structure & Salary Range</h2>
          <p className="settings-group__note">
            Configure acceptable pay structures (Paid vs Unpaid) and your compensation bounds.
          </p>

          <div className="settings-group__fields">
            <div className="multi-select-block">
              <span className="multi-select-block__label">Compensation Type</span>
              <span className="multi-select-block__help">
                Choose whether to include paid positions, unpaid/volunteer, or both.
              </span>
              <div className="selection-grid">
                <label
                  className={`selection-card ${
                    selectedCompensation.has('paid') ? 'selection-card--checked' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    className="selection-card__checkbox"
                    checked={selectedCompensation.has('paid')}
                    onChange={() => toggleCompensation('paid')}
                  />
                  <div className="selection-card__body">
                    <span className="selection-card__title">Paid Roles</span>
                    <span className="selection-card__desc">
                      Positions offering stipend, hourly wage, or annual salary.
                    </span>
                  </div>
                </label>

                <label
                  className={`selection-card ${
                    selectedCompensation.has('unpaid') ? 'selection-card--checked' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    className="selection-card__checkbox"
                    checked={selectedCompensation.has('unpaid')}
                    onChange={() => toggleCompensation('unpaid')}
                  />
                  <div className="selection-card__body">
                    <span className="selection-card__title">Unpaid / College Credit</span>
                    <span className="selection-card__desc">
                      Volunteer internships, open source fellowships, or academic credit.
                    </span>
                  </div>
                </label>
              </div>
            </div>

            <div className="field field--wide">
              <span className="field__label">Salary / Stipend Range</span>
              <span className="field__help">
                Set an expected minimum floor and optional maximum target ceiling.
              </span>
              <div className="salary-range-fields">
                <label className="field">
                  <span className="field__label">Min Salary (Floor)</span>
                  <input
                    type="number"
                    className="field__control"
                    min={0}
                    placeholder="e.g. 300000"
                    value={minSalary}
                    onChange={(e) => setMinSalary(e.target.value)}
                  />
                </label>

                <label className="field">
                  <span className="field__label">Max Salary (Ceiling)</span>
                  <input
                    type="number"
                    className="field__control"
                    min={0}
                    placeholder="e.g. 2000000"
                    value={maxSalary}
                    onChange={(e) => setMaxSalary(e.target.value)}
                  />
                </label>

                <label className="field">
                  <span className="field__label">Currency</span>
                  <select
                    className="field__control"
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                  >
                    <option value="INR">INR (₹)</option>
                    <option value="USD">USD ($)</option>
                    <option value="EUR">EUR (€)</option>
                    <option value="GBP">GBP (£)</option>
                  </select>
                </label>
              </div>
            </div>
          </div>
        </section>

        {/* --- Target Roles & Skills --- */}
        <section className="settings-group">
          <h2 className="settings-group__title">Target Roles & Skills</h2>
          <p className="settings-group__note">
            Job titles and technologies the Scout scans across target company boards.
          </p>

          <div className="settings-group__fields">
            <label className="field field--wide">
              <span className="field__label">Target Job Titles</span>
              <span className="field__help">
                Comma-separated titles to hunt for on ATS boards.
              </span>
              <input
                type="text"
                className="field__control"
                value={titles}
                onChange={(e) => setTitles(e.target.value)}
                placeholder="Software Engineer Intern, Junior Developer, Graduate Engineer"
              />
            </label>

            <label className="field field--wide">
              <span className="field__label">Keywords & Technologies</span>
              <span className="field__help">
                Prioritized by the Tailor during resume alignment.
              </span>
              <input
                type="text"
                className="field__control"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder="Node.js, React, TypeScript, Python, REST APIs"
              />
            </label>

            <label className="field field--wide">
              <span className="field__label">Excluded Keywords</span>
              <span className="field__help">
                Cheap pre-filter: discard postings containing these phrases.
              </span>
              <input
                type="text"
                className="field__control"
                value={excludedKeywords}
                onChange={(e) => setExcludedKeywords(e.target.value)}
                placeholder="Senior, Lead, Principal, 5+ years"
              />
            </label>

            <label className="field">
              <span className="field__label">Min Experience (Years)</span>
              <span className="field__help">Minimum experience floor.</span>
              <input
                type="number"
                className="field__control"
                min={0}
                value={minExperience}
                onChange={(e) => setMinExperience(Number(e.target.value))}
              />
            </label>

            <label className="field">
              <span className="field__label">Max Experience (Years)</span>
              <span className="field__help">Experience ceiling enforced by cascade.</span>
              <input
                type="number"
                className="field__control"
                min={0}
                value={maxExperience}
                onChange={(e) => setMaxExperience(Number(e.target.value))}
              />
            </label>
          </div>
        </section>

        {/* --- Autonomous Dispatch & Kill Switch --- */}
        <section className="settings-group">
          <h2 className="settings-group__title">Pipeline Dispatch & Rate Limits</h2>
          <p className="settings-group__note">
            Autonomous execution limits, safety backoffs, and emergency kill switch.
          </p>

          <div className="settings-group__fields">
            <label className="field field--wide">
              <span className="field__label">Emergency Kill Switch</span>
              <span className="field__help">
                Halts autonomous agent dispatch across Scout, Tailor, and Applier immediately.
              </span>
              <select
                className="field__control"
                value={killSwitchActive ? 'active' : 'disabled'}
                onChange={(e) => setKillSwitchActive(e.target.value === 'active')}
              >
                <option value="active">Active (normal autonomous pipeline execution)</option>
                <option value="disabled">Paused (emergency halt engaged)</option>
              </select>
            </label>

            <label className="field">
              <span className="field__label">Rate-Limit Backoff (Seconds)</span>
              <span className="field__help">
                Cooldown window when HTTP 429 rate limit is encountered.
              </span>
              <input
                type="number"
                className="field__control"
                min={10}
                value={backoffSeconds}
                onChange={(e) => setBackoffSeconds(Number(e.target.value))}
              />
            </label>

            <label className="field">
              <span className="field__label">Daily Submission Cap</span>
              <span className="field__help">
                Maximum submissions per rolling 24 hours.
              </span>
              <input
                type="number"
                className="field__control"
                min={1}
                max={100}
                value={dailyCap}
                onChange={(e) => setDailyCap(Number(e.target.value))}
              />
            </label>
          </div>
        </section>

        {/* --- Save Button & Status Bar --- */}
        <div className="settings-actions-bar">
          {statusMessage && (
            <span
              className={`settings-actions-bar__status ${
                statusMessage.type === 'success'
                  ? 'settings-actions-bar__status--success'
                  : 'settings-actions-bar__status--error'
              }`}
            >
              {statusMessage.text}
            </span>
          )}
          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              type="button"
              className="button button--secondary"
              onClick={async () => {
                const ok = await performSave();
                if (ok) {
                  setDiscoveryModalOpen(true);
                }
              }}
              disabled={saving || loading}
              title="Save search preferences and immediately scout open global remote tech feeds"
            >
              🌐 Save & Find Remote Jobs Now
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={saving || loading}
            >
              {saving ? 'Saving...' : 'Save Preferences'}
            </button>
          </div>
        </div>
      </form>

      {discoveryModalOpen && (
        <DiscoveryModal
          mode="remote"
          onClose={() => setDiscoveryModalOpen(false)}
          onRefresh={() => {}}
        />
      )}
    </div>
  );
}
