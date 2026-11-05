-- WHY THIS MIGRATION EXISTS (2026-11-05). Two Emails-page features Teja asked for, one table.
--
-- (C) ADD TO APPLIED. Teja applies to some jobs OUTSIDE the portal (a recruiter's link, a careers page).
-- The tracker then captures their mail (a receipt, an assessment, an interview invite), but the mail
-- matches no application, because there is none, so nothing tracks that job. Teja ruled (12:31 IST,
-- "Inbox + one-click add"): the Emails page lists those unmatched job emails, and one click creates
-- the job and its application at `applied` and links the email. NEVER created automatically.
--
-- WHY A NEW EDGE, discovered -> applied (human). An application is born only at discovered,
-- passed_filters or dropped_filter (guard_status_insert), and no edge led from those to `applied`.
-- Going through `approved` instead would stamp approved_at for an approval that never happened, and
-- an insert at `approved` is forbidden. The edge opens NO submit path: the applier reads only
-- `approved` rows, and approved -> applying remains the only edge into `applying`.
-- ONLY track_email_as_applied takes this edge. No screen offers it on a scouted `discovered` row:
-- apps/web/src/data/humanLanes.ts lists it in RPC_ONLY_HUMAN_EDGES, the screens' move lists exclude it,
-- and apps/web/test/emailsTrack.test.ts goes red if a lane ever offers it.
--
-- WHY ONE SECURITY INVOKER FUNCTION, not four browser writes. Insert job, insert application, advance,
-- link the email: as four requests, a failure after the second would leave an orphan `discovered` row
-- that the normalizer picks up and sends down the whole pipeline. Inside one function it is one
-- transaction, and no agent ever sees the row at `discovered`. INVOKER, not DEFINER: RLS still scopes
-- every read and write to the caller ("own ..." policies), so the function holds no privilege of its own.
--
-- (D) READ STATE. email_events.read_at: when Teja marked the email read IN THIS APP. It is never Gmail's
-- read state: changing that would widen the Apps Script's OAuth scope to gmail.modify, which nobody
-- asked for. The browser sets it through the existing "own email events" policy; the intake's upsert
-- (ignoreDuplicates) never touches it.
--
-- Not re-runnable as written (plain insert into a primary-keyed graph table): run once, like every graph
-- migration here. The column and the function are idempotent (if not exists / or replace).

-- (D) The in-app read mark. NULL = unread; a timestamp, not a boolean, so "read when" is kept.
alter table public.email_events add column if not exists read_at timestamptz;

-- (C) The one new edge, human-only, in the tuple shape the TS parity test parses (status-flow.ts mirrors it).
insert into public.application_status_transitions (from_status, to_status, allowed_agents, note) values
  -- Born and advanced inside track_email_as_applied, in one transaction.
  ('discovered', 'applied', array['human']::public.agent_name[], 'Human tracks a job applied to outside the portal, from its email (Emails page, Add to Applied).');

-- (C) The one-click route. Returns the application id.
--   p_company_slug comes from the web's slug function (the same rule as scout-web slugFromToken), so the
--   slug has ONE implementation; this function only checks its shape.
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
  -- The job's deterministic key: one email can only ever create one job.
  v_fingerprint text;
  -- The job and application this email creates (or created on an earlier run).
  v_job uuid;
  v_app uuid;
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

  -- One email, one job, whatever the company and title typed.
  v_fingerprint := 'email:' || v_email.id::text;

  -- Already linked: a re-run of THIS email returns its own application; any other link is refused.
  if v_email.matched_application_id is not null then
    -- The application this email created on an earlier run, if any.
    select a.id into v_app
      from public.applications a
      -- Through the job, whose fingerprint names this email.
      join public.jobs j on j.id = a.job_id
     -- This user's job made from this email.
     where j.user_id = v_email.user_id and j.fingerprint = v_fingerprint;
    -- Same application: idempotent.
    if v_app is not null and v_app = v_email.matched_application_id then
      return v_app;
    end if;
    -- Linked to a different application (the tracker matched it): never re-link silently.
    raise exception 'email % is already linked to application %', p_email_event_id, v_email.matched_application_id using errcode = '22023';
  end if;

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
  -- The job's id, new or from an earlier run.
  select j.id into v_job from public.jobs j where j.user_id = v_email.user_id and j.fingerprint = v_fingerprint;

  -- The application, born at discovered (the only legal birth status the graph can leave to applied).
  insert into public.applications (user_id, job_id) values (v_email.user_id, v_job)
  -- One application per job per user (applications_user_job_key).
  on conflict (user_id, job_id) do nothing;
  -- Its id, and whether an earlier run already advanced it.
  select a.id into v_app from public.applications a where a.user_id = v_email.user_id and a.job_id = v_job;

  -- discovered -> applied through the one status writer, so the graph decides, the event is logged and
  -- applied_at is stamped. Skipped only if a previous run already got it there.
  if (select a.status from public.applications a where a.id = v_app) = 'discovered' then
    perform public.advance_application_status(
      -- The new application.
      v_app,
      -- To applied, along the new edge.
      'applied'::public.application_status,
      -- As the human: the browser holds no agent key, and the edge allows only human.
      'human'::public.agent_name,
      -- The event log says where the move came from and which email.
      jsonb_build_object('source', 'email_add_to_applied', 'email_event_id', v_email.id),
      -- No stale-read stamp: the row was born in this transaction.
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
