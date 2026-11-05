-- WHY THIS MIGRATION EXISTS (2026-11-05). Add to Applied must LINK, not duplicate.
--
-- 20261105124600 made Add to Applied (Emails page) create a NEW job for every email, keyed
-- 'email:<email id>'. When the job already exists (a scout found the posting under its board
-- fingerprint, or an earlier email about the same job was already added), that made a second job
-- and a second application for one real application. This replaces the function with the same body
-- plus ONE lookup: the caller's jobs with the same company and title, compared trimmed and
-- case-insensitively.
--   exactly one match -> reuse that job, and its application if it has one;
--   none              -> create, as before;
--   several           -> create, as before. Never guess between them: ~3,000 groups of same-company,
--                        same-title jobs exist live (multi-location postings, measured 2026-11-05), and
--                        the page has no picker. A wrong guess would mark the wrong job applied.
--
-- STATUS RULES. A reused application already applied (applied_at stamped by the guard trigger, which
-- also covers later stages such as interview) is only linked, never moved. Any other one goes through
-- advance_application_status() to `applied` as the human, so the graph decides: discovered, approved,
-- blocked_needs_human and needs_verification have a human edge; any other status (scored,
-- awaiting_approval, ...) is REFUSED by the graph (23514) and the whole call rolls back. Nothing is
-- linked half-way.
--
-- RETRY SAFETY. The page tells Teja a retry after a lost answer is safe. With linking, the email's
-- application may hang off a reused job, not off 'email:<id>', so the "already linked" check also
-- accepts a linked job with the typed company and title. Any other link is still refused.
--
-- Same signature, SECURITY INVOKER, empty search_path and grants as 20261105124600. Re-runnable
-- (create or replace + idempotent grants).

-- The one-click route. Returns the application id.
create or replace function public.track_email_as_applied(
  -- The unmatched email the job is created from.
  p_email_event_id uuid,
  -- The company and its slug, as Teja confirmed them on the Emails page.
  p_company text,
  p_company_slug text,
  -- The job title, as confirmed.
  p_title text
) returns uuid
-- plpgsql: several statements, one transaction.
language plpgsql
-- The caller's rights: RLS scopes every row.
security invoker
-- Empty search_path: every name below is schema-qualified, so a caller's objects cannot shadow ours.
set search_path = ''
as $$
declare
  -- The email, locked for the whole transaction so two clicks serialise.
  v_email record;
  -- The job's deterministic key when this email creates the job: one email can only ever create one job.
  v_fingerprint text;
  -- The job and application this email uses (reused, created, or from an earlier run).
  v_job uuid;
  v_app uuid;
  -- How many of the caller's jobs carry this company and title; only exactly 1 is reused.
  v_matches bigint;
  -- When the application reached applied, if ever: set means "already applied, link only".
  v_applied_at timestamptz;
begin
  -- Inputs first: a blank or oversized name would become a permanent row.
  if p_company is null or btrim(p_company) = '' or length(btrim(p_company)) > 200 then
    raise exception 'company must be 1-200 characters' using errcode = '22023';
  end if;
  -- Same rule for the title.
  if p_title is null or btrim(p_title) = '' or length(btrim(p_title)) > 200 then
    raise exception 'title must be 1-200 characters' using errcode = '22023';
  end if;
  -- The slug's SHAPE only (lowercase words joined by single dashes); its rule lives in the web.
  if p_company_slug is null or length(p_company_slug) > 200 or p_company_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'company_slug % is not a slug', p_company_slug using errcode = '22023';
  end if;

  -- The email, under RLS (only the caller's own), locked.
  select e.id, e.user_id, e.classification, e.matched_application_id, e.received_at, e.provider_message_id
    -- One record for every check below.
    into v_email
    from public.email_events e
   -- Exactly this email.
   where e.id = p_email_event_id
     -- Locked: a second click waits, then sees this one's link.
     for update;
  -- Not found, or not the caller's.
  if not found then
    raise exception 'email % not found', p_email_event_id using errcode = 'P0002';
  end if;
  -- Only mail about an application: an alert, a notice or an unread-by-the-classifier email is not one.
  if v_email.classification::text in ('unclassified', 'other', 'job_alert') then
    raise exception 'email % is %, not mail about an application', p_email_event_id, v_email.classification using errcode = '22023';
  end if;

  -- One email, one job, whatever the company and title typed (used only when this email creates the job).
  v_fingerprint := 'email:' || v_email.id::text;

  -- Already linked: a re-run of THIS email returns its own application; any other link is refused.
  if v_email.matched_application_id is not null then
    -- The linked application, if its job is the one this email created OR the same-name job it reused.
    select a.id into v_app
      from public.applications a
      -- Through the job, to compare its key and names.
      join public.jobs j on j.id = a.job_id
     -- Exactly the application the email points at, owned by the email's user.
     where a.id = v_email.matched_application_id and j.user_id = v_email.user_id
       -- Created from this email, or reused because company and title matched (the lookup below).
       and (j.fingerprint = v_fingerprint or (lower(btrim(j.company_name)) = lower(btrim(p_company)) and lower(btrim(j.title)) = lower(btrim(p_title))));
    -- Same application: idempotent.
    if v_app is not null then
      return v_app;
    end if;
    -- Linked to a different application (the tracker matched it): never re-link silently.
    raise exception 'email % is already linked to application %', p_email_event_id, v_email.matched_application_id using errcode = '22023';
  end if;

  -- THE FIX: the caller's jobs with this company and title, trimmed and case-insensitive. Count and the
  -- first id in one statement, so the decision below reads one snapshot. RLS also scopes it; the user
  -- filter keeps it correct even for a caller whose policies are wider.
  select count(*), (array_agg(j.id))[1] into v_matches, v_job from public.jobs j where j.user_id = v_email.user_id and lower(btrim(j.company_name)) = lower(btrim(p_company)) and lower(btrim(j.title)) = lower(btrim(p_title));

  -- Exactly one: reuse it (v_job is already its id). Zero or several: create, as before; never guess.
  if v_matches <> 1 then
    -- The job, owned by the email's user (carried from the row, as every write here is).
    insert into public.jobs (user_id, fingerprint, title, company_name, company_slug, apply_url, posted_at, posted_at_source, discovered_via)
    values (
      -- The email's owner, carried from the row.
      v_email.user_id,
      -- One email, one job.
      v_fingerprint,
      -- Trimmed, as validated.
      btrim(p_title),
      btrim(p_company),
      -- The web's slug, shape-checked above.
      p_company_slug,
      -- The only link we have: the email itself, in Gmail.
      'https://mail.google.com/mail/u/0/#all/' || v_email.provider_message_id,
      -- Not a posting date: the email's date, marked derived.
      v_email.received_at,
      'derived',
      -- Entered by hand; discovery_source has no email value.
      array['manual']::public.discovery_source[]
    )
    -- An earlier run's job is reused, never duplicated.
    on conflict (user_id, fingerprint) do nothing;
    -- The job's id, new or from an earlier run (overwrites the lookup's first id when there were several).
    select j.id into v_job from public.jobs j where j.user_id = v_email.user_id and j.fingerprint = v_fingerprint;
  end if;

  -- The application: reused if the job has one, else born at discovered (guard_status_insert's legal birth).
  insert into public.applications (user_id, job_id) values (v_email.user_id, v_job)
  -- One application per job per user (applications_user_job_key).
  on conflict (user_id, job_id) do nothing;
  -- Its id, and whether it has ever been applied.
  select a.id, a.applied_at into v_app, v_applied_at from public.applications a where a.user_id = v_email.user_id and a.job_id = v_job;

  -- -> applied through the one status writer, so the graph decides, the event is logged and applied_at is
  -- stamped. Skipped when it was already applied (or later): that application is only linked.
  if v_applied_at is null then
    perform public.advance_application_status(
      -- The new or reused application.
      v_app,
      -- To applied; the graph refuses a status with no human edge there, rolling the whole call back.
      'applied'::public.application_status,
      -- As the human: the browser holds no agent key, and these edges allow only human.
      'human'::public.agent_name,
      -- The event log says where the move came from and which email.
      jsonb_build_object('source', 'email_add_to_applied', 'email_event_id', v_email.id),
      -- No stale-read stamp, as in 20261105124600: the status was read in this same transaction.
      null
    );
  end if;

  -- The email now points at the job it is about.
  update public.email_events set matched_application_id = v_app where id = v_email.id;
  -- The caller shows it.
  return v_app;
end;
$$;

-- The browser's role may call it; nobody else (functions are executable by PUBLIC by default).
revoke all on function public.track_email_as_applied(uuid, text, text, text) from public, anon;
grant execute on function public.track_email_as_applied(uuid, text, text, text) to authenticated;
