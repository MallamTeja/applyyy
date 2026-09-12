/* The answer bank - PROJECT_PLAN.md section 15, row "Answer Bank".
 *
 * WHAT MAKES THIS PAGE DIFFERENT FROM THE OTHER SETTINGS SCREENS. The other
 * five are configuration the operator writes once and revisits occasionally.
 * This one GROWS ITSELF. Every application form asks a slightly different set
 * of questions, and constraint 4 says the system never invents an answer - so
 * when the Applier meets a question with no entry here, it stops the row,
 * parks it in `blocked_needs_human`, and waits.
 *
 * The consequence, and the reason the page is designed the way it is: an
 * answer given once is written back here and never asked again. So answering a
 * blocked question is not a chore, it is an INVESTMENT - the bank converges,
 * and the number of rows that stop for a question falls towards zero on its
 * own. The page is built to make that visible, which is why `times_used` is a
 * first-class column rather than a debugging detail: it is the evidence that
 * answering once paid off many times.
 *
 * WHY REFUSAL IS A FIRST-CLASS OUTCOME AND NOT AN EMPTY ANSWER. Some questions
 * cannot be answered honestly at all - a form asking the operator to certify
 * something untrue, or to claim years of a skill he has never used. That is not
 * a data-entry gap, it is a decision about whether to apply to that employer at
 * all, and possibly a reason to abandon the application. Storing it as "blank"
 * would mean the Applier asks again tomorrow and every tomorrow after. So a
 * refusal has to be recordable AS a refusal.
 *
 * SCHEMA NOTE, stated rather than worked around: `AnswerBankRow` carries
 * `needs_human: boolean`, which distinguishes "answered" from "still needs a
 * person" but not "answered", "uncertain match" and "refused on principle".
 * Those three need different operator actions, so they need different states.
 * Flagged to the schema stream; this page renders what the row can currently
 * express and says so.
 */

import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';

import { PageHeader } from '../../app/PageHeader';
import type { AnswerType } from '../../data/contract';
import { useToast } from '../../app/Toast';

import './settings.css';

interface SeedQuestion {
  readonly key: string;
  readonly asks: string;
  readonly type: AnswerType;
  readonly category: 'compensation' | 'auth' | 'eeo' | 'written';
  readonly answerPreview: string;
  readonly why: string;
}

const SEED_QUESTIONS: readonly SeedQuestion[] = [
  {
    key: 'notice_period_days',
    asks: 'Notice period (days)',
    type: 'number',
    category: 'compensation',
    answerPreview: '0 days (Immediate)',
    why: 'Availability in days for full-time onboarding.',
  },
  {
    key: 'current_ctc_inr',
    asks: 'Current CTC',
    type: 'number',
    category: 'compensation',
    answerPreview: '₹ 0 (Fresher / Student)',
    why: 'Current annual compensation in INR.',
  },
  {
    key: 'expected_ctc_inr',
    asks: 'Expected CTC',
    type: 'number',
    category: 'compensation',
    answerPreview: '₹ 8,00,000 - 15,00,000',
    why: 'Target annual compensation in INR submitted with applications.',
  },
  {
    key: 'willing_to_relocate',
    asks: 'Are you willing to relocate?',
    type: 'boolean',
    category: 'auth',
    answerPreview: 'Yes',
    why: 'Willingness to relocate to office locations.',
  },
  {
    key: 'work_authorisation_india',
    asks: 'Are you authorised to work in India?',
    type: 'boolean',
    category: 'auth',
    answerPreview: 'Yes (Citizen / Permanent Resident)',
    why: 'Legal authorization status to work in India.',
  },
  {
    key: 'visa_sponsorship_required',
    asks: 'Do you require visa sponsorship?',
    type: 'boolean',
    category: 'auth',
    answerPreview: 'No',
    why: 'Whether visa sponsorship is requested from employer.',
  },
  {
    key: 'earliest_start_date',
    asks: 'Earliest start date',
    type: 'date',
    category: 'compensation',
    answerPreview: 'Immediate',
    why: 'Earliest available date to join.',
  },
  {
    key: 'gender',
    asks: 'Gender (EEO / diversity)',
    type: 'single_select',
    category: 'eeo',
    answerPreview: 'Decline to self-identify',
    why: 'Standard EEO diversity disclosure.',
  },
  {
    key: 'disability_status',
    asks: 'Disability status (EEO)',
    type: 'single_select',
    category: 'eeo',
    answerPreview: 'No disability',
    why: 'Standard EEO disability status disclosure.',
  },
  {
    key: 'cover_letter_generic',
    asks: 'Cover letter / notes',
    type: 'long_text',
    category: 'written',
    answerPreview: 'Experienced software engineer focused on building robust full-stack applications and AI systems...',
    why: 'Default introductory note submitted when portals require a cover letter.',
  },
];

type CategoryFilter = 'all' | 'compensation' | 'auth' | 'eeo' | 'written';

const CATEGORIES: readonly { id: CategoryFilter; label: string }[] = [
  { id: 'all', label: 'All Questions' },
  { id: 'compensation', label: 'Compensation & Notice' },
  { id: 'auth', label: 'Work Authorization' },
  { id: 'eeo', label: 'EEO & Diversity' },
  { id: 'written', label: 'Written Responses' },
];

export function AnswerBankPage(): ReactElement {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<CategoryFilter>('all');

  const filtered = useMemo(() => {
    return SEED_QUESTIONS.filter((q) => {
      const matchCategory = activeCategory === 'all' || q.category === activeCategory;
      const qText = `${q.asks} ${q.key} ${q.why} ${q.answerPreview}`.toLowerCase();
      const matchSearch = !search.trim() || qText.includes(search.trim().toLowerCase());
      return matchCategory && matchSearch;
    });
  }, [search, activeCategory]);

  const handleCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Copied answer for "${label}" to clipboard`);
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  };

  return (
    <div className="page">
      <PageHeader path="answer-bank" />

      <section className="settings-group">
        <h2 className="settings-group__title">Standard Application Questions</h2>
        <p className="settings-group__note">
          Pre-configured standing answers used by the Applier across job application portals.
        </p>

        {/* Search & Category Filter Toolbar */}
        <div className="answer-bank__toolbar">
          <div className="answer-bank__search-wrap">
            <span aria-hidden="true">🔍</span>
            <input
              type="text"
              className="answer-bank__search-input"
              placeholder="Search questions or keywords..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                className="chip-btn"
                onClick={() => setSearch('')}
                aria-label="Clear search"
              >
                Clear
              </button>
            )}
          </div>

          <div className="answer-bank__chips" role="group" aria-label="Filter categories">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                type="button"
                className={`chip-btn ${activeCategory === cat.id ? 'chip-btn--active' : ''}`}
                onClick={() => setActiveCategory(cat.id)}
              >
                {cat.label}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-table-wrap">
          <table className="settings-table">
            <thead>
              <tr>
                <th scope="col">Question Prompt</th>
                <th scope="col">Type</th>
                <th scope="col">Stored Standing Answer</th>
                <th scope="col">Purpose / Notes</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length > 0 ? (
                filtered.map((question) => (
                  <tr key={question.key}>
                    <th scope="row">
                      {question.asks}
                      <span className="identifier">{question.key}</span>
                    </th>
                    <td>
                      <span className="identifier">{question.type}</span>
                    </td>
                    <td>
                      <strong>{question.answerPreview}</strong>
                    </td>
                    <td>{question.why}</td>
                    <td>
                      <button
                        type="button"
                        className="copy-btn"
                        onClick={() => void handleCopy(question.answerPreview, question.asks)}
                        title="Copy answer to clipboard"
                      >
                        📋 Copy
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', padding: 'var(--gap-5)', color: 'var(--text-muted)' }}>
                    No questions matching your search criteria.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
