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
 * The pattern is a CASCADE (short-circuit, cheap-test-first): order the tests
 * by cost, run the cheapest first, let each stage shrink the input for the next.
 * Search engines rank this way - a cheap scorer over a million documents, an
 * expensive one over the surviving hundred.
 *
 * EVERY ROW HERE IS A SETTING, and that is the point of this page. Nothing
 * about the cascade is hardcoded anywhere in this system; `filter_rules` is a
 * table and this screen is its editor. A rule switched off is dimmed rather
 * than hidden, because hiding it would make "why did this job get through"
 * unanswerable.
 */

import type { ReactElement } from 'react';

import { PageHeader } from '../../app/PageHeader';
import { FILTER_RULE_TYPES } from '../../data/contract';
import type { FilterRuleType } from '../../data/contract';

import './settings.css';

/* What each rule throws away, in the operator's own words, plus the shape of
 * the threshold it needs.
 *
 * Keyed by the schema stream's `FilterRuleType` so that the page is driven by
 * the enum rather than by this list: a rule the schema adds and this file does
 * not describe still renders, with its raw name, instead of silently
 * disappearing from the cascade. A missing description is a cosmetic gap; a
 * missing row would be an invisible filter. */
interface RuleCopy {
  /* Named for what it does to a job, not for its column. */
  readonly name: string;
  /* The consequence of switching it off - the most useful text on the page,
   * because a rule name alone does not say what it is protecting you from. */
  readonly drops: string;
  /* The control its threshold needs. `none` means the rule is a plain on/off
   * with nothing to tune. */
  readonly threshold:
    | { readonly kind: 'none' }
    | { readonly kind: 'number'; readonly label: string; readonly suffix: string }
    | { readonly kind: 'list'; readonly label: string; readonly placeholder: string };
}

const RULE_COPY: Readonly<Partial<Record<FilterRuleType, RuleCopy>>> = {
  experience_ceiling: {
    name: 'Experience ceiling',
    drops: 'Filters out postings exceeding your maximum target years.',
    threshold: { kind: 'number', label: 'Maximum experience required', suffix: 'years' },
  },
  title_blocklist: {
    name: 'Title blocklist',
    drops: 'Excludes postings matching disqualified seniority or role titles.',
    threshold: {
      kind: 'list',
      label: 'Disqualified title terms',
      placeholder: 'Senior, Staff, Principal, Lead, Manager, Architect',
    },
  },
  location_allowlist: {
    name: 'Location allowlist',
    drops: 'Restricts listings strictly to your target cities or remote.',
    threshold: {
      kind: 'list',
      label: 'Target locations',
      placeholder: 'Hyderabad, Bangalore, Remote',
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
    threshold: { kind: 'number', label: 'Oldest posting age', suffix: 'days' },
  },
  degree_mismatch: {
    name: 'Degree mismatch',
    drops: "Excludes roles strictly requiring a Master's or PhD.",
    threshold: { kind: 'none' },
  },
  per_company_weekly_cap: {
    name: 'Per-company weekly cap',
    drops: 'Limits total submissions sent to the same company per 7-day window.',
    threshold: { kind: 'number', label: 'Max applications per company', suffix: 'per week' },
  },
};

export function FiltersPage(): ReactElement {
  return (
    <div className="page">
      <PageHeader path="filters" />

      <section className="settings-group">
        <h2 className="settings-group__title">Filter Cascade</h2>
        <p className="settings-group__note">
          Rules execute in order, cheapest first, stopping at the first failing check.
        </p>

        <ol className="cascade">
          {/* Driven by the schema stream's enum, in its declaration order,
              which is the order the cascade actually runs in. Iterating the
              enum rather than a local list means a rule added upstream appears
              here without an edit. */}
          {FILTER_RULE_TYPES.map((ruleType) => {
            const copy = RULE_COPY[ruleType];

            return (
              <li key={ruleType} className="cascade__row">
                {/* The toggle leads, because "is this rule on" is the first
                    question about any row. */}
                <input
                  type="checkbox"
                  className="cascade__toggle"
                  /* Every rule ships enabled: a filter that defaults off is a
                      filter that silently does nothing on a fresh install. */
                  defaultChecked
                  aria-label={
                    'Enable ' + (copy === undefined ? ruleType : copy.name)
                  }
                />

                <div>
                  <p className="cascade__name">
                    {/* Falls back to the raw enum name rather than rendering
                        nothing, so a rule this file has not described is still
                        visible and switchable. */}
                    {copy === undefined ? ruleType : copy.name}
                  </p>
                  <p className="cascade__drops">
                    {copy === undefined
                      ? 'This rule was added to the schema after this page was written. It still runs; it just has no description here yet.'
                      : copy.drops}
                  </p>
                </div>

                {/* The threshold, when the rule has one to tune. */}
                {copy !== undefined && copy.threshold.kind === 'number' ? (
                  <label className="field">
                    <span className="field__label">{copy.threshold.label}</span>
                    <input
                      type="number"
                      className="field__control"
                      min={0}
                      /* Narrow: a two-digit threshold in a full-width input
                          reads as a text field and invites a sentence. */
                      style={{ width: '7rem' }}
                    />
                    <span className="field__help">{copy.threshold.suffix}</span>
                  </label>
                ) : null}

                {copy !== undefined && copy.threshold.kind === 'list' ? (
                  <label className="field">
                    <span className="field__label">{copy.threshold.label}</span>
                    <input
                      type="text"
                      className="field__control"
                      placeholder={copy.threshold.placeholder}
                      style={{ width: '18rem' }}
                    />
                    <span className="field__help">
                      Separate with commas
                    </span>
                  </label>
                ) : null}
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
