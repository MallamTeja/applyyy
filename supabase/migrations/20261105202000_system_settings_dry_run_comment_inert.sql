-- 20261105202000_system_settings_dry_run_comment_inert.sql — correct a comment that claims a control.
--
-- WHY THIS EXISTS (P3 #2, 2026-11-05). 20260909234700_core_tables.sql documents
-- system_settings.dry_run as "Fills and screenshots forms without submitting. Real submission
-- requires explicit opt-in." Nothing reads that column. Re-measured 2026-11-05 by grepping
-- apps/web/src, worker/src, supabase/functions and .github/workflows: every "dry_run" hit is
-- the apply.yml workflow INPUT or a log/outcome label, never system_settings.dry_run. Whether
-- a run submits is decided by apply.yml: its `dry_run` input on a manual dispatch, and the
-- repository variable APPLYY_CRON_LIVE on a scheduled run.
--
-- A comment that names a safety control which does not exist is worse than no comment: a
-- reader flipping this column to TRUE believes submission has stopped while the next live
-- dispatch still submits (CLAUDE.md §6: a comment is not a control). The comment now says the
-- column is inert and where the real switch lives.
--
-- COMMENT-ONLY: no data, no schema, no behaviour change. The old migration is not edited (an
-- applied migration never is); `comment on` simply replaces the text. Re-runnable as is.
comment on column public.system_settings.dry_run is
  'INERT: read by nothing (verified 2026-11-05). Setting it does NOT stop submission. Live vs dry is '
  'decided by .github/workflows/apply.yml: the dry_run workflow input on a manual or dispatch-apply run, '
  'and the repository variable APPLYY_CRON_LIVE for scheduled runs. Kept only so existing rows and '
  'types stay valid; see migration 20261105202000.';
