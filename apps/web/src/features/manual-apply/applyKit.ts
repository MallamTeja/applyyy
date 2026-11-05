/* The "manual apply kit": everything one application form asks, answered from our own data, so the
 * operator can fill a captcha-protected form by hand in a minute (2026-10-24).
 *
 * WHERE IT COMES FROM. The worker (apply-kit.yml, peer 4) appends one application_events row per
 * application: event_type 'note', detail.kind 'apply_kit'. That detail is the CONTRACT below, fixed
 * between the worker and this page. Pure module: no React, no client, so node --test reads it directly.
 *
 * WHY THE PARSE IS STRICT (CLAUDE.md §6). A kit is a list of answers Teja will paste into a real
 * employer's form. A malformed kit rendered "as far as it parses" would show a form that LOOKS complete
 * while a field is missing or misattributed. So a kit is all-or-nothing: either every field proves its
 * shape, or the whole kit is "unreadable" and no field is shown. */

// Type only: the status union the badge arithmetic takes.
import type { ApplicationStatus } from '../../data/contract.ts';
// The two-lane count from the status RPC: the badge's fallback when the page's own read is unavailable.
import { manualActionCount } from '../../data/humanLanes.ts';
// Type only: the page's row, so the badge counts the very list the page renders. A type-only import, so
// the runtime cycle with manualApplyData.ts (which imports this module) does not exist.
import type { ManualApplyRow } from './manualApplyData.ts';

// Where each answer came from, so the operator knows how much to trust it before pasting.
export type KitFieldSource = 'identity' | 'tailored' | 'answer_bank' | 'derived' | 'unanswered';
// The form control the answer goes into; decides whether a Copy button makes sense.
export type KitInputType = 'text' | 'textarea' | 'select' | 'checkbox' | 'radio' | 'file' | 'other';

/* One form field, in the order the form shows it. */
export interface KitField {
  // The form's own label.
  readonly label: string;
  // The answer, or null when we have none.
  readonly value: string | null;
  // Provenance.
  readonly source: KitFieldSource;
  // Whether the form refuses to submit without it.
  readonly required: boolean;
  // The control type.
  readonly inputType: KitInputType;
  // The choices of a select/radio, when the worker read them.
  readonly options: readonly string[] | null;
}

/* A validated kit (contract v1). */
export interface ApplyKit {
  // When the worker built it.
  readonly generatedAt: string;
  // The worker run that built it, when there was one.
  readonly runId: string | null;
  // The form's URL, UNTRUSTED: rendered only through safeHref.
  readonly formUrl: string;
  // The resume the kit was built with, in the private `resumes` bucket, or null.
  readonly resume: { readonly storagePath: string; readonly fileName: string } | null;
  // Every field, in form order.
  readonly fields: readonly KitField[];
  // Things the worker wants the operator to know first.
  readonly warnings: readonly string[];
}

/* What the page knows about one application's kit. Three states, never a partial kit. */
export type KitState =
  // No kit event for this application yet.
  | { readonly kind: 'none' }
  // The newest kit event failed validation; `reason` says which part.
  | { readonly kind: 'unreadable'; readonly reason: string }
  // A fully valid kit.
  | { readonly kind: 'kit'; readonly kit: ApplyKit };

// The closed sets, as runtime lists for the membership checks.
const SOURCES: ReadonlySet<string> = new Set(['identity', 'tailored', 'answer_bank', 'derived', 'unanswered']);
// Same for input types.
const INPUT_TYPES: ReadonlySet<string> = new Set(['text', 'textarea', 'select', 'checkbox', 'radio', 'file', 'other']);

// True for a plain object (not null, not an array).
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
// True for a string with visible characters.
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
// True for an array whose every element is a string.
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/* One field, or the reason it is not one. */
function parseField(raw: unknown, index: number): KitField | string {
  // Named by position, so the reason points at the broken field.
  const where = `field ${index + 1}`;
  // Must be an object.
  if (!isRecord(raw)) return `${where} is not an object`;
  // A field with no label cannot be matched to the form.
  if (!isText(raw['label'])) return `${where} has no label`;
  // An answer is a string or an explicit null; anything else (a number, missing) is a broken contract.
  if (!(raw['value'] === null || typeof raw['value'] === 'string')) return `${where} has a non-string value`;
  // Provenance from the closed set.
  if (typeof raw['source'] !== 'string' || !SOURCES.has(raw['source'])) return `${where} has an unknown source`;
  // A real boolean; a missing flag must not read as "optional".
  if (typeof raw['required'] !== 'boolean') return `${where} has no required flag`;
  // Input type from the closed set.
  if (typeof raw['input_type'] !== 'string' || !INPUT_TYPES.has(raw['input_type'])) return `${where} has an unknown input type`;
  // Options are optional, but when present must be all strings.
  if (raw['options'] !== undefined && !isStringArray(raw['options'])) return `${where} has malformed options`;
  // Proven; mapped to the page's names.
  return {
    label: raw['label'],
    value: raw['value'],
    source: raw['source'] as KitFieldSource,
    required: raw['required'],
    inputType: raw['input_type'] as KitInputType,
    options: raw['options'] === undefined ? null : (raw['options'] as string[]),
  };
}

/* A whole kit detail, validated against contract v1: a kit, or the first reason it is not one. */
export function parseApplyKit(detail: unknown): { readonly ok: true; readonly kit: ApplyKit } | { readonly ok: false; readonly reason: string } {
  // The payload must be an object.
  if (!isRecord(detail)) return { ok: false, reason: 'detail is not an object' };
  // The discriminator; the read filters on it, but the parse does not trust the filter.
  if (detail['kind'] !== 'apply_kit') return { ok: false, reason: 'not an apply_kit' };
  // Only v1 is understood; a newer shape is refused rather than half-read.
  if (detail['v'] !== 1) return { ok: false, reason: `unsupported version ${JSON.stringify(detail['v'])}` };
  // A parseable timestamp.
  if (typeof detail['generated_at'] !== 'string' || !Number.isFinite(Date.parse(detail['generated_at']))) return { ok: false, reason: 'generated_at is not a timestamp' };
  // A run id string, or an explicit null.
  if (!(detail['run_id'] === null || typeof detail['run_id'] === 'string')) return { ok: false, reason: 'run_id is malformed' };
  // The form URL must be present; whether it is SAFE is safeHref's job at render time.
  if (!isText(detail['form_url'])) return { ok: false, reason: 'form_url is missing' };
  // Resume: an object with both strings, or an explicit null.
  const resume = detail['resume'];
  // Neither shape: refused.
  if (!(resume === null || (isRecord(resume) && isText(resume['storage_path']) && isText(resume['file_name'])))) return { ok: false, reason: 'resume is malformed' };
  // A path that climbs out of its folder is not a storage path we produced.
  if (resume !== null && String(resume['storage_path']).split('/').includes('..')) return { ok: false, reason: 'resume path is malformed' };
  // Fields must be a list.
  if (!Array.isArray(detail['fields'])) return { ok: false, reason: 'fields is not a list' };
  // Warnings must be all strings.
  if (!isStringArray(detail['warnings'])) return { ok: false, reason: 'warnings is malformed' };
  // Every field proven; the first failure fails the kit.
  const fields: KitField[] = [];
  // In the worker's order, which is the form's order.
  for (const [i, raw] of detail['fields'].entries()) {
    // Parsed or refused.
    const field = parseField(raw, i);
    // All-or-nothing: one bad field makes the kit unreadable.
    if (typeof field === 'string') return { ok: false, reason: field };
    // Kept in order.
    fields.push(field);
  }
  // Fully valid.
  return {
    ok: true,
    kit: {
      generatedAt: detail['generated_at'],
      runId: detail['run_id'],
      formUrl: detail['form_url'],
      resume: resume === null ? null : { storagePath: String(resume['storage_path']), fileName: String(resume['file_name']) },
      fields,
      warnings: detail['warnings'],
    },
  };
}

/* The newest kit event per application, by an exact application_id key (the newestUnknownCauses
 * pattern in RecoveryQueue.tsx). The NEWEST event decides: if it is malformed the state is
 * "unreadable", never an older valid kit, because the older one may describe a form that changed. */
export function newestKitStates(events: unknown): ReadonlyMap<string, KitState> {
  // Newest event per application while scanning.
  const newest = new Map<string, { at: number; detail: unknown }>();
  // Not a list: no kits.
  if (!Array.isArray(events)) return new Map();
  // Each event proven enough to be ordered.
  for (const raw of events) {
    // Loose read.
    const e = raw as { application_id?: unknown; created_at?: unknown; detail?: unknown } | null;
    // The join key must be a real string.
    if (typeof e?.application_id !== 'string') continue;
    // An unorderable event cannot be "newest".
    const at = typeof e.created_at === 'string' ? Date.parse(e.created_at) : Number.NaN;
    // Skipped.
    if (!Number.isFinite(at)) continue;
    // The current newest for this application.
    const prev = newest.get(e.application_id);
    // Newest wins whatever the server order.
    if (prev === undefined || at > prev.at) newest.set(e.application_id, { at, detail: e.detail });
  }
  // Each application's newest event, parsed whole.
  return new Map([...newest].map(([id, { detail }]) => {
    // All-or-nothing.
    const parsed = parseApplyKit(detail);
    // A kit, or why not.
    const state: KitState = parsed.ok ? { kind: 'kit', kit: parsed.kit } : { kind: 'unreadable', reason: parsed.reason };
    // Keyed by application.
    return [id, state] as const;
  }));
}

/* "Copy all": one `label: value` line per field the operator types or picks, in form order. File
 * fields are skipped (the resume is downloaded, not pasted); a missing answer says so instead of
 * pasting an empty string that looks like an answer. */
export function copyAllText(kit: ApplyKit): string {
  // Form order, typed fields only.
  return kit.fields
    // A file input takes the downloaded resume, not text.
    .filter((f) => f.inputType !== 'file')
    // One line each.
    .map((f) => `${f.label}: ${f.value ?? '(unanswered)'}`)
    // Newline-separated, ready to paste into notes.
    .join('\n');
}

/* The statuses at which a kit row still needs the operator to apply: the submit stages, from approval
 * up to a confirmed send. A CLOSED list, not "not terminal": `applied` is not terminal (it moves on to
 * interview, offer, ...) yet nothing is left to apply, and awaiting_approval has not been approved. */
export const KIT_OPEN_STATUSES: readonly ApplicationStatus[] = ['approved', 'applying', 'needs_verification', 'blocked_needs_human'];

/* Whether a row with a kit still belongs on the Manual apply page. */
export function isOpenKitStatus(status: ApplicationStatus): boolean {
  // Membership in the closed list above.
  return KIT_OPEN_STATUSES.includes(status);
}

/* The rail badge for Manual apply: the number of rows the Manual apply page lists (2026-11-05).
 *
 * WHY THE PAGE'S LIST, NOT ITS OWN ARITHMETIC. The badge used to add the lane counts to the statuses of
 * rows with a kit. 6f91221 made the page also list approved rows with no kit yet ("Kit pending"), and the
 * badge, counting from a different row set, read 0 over 5 listed jobs. Counting mergeManualApplyRows'
 * output (the AppShell reads it through loadManualApply, the page's own loader) makes the two equal by
 * construction instead of by keeping two formulas in step.
 *
 * A FAILURE IS NOT A ZERO (CLAUDE.md §6). pageRows is null while the page's read is pending or failed; the
 * badge then shows the lane counts from the status RPC (an undercount the page corrects, never a made-up
 * row). counts is null when that RPC has not succeeded either: with nothing known, the badge is hidden. */
export function manualApplyCount(
  // Per-status counts from the status RPC, or null when that read has not succeeded.
  counts: Readonly<Partial<Record<ApplicationStatus, number>>> | null,
  // The page's row list (mergeManualApplyRows), or null when that read is pending or failed.
  pageRows: readonly ManualApplyRow[] | null,
): number {
  // The page's own list was read: it is the answer, exactly.
  if (pageRows !== null) return pageRows.length;
  // Otherwise the two lanes alone, when the RPC read succeeded; else nothing is known, so no badge.
  return counts === null ? 0 : manualActionCount(counts);
}
