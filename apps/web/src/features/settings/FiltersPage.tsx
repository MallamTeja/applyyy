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
    drops: 'Jobs asking for more years than you have. A JD saying "5+ years" when you want up to one.',
    threshold: { kind: 'number', label: 'Most years a job may ask for', suffix: 'years' },
  },
  title_blocklist: {
    name: 'Title blocklist',
    drops: 'Senior, Staff, Principal, Lead, Manager, Architect. The cheapest useful check in the whole system - it reads one field and stops.',
    threshold: {
      kind: 'list',
      label: 'Words that disqualify a title',
      placeholder: 'Senior, Staff, Principal, Lead, Manager, Architect',
    },
  },
  location_allowlist: {
    name: 'Location allowlist',
    drops: 'Anywhere you would not actually go. This is an allowlist, not a blocklist, so a city you forget to add is a city you never see.',
    threshold: {
      kind: 'list',
      label: 'Places you would work',
      placeholder: 'Hyderabad, Bangalore, Remote',
    },
  },
  employment_type: {
    name: 'Employment type',
    drops: 'Contract and part-time roles when you want an internship or a full-time job.',
    threshold: { kind: 'none' },
  },
  already_applied: {
    name: 'Already applied',
    drops: 'Jobs whose fingerprint is already in your history. A cheap pre-check ahead of the database constraint that would refuse the duplicate anyway - this one saves the work rather than the row.',
    threshold: { kind: 'none' },
  },
  company_blocklist: {
    name: 'Company blocklist',
    drops: 'Everything from a company on your blocklist. Without it, one staffing firm posting thirty near-identical listings gets thirty applications and you never notice, because each looked like a different job.',
    threshold: { kind: 'none' },
  },
  staleness: {
    name: 'Staleness',
    drops: 'Jobs posted more than a few days ago. Recruiters read in arrival order and often stop around the fiftieth, so applying inside a day is worth more than any resume tweak. Jobs whose posted date cannot be trusted skip this rule rather than being guessed at.',
    threshold: { kind: 'number', label: 'Oldest posting to consider', suffix: 'days' },
  },
  degree_mismatch: {
    name: 'Degree mismatch',
    drops: "Roles requiring a Master's or PhD.",
    threshold: { kind: 'none' },
  },
  per_company_weekly_cap: {
    name: 'Per-company weekly cap',
    drops: 'Applications beyond a few per company per week. Five in a week from one candidate is a visible negative in most applicant tracking systems.',
    threshold: { kind: 'number', label: 'Applications per company per week', suffix: 'max' },
  },
};

export function FiltersPage(): ReactElement {
  return (
    <div className="page">
      <PageHeader path="filters" />

      <p className="not-wired">
        These controls are laid out but not yet reading or writing{' '}
        <span className="identifier">filter_rules</span>. Changing one does
        nothing until the page is wired up.
      </p>

      <section className="settings-group">
        <h2 className="settings-group__title">The cascade, in order</h2>
        <p className="settings-group__note">
          These run top to bottom, cheapest first, and stop at the first rule
          that rejects a job. Most discovered jobs die here before any AI reads
          them, which is what keeps the running cost near zero.
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
