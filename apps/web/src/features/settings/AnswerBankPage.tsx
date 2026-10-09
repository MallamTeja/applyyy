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
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';

import { PageHeader } from '../../app/PageHeader';
import { useToast } from '../../app/Toast';
import { AddQuestionModal } from './AddQuestionModal';
// Own file so this page's table stays readable; it shares the page's loaded bank.
import { EligibilityAnswers } from './EligibilityAnswers';
import {
  deleteCustomBankQuestion,
  formatAnswerPreview,
  loadAnswerBank,
  saveBankAnswer,
} from './answerBankStore';
import type { BankQuestion, QuestionCategory } from './answerBankStore';
// Which rows the table leaves out (EEO keys and the legacy gender/disability seeds), and why, in one tested place.
import { isTableHiddenKey } from './answerBankView';

import './settings.css';

type ExtendedCategoryFilter = QuestionCategory | 'needs_attention';

const CATEGORIES: readonly { id: ExtendedCategoryFilter; label: string }[] = [
  { id: 'all', label: 'All Questions' },
  { id: 'compensation', label: 'Compensation & Notice' },
  { id: 'auth', label: 'Work Authorization' },
  { id: 'eeo', label: 'EEO & Diversity' },
  { id: 'written', label: 'Written Responses' },
  { id: 'general', label: 'General / Custom' },
];

export function AnswerBankPage(): ReactElement {
  const toast = useToast();
  const [questions, setQuestions] = useState<readonly BankQuestion[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [search, setSearch] = useState<string>('');
  const [activeCategory, setActiveCategory] = useState<ExtendedCategoryFilter>('all');
  const [addModalOpen, setAddModalOpen] = useState<boolean>(false);

  // Track which question is currently in edit mode and its draft value
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftValue, setDraftValue] = useState<unknown>('');
  const [savingKey, setSavingKey] = useState<string | null>(null);
  // The failed read's message. Held apart from `questions` so an outage renders as
  // an outage, not as an empty (or seed-filled) bank the user might then save over.
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchBank = useCallback(async () => {
    try {
      setLoading(true);
      const items = await loadAnswerBank();
      setQuestions(items);
      // A successful read clears any banner from an earlier failed attempt.
      setLoadError(null);
    } catch (err) {
      // Nothing trustworthy loaded: show none, rather than stale rows from a previous read.
      setQuestions([]);
      // Persistent banner, because a toast disappears and the block on saving does not.
      setLoadError(err instanceof Error ? err.message : String(err));
      toast.error(`Failed to load answer bank: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void fetchBank();
  }, [fetchBank]);

  // Statistics
  const totalQuestions = questions.length;
  const needsAttentionCount = useMemo(
    () => questions.filter((q) => q.needsHuman).length,
    [questions],
  );
  const totalTimesUsed = useMemo(
    () => questions.reduce((sum, q) => sum + (q.timesUsed || 0), 0),
    [questions],
  );

  // Filtered view
  const filtered = useMemo(() => {
    return questions.filter((q) => {
      // EEO answers are edited only in the Eligibility section's exact-option selects, and the
      // legacy gender/disability_status seeds are never read by the worker. Both are hidden
      // here (UI only; no row is deleted). The reasons sit on TABLE_HIDDEN_KEYS.
      if (isTableHiddenKey(q.key)) return false;
      if (activeCategory === 'needs_attention') {
        if (!q.needsHuman) return false;
      } else if (activeCategory !== 'all') {
        if (q.category !== activeCategory) return false;
      }

      if (!search.trim()) return true;
      const query = search.trim().toLowerCase();
      const strVal = formatAnswerPreview(q.type, q.value, q.key).toLowerCase();
      return (
        q.asks.toLowerCase().includes(query) ||
        q.key.toLowerCase().includes(query) ||
        q.why.toLowerCase().includes(query) ||
        strVal.includes(query)
      );
    });
  }, [questions, activeCategory, search]);

  const startEditing = (q: BankQuestion) => {
    setEditingKey(q.key);
    setDraftValue(q.value);
  };

  const cancelEditing = () => {
    setEditingKey(null);
    setDraftValue('');
  };

  const handleSaveEdit = async (question: BankQuestion) => {
    try {
      setSavingKey(question.key);
      const res = await saveBankAnswer(question, draftValue);
      if (res.ok) {
        toast.success(`Saved standing answer for "${question.asks}"`);
        setQuestions((prev) =>
          prev.map((item) =>
            item.key === question.key
              ? { ...item, value: draftValue, needsHuman: false }
              : item,
          ),
        );
        setEditingKey(null);
      } else {
        toast.error(res.error || 'Failed to save answer');
      }
    } catch (err) {
      toast.error(`Error saving answer: ${String(err)}`);
    } finally {
      setSavingKey(null);
    }
  };

  const handleResetToDefault = (question: BankQuestion) => {
    setDraftValue(question.defaultValue);
  };

  const handleCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Copied answer for "${label}" to clipboard`);
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  };

  const handleDeleteCustom = async (question: BankQuestion) => {
    if (!window.confirm(`Are you sure you want to delete "${question.asks}" from the Answer Bank?`)) {
      return;
    }
    try {
      const res = await deleteCustomBankQuestion(question.key);
      if (res.ok) {
        toast.success(`Deleted question "${question.asks}"`);
        setQuestions((prev) => prev.filter((item) => item.key !== question.key));
        if (editingKey === question.key) {
          cancelEditing();
        }
      } else {
        toast.error(res.error || 'Failed to delete question');
      }
    } catch (err) {
      toast.error(`Error deleting question: ${String(err)}`);
    }
  };

  const handleAddQuestion = async (newQ: BankQuestion) => {
    const res = await saveBankAnswer(newQ, newQ.value);
    if (res.ok) {
      toast.success(`Added "${newQ.asks}" to Answer Bank`);
      setQuestions((prev) => [...prev, newQ]);
      return { ok: true };
    }
    return res;
  };

  return (
    <div className="page">
      <PageHeader path="answer-bank" />

      <section className="settings-group">
        <h2 className="settings-group__title">Standing Answers & Screening Questions</h2>
        <p className="settings-group__note">
          Pre-configured answers used by the Applier across job application portals. Update your
          values below to prevent the bot from pausing or guessing.
        </p>

        {/* Persistent, because saving stays blocked (in the store) until a reload succeeds. */}
        {loadError !== null && (
          <p className="store-notice store-notice--bad" role="alert">
            {loadError}. Your stored answers are not shown and saving is blocked so they are not
            overwritten. Use Refresh to retry.
          </p>
        )}

        {/* Top Summary Bar & Add Button */}
        <div className="answer-bank__top-bar">
          <div className="answer-bank__stats-bar">
            <span className="answer-bank__stat-pill">
              📋 <strong>{totalQuestions}</strong> Standard Questions
            </span>
            <span className="answer-bank__stat-pill">
              ⚡ <strong>{totalTimesUsed}</strong> Answers Injected
            </span>
            {needsAttentionCount > 0 && (
              <span className="answer-bank__stat-pill answer-bank__stat-pill--alert">
                ⚠️ <strong>{needsAttentionCount}</strong> Needs Human Answer
              </span>
            )}
          </div>

          <div className="answer-bank__top-actions">
            <button
              type="button"
              className="chip-btn"
              onClick={() => void fetchBank()}
              title="Reload from Supabase"
            >
              ↻ Refresh
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => setAddModalOpen(true)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <span>➕</span> Add Question
            </button>
          </div>
        </div>

        {/* Search & Category Filter Toolbar */}
        <div className="answer-bank__toolbar">
          <div className="answer-bank__search-wrap">
            <span aria-hidden="true">🔍</span>
            <input
              type="text"
              className="answer-bank__search-input"
              /* Placeholder text vanishes on input and is not a label; screen readers need this. */
              aria-label="Search answer bank questions"
              placeholder="Search questions, prompts, or values..."
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

            {needsAttentionCount > 0 && (
              <button
                type="button"
                className={`chip-btn ${activeCategory === 'needs_attention' ? 'chip-btn--active' : ''}`}
                onClick={() => setActiveCategory('needs_attention')}
                style={{ /* Warning token: #b45309 was the light-mode amber and too dark on a dark chip. */ color: 'var(--signal)', borderColor: 'var(--signal)' }}
              >
                ⚠️ Needs Attention ({needsAttentionCount})
              </button>
            )}
          </div>
        </div>

        {/* Table of Questions & Inputs */}
        <div className="settings-table-wrap">
          <table className="settings-table">
            <thead>
              <tr>
                <th scope="col" style={{ width: '28%' }}>Question Prompt</th>
                <th scope="col" style={{ width: '12%' }}>Type</th>
                <th scope="col" style={{ width: '36%' }}>Configured Standing Answer</th>
                <th scope="col" style={{ width: '14%' }}>Usage</th>
                <th scope="col" style={{ width: '10%' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', padding: 'var(--gap-5)', color: 'var(--text-muted)' }}>
                    Loading standing answers...
                  </td>
                </tr>
              ) : filtered.length > 0 ? (
                filtered.map((question) => {
                  const isEditing = editingKey === question.key;
                  const isSaving = savingKey === question.key;

                  return (
                    <tr key={question.key}>
                      <th scope="row">
                        <div>{question.asks}</div>
                        <span className="identifier">{question.key}</span>
                        {question.needsHuman && (
                          <div>
                            <span className="answer-bank__badge-needs-human">
                              ⚠️ Needs Human Answer
                            </span>
                          </div>
                        )}
                        <div style={{ marginTop: '4px', fontSize: 'var(--size-xs)', color: 'var(--text-secondary)', fontWeight: 'normal' }}>
                          {question.why}
                        </div>
                      </th>

                      <td>
                        <span className="identifier">{question.type}</span>
                        {question.isCustom && (
                          <div style={{ marginTop: '4px', fontSize: '0.7rem', color: 'var(--accent)' }}>
                            Custom
                          </div>
                        )}
                      </td>

                      <td>
                        {isEditing ? (
                          <div className="answer-bank__edit-container">
                            {/* NUMBER INPUT */}
                            {question.type === 'number' && (
                              <div>
                                <input
                                  type="number"
                                  className="answer-bank__input"
                                  value={String(draftValue ?? '')}
                                  onChange={(e) => setDraftValue(e.target.value === '' ? '' : Number(e.target.value))}
                                  autoFocus
                                />
                                {question.key === 'notice_period_days' && (
                                  <div className="answer-bank__quick-pills">
                                    <button type="button" className="answer-bank__quick-pill" onClick={() => setDraftValue(0)}>
                                      0 (Immediate)
                                    </button>
                                    <button type="button" className="answer-bank__quick-pill" onClick={() => setDraftValue(15)}>
                                      15 days
                                    </button>
                                    <button type="button" className="answer-bank__quick-pill" onClick={() => setDraftValue(30)}>
                                      30 days
                                    </button>
                                    <button type="button" className="answer-bank__quick-pill" onClick={() => setDraftValue(60)}>
                                      60 days
                                    </button>
                                    <button type="button" className="answer-bank__quick-pill" onClick={() => setDraftValue(90)}>
                                      90 days
                                    </button>
                                  </div>
                                )}
                                {question.key === 'current_ctc_inr' && (
                                  <div className="answer-bank__quick-pills">
                                    <button type="button" className="answer-bank__quick-pill" onClick={() => setDraftValue(0)}>
                                      ₹0 (Fresher/Student)
                                    </button>
                                    <button type="button" className="answer-bank__quick-pill" onClick={() => setDraftValue(300000)}>
                                      ₹3 LPA
                                    </button>
                                    <button type="button" className="answer-bank__quick-pill" onClick={() => setDraftValue(600000)}>
                                      ₹6 LPA
                                    </button>
                                    <button type="button" className="answer-bank__quick-pill" onClick={() => setDraftValue(1000000)}>
                                      ₹10 LPA
                                    </button>
                                  </div>
                                )}
                                {question.key === 'expected_ctc_inr' && (
                                  <div className="answer-bank__quick-pills">
                                    <button type="button" className="answer-bank__quick-pill" onClick={() => setDraftValue(800000)}>
                                      ₹8 LPA
                                    </button>
                                    <button type="button" className="answer-bank__quick-pill" onClick={() => setDraftValue(1200000)}>
                                      ₹12 LPA
                                    </button>
                                    <button type="button" className="answer-bank__quick-pill" onClick={() => setDraftValue(1500000)}>
                                      ₹15 LPA
                                    </button>
                                    <button type="button" className="answer-bank__quick-pill" onClick={() => setDraftValue(2000000)}>
                                      ₹20 LPA
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}

                            {/* BOOLEAN INPUT */}
                            {question.type === 'boolean' && (
                              <div className="answer-bank__bool-group">
                                <button
                                  type="button"
                                  className={`answer-bank__bool-btn ${draftValue === true || draftValue === 'true' ? 'answer-bank__bool-btn--active-yes' : ''}`}
                                  onClick={() => setDraftValue(true)}
                                >
                                  ✓ Yes (True)
                                </button>
                                <button
                                  type="button"
                                  className={`answer-bank__bool-btn ${draftValue === false || draftValue === 'false' ? 'answer-bank__bool-btn--active-no' : ''}`}
                                  onClick={() => setDraftValue(false)}
                                >
                                  ✕ No (False)
                                </button>
                              </div>
                            )}

                            {/* SINGLE SELECT (Gender, Disability, etc.) */}
                            {question.type === 'single_select' && (
                              <div>
                                {question.key === 'gender' ? (
                                  <select
                                    className="answer-bank__input"
                                    value={String(draftValue ?? '')}
                                    onChange={(e) => setDraftValue(e.target.value)}
                                  >
                                    <option value="Decline to self-identify">Decline to self-identify</option>
                                    <option value="Male">Male</option>
                                    <option value="Female">Female</option>
                                    <option value="Non-binary">Non-binary</option>
                                    <option value="Prefer to self-describe">Prefer to self-describe</option>
                                  </select>
                                ) : question.key === 'disability_status' ? (
                                  <select
                                    className="answer-bank__input"
                                    value={String(draftValue ?? '')}
                                    onChange={(e) => setDraftValue(e.target.value)}
                                  >
                                    <option value="No disability">No disability</option>
                                    <option value="Yes, I have a disability">Yes, I have a disability</option>
                                    <option value="Decline to self-identify">Decline to self-identify</option>
                                  </select>
                                ) : (
                                  <input
                                    type="text"
                                    className="answer-bank__input"
                                    value={String(draftValue ?? '')}
                                    onChange={(e) => setDraftValue(e.target.value)}
                                  />
                                )}
                              </div>
                            )}

                            {/* DATE INPUT */}
                            {question.type === 'date' && (
                              <div>
                                <input
                                  type="text"
                                  className="answer-bank__input"
                                  placeholder="e.g. Immediate or YYYY-MM-DD"
                                  value={String(draftValue ?? '')}
                                  onChange={(e) => setDraftValue(e.target.value)}
                                />
                                <div className="answer-bank__quick-pills">
                                  <button
                                    type="button"
                                    className="answer-bank__quick-pill"
                                    onClick={() => setDraftValue('Immediate')}
                                  >
                                    Immediate
                                  </button>
                                  <button
                                    type="button"
                                    className="answer-bank__quick-pill"
                                    onClick={() => {
                                      const d = new Date();
                                      d.setDate(d.getDate() + 15);
                                      setDraftValue(d.toISOString().slice(0, 10));
                                    }}
                                  >
                                    In 15 days
                                  </button>
                                </div>
                              </div>
                            )}

                            {/* LONG TEXT (Cover letter / statement) */}
                            {question.type === 'long_text' && (
                              <textarea
                                className="answer-bank__textarea"
                                rows={4}
                                value={String(draftValue ?? '')}
                                onChange={(e) => setDraftValue(e.target.value)}
                                placeholder="Enter introductory statement or cover letter..."
                              />
                            )}

                            {/* SHORT TEXT */}
                            {question.type === 'text' && (
                              <input
                                type="text"
                                className="answer-bank__input"
                                value={String(draftValue ?? '')}
                                onChange={(e) => setDraftValue(e.target.value)}
                              />
                            )}

                            {/* Save / Cancel Action Buttons */}
                            <div className="answer-bank__edit-actions">
                              <button
                                type="button"
                                className="answer-bank__btn-save"
                                onClick={() => void handleSaveEdit(question)}
                                disabled={isSaving}
                              >
                                {isSaving ? 'Saving...' : '💾 Save Answer'}
                              </button>
                              <button
                                type="button"
                                className="answer-bank__btn-cancel"
                                onClick={cancelEditing}
                                disabled={isSaving}
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                className="answer-bank__btn-reset"
                                onClick={() => handleResetToDefault(question)}
                                title="Reset to standard default"
                              >
                                ↺ Reset to default
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <strong style={{ fontSize: 'var(--size-sm)', color: 'var(--text-primary)' }}>
                              {formatAnswerPreview(question.type, question.value, question.key)}
                            </strong>
                            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '2px' }}>
                              <button
                                type="button"
                                className="answer-bank__action-btn answer-bank__action-btn--edit"
                                onClick={() => startEditing(question)}
                              >
                                ✏️ Edit Answer
                              </button>
                            </div>
                          </div>
                        )}
                      </td>

                      <td>
                        <span className="identifier">
                          {question.timesUsed > 0 ? `${question.timesUsed}x used` : 'Unused'}
                        </span>
                        {question.lastUsedAt && (
                          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                            {new Date(question.lastUsedAt).toLocaleDateString()}
                          </div>
                        )}
                      </td>

                      <td>
                        <div className="answer-bank__row-actions">
                          <button
                            type="button"
                            className="copy-btn answer-bank__action-btn"
                            onClick={() =>
                              void handleCopy(
                                typeof question.value === 'object'
                                  ? JSON.stringify(question.value)
                                  : String(question.value),
                                question.asks,
                              )
                            }
                            title="Copy answer value to clipboard"
                          >
                            📋 Copy
                          </button>
                          {question.isCustom && (
                            <button
                              type="button"
                              className="answer-bank__action-btn answer-bank__action-btn--delete"
                              onClick={() => void handleDeleteCustom(question)}
                              title="Delete custom question"
                            >
                              🗑️
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', padding: 'var(--gap-5)', color: 'var(--text-muted)' }}>
                    No screening questions matching your search criteria.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Eligibility answers: the worker answers these only from rows Teja saved; Save re-reads the bank so the shown state is the DB's. */}
      <EligibilityAnswers
        /* The same loaded bank as the table, so both views show one state. */
        questions={questions}
        /* While loading, the section must not claim "Not saved yet". */
        loading={loading}
        /* A failed read blocks saves; the section disables its buttons to match. */
        loadError={loadError}
        /* Re-read after a save so "Saved by you" comes from the DB's attested flag, not a guess. */
        onSaved={() => void fetchBank()}
      />

      {/* Add Custom Question Modal */}
      <AddQuestionModal
        isOpen={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        onAdd={handleAddQuestion}
      />
    </div>
  );
}
