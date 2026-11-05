-- P1-6, apply on approve (2026-11-05).
--
-- WHY THIS EXISTS. Teja (00:16 IST): "whenever i approve a job it need to be applied at that time, no
-- daily job applie limits at all, keep it unlimited". Ruled (12:50 IST): build it behind an OFF switch
-- he turns on himself, only after one proven live submit.
--
-- 1. auto_apply_on_approve: the switch dispatch-apply reads before it starts apply.yml. Server-side, so
--    the function can refuse while it is off whatever a browser sends. NOT NULL DEFAULT false: every
--    existing row is off after this migration, and a fresh row is born off. Lives on system_settings,
--    beside system_enabled (the kill switch) and the daily cap, in the owner-only row ("own settings"
--    policy, auth.uid() = user_id) that Search preferences already reads and upserts.
--
-- 2. max_applications_per_day becomes NULLABLE, so "no daily limit" is representable. The worker
--    already reads NULL as no daily cap (worker/src/supabase-gateway.ts fetchDailyCap). The existing
--    CHECK (> 0) passes NULL. NO data is changed here: Teja sets "No daily limit" himself in Search
--    preferences (orchestrator ruling, 2026-11-05), so no row is touched and no email is named.
--
-- Re-runnable: `add column if not exists`; `drop not null` on a nullable column is a no-op.

-- The switch, off for everyone.
alter table public.system_settings
  add column if not exists auto_apply_on_approve boolean not null default false;

-- Said where a reader of the schema will look.
comment on column public.system_settings.auto_apply_on_approve is
  'P1-6: when true, approving a job starts apply.yml as a live drain of the approved queue (dispatch-apply). Default false; the owner turns it on after one proven live submit.';

-- "No daily limit" = NULL.
alter table public.system_settings
  alter column max_applications_per_day drop not null;
