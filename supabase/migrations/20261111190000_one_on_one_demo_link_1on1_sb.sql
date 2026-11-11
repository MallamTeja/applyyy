-- Why this migration exists: Teja ruled on 2026-11-11 (18:5x IST) that the One-on-One project's
-- "Live Demo" link moves from https://open1on1.vercel.app to https://1on1-sb.vercel.app on every
-- resume, "in one shot". Scope he chose: every master version + every resume still in the live
-- queue (awaiting_approval, approved). Rows that were applied/failed/rejected/dropped keep the old
-- link ON PURPOSE: that is the resume an employer actually received, and the snapshot is the record.
--
-- Why it rewrites ALL 39 master versions instead of inserting a v40: each queued row pins its own
-- master (v27/29/32/39 measured) and the approval page rebuilds the row's "original" from that pin
-- (rebuildOriginal, apps/web/src/features/approval/tailoredEdits.ts). Editing only the tailored copy
-- would show the link as an unexplained edit on every row, and the validator re-resolves links from
-- the pinned master by ref, so the next edit would put the OLD link back. Changing the pins too keeps
-- snapshot == rebuild.
--
-- Two append-only/freeze controls are switched off for THESE statements only and switched back on
-- before the transaction commits (a migration runs in one transaction, so no other session ever sees
-- them off): master_profiles.forbid_update and applications.guard_tailored_profile_freeze.
-- Do NOT copy this pattern for content edits: a new resume normally needs a new master version or a
-- re-tailor. This is a pure URL swap with a human ruling behind it.

-- Lift the master's append-only guard; the master rows are the source every resume is rebuilt from.
alter table public.master_profiles disable trigger forbid_update;
-- Lift the freeze so the 17 approved rows (frozen by design) can carry the new link too.
alter table public.applications disable trigger guard_tailored_profile_freeze;

do $$
declare
  -- How many master versions held the old link, so the report can be checked against the 39 measured.
  v_master int;
  -- How many queued resumes held it, checked against the 109 measured (92 awaiting + 17 approved).
  v_apps int;
begin
  -- Text replace on the jsonb rendering: the URL appears only as a string value, and the cast back
  -- to jsonb re-validates the document, so a malformed result aborts the whole migration.
  update public.master_profiles
     set profile = replace(profile::text, 'https://open1on1.vercel.app', 'https://1on1-sb.vercel.app')::jsonb,
         -- Recompute the digest exactly as assign_master_profile_content_hash does on insert, so the
         -- (user_id, content_hash) dedup key keeps describing the stored document.
         content_hash = encode(pg_catalog.sha256(pg_catalog.convert_to(
           replace(profile::text, 'https://open1on1.vercel.app', 'https://1on1-sb.vercel.app')::jsonb::text, 'UTF8')), 'hex')
   -- Only rows that carry the old link; every other row stays byte-identical.
   where profile::text like '%https://open1on1.vercel.app%';
  -- Rows the master update wrote.
  get diagnostics v_master = row_count;

  -- The live queue only: history keeps what was sent (see header).
  update public.applications
     set tailored_profile = replace(tailored_profile::text, 'https://open1on1.vercel.app', 'https://1on1-sb.vercel.app')::jsonb
   where status in ('awaiting_approval', 'approved')
     -- Only rows that carry the old link, so updated_at moves on nothing else.
     and tailored_profile::text like '%https://open1on1.vercel.app%';
  -- Rows the application update wrote.
  get diagnostics v_apps = row_count;

  -- Warning, not exception, per repo rule: report both counts so the operator can compare.
  raise warning 'demo link swap: % master versions, % queued resumes rewritten', v_master, v_apps;
end;
$$;

-- Put both controls back before commit; everything after this point is guarded again.
alter table public.master_profiles enable trigger forbid_update;
-- Same for the freeze: approved resumes are frozen again from here.
alter table public.applications enable trigger guard_tailored_profile_freeze;
