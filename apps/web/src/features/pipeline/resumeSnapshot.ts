/* The tailored resume snapshot of one application, or null when there is none worth showing.

   WHY A SHAPE CHECK AND NOT A TRUTHY TEST. `applications.tailored_profile` is jsonb: it can be
   null (never tailored), `{}` (a malformed write) or any other JSON. A truthy test lets `{}`
   through, and the preview would then render an empty resume that LOOKS like the tailored one.
   Null here means the row offers no "View resume" at all; there is deliberately no fallback to
   the master, because showing the master under a row's name would claim it was tailored for it.

   Originally copied from approval/ApprovalQueuePage.tsx's isValidTailoredProfile, which was
   deleted on 2026-10-06 in favour of approval/tailoredEdits.ts isResumeShape (a stricter check
   of the same idea). Requires master_version on purpose: the preview is pinned to THAT version
   (not the latest master) and cannot pick one honestly without it. */

/* Type only: the frozen render input the preview takes. */
import type { ResolvedResume } from '../../data/contract';

export function readResumeSnapshot(value: unknown): ResolvedResume | null {
  /* null/undefined is the ordinary "never tailored" row; arrays are objects to typeof, so excluded explicitly. */
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  /* Narrowed once for the field checks below. */
  const p = value as Record<string, unknown>;
  /* The schema marker is what distinguishes a ResolvedResume from any other object. */
  if (p.schema_version !== 1) return null;
  /* The pinned master version the preview loads; a non-integer cannot name a stored version. */
  if (typeof p.master_version !== 'number' || !Number.isInteger(p.master_version) || p.master_version < 1) return null;
  /* Identity heads the rendered page; without it the render has no name to print. */
  if (typeof p.identity !== 'object' || p.identity === null) return null;
  /* The two sections every renderer path walks; same pair the approval page checks. */
  if (!Array.isArray(p.experience) || !Array.isArray(p.skills)) return null;
  /* Every check passed, so the cast states a fact rather than a hope. */
  return value as ResolvedResume;
}
