// This module now lives in supabase/functions/_shared/resume-edit/master-store.ts (S9i, 2026-11-21).
// WHY: resume-assist applies chat edits server-side (Teja 15:34: edits land even with the tab closed), so the server
// runs the same master writes and checks as this page. One copy, imported by both sides by relative path.
// Re-exported here so every existing import in apps/web keeps working unchanged.
export * from '../../../../../supabase/functions/_shared/resume-edit/master-store.ts';
