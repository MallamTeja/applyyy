/* Add custom screening question modal.
 *
 * Allows the operator to register new company-specific or ATS-specific questions
 * into the Answer Bank with typed validation, so the Applier can fill them
 * autonomously without pausing or hallucinating.
 */

import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

import type { AnswerType } from '../../data/contract';
import type { BankQuestion, QuestionCategory } from './answerBankStore';

import './settings.css';

interface AddQuestionModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onAdd: (question: BankQuestion) => Promise<{ ok: boolean; error?: string }>;
}

const CATEGORIES: readonly { id: QuestionCategory; label: string }[] = [
  { id: 'general', label: 'General / Technical' },
  { id: 'compensation', label: 'Compensation & Availability' },
  { id: 'auth', label: 'Work Authorization & Legal' },
  { id: 'eeo', label: 'EEO & Diversity' },
  { id: 'written', label: 'Written Response' },
];

const ANSWER_TYPES_OPTIONS: readonly { id: AnswerType; label: string }[] = [
  { id: 'text', label: 'Short Text' },
  { id: 'number', label: 'Number (Days, INR, Count)' },
  { id: 'boolean', label: 'Yes / No (Boolean)' },
  { id: 'single_select', label: 'Single Select Option' },
  { id: 'date', label: 'Date / Timeline' },
  { id: 'long_text', label: 'Long Text (Paragraph / Statement)' },
];

export function AddQuestionModal({ isOpen, onClose, onAdd }: AddQuestionModalProps): ReactElement | null {
  const [asks, setAsks] = useState('');
  const [customKey, setCustomKey] = useState('');
  const [category, setCategory] = useState<QuestionCategory>('general');
  const [type, setType] = useState<AnswerType>('text');
  const [value, setValue] = useState<unknown>('');
  const [why, setWhy] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  // Auto-suggest a normalized key when prompt changes if user hasn't explicitly customized key
  const handlePromptChange = (text: string) => {
    setAsks(text);
    if (!customKey || customKey === asks.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')) {
      const slug = text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
      setCustomKey(slug);
    }
  };

  const handleTypeChange = (newType: AnswerType) => {
    setType(newType);
    if (newType === 'boolean') {
      setValue(true);
    } else if (newType === 'number') {
      setValue(0);
    } else {
      setValue('');
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedAsks = asks.trim();
    const normalizedKey = customKey.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');

    if (!trimmedAsks) {
      setError('Please provide a question prompt.');
      return;
    }
    if (!normalizedKey) {
      setError('Please provide a unique question key.');
      return;
    }

    let finalValue = value;
    if (type === 'number') {
      finalValue = Number(value);
      if (isNaN(finalValue as number)) {
        setError('Please enter a valid numeric value.');
        return;
      }
    } else if (type === 'boolean') {
      finalValue = value === true || value === 'true';
    } else {
      if (String(value).trim() === '') {
        setError('Please provide an initial answer.');
        return;
      }
    }

    const newQuestion: BankQuestion = {
      key: normalizedKey,
      asks: trimmedAsks,
      type,
      category: category === 'all' ? 'general' : category,
      value: finalValue,
      defaultValue: finalValue,
      why: why.trim() || 'Custom screening question for job applications.',
      needsHuman: false,
      timesUsed: 0,
      lastUsedAt: null,
      isCustom: true,
    };

    try {
      setSubmitting(true);
      const res = await onAdd(newQuestion);
      if (!res.ok && res.error) {
        setError(res.error);
      } else {
        onClose();
      }
    } catch (err) {
      setError(`Failed to save question: ${String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="suggestions-overlay" onClick={onClose}>
      <div
        className="suggestions-modal"
        style={{ maxWidth: '580px' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-question-title"
      >
        <header className="suggestions-header">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 id="add-question-title" className="suggestions-header__title">
              Add Standing Question
            </h2>
            <button
              type="button"
              className="chip-btn"
              onClick={onClose}
              aria-label="Close dialog"
            >
              ✕
            </button>
          </div>
          <p className="suggestions-header__desc">
            Register a new screening question. The Applier will use this stored answer whenever it
            encounters this prompt on application portals.
          </p>
        </header>

        <form onSubmit={handleSubmit} style={{ padding: 'var(--gap-4) var(--gap-5)', overflowY: 'auto' }}>
          {error && (
            <div className="ingest__item ingest__item--blocking" style={{ marginBottom: 'var(--gap-3)' }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap-3)' }}>
            <div>
              <label className="field__label" htmlFor="q-prompt" style={{ display: 'block', marginBottom: '4px' }}>
                Question Prompt (as phrased on ATS forms) *
              </label>
              <input
                id="q-prompt"
                type="text"
                className="answer-bank__input"
                placeholder="e.g. Do you have experience with Kubernetes?"
                value={asks}
                onChange={(e) => handlePromptChange(e.target.value)}
                required
                autoFocus
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--gap-3)' }}>
              <div>
                <label className="field__label" htmlFor="q-key" style={{ display: 'block', marginBottom: '4px' }}>
                  Identifier Key *
                </label>
                <input
                  id="q-key"
                  type="text"
                  className="answer-bank__input"
                  placeholder="e.g. experience_kubernetes"
                  value={customKey}
                  onChange={(e) => setCustomKey(e.target.value)}
                  required
                />
              </div>

              <div>
                <label className="field__label" htmlFor="q-category" style={{ display: 'block', marginBottom: '4px' }}>
                  Category
                </label>
                <select
                  id="q-category"
                  className="answer-bank__input"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as QuestionCategory)}
                >
                  {CATEGORIES.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="field__label" htmlFor="q-type" style={{ display: 'block', marginBottom: '4px' }}>
                Answer Type
              </label>
              <select
                id="q-type"
                className="answer-bank__input"
                value={type}
                onChange={(e) => handleTypeChange(e.target.value as AnswerType)}
              >
                {ANSWER_TYPES_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="field__label" style={{ display: 'block', marginBottom: '4px' }}>
                Standing Answer Value *
              </label>

              {type === 'boolean' ? (
                <div className="answer-bank__bool-group">
                  <button
                    type="button"
                    className={`answer-bank__bool-btn ${value === true ? 'answer-bank__bool-btn--active-yes' : ''}`}
                    onClick={() => setValue(true)}
                  >
                    Yes (True)
                  </button>
                  <button
                    type="button"
                    className={`answer-bank__bool-btn ${value === false ? 'answer-bank__bool-btn--active-no' : ''}`}
                    onClick={() => setValue(false)}
                  >
                    No (False)
                  </button>
                </div>
              ) : type === 'number' ? (
                <input
                  type="number"
                  className="answer-bank__input"
                  placeholder="0"
                  value={String(value)}
                  onChange={(e) => setValue(e.target.value)}
                  required
                />
              ) : type === 'long_text' ? (
                <textarea
                  className="answer-bank__textarea"
                  placeholder="Enter detailed paragraph or response..."
                  rows={4}
                  value={String(value)}
                  onChange={(e) => setValue(e.target.value)}
                  required
                />
              ) : (
                <input
                  type="text"
                  className="answer-bank__input"
                  placeholder="Enter answer value..."
                  value={String(value)}
                  onChange={(e) => setValue(e.target.value)}
                  required
                />
              )}
            </div>

            <div>
              <label className="field__label" htmlFor="q-why" style={{ display: 'block', marginBottom: '4px' }}>
                Purpose / Context Notes (Optional)
              </label>
              <input
                id="q-why"
                type="text"
                className="answer-bank__input"
                placeholder="e.g. Disclosed when portal asks for container experience"
                value={why}
                onChange={(e) => setWhy(e.target.value)}
              />
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--gap-2)', marginTop: 'var(--gap-5)' }}>
            <button
              type="button"
              className="answer-bank__btn-cancel"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={submitting || !asks.trim()}
            >
              {submitting ? 'Saving...' : 'Save to Answer Bank'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
