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
  /* The remote row's `attested_by_human`, stamped by a DB trigger: true for a browser
   * (Teja's) write, false for a machine write. UNDEFINED means "no remote row exists",
   * which is a different fact from false: the eligibility section shows "Not saved yet"
   * for undefined and "Saved, not attested" for false. A row read before the column
   * exists also lands on false, because `=== true` refuses to trust a missing value. */
  readonly attestedByHuman?: boolean | undefined;
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
    // Worded as ATS forms ask it ("now or in the future"), because this text is the
    // question_text Teja attests to when he saves it from the eligibility section.
    asks: 'Will you now or in the future need visa sponsorship?',
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

/* Eligibility questions the worker's form filler answers ONLY from a row Teja saved
 * (attested_by_human = true). The keys are a contract with the worker, which matches
 * on them verbatim; renaming one silently sends that question back to a human.
 * `value: null` on purpose: an unsaved eligibility answer must render as "not answered",
 * never as a seed dressed up as Teja's answer. The suggestion lives in `defaultValue`.
 * Kept OUT of SEED_QUESTIONS so the standard-seed list (and its count test) is unchanged;
 * `visa_sponsorship_required` is reused from SEED_QUESTIONS rather than duplicated here. */
export const ELIGIBILITY_QUESTIONS: readonly BankQuestion[] = [
  {
    // Matched verbatim by the worker.
    key: 'located_in_country',
    // The label Teja sees and the question_text saved with his answer.
    asks: 'Which country are you located in?',
    // Free text: a country name, not a yes/no.
    type: 'text',
    // Grouped with work authorisation in the main table's filter chips.
    category: 'auth',
    // Unanswered until Teja saves; see the block comment above.
    value: null,
    // Teja's ruling of 2026-10-09, offered as a suggestion only.
    defaultValue: 'India',
    // Shown under the prompt in the main table.
    why: 'Answers "are you located in <country>?" eligibility questions.',
    // Not blocked on a human: the section itself is where the human answers.
    needsHuman: false,
    // No uses yet; the worker increments this.
    timesUsed: 0,
    // Never used yet.
    lastUsedAt: null,
  },
  {
    // Matched verbatim by the worker.
    key: 'employment_restrictions',
    // The label Teja sees and the question_text saved with his answer.
    asks: 'Employment agreements or post-employment restrictions (non-compete etc.)',
    // Free text, so a real restriction can be described rather than squeezed into yes/no.
    type: 'text',
    // Grouped with work authorisation in the main table.
    category: 'auth',
    // Unanswered until Teja saves.
    value: null,
    // Teja's ruling: none for now. The worker answers "No" only on exactly None/No.
    defaultValue: 'None',
    // Shown under the prompt in the main table; states the worker's exact rule.
    why: 'The bot answers "No" only when this is exactly "None" or "No"; anything else goes to you.',
    // Not blocked on a human.
    needsHuman: false,
    // No uses yet.
    timesUsed: 0,
    // Never used yet.
    lastUsedAt: null,
  },
  {
    // The normalised GitLab label; the worker matches on this exact key.
    key: 'what_is_your_primary_programming_language_and_or_framework',
    // The label as GitLab's form prints it.
    asks: 'What is your primary programming language and/or framework?',
    // One short line.
    type: 'text',
    // A written answer, not an authorisation fact.
    category: 'written',
    // Unanswered until Teja saves.
    value: null,
    // The suggestion is derived from the master profile at render time, not seeded.
    defaultValue: '',
    // Shown under the prompt in the main table.
    why: 'GitLab screening question; suggestion comes from your master profile skills.',
    // Not blocked on a human.
    needsHuman: false,
    // No uses yet.
    timesUsed: 0,
    // Never used yet.
    lastUsedAt: null,
  },
  {
    // The normalised GitLab label; the worker matches on this exact key.
    key: 'please_share_links_of_any_open_source_projects_you_own_or_have_made_contributions_to',
    // The label as GitLab's form prints it.
    asks: 'Please share links of any open source projects you own or have made contributions to',
    // Several URLs, one per line, so a textarea.
    type: 'long_text',
    // A written answer.
    category: 'written',
    // Unanswered until Teja saves.
    value: null,
    // Derived from the master profile's GitHub links at render time.
    defaultValue: '',
    // Shown under the prompt in the main table.
    why: 'GitLab screening question; suggestion is your GitHub project links.',
    // Not blocked on a human.
    needsHuman: false,
    // No uses yet.
    timesUsed: 0,
    // Never used yet.
    lastUsedAt: null,
  },
];

/* The order the eligibility section renders its editable fields in. A list of keys, not
 * of questions, so the visa seed is looked up from the loaded bank like the rest. */
export const ELIGIBILITY_KEYS: readonly string[] = [
  // Location first: it is the most common eligibility question.
  'located_in_country',
  // Reused standard seed; not duplicated in ELIGIBILITY_QUESTIONS.
  'visa_sponsorship_required',
  // Non-compete / agreements.
  'employment_restrictions',
  // GitLab free-text pair.
  'what_is_your_primary_programming_language_and_or_framework',
  // GitLab free-text pair.
  'please_share_links_of_any_open_source_projects_you_own_or_have_made_contributions_to',
];

/* An EEO question carries its option list, because the worker types the stored text
 * verbatim into a <select> and the form refuses any string it does not offer. */
export interface EeoQuestion extends BankQuestion {
  // Exact strings, verbatim from Greenhouse's public API for GitLab job 8775507002.
  readonly options: readonly string[];
}

/* Builds one EEO question. A helper, because the four differ only in key, text and options,
 * and every shared field (value null, needsHuman false) must be identical across them. */
function eeoQuestion(key: string, asks: string, options: readonly string[]): EeoQuestion {
  // Spread into a full BankQuestion so the store's save path takes it unchanged.
  return {
    // Matched verbatim by the worker.
    key,
    // The label Teja sees and the question_text saved with his answer.
    asks,
    // The AnswerType for a pick-one answer; saved as answer_type.
    type: 'single_select',
    // Lands under the main table's EEO filter, alongside the older gender seed.
    category: 'eeo',
    // Unanswered until Teja saves: unanswered means the worker leaves the field blank.
    value: null,
    // No default on purpose; never pre-select an answer, not even "Decline".
    defaultValue: null,
    // Shown under the prompt if the row ever surfaces in the main table.
    why: 'Voluntary EEO question; left blank on applications unless you save an answer.',
    // Not blocked on a human: an unanswered EEO field is simply left blank.
    needsHuman: false,
    // No uses yet.
    timesUsed: 0,
    // Never used yet.
    lastUsedAt: null,
    // The verbatim option strings.
    options,
  };
}

/* The voluntary self-identification questions. One copy shared by the UI and the tests,
 * so a typo in an option string is caught by a deepEqual, not by a refused form. */
export const EEO_QUESTIONS: readonly EeoQuestion[] = [
  // Greenhouse's gender options, in its order.
  eeoQuestion('eeo_gender', 'Gender', ['Decline To Self Identify', 'Female', 'Male']),
  // Option list NOT in the API; the UI says so, and the worker refuses if the form differs.
  eeoQuestion('eeo_hispanic_latino', 'Are you Hispanic/Latino?', ['Yes', 'No', 'Decline To Self Identify']),
  // Greenhouse's race options, in its order.
  eeoQuestion('eeo_race', 'Race (asked when Hispanic/Latino is No)', [
    // Spelling ("Alaskan") is Greenhouse's; do not correct it.
    'American Indian or Alaskan Native',
    // Verbatim.
    'Asian',
    // Verbatim.
    'Black or African American',
    // Verbatim.
    'Hispanic or Latino',
    // Verbatim.
    'Native Hawaiian or Other Pacific Islander',
    // Verbatim.
    'White',
    // Verbatim.
    'Two or More Races',
    // Verbatim.
    'Decline To Self Identify',
  ]),
  // Greenhouse's veteran options, in its order.
  eeoQuestion('eeo_veteran_status', 'Veteran Status', [
    // Verbatim.
    'I am not a protected veteran',
    // Verbatim.
    'I identify as one or more of the classifications of a protected veteran',
    // Verbatim, straight apostrophe included.
    "I don't wish to answer",
  ]),
];

/** Save is allowed only for one of the question's exact option strings. The "Not answered"
 * choice (any value outside the list, '' in the UI) is never saveable: an unanswered EEO
 * field must stay unanswered, not become a stored default. */
export function isSaveableEeoAnswer(question: EeoQuestion, value: unknown): boolean {
  // Strict membership: a string, and one the form will accept verbatim.
  return typeof value === 'string' && question.options.includes(value);
}

/** The three save states an eligibility field can be in. */
export type AttestationState = 'attested' | 'unattested' | 'unsaved';

/** Map the loaded row's flag to a state. Only `true` counts as attested: the worker
 * trusts nothing else, so the page must not either. */
export function attestationState(question: BankQuestion | undefined): AttestationState {
  // No question or no remote row: nothing has been saved.
  if (question === undefined || question.attestedByHuman === undefined) return 'unsaved';
  // Strict true only; a false or anything else is a row the worker will not use.
  return question.attestedByHuman === true ? 'attested' : 'unattested';
}

/* Minimal shapes the two suggestion helpers read, so tests can pass plain objects
 * instead of building a whole MasterProfile. MasterProfile satisfies both. */
interface SkillLike {
  // The skill as printed on the resume.
  readonly name: string;
  // The resume's grouping, e.g. "Languages" or "Frameworks".
  readonly category: string;
}
interface ProjectLike {
  // Every address of the project, in document order.
  readonly links: readonly { readonly url: string }[];
}

/** Suggest a "primary language and/or framework" answer from the master profile's skills:
 * the first three skills whose category reads as a language or framework, in document
 * order (which is Teja's own priority order). Empty string when nothing matches. */
export function suggestPrimaryLanguage(profile: { readonly skills: readonly SkillLike[] } | null): string {
  // No profile, no suggestion: an empty field is better than an invented one.
  if (profile === null) return '';
  // Category text is free-form ("Languages", "Frameworks & Libraries"), so a word test.
  const picked = profile.skills.filter((s) => /language|framework/i.test(s.category));
  // ponytail: first 3 by document order; a "primary" flag on the skill would be exact.
  return picked.slice(0, 3).map((s) => s.name.trim()).join(', ');
}

/** True when the URL's HOST is github.com (or a subdomain). A host check, not a substring
 * test, so "github.com.evil.example" or a "?ref=github.com" query does not pass. */
function isGithubUrl(raw: string): boolean {
  // Resume links are often written without a scheme ("github.com/x"); URL needs one.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  // URL throws on garbage; garbage is simply not a GitHub link.
  try {
    // Hostname is lowercased by URL already.
    const host = new URL(withScheme).hostname;
    // Exact host or a subdomain of it.
    return host === 'github.com' || host.endsWith('.github.com');
  } catch {
    // Unparseable: not a link we can vouch for.
    return false;
  }
}

/** Suggest the open-source links answer: every GitHub URL across the master profile's
 * projects, de-duplicated, one per line. Empty string when there are none. */
export function suggestOpenSourceLinks(profile: { readonly projects: readonly ProjectLike[] } | null): string {
  // No profile, no suggestion.
  if (profile === null) return '';
  // Flatten in document order; trimmed so stray whitespace does not defeat the de-dup.
  const urls = profile.projects.flatMap((p) => p.links.map((l) => l.url.trim()));
  // Set keeps first-seen order, so the output stays in document order.
  return [...new Set(urls.filter(isGithubUrl))].join('\n');
}

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

  // 1. Initialize with SEED_QUESTIONS, plus the eligibility questions so a remote row for
  //    one of them overlays its real metadata instead of landing as an unknown "custom" row.
  //    EEO questions too, for the same reason.
  for (const seed of [...SEED_QUESTIONS, ...ELIGIBILITY_QUESTIONS, ...EEO_QUESTIONS]) {
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
          // A row exists, so never undefined; strict true so a missing column reads as false.
          attestedByHuman: row.attested_by_human === true,
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
          // Same strict reading as the seeded branch above.
          attestedByHuman: row.attested_by_human === true,
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
