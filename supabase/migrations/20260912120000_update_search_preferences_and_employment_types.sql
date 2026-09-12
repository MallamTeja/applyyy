-- =============================================================================
-- Migration: Add 'apprenticeship' to employment_type enum & expand search_preferences
--
-- 1. Adds 'apprenticeship' to employment_type enum (trainee / graduate schemes).
-- 2. Adds multi-select work_arrangements, max_salary, and compensation_types
--    to search_preferences.
-- =============================================================================

-- Add 'apprenticeship' to employment_type.
alter type public.employment_type add value if not exists 'apprenticeship';

-- Expand search_preferences for multi-select work arrangements, salary ceiling,
-- and compensation types (paid vs unpaid / stipend).
alter table public.search_preferences
  add column if not exists work_arrangements public.work_arrangement[] not null default '{onsite,hybrid,remote}',
  add column if not exists max_salary numeric(14, 2),
  add column if not exists compensation_types text[] not null default '{paid}';

comment on column public.search_preferences.work_arrangements is
  'Target work arrangements (onsite, hybrid, remote, unknown). Allows multi-select scouting.';

comment on column public.search_preferences.max_salary is
  'Upper bound / salary ceiling for compensation targeting.';

comment on column public.search_preferences.compensation_types is
  'Allowed compensation models: paid, unpaid, stipend. Defaults to {paid}.';
