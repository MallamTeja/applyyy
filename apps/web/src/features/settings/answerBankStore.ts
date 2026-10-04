/* Answer bank data store & persistence adapter.
 *
 * Implements the Answer Bank (PROJECT_PLAN.md section 15):
 * - Strongly typed questions (number, boolean, single_select, date, long_text, text)
 * - Anti-fabrication source of truth for the Applier
 * - Self-growing bank: stores answers, tracks times used, resolves needs_human
 * - Dual persistence: Supabase public.answer_bank + localStorage offline cache
 */

import type { AnswerType } from '../../data/contract.ts';
import { supabase } from '../../data/supabase.ts';
// Type-only: lets tests inject a client whose read fails, without a network.
import type { SupabaseClient } from '@supabase/supabase-js';

export type QuestionCategory = 'all' | 'compensation' | 'auth' | 'eeo' | 'written' | 'general';

export interface BankQuestion {
  readonly key: string;
  readonly asks: string;
  readonly type: AnswerType;
  readonly category: 'compensation' | 'auth' | 'eeo' | 'written' | 'general';
  readonly value: unknown;
  readonly defaultValue: unknown;
  readonly why: string;
  readonly needsHuman: boolean;
  readonly timesUsed: number;
  readonly lastUsedAt: string | null;
  readonly isCustom?: boolean;
}

export const SEED_QUESTIONS: readonly BankQuestion[] = [
  {
    key: 'notice_period_days',
    asks: 'Notice period (days)',
    type: 'number',
    category: 'compensation',
    value: 0,
    defaultValue: 0,
    why: 'Availability in days for full-time onboarding. 0 = Immediate.',
    needsHuman: false,
    timesUsed: 0,
    lastUsedAt: null,
  },
  {
    key: 'current_ctc_inr',
    asks: 'Current CTC',
    type: 'number',
    category: 'compensation',
    value: 0,
    defaultValue: 0,
    why: 'Current annual compensation in INR. ₹0 for student / fresher.',
    needsHuman: false,
    timesUsed: 0,
    lastUsedAt: null,
  },
  {
    key: 'expected_ctc_inr',
    asks: 'Expected CTC',
    type: 'number',
    category: 'compensation',
    value: 1200000,
    defaultValue: 1200000,
    why: 'Target annual compensation in INR submitted with job applications.',
    needsHuman: false,
    timesUsed: 0,
    lastUsedAt: null,
  },
  {
    key: 'willing_to_relocate',
    asks: 'Are you willing to relocate?',
    type: 'boolean',
    category: 'auth',
    value: true,
    defaultValue: true,
    why: 'Willingness to relocate to office locations if required.',
    needsHuman: false,
    timesUsed: 0,
    lastUsedAt: null,
  },
  {
    key: 'work_authorisation_india',
    asks: 'Are you authorised to work in India?',
    type: 'boolean',
    category: 'auth',
    value: true,
    defaultValue: true,
    why: 'Legal authorization status to work in India (Citizen or PR).',
    needsHuman: false,
    timesUsed: 0,
    lastUsedAt: null,
  },
  {
    key: 'visa_sponsorship_required',
    asks: 'Do you require visa sponsorship?',
    type: 'boolean',
    category: 'auth',
    value: false,
    defaultValue: false,
    why: 'Whether visa sponsorship is requested from employer.',
    needsHuman: false,
    timesUsed: 0,
    lastUsedAt: null,
  },
  {
    key: 'earliest_start_date',
    asks: 'Earliest start date',
    type: 'date',
    category: 'compensation',
    value: 'Immediate',
    defaultValue: 'Immediate',
    why: 'Earliest available date to join.',
    needsHuman: false,
    timesUsed: 0,
    lastUsedAt: null,
  },
  {
    key: 'gender',
    asks: 'Gender (EEO / diversity)',
    type: 'single_select',
    category: 'eeo',
    value: 'Decline to self-identify',
    defaultValue: 'Decline to self-identify',
    why: 'Standard EEO diversity disclosure.',
    needsHuman: false,
    timesUsed: 0,
    lastUsedAt: null,
  },
  {
    key: 'disability_status',
    asks: 'Disability status (EEO)',
    type: 'single_select',
    category: 'eeo',
    value: 'No disability',
    defaultValue: 'No disability',
    why: 'Standard EEO disability status disclosure.',
    needsHuman: false,
    timesUsed: 0,
    lastUsedAt: null,
  },
  {
    key: 'cover_letter_generic',
    asks: 'Cover letter / notes',
    type: 'long_text',
    category: 'written',
    value:
      'Experienced software engineer focused on building robust full-stack applications, scalable APIs, and AI systems. Excited to contribute strong software design and problem-solving skills.',
    defaultValue:
      'Experienced software engineer focused on building robust full-stack applications, scalable APIs, and AI systems. Excited to contribute strong software design and problem-solving skills.',
    why: 'Default introductory note submitted when portals require a cover letter.',
    needsHuman: false,
    timesUsed: 0,
    lastUsedAt: null,
  },
];

const LOCAL_STORAGE_KEY = 'applyy_answer_bank_overrides_v1';

export interface StoredOverride {
  key: string;
  asks?: string | undefined;
  type?: AnswerType | undefined;
  category?: ('compensation' | 'auth' | 'eeo' | 'written' | 'general') | undefined;
  value: unknown;
  why?: string | undefined;
  needsHuman?: boolean | undefined;
  timesUsed?: number | undefined;
  lastUsedAt?: string | null | undefined;
  isCustom?: boolean | undefined;
}

/** Read overrides cached in localStorage */
export function readLocalOverrides(): Record<string, StoredOverride> {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, StoredOverride>;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Write overrides cached in localStorage */
export function writeLocalOverrides(overrides: Record<string, StoredOverride>): void {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Storage quota or private mode protection
  }
}

/** Format answer value for concise display in tables */
export function formatAnswerPreview(type: AnswerType, value: unknown, key?: string): string {
  if (value === null || value === undefined || value === '') {
    return '— Not answered —';
  }

  if (type === 'boolean') {
    return value === true || value === 'true' ? 'Yes' : 'No';
  }

  if (type === 'number') {
    const num = Number(value);
    if (isNaN(num)) return String(value);

    if (key?.includes('ctc') || key?.includes('salary')) {
      if (num === 0) return '₹ 0 (Fresher / Student)';
      if (num >= 10000000) return `₹ ${(num / 10000000).toFixed(2)} Cr`;
      if (num >= 100000) return `₹ ${(num / 100000).toFixed(1)} LPA (${num.toLocaleString('en-IN')})`;
      return `₹ ${num.toLocaleString('en-IN')}`;
    }

    if (key?.includes('notice_period') || key?.includes('days')) {
      if (num === 0) return '0 days (Immediate)';
      return `${num} days`;
    }

    return num.toLocaleString('en-IN');
  }

  const str = String(value);
  if (str.length > 80) {
    return `${str.slice(0, 77)}...`;
  }
  return str;
}

/* The last remote read's failure, or null after a successful (or no-backend) read.
 * Module state so the WRITE functions can refuse on their own: the guard lives in
 * the functions every save crosses, not in each page that calls them. */
let lastReadError: string | null = null;

/** Why the last remote read failed, or null. */
export function getAnswerBankReadError(): string | null {
  // A getter, so callers cannot clear the guard by assignment.
  return lastReadError;
}

/* Shared refusal for every write while the read is failed. */
function blockedWrite(): { ok: false; error: string } {
  // Names the cause and the fix, so the toast is actionable.
  return {
    ok: false,
    // The read error is included verbatim for diagnosis.
    error: `Not saved: your answer bank failed to load (${lastReadError ?? 'unknown error'}), so saving could overwrite your stored answers. Reload and try again.`,
  };
}

/** Load all answer bank questions (seed + custom, with remote and local values merged).
 *
 * THROWS when the remote read fails. Until 2026-10-04 a failed read was swallowed
 * and the seed values rendered as if they were the user's answers, and the next
 * Save wrote them over the real remote rows. Seeds now apply only beneath a read
 * that SUCCEEDED; a failure records itself and blocks every write. */
export async function loadAnswerBank(
  // Injectable for tests; production callers pass nothing and get the app client.
  client: SupabaseClient | null = supabase,
): Promise<BankQuestion[]> {
  const localMap = readLocalOverrides();
  const resultMap = new Map<string, BankQuestion>();

  // 1. Initialize with SEED_QUESTIONS
  for (const seed of SEED_QUESTIONS) {
    const local = localMap[seed.key];
    resultMap.set(seed.key, {
      ...seed,
      value: local?.value !== undefined ? local.value : seed.value,
      needsHuman: local?.needsHuman !== undefined ? local.needsHuman : seed.needsHuman,
      timesUsed: local?.timesUsed !== undefined ? local.timesUsed : seed.timesUsed,
      lastUsedAt: local?.lastUsedAt !== undefined ? local.lastUsedAt : seed.lastUsedAt,
    });
  }

  // 2. Add any custom items saved locally
  for (const [key, item] of Object.entries(localMap)) {
    if (!resultMap.has(key) && item.isCustom) {
      resultMap.set(key, {
        key,
        asks: item.asks || key,
        type: item.type || 'text',
        category: item.category || 'general',
        value: item.value,
        defaultValue: item.value,
        why: item.why || 'Custom screening question.',
        needsHuman: item.needsHuman ?? false,
        timesUsed: item.timesUsed ?? 0,
        lastUsedAt: item.lastUsedAt ?? null,
        isCustom: true,
      });
    }
  }

  // 3. If Supabase is available, sync and merge remote rows
  if (client === null) {
    // Local-only mode is a real mode, not a failed read.
    lastReadError = null;
  } else {
    // Captures a returned or thrown failure so both take one path.
    let failure: string | null = null;
    // Holds the rows only when the read succeeded.
    let rows: unknown[] = [];
    // The read itself; a thrown network error is caught below.
    try {
      const { data, error } = await client
        .from('answer_bank')
        .select('*')
        .order('question_key', { ascending: true });
      // Error checked on its own: "errored" and "no rows" are opposite claims.
      if (error) failure = error.message;
      // A success without an array is not trustworthy as "no rows".
      else if (!Array.isArray(data)) failure = 'answer_bank read returned no data';
      // Success: keep the rows for the merge below.
      else rows = data;
    } catch (err) {
      // Thrown failures (network, CORS) are read failures too.
      failure = err instanceof Error ? err.message : String(err);
    }
    // Record the outcome either way, so a recovered read clears an old failure.
    lastReadError = failure;
    // Refuse to return seeds dressed as the user's answers.
    if (failure !== null) throw new Error(`Failed to load answer bank: ${failure}`);
    // Typed loosely on purpose: the row shape is the remote table's, read field by field.
    const data = rows as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

    // Overlay each remote row on the seeds and local values.
    for (const row of data) {
      const existing = resultMap.get(row.question_key);
      const val = row.answer_value;

      if (existing) {
        resultMap.set(row.question_key, {
          ...existing,
          value: val !== null && val !== undefined ? val : existing.value,
          needsHuman: row.needs_human,
          timesUsed: row.times_used ?? existing.timesUsed,
          lastUsedAt: row.last_used_at ?? existing.lastUsedAt,
        });
      } else {
        // New question dynamically discovered by Applier on an ATS!
        resultMap.set(row.question_key, {
          key: row.question_key,
          asks: row.question_text || row.question_key,
          type: row.answer_type || 'text',
          category: 'general',
          value: val,
          defaultValue: val,
          why: 'Discovered from ATS application portal.',
          needsHuman: row.needs_human,
          timesUsed: row.times_used ?? 0,
          lastUsedAt: row.last_used_at ?? null,
          isCustom: true,
        });
      }
    }
  }

  return Array.from(resultMap.values());
}

/** Save an answer to the answer bank (Supabase + localStorage) */
export async function saveBankAnswer(
  question: BankQuestion,
  newValue: unknown,
  // Injectable for tests, same as loadAnswerBank.
  client: SupabaseClient | null = supabase,
): Promise<{ ok: boolean; error?: string }> {
  // Refuse before ANY write, local included, while the last read stands failed.
  if (lastReadError !== null) return blockedWrite();
  // Update local storage first
  const localMap = readLocalOverrides();
  localMap[question.key] = {
    key: question.key,
    asks: question.asks,
    type: question.type,
    category: question.category,
    value: newValue,
    why: question.why,
    needsHuman: false,
    timesUsed: question.timesUsed,
    lastUsedAt: question.lastUsedAt,
    isCustom: question.isCustom,
  };
  writeLocalOverrides(localMap);

  // Sync to Supabase
  if (client !== null) {
    try {
      const { data: userData } = await client.auth.getUser();
      const userId = userData?.user?.id;

      const payload = {
        question_key: question.key,
        question_text: question.asks,
        answer_type: question.type,
        answer_value: newValue,
        needs_human: false,
        updated_at: new Date().toISOString(),
        ...(userId ? { user_id: userId } : {}),
      };

      const { error } = await client
        .from('answer_bank')
        .upsert(payload, { onConflict: 'user_id,question_key' });

      if (error) {
        return { ok: false, error: `Saved locally; remote sync warning: ${error.message}` };
      }
    } catch (err) {
      return { ok: false, error: `Saved locally; remote error: ${String(err)}` };
    }
  }

  return { ok: true };
}

/** Delete a custom question from the answer bank */
export async function deleteCustomBankQuestion(
  questionKey: string,
): Promise<{ ok: boolean; error?: string }> {
  // A delete is a write too; same refusal while the read stands failed.
  if (lastReadError !== null) return blockedWrite();
  // Remove from local storage
  const localMap = readLocalOverrides();
  delete localMap[questionKey];
  writeLocalOverrides(localMap);

  // Remove from Supabase
  if (supabase !== null) {
    try {
      const { error } = await supabase
        .from('answer_bank')
        .delete()
        .eq('question_key', questionKey);

      if (error) {
        return { ok: false, error: error.message };
      }
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  return { ok: true };
}
