/* The Applied page's "answers prepared for this form" (Teja, 2026-11-07): each applied row shows the
 * form answers from its NEWEST apply_kit note, next to the resume the page already shows.
 *
 * WHAT A KIT IS. What the system PREFILLED for the form (manual-apply/applyKit.ts contract v1), not a
 * record of what reached the employer. So every word built on this module says "prepared", never
 * "submitted".
 *
 * WHY THIS REUSES THE MANUAL APPLY PARSE. newestKitStates already picks the newest note per application
 * and refuses a malformed kit whole (CLAUDE.md section 6: a half-read kit looks complete while a field is
 * missing). A second parser here would drift from the one the worker's contract is tested against.
 *
 * Pure: no React, no client, so test/appliedSubmittedDetails.test.ts runs it without a DOM. */

// The shared kit parse: newest note per application, all-or-nothing validation.
import { newestKitStates } from '../manual-apply/applyKit.ts';
// Types only: one validated field, and the per-application kit state.
import type { KitField, KitState } from '../manual-apply/applyKit.ts';
// The page's ISO timestamp reader: Date.parse alone reads "-5" as year -5.
import { readTimestamp } from './appliedView.ts';

/* The kit read for the whole page: three honest states, so a failed read is never "no answers". */
export type AnswersRead =
  // Before the read answers.
  | { readonly kind: 'loading' }
  // supabase-js returned an error; its words are kept.
  | { readonly kind: 'error'; readonly message: string }
  // The newest kit state per application id.
  | { readonly kind: 'ok'; readonly states: ReadonlyMap<string, KitState> };

/* What one row's block shows. A closed union, so the view handles each state by name. */
export type PreparedAnswers =
  // The read has not answered.
  | { readonly kind: 'loading' }
  // The read failed: said, never shown as "no answers".
  | { readonly kind: 'error'; readonly message: string }
  // No kit note for this row (Gushwork, eTeam live 2026-11-07), or a kit with no fields.
  | { readonly kind: 'none' }
  // The newest kit failed its shape check: no field is shown, never a half-list.
  | { readonly kind: 'unreadable' }
  // The newest valid kit's fields, in form order, and when it was built (null when that time is junk).
  | { readonly kind: 'fields'; readonly fields: readonly KitField[]; readonly preparedAt: number | null };

/* The page's events answer as a successful read: the newest kit state per application. */
export function readKitAnswers(events: unknown): AnswersRead {
  // A non-list answer reads as "no kits" inside newestKitStates, never a throw.
  return { kind: 'ok', states: newestKitStates(events) };
}

/* One row's block from the page's read. */
export function answersFor(read: AnswersRead, applicationId: string): PreparedAnswers {
  // Loading and error pass through: neither is "no answers".
  if (read.kind !== 'ok') return read;
  // The newest note for this row, by exact id.
  const state = read.states.get(applicationId);
  // No note: the explicit empty state. A skip note is not a kit either (the read asks for kits only).
  if (state === undefined || state.kind === 'none' || state.kind === 'skipped') return { kind: 'none' };
  // A malformed newest kit hides every field; an older valid kit may describe a form that changed.
  if (state.kind === 'unreadable') return { kind: 'unreadable' };
  // A valid kit with nothing in it has no answers to show.
  if (state.kit.fields.length === 0) return { kind: 'none' };
  // The fields, and the build time only when it proves the ISO shape.
  return { kind: 'fields', fields: state.kit.fields, preparedAt: readTimestamp(state.kit.generatedAt) };
}
