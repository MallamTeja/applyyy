-- WHY THIS MIGRATION EXISTS (2026-11-01).
--
-- application_events and resume_chat_messages are append-only: a BEFORE UPDATE and a BEFORE
-- DELETE trigger raise for every row, and RLS grants only select and insert. But the TABLE
-- PRIVILEGES said otherwise. Measured live on 2026-11-01:
--
--   authenticated held UPDATE, DELETE and TRUNCATE on both tables;
--   anon held UPDATE, DELETE and TRUNCATE on application_events (20,925 rows).
--
-- They come from Supabase's default privileges, which grant ALL on every new public table to
-- anon and authenticated. TRUNCATE is the one that matters: it bypasses RLS AND row-level
-- triggers (forbid_delete is FOR EACH ROW), so one statement run as either role would wipe an
-- audit log. Nothing reaches it today (PostgREST has no TRUNCATE route, and neither role can
-- log in directly), so the append-only promise rested on that absence. This makes it a control.
--
-- CORRECTION to 20261101120000_resume_chat_messages.sql (an applied migration, so corrected here,
-- never edited): its comment "no update or delete grant exists to misuse" was false. That
-- migration revoked from anon only and granted select, insert to authenticated, which ADDS to the
-- default ALL; it never removed update, delete or truncate.
--
-- WHAT THIS DOES NOT TOUCH: SELECT and INSERT (the page reads and appends chat messages; agents and
-- the status trigger insert events), service_role, and every other table. Approved by Teja on
-- 2026-11-01: "Approve, 2 tables only". FK cascades are unaffected: referential actions run as the
-- table owner, not as the caller.
--
-- Re-runnable: revoking a privilege that is not held is a no-op.

-- The event log: no API role may rewrite or empty it.
revoke update, delete, truncate on public.application_events from anon, authenticated;

-- The AI chat: same rule, same roles.
revoke update, delete, truncate on public.resume_chat_messages from anon, authenticated;

-- Verify after applying (all 12 must be false):
--   select t, r, v, has_table_privilege(r, t, v)
--   from unnest(array['public.application_events', 'public.resume_chat_messages']) t,
--        unnest(array['anon', 'authenticated']) r,
--        unnest(array['update', 'delete', 'truncate']) v;
