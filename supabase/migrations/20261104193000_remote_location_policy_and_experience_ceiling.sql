-- -----------------------------------------------------------------------------
-- search_preferences.remote_location_policy: what does "remote" mean for this user?
-- filter_rules experience_ceiling config.max_years: how many years is too many?
--
-- WHY THIS EXISTS (2026-11-04, Teja's rulings).
--
-- REMOTE. 18:26 IST: "i dont need country lokced remote except indain remote
-- jobs", then "i want remote jobs with no country lock too". He had read "remote"
-- as "work for a US company from India"; on the live approval queue 43 of 64
-- remote rows were "Remote - US", "Remote (United States | Canada)", "Remote UK"
-- and the like, which require the right to live and work in that country. No visa
-- path exists for a remote role. The work-auth gate kept every remote part since
-- 2026-10-24 ("i am ok with us jobs where i can work remotly"); this column lets the
-- gate read a remote part by the places it names. He also asked for the option to
-- be in Settings, in its section ("Where You Would Work"), so it is a column the
-- Settings page edits, not a constant in the gate.
--
-- EXPERIENCE. 19:00 IST: Axiad "AI-First Golang Developer", whose JD says "6-8
-- years of hands-on software development experience", went through Ready to
-- tailor, the approval queue and manual apply before Teja caught it. The cascade's
-- experience_ceiling rule (supabase/functions/_shared/filter/cascade.ts) has existed
-- since 2026-09-10 and never fired: nothing wrote jobs.min_experience_years (the
-- screener now reads it from the JD, _shared/screen/required-experience.ts), and the
-- live config was {} on both rows, so the rule warned "no max_years configured" and
-- kept everything. Teja's ruling (2026-11-01, confirmed 11-04): drop a HARD minimum
-- above 1 year. The threshold stays a setting in the rule's own config, never a
-- constant in code.
--
-- WHY A CLOSED TEXT UNION WITH A CHECK, NOT A BOOLEAN OR AN ENUM. Two readings
-- exist and a third must not be writable (CLAUDE.md section 6: a convenience
-- boolean beside a union collapses it back). A Postgres enum would need ALTER TYPE
-- for any future value and an enum-parity mirror in packages/shared-types; text with
-- a CHECK gives the same closed set at zero cost, as work_authorized_countries did.
--
-- WHY NOT NULL WITH A DEFAULT, unlike work_authorized_countries. That column's null
-- means "never set, gate open", a real third state. Here there is no third state:
-- every user has some reading of remote. The default IS Teja's ruling, so his two
-- rows (tejamallam00@ and the retired tejamallam1233@, the only auth.users, checked
-- 2026-10-24) take it on apply, and 'any' (the 10-24 behaviour) is one Settings
-- choice away.
--
-- DEPLOY ORDER (CLAUDE.md section 3): apply this BEFORE deploying screener,
-- scout-ats and matcher, and before the web push. All of them select the new
-- column, and a select naming a missing column fails the whole read.
-- -----------------------------------------------------------------------------

-- Re-runnable: a second apply is a no-op rather than an error. The CHECK is NOT written inline:
-- Postgres turns an inline column CHECK into its own add-constraint step, and relying on IF NOT
-- EXISTS to skip that too is version-dependent; a re-run could stack a second, auto-named
-- constraint (code review, 2026-11-04). It is added by name below, only when absent.
alter table public.search_preferences
  add column if not exists remote_location_policy text not null default 'unlocked_or_authorized';

-- The closed set, by name, exactly once.
do $$
begin
  -- Only when no constraint of this name exists on the table yet.
  if not exists (
    select 1 from pg_constraint
    where conname = 'search_preferences_remote_location_policy_check'
      and conrelid = 'public.search_preferences'::regclass
  ) then
    -- The two literals the gate, the shared Row type and the Settings select all use.
    alter table public.search_preferences
      add constraint search_preferences_remote_location_policy_check
      check (remote_location_policy in ('unlocked_or_authorized', 'any'));
  end if;
end
$$;

-- What the column means, kept on the column so a reader of the schema sees it.
comment on column public.search_preferences.remote_location_policy is
  'How the work-auth gate reads a remote location (Teja, 2026-11-04). unlocked_or_authorized: remote is kept only when it names no place or a place in work_authorized_countries ("Remote - US" drops, "Remote" and "Remote - India" stay). any: every remote part is kept, the 2026-10-24 behaviour.';

-- TEJA'S EXPERIENCE CEILING, recorded once in the rule's own config. Only rows
-- WITHOUT a max_years are touched, so a re-run never overwrites a ceiling set since.
-- auth.uid() is NULL inside a migration, so no per-user filter is possible; both
-- experience_ceiling rows are Teja's. The matched and written counts are reported
-- (CLAUDE.md section 7), and "nothing matched" is a warning, not an error, because a
-- re-run legitimately matches nothing.
do $$
declare
  -- How many experience_ceiling rows lack a threshold before the write.
  matched integer;
  -- How many the update actually wrote.
  written integer;
begin
  -- Count first, so the report can say whether the update did all it should.
  select count(*) into matched
    from public.filter_rules
    where rule_type = 'experience_ceiling' and not (config ? 'max_years');
  -- Merge max_years = 1 into the existing config, keeping any other keys.
  update public.filter_rules
    set config = config || jsonb_build_object('max_years', 1)
    where rule_type = 'experience_ceiling' and not (config ? 'max_years');
  -- The rows the update touched.
  get diagnostics written = row_count;
  -- A re-run, or a ceiling already set by hand: say so without failing the apply.
  if matched = 0 then
    raise warning 'experience_ceiling: no rule without max_years; nothing written';
  end if;
  -- Both numbers, so a mismatch is visible in the db push output.
  raise notice 'experience_ceiling max_years=1: matched %, written %', matched, written;
end
$$;
