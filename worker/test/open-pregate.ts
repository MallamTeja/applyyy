// Test helper (P1-6 B2, 2026-11-05): the pre-gate config with every gate OPEN, for tests whose subject
// is not the re-check. A live applyToOne / claim loop refuses to run without a re-check config (fail
// closed), so every live test hands one in; open gates keep each test's own subject unchanged.
import type { PreGatePreferences } from '../../supabase/functions/matcher/tech-pregate.ts';
import type { LoadedPreGatePreferences } from '../../supabase/functions/auditor/pregate.ts';
import type { SubmitRecheck } from '../src/apply-one.ts';

// No title list, no countries, any remote, no experience ceiling: nothing is dropped.
export const OPEN_PREGATE_PREFERENCES: PreGatePreferences = { titles: [], keywords: [], excludedKeywords: [], workAuthorizedCountries: null, remoteLocationPolicy: 'any', experienceMaxYears: null };

// What applyToOne takes.
export const OPEN_RECHECK: SubmitRecheck = { preferences: OPEN_PREGATE_PREFERENCES };

// What a gateway's loadPreGatePreferences answers.
export const loadOpenPreGatePreferences = async (): Promise<LoadedPreGatePreferences> => ({ kind: 'ok', preferences: OPEN_PREGATE_PREFERENCES });
