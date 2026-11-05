/* The filter cascade as live controls - PROJECT_PLAN.md section 8.
 *
 * 400 jobs are discovered in a morning. Without filtering, all 400 go to
 * Gemini, which reads a Senior Staff JD demanding eight years of Kubernetes,
 * thinks carefully, and correctly reports "poor match" - having cost tokens,
 * two seconds, and one slot of a daily quota whose size nobody can see.
 *
 * With filtering, plain code checks first: title contains "Senior" -> drop,
 * never parsed the rest, zero tokens, about a millisecond. 400 in, ~40 survive,
 * so 40 LLM calls instead of 400. And it compounds - the Tailor and the Auditor
 * also only ever see the 40, so the saving is 10x on three agents, not one.
 *
 * EVERY ROW HERE IS A SETTING, and that is the point of this page. Nothing
 * about the cascade is hardcoded anywhere in this system; `filter_rules` is a
 * table and this screen is its live editor.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { PageHeader } from '../../app/PageHeader';
import { useToast } from '../../app/Toast';
import { FILTER_RULE_TYPES } from '../../data/contract.ts';
import type { FilterRuleType } from '../../data/contract.ts';
import {
  DEFAULT_FILTER_RULES,
  // The one experience-ceiling value the preset writes (2026-11-04).
  EARLY_CAREER_MAX_YEARS,
  getFilterRulesReadError,
  getTechOnlyPreference,
  loadFilterRules,
  saveFilterRules,
  setTechOnlyPreference,
} from './filtersStore.ts';
import type { FilterRuleConfig } from './filtersStore.ts';

import './settings.css';

// Exported for the B1 render test, which renders rows from the same copy the page uses.
export interface RuleCopy {
  readonly name: string;
  readonly drops: string;
  /* B1 (2026-10-08): set ONLY for a rule the screener cannot enforce with today's job data. Two
     rules shipped enabled and read as working while they could never drop a job; this says so on
     the row instead of leaving it to a reader of cascade.ts. */
  readonly notEnforced?: string;
  readonly threshold:
    | { readonly kind: 'none' }
    | { readonly kind: 'number'; readonly label: string; readonly suffix: string; readonly key: string }
    | { readonly kind: 'list'; readonly label: string; readonly placeholder: string; readonly key: string };
}

// Exported so the B1 test can assert exactly which rules carry the "Not enforced" note.
export const RULE_COPY: Readonly<Partial<Record<FilterRuleType, RuleCopy>>> = {
  experience_ceiling: {
    name: 'Experience ceiling',
    drops: 'Filters out postings exceeding your maximum target years.',
    threshold: { kind: 'number', label: 'Maximum experience required', suffix: 'years', key: 'max_years' },
    // ENFORCED since 2026-11-04. cascade.ts:157 still skips the rule when min_experience_years is
    // null, but the screener now fills it from the JD's required years
    // (supabase/functions/_shared/screen/required-experience.ts), so the old "Not enforced" note
    // was removed rather than left claiming the opposite of what runs.
  },
  title_blocklist: {
    name: 'Title blocklist',
    drops: 'Excludes postings matching disqualified seniority (Senior/Staff) or non-tech role titles.',
    threshold: {
      kind: 'list',
      label: 'Disqualified title terms',
      placeholder: 'Senior, Staff, Principal, Lead, Manager, Architect, Sales, Marketing',
      key: 'blocked_titles',
    },
  },
  location_allowlist: {
    name: 'Location allowlist',
    drops: 'Restricts listings strictly to your target cities or remote.',
    threshold: {
      kind: 'list',
      label: 'Target locations',
      placeholder: 'Hyderabad, Bangalore, Pune, Remote, India',
      key: 'allowed_locations',
    },
  },
  employment_type: {
    name: 'Employment type',
    drops: 'Filters out non-matching contract, part-time, or internship roles.',
    threshold: { kind: 'none' },
  },
  already_applied: {
    name: 'Already applied',
    drops: 'Skips jobs already present in your historical application records.',
    threshold: { kind: 'none' },
  },
  company_blocklist: {
    name: 'Company blocklist',
    drops: 'Immediately drops postings from blocked companies and agencies.',
    threshold: { kind: 'none' },
  },
  staleness: {
    name: 'Staleness',
    drops: 'Discards job postings older than the maximum freshness window.',
    threshold: { kind: 'number', label: 'Oldest posting age', suffix: 'days', key: 'window_days' },
  },
  degree_mismatch: {
    name: 'Degree mismatch',
    drops: "Excludes roles strictly requiring a Master's or PhD.",
    threshold: { kind: 'none' },
    /* The degree_mismatch null-skip in cascade.ts (named, not line-cited — the number
       drifted once already) fires whenever requires_advanced_degree is null, and no job carries it.
       The second sentence is because filtersStore's evaluateJobMatch DOES read the description
       text, so the Discovered Jobs view can flag a role the screener never drops. */
    notEnforced:
      "Not enforced: job data doesn't include this. The Discovered Jobs view checks the description text, but the screener does not.",
  },
  per_company_weekly_cap: {
    name: 'Per-company weekly cap',
    drops: 'Limits total submissions sent to the same company per 7-day window.',
    threshold: { kind: 'number', label: 'Max applications per company', suffix: 'per week', key: 'max_per_week' },
  },
};

/* One rule's name, what it drops, and (B1) whether it can actually be enforced. Exported for the
   render test; the page renders every row through it, so the test reads the shipped markup. */
export function RuleText({ ruleType, copy }: { readonly ruleType: FilterRuleType; readonly copy: RuleCopy | undefined }): ReactElement {
  return (
    <div>
      <p className="cascade__name">
        {copy === undefined ? ruleType : copy.name}
      </p>
      <p className="cascade__drops">
        {copy === undefined
          ? 'This rule was added to the schema after this page was written.'
          : copy.drops}
      </p>
      {/* A role=note line, styled as a warning, so an enabled-but-dead rule cannot read as working. */}
      {copy?.notEnforced !== undefined ? (
        <p className="cascade__drops cascade__not-enforced" role="note">
          {copy.notEnforced}
        </p>
      ) : null}
    </div>
  );
}

export function FiltersPage(): ReactElement {
  const toast = useToast();
  const [rules, setRules] = useState<FilterRuleConfig[]>([...DEFAULT_FILTER_RULES]);
  const [techOnly, setTechOnly] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  // Mirrors the store's read failure so the page can say why Save will refuse, instead of
  // showing an empty cascade that looks like "no rules configured".
  const [readError, setReadError] = useState<string | null>(null);

  const fetchRules = useCallback(async () => {
    try {
      setLoading(true);
      const loaded = await loadFilterRules();
      setRules(loaded);
      // Read the getter only after load settles: the store records the outcome inside loadFilterRules.
      setReadError(getFilterRulesReadError());
      setTechOnly(getTechOnlyPreference());
    } catch {
      // Fallback
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRules();
  }, [fetchRules]);

  const toggleRule = (ruleType: FilterRuleType) => {
    setRules((prev) =>
      prev.map((r) =>
        r.ruleType === ruleType ? { ...r, isEnabled: !r.isEnabled } : r,
      ),
    );
  };

  const updateNumberConfig = (ruleType: FilterRuleType, key: string, val: number) => {
    setRules((prev) =>
      prev.map((r) =>
        r.ruleType === ruleType
          ? { ...r, config: { ...r.config, [key]: val } }
          : r,
      ),
    );
  };

  const updateListConfig = (ruleType: FilterRuleType, key: string, commaSeparated: string) => {
    const list = commaSeparated
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    setRules((prev) =>
      prev.map((r) =>
        r.ruleType === ruleType
          ? { ...r, config: { ...r.config, [key]: list } }
          : r,
      ),
    );
  };

  const handleTechOnlyToggle = () => {
    const next = !techOnly;
    setTechOnly(next);
    setTechOnlyPreference(next);
  };

  const applyEarlyCareerSdePreset = () => {
    setTechOnly(true);
    setTechOnlyPreference(true);
    setRules((prev) =>
      prev.map((r) => {
        if (r.ruleType === 'experience_ceiling') {
          // Teja's 1-year ceiling, from the store's one constant (was a literal 2 until 2026-11-04).
          return { ...r, isEnabled: true, config: { max_years: EARLY_CAREER_MAX_YEARS } };
        }
        if (r.ruleType === 'title_blocklist') {
          return {
            ...r,
            isEnabled: true,
            config: {
              blocked_titles: [
                'Senior',
                'Staff',
                'Principal',
                'Lead',
                'Manager',
                'Director',
                'Architect',
                'VP',
                'Head of',
                'Sales',
                'Marketing',
                'Recruiter',
                'HR',
              ],
            },
          };
        }
        if (r.ruleType === 'location_allowlist') {
          return {
            ...r,
            isEnabled: true,
            config: {
              allowed_locations: ['Hyderabad', 'Bangalore', 'Bengaluru', 'Pune', 'Remote', 'India'],
            },
          };
        }
        if (r.ruleType === 'degree_mismatch') {
          return { ...r, isEnabled: true, config: {} };
        }
        return r;
      }),
    );
    toast.success('Applied Early-Career SDE & Tech Preset!');
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setStatusMessage(null);
      setTechOnlyPreference(techOnly);
      const res = await saveFilterRules(rules);
      if (res.ok) {
        setStatusMessage({ text: 'Filter rules saved successfully and applied to Job Discovery.', type: 'success' });
        toast.success('Filter Cascade updated!');
      } else {
        setStatusMessage({ text: res.error || 'Failed to save rules', type: 'error' });
        toast.error(res.error || 'Failed to save rules');
      }
    } catch (err) {
      setStatusMessage({ text: String(err), type: 'error' });
      toast.error(`Save error: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <PageHeader path="filters" />

      {/* Tech-Only Master Constraint Section */}
      <section className="settings-group" style={{ borderLeft: '4px solid var(--accent)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 'var(--gap-3)' }}>
          <div>
            <h2 className="settings-group__title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              Tech & Software Engineering Constraint
            </h2>
            <p className="settings-group__note">
              Strictly restrict job discovery and automated pipeline to Software Engineering, Developer, AI/ML, Data, DevOps, and Technical roles.
              Disqualifies all non-technical postings (Sales, Marketing, HR, Finance, Customer Support, Legal, Operations).
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              type="button"
              className="chip-btn"
              onClick={applyEarlyCareerSdePreset}
              title="Auto-fill 0-2 yrs exp, early-career software engineering filters"
            >
              Apply SDE / Fresher Preset
            </button>

            <button
              type="button"
              className={`answer-bank__bool-btn ${techOnly ? 'answer-bank__bool-btn--active-yes' : 'answer-bank__bool-btn--active-no'}`}
              onClick={handleTechOnlyToggle}
              style={{ minWidth: '130px' }}
            >
              {techOnly ? 'Tech Only (ON)' : 'All Roles (OFF)'}
            </button>
          </div>
        </div>
      </section>

      {/* Main Cascade Section */}
      <section className="settings-group">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--gap-3)' }}>
          <div>
            <h2 className="settings-group__title">Filter Cascade</h2>
            <p className="settings-group__note">
              Rules execute in order, cheapest first, stopping at the first failing check. Configured rules strictly govern Job Discovery and automated applications.
            </p>
          </div>

          <button
            type="button"
            className="btn-primary"
            onClick={() => void handleSave()}
            // The store would refuse anyway after a failed read; disabling makes the banner's claim visible.
            disabled={saving || readError !== null}
          >
            {saving ? 'Saving...' : 'Save Filter Cascade'}
          </button>
        </div>

        {/* Persistent, because saveFilterRules refuses every save until a later read succeeds. */}
        {readError !== null && (
          <p className="store-notice store-notice--bad" role="alert" style={{ marginTop: 'var(--gap-3)' }}>
            {/* Names the failure and the block, so a refused Save is not mistaken for a bug. */}
            Could not load your filter rules ({readError}). The rules below are not your
            saved settings, and saving is disabled so they cannot overwrite them. Reload to retry.
          </p>
        )}

        {statusMessage && (
          <div
            className={`ingest__item ${statusMessage.type === 'success' ? 'ingest__item--advisory' : 'ingest__item--blocking'}`}
            style={{ marginTop: 'var(--gap-3)' }}
          >
            {statusMessage.text}
          </div>
        )}

        {loading ? (
          <p style={{ marginTop: 'var(--gap-4)', color: 'var(--text-secondary)' }}>
            Loading filter rules...
          </p>
        ) : (
          <ol className="cascade">
            {FILTER_RULE_TYPES.map((ruleType) => {
              const copy = RULE_COPY[ruleType];
              const rule = rules.find((r) => r.ruleType === ruleType) || {
                ruleType,
                isEnabled: true,
                config: {},
              };

              return (
                <li
                  key={ruleType}
                  className={`cascade__row ${!rule.isEnabled ? 'cascade__row--off' : ''}`}
                >
                  <input
                    type="checkbox"
                    className="cascade__toggle"
                    checked={rule.isEnabled}
                    onChange={() => toggleRule(ruleType)}
                    aria-label={'Enable ' + (copy === undefined ? ruleType : copy.name)}
                  />

                  {/* Extracted so the B1 note is render-tested on the exact markup this row ships. */}
                  <RuleText ruleType={ruleType} copy={copy} />

                  {/* Number Threshold */}
                  {copy !== undefined && copy.threshold.kind === 'number' ? (
                    <label className="field">
                      <span className="field__label">{copy.threshold.label}</span>
                      <input
                        type="number"
                        className="field__control"
                        min={0}
                        style={{ width: '7rem' }}
                        disabled={!rule.isEnabled}
                        value={String(rule.config[copy.threshold.key] ?? '')}
                        onChange={(e) =>
                          updateNumberConfig(
                            ruleType,
                            (copy.threshold as { key: string }).key,
                            Number(e.target.value),
                          )
                        }
                      />
                      <span className="field__help">{copy.threshold.suffix}</span>
                    </label>
                  ) : null}

                  {/* List Threshold */}
                  {copy !== undefined && copy.threshold.kind === 'list' ? (
                    <label className="field">
                      <span className="field__label">{copy.threshold.label}</span>
                      <input
                        type="text"
                        className="field__control"
                        placeholder={copy.threshold.placeholder}
                        style={{ width: '18rem' }}
                        disabled={!rule.isEnabled}
                        value={
                          Array.isArray(rule.config[copy.threshold.key])
                            ? (rule.config[copy.threshold.key] as string[]).join(', ')
                            : String(rule.config[copy.threshold.key] ?? '')
                        }
                        onChange={(e) =>
                          updateListConfig(
                            ruleType,
                            (copy.threshold as { key: string }).key,
                            e.target.value,
                          )
                        }
                      />
                      <span className="field__help">Separate with commas</span>
                    </label>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--gap-5)', paddingTop: 'var(--gap-4)', borderTop: '1px solid var(--rule)' }}>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void handleSave()}
            // The store would refuse anyway after a failed read; disabling makes the banner's claim visible.
            disabled={saving || readError !== null}
          >
            {saving ? 'Saving...' : 'Save Filter Cascade'}
          </button>
        </div>
      </section>
    </div>
  );
}
