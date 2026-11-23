// This module now lives in supabase/functions/_shared/resume-edit/tailored-edits.ts (S9i, 2026-11-21).
// WHY: Teja ruled (15:34) that every resume-chat edit lands server-side, even with the tab closed, so resume-assist
// must run the same end-state checks the browser runs. One copy, imported by both sides by relative path (the
// validator.ts precedent), means the browser and the server can never disagree about what an edit may do.
// Re-exported here so every existing import in apps/web keeps working unchanged.
export * from '../../../../../supabase/functions/_shared/resume-edit/tailored-edits.ts';
