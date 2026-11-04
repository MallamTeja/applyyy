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
// Domain types through the schema seam; SearchPreferencesRow added 2026-11-04 for the remote policy.
import type { EmploymentType, SearchPreferencesRow, WorkArrangement } from '../../data/contract';

// The remote policy's two literals, taken from the schema owner's Row type rather than redeclared
// (contract.ts rule: no domain type is declared under apps/web).
type RemoteLocationPolicy = SearchPreferencesRow['remote_location_policy'];
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
  // Countries Teja may work in without a visa (search_preferences.work_authorized_countries),
  // as the comma list the box shows. Starts empty, which saves as null = never set: the
  // screener then drops nothing, so an unread row can never become "authorised nowhere".
  const [workAuthCountries, setWorkAuthCountries] = useState<string>('');
  // How the screener reads a remote job (search_preferences.remote_location_policy, Teja
  // 2026-11-04). Starts at the column default, so an unsaved page shows what the DB holds for a
  // new row; a loaded row replaces it below.
  const [remotePolicy, setRemotePolicy] = useState<RemoteLocationPolicy>('unlocked_or_authorized');

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

  // Rate Limits / System Controls — backed by public.system_settings (core_tables.sql:26).
  // Starts FALSE to mirror the column default: until the real row loads, the page must
  // never imply the pipeline is running, because "on" is the dangerous direction.
  const [systemEnabled, setSystemEnabled] = useState<boolean>(false);
  // Mirrors max_applications_per_day's column default (35) so a user with no row yet
  // sees the number the database would actually apply.
  const [dailyCap, setDailyCap] = useState<number>(35);
  // True only once the system_settings read SUCCEEDED (row or no row). A failed read
  // leaves the controls at placeholder values, and saving those would overwrite the
  // user's real kill switch — so the controls and their save stay locked until then.
  const [settingsLoaded, setSettingsLoaded] = useState<boolean>(false);
  // Same guard for search_preferences: after a failed read the fields hold the
  // hardcoded examples, and Save would write them over the user's real row.
  const [prefsLoaded, setPrefsLoaded] = useState<boolean>(false);

  const loadPreferences = useCallback(async () => {
    if (supabase === null) {
      setLoading(false);
      return;
    }

    // Read the control-panel row separately from search_preferences so one table's
    // outage cannot be mistaken for the other's emptiness.
    try {
      // maybeSingle: zero rows is a legitimate "never configured" state, not an error.
      const { data: settings, error: settingsError } = await supabase
        .from('system_settings')
        // Only the two columns this page edits; the rest belong to agents.
        .select('system_enabled, max_applications_per_day')
        .maybeSingle();
      // A failed read must be visible and must keep the controls locked.
      if (settingsError) {
        // Say which table failed, so the user knows the search fields are unaffected.
        setStatusMessage({ text: `Failed to load pipeline controls: ${settingsError.message}`, type: 'error' });
      } else {
        // Row present: show the user's real values instead of the placeholders.
        if (settings) {
          // Coerce strictly: only a literal true means "running".
          setSystemEnabled(settings.system_enabled === true);
          // Keep the default when the column somehow comes back non-numeric.
          if (typeof settings.max_applications_per_day === 'number') setDailyCap(settings.max_applications_per_day);
        }
        // Read succeeded (with or without a row), so saving is now safe.
        setSettingsLoaded(true);
      }
    } catch (err) {
      // A thrown network error is the same failure as a returned one.
      setStatusMessage({
        // Prefer the real message; fall back to naming the table.
        text: err instanceof Error ? err.message : 'Error loading pipeline controls',
        // Red, because the controls are now locked.
        type: 'error',
      });
    }

    try {
      const { data, error } = await supabase
        .from('search_preferences')
        .select('*')
        .maybeSingle();

      if (error) {
        // Appended, not replacing: if the controls read also failed, both causes stay visible.
        setStatusMessage((prev) => ({
          // Keep an earlier failure's text in front of this one.
          text: (prev?.type === 'error' ? `${prev.text} ` : '') + `Failed to load preferences: ${error.message}. Saving is blocked until a reload succeeds.`,
          // Red: the page is not showing the user's data.
          type: 'error',
        }));
      } else {
        // Read succeeded (row or no row), so saving cannot clobber unseen data.
        setPrefsLoaded(true);
      }
      // Only a real row overrides the example values.
      if (!error && data) {
        if (Array.isArray(data.titles) && data.titles.length > 0) setTitles(data.titles.join(', '));
        if (Array.isArray(data.keywords) && data.keywords.length > 0) setKeywords(data.keywords.join(', '));
        if (Array.isArray(data.excluded_keywords) && data.excluded_keywords.length > 0) {
          setExcludedKeywords(data.excluded_keywords.join(', '));
        }
        if (Array.isArray(data.locations) && data.locations.length > 0) setLocations(data.locations.join(', '));
        // Only a real list is an answer; anything else leaves the box empty (never set).
        if (Array.isArray(data.work_authorized_countries)) setWorkAuthCountries(data.work_authorized_countries.join(', '));
        // Only one of the two literals is an answer (the column's CHECK); anything else, including
        // a row read before migration 20261104193000, leaves the default showing.
        if (data.remote_location_policy === 'unlocked_or_authorized' || data.remote_location_policy === 'any') {
          // The stored choice.
          setRemotePolicy(data.remote_location_policy);
        }

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
      // A thrown read is a failed read: prefsLoaded stays false and Save stays blocked.
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
      // An empty box saves null (never set, gate open), never an empty list meaning "nowhere".
      work_authorized_countries: parseList(workAuthCountries).length > 0 ? parseList(workAuthCountries) : null,
      // Always one of the two literals: the select below offers nothing else.
      remote_location_policy: remotePolicy,
    };

    if (supabase === null) {
      // Nothing persists without a backend. Saying "saved" here was a lie the user
      // would discover only after a reload wiped every field.
      setStatusMessage({ text: 'Supabase is not configured, so nothing was saved.', type: 'error' });
      // Release the button; there is no request in flight.
      setSaving(false);
      // False so "Save & Find" does not go on to scout with unsaved preferences.
      return false;
    }

    try {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData?.user?.id;

      // Refuse to save over a row we never managed to read.
      if (!prefsLoaded) {
        // Says why nothing happened and how to fix it.
        setStatusMessage({ text: 'Not saved: your saved preferences failed to load, so saving would overwrite them. Reload and try again.', type: 'error' });
        // Nothing was written.
        return false;
      }

      if (!userId) {
        // No session means RLS refuses every write — there is no "session memory" to fall back to.
        setStatusMessage({ text: 'Not signed in, so nothing was saved.', type: 'error' });
        setSaving(false);
        return false;
      }

      const { error: upsertError } = await supabase
        .from('search_preferences')
        .upsert({ user_id: userId, ...payload }, { onConflict: 'user_id' });

      if (upsertError) {
        setStatusMessage({ text: `Failed to save: ${upsertError.message}`, type: 'error' });
        return false;
      }

      // The pipeline controls were placeholders if their read failed; writing them
      // then would silently flip the user's real kill switch. Report what did save.
      if (!settingsLoaded) {
        // Partial success stated as partial, in red, because something the user sees did not persist.
        setStatusMessage({
          // Name both halves so the user knows which one to retry.
          text: 'Search preferences saved. Pipeline controls were NOT saved because they failed to load — reload and retry.',
          // Error styling: the page is not fully saved.
          type: 'error',
        });
        // The search half did persist, so the discovery follow-up may still run.
        return true;
      }

      // Upsert so a user with no settings row yet gets one; the other columns take
      // their safe defaults (dry_run true, etc.) from the table.
      const { error: settingsError } = await supabase
        .from('system_settings')
        // Only the two columns this page owns; agent-owned counters stay untouched.
        .upsert(
          // user_id is the primary key, which is also the conflict target.
          { user_id: userId, system_enabled: systemEnabled, max_applications_per_day: dailyCap },
          // Same conflict target as the table's primary key.
          { onConflict: 'user_id' },
        );

      // A failed kill-switch write is the most important failure on this page to surface.
      if (settingsError) {
        // Say precisely which half failed; the search preferences did persist.
        setStatusMessage({
          // Include the database's own message so RLS/check-constraint failures are diagnosable.
          text: `Search preferences saved, but pipeline controls failed to save: ${settingsError.message}`,
          // Red, because the kill switch on screen may not match the database.
          type: 'error',
        });
        // Search half persisted; let the caller proceed.
        return true;
      }

      // Both writes returned no error, so this claim is now true.
      setStatusMessage({ text: 'Search preferences and pipeline controls saved.', type: 'success' });
      return true;
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

            {/* Work authorisation. The screener drops on-site/hybrid jobs located only outside these countries. */}
            <label className="field field--wide">
              {/* Teja's wording for the setting. */}
              <span className="field__label">Countries I can work in without a visa</span>
              {/* Says what the list does and what an empty box means, so it is not a mystery filter. */}
              <span className="field__help">
                Comma-separated English country names, e.g. India, Nepal, Bhutan. On-site and hybrid jobs located only
                outside these countries are dropped before matching; remote jobs follow the Remote jobs choice below.
                Leave empty to drop nothing.
              </span>
              {/* Same comma-list control as the locations box above. */}
              <input
                /* Plain text: the list is short and edited rarely. */
                type="text"
                /* Same control styling as the other text fields. */
                className="field__control"
                /* The draft; nothing is written until Save. */
                value={workAuthCountries}
                /* Draft only. */
                onChange={(e) => setWorkAuthCountries(e.target.value)}
                /* Says "not set" first: a bare country list in grey read as a SAVED value (browser proof, 2026-10-25). */
                placeholder="Not set: filter off. e.g. India, Nepal, Bhutan"
              />
            </label>

            {/* Remote policy (Teja, 2026-11-04): a "Remote - US" job needs the right to live and work in the US. */}
            <label className="field field--wide">
              {/* Teja's word for the setting. */}
              <span className="field__label">Remote jobs</span>
              {/* Says what each choice does in his terms, so "remote" is never read as "from anywhere" by accident. */}
              <span className="field__help">
                {/* The exception is real, not a hedge: the gate's US-requirement check drops a bare remote job too. */}
                Many remote jobs are locked to one country (e.g. &quot;Remote - US&quot;) and need the right to work there.
                Remote jobs with no country, or locked to a country above, are kept, unless the job description
                legally requires US status (ITAR, a security clearance, US work authorization).
              </span>
              {/* A two-option select, the same control as Currency; a closed choice, never free text. */}
              <select
                /* Same control styling as the other fields. */
                className="field__control"
                /* The draft; nothing is written until Save. */
                value={remotePolicy}
                /* Only the two literals below can arrive here. */
                onChange={(e) => setRemotePolicy(e.target.value as RemoteLocationPolicy)}
              >
                {/* The 11-04 default: country-locked remote outside the list is dropped. */}
                <option value="unlocked_or_authorized">
                  {/* Teja's own wording of the rule, so the choice reads as he ruled it. */}
                  Only remote jobs I can do from my countries (no country lock, or locked to a country above)
                </option>
                {/* The 10-24 behaviour, one click away. */}
                <option value="any">
                  {/* The permissive choice: every remote job is kept wherever it is locked to. */}
                  Any remote job
                </option>
              </select>
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
            {/* Persisted to system_settings.system_enabled — the column every agent checks first. */}
            <label className="field field--wide">
              {/* Names the real mechanism so the label cannot drift from the column. */}
              <span className="field__label">Emergency Kill Switch</span>
              {/* Explains the locked state, so a disabled control is not mistaken for a broken one. */}
              <span className="field__help">
                {settingsLoaded
                  ? 'Halts every agent on its next tick. A fresh account starts halted.'
                  : 'Locked: the current setting could not be loaded, so it cannot be changed safely.'}
              </span>
              {/* Disabled until the real value loads, so a placeholder can never be saved over it. */}
              <select
                className="field__control"
                value={systemEnabled ? 'running' : 'halted'}
                onChange={(e) => setSystemEnabled(e.target.value === 'running')}
                disabled={!settingsLoaded}
              >
                {/* system_enabled = true. */}
                <option value="running">Running (agents may act)</option>
                {/* system_enabled = false, the column default. */}
                <option value="halted">Halted (kill switch engaged)</option>
              </select>
            </label>

            {/* Backoff is deliberately NOT a setting: no column exists, and agents honour
                the server's Retry-After instead of inventing one. The old input saved nowhere. */}
            <p className="field__help">
              Rate-limit backoff is not configurable: agents wait as long as the provider&apos;s
              Retry-After header says.
            </p>

            {/* Persisted to system_settings.max_applications_per_day. */}
            <label className="field">
              {/* Named after the column (per day); the old "rolling 24 hours" wording was unverified. */}
              <span className="field__label">Daily Application Cap</span>
              {/* States the budget reasoning from the column comment. */}
              <span className="field__help">
                Maximum applications per day (sized to the GitHub Actions minutes budget).
              </span>
              {/* min 1 mirrors the column's CHECK (> 0) so the browser refuses what Postgres would. */}
              <input
                type="number"
                className="field__control"
                min={1}
                max={100}
                value={dailyCap}
                onChange={(e) => setDailyCap(Number(e.target.value))}
                disabled={!settingsLoaded}
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
              /* Saves, then explains the daily remote scout; there is no on-demand remote scan any more. */
              title="Save search preferences; remote feeds are scouted automatically every day at 07:00 IST"
            >
              {/* No "Now": the scan runs on its daily schedule, not on this click. */}
              🌐 Save & See Remote Scouting
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
