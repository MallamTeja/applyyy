// The per-row pipeline engine behind "Send through pipeline", re-exported from its shared home.
//
// WHY THIS FILE IS ONE LINE (audit W26, 2026-11-02): the engine moved to
// supabase/functions/_shared/pipeline/row-pipeline.ts, because job-link-intake runs it too and an
// edge function must not load web source (the web auto-deploys, the function deploys by hand).
// This re-export keeps the 11 web importers and their tests on the path they already use, so the
// move changed no web import line. Edit the engine at the shared path, never here; a change there
// means redeploying job-link-intake as well as the web.
export * from '../../../../../supabase/functions/_shared/pipeline/row-pipeline.ts';
