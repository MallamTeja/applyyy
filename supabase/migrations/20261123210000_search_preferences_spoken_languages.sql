-- -----------------------------------------------------------------------------
-- search_preferences.spoken_languages: which languages can the user work in?
--
-- WHY THIS EXISTS (Teja, 2026-11-23 20:00 IST): "rm the most recent java job because it needs germany ... make filter
-- which removes it". BBHT 5e108a32 ("Java Entwickler:in", board location "Homeoffice") reached `scored` with a JD
-- requiring "fließende Deutschkenntnisse (mind. C1)". The work-auth gate kept it correctly (no place is named
-- anywhere); the blocker was the LANGUAGE. The orch ruled a separate stage-0c gate,
-- supabase/functions/_shared/screen/language-gate.ts, with its own drop_reason 'language_required', so 'work_auth'
-- keeps one meaning. That gate reads this column.
--
-- WHY HERE, NOT IN THE MASTER PROFILE. The orch asked for "the master's languages", but master_profiles.profile has
-- no spoken-language field (v51, checked live 2026-11-23): its "Languages" skill group is programming languages.
-- Adding a field there would touch the master schema, its validator and the tailor's rebuild check for a fact the
-- resume never prints. search_preferences is the row the screener already loads, beside work_authorized_countries.
--
-- WHY NULLABLE WITH NO DEFAULT. null = never set: the gate passes everything and warns (CLAUDE.md section 6). A
-- missing answer must never read as "speaks nothing", which would drop every JD naming any language.
--
-- NO drop_reason MIGRATION NEEDED: applications.drop_reason is free text with no CHECK (checked live 2026-11-23).
-- -----------------------------------------------------------------------------

-- Re-runnable: a second apply is a no-op rather than an error.
alter table public.search_preferences
  add column if not exists spoken_languages text[];

-- What the column means, kept on the column so a reader of the schema sees it.
comment on column public.search_preferences.spoken_languages is
  'Languages the user can work in (English names or native names, e.g. English, Deutsch). A JD requiring fluency in a language not listed, or written mostly in one, is dropped by the screener as language_required. null or empty = never set, gate open.';

-- THE SEED: English only, the one language proven by the data (master v51 and every tailored resume are English).
-- Any other language Teja speaks (Hindi? Telugu?) is NOT guessed: it is a personal fact he adds in Settings or by
-- a follow-up update. Until then a JD that REQUIRES fluency in it drops (2026-11-23 preview: 0 of 37 in-flight rows,
-- 1 historic dropped row, a Bangalore role "fluent in Tamil"). Only null rows are touched, so a re-run never
-- overwrites a list saved since. auth.uid() is NULL in a migration, so no per-user filter (CLAUDE.md section 7).
update public.search_preferences
  set spoken_languages = array['English']
  where spoken_languages is null;

-- -----------------------------------------------------------------------------
-- THE QUEUE SWEEP MAY DROP FOR language_required TOO (added 2026-11-23, peer 2, same ruling).
-- WHY: the auditor's queue re-gate (auditor/regate-queue.ts) drops an awaiting_approval row that fails a gate Teja ruled
-- removes it, as for work_auth and title_seniority. guard_auditor_queue_drop_reason() (20261111220000, widened by
-- 20261121110000 and 20261121203000) refuses any other drop_reason from the auditor with 42501, so without this the
-- sweep's language drop would fail. Body copied from 20261121203000; only the closed list and its message change.
-- experience_ceiling stays OUT (reported only, ruling A).
-- DEPLOY ORDER: this migration BEFORE the auditor that writes language_required.
-- Re-runnable: update by key, then create or replace (the trigger from 20261121110000 calls the function by name).
-- -----------------------------------------------------------------------------

-- The edge note names every reason the auditor may use here.
update public.application_status_transitions
   -- Same agents as before (human + auditor); only the note changes.
   set note = 'Human declined (drop_reason carries why; a human is the last filter in the cascade). '
           || 'Since 2026-11-11 the auditor may also take it, ONLY with drop_reason work_auth, (since 2026-11-21) '
           || 'already_applied, (since 2026-11-21, Teja 20:12) title_seniority, or (since 2026-11-23) language_required '
           || '(guard_auditor_queue_drop_reason).'
 -- Exactly the one edge.
 where from_status = 'awaiting_approval' and to_status = 'dropped_filter';

-- The guard, with language_required added to the closed list.
create or replace function public.guard_auditor_queue_drop_reason()
  -- A trigger function.
  returns trigger
  -- Plain SQL-level checks, no privileges needed beyond the row.
  language plpgsql
  -- Fixed search_path, so no caller can shadow a name.
  set search_path = ''
as $$
begin
  -- Only the auditor's move off the approval queue is narrowed; every other move passes through untouched.
  if old.status = 'awaiting_approval'
     and new.status = 'dropped_filter'
     and pg_catalog.current_setting('applyy.acting_agent', true) = 'auditor'
     -- The closed list; a null reason is refused too (coalesce to '').
     and coalesce(new.drop_reason, '') not in ('work_auth', 'already_applied', 'title_seniority', 'language_required') then
    -- 42501, the code the transition guard uses for a wrong agent, so callers treat it as "not allowed".
    raise exception 'the auditor may drop an awaiting_approval row only for work_auth, already_applied, title_seniority or language_required (drop_reason %)', coalesce(new.drop_reason, 'null')
      using errcode = '42501';
  end if;
  -- Allowed.
  return new;
end;
$$;
