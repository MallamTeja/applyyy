-- =============================================================================
-- Agent key, part 2: claim_applications and release_application_claim.
--
-- WHY. 20261008160000 made advance_application_status refuse a machine identity
-- without the x-applyy-agent-key header, and named these two functions as NOT
-- COVERED. Both are executable by PUBLIC, anon and authenticated (live proacl
-- 2026-10-08), so any browser session could claim queue work (leasing rows away from
-- the applier) or release a lease a running agent holds.
--
-- THE KEY IS REQUIRED FOR EVERY CALLER, with no 'human' exemption, unlike
-- advance_application_status. claim_applications takes no agent at all
-- (p_claimed_by is free text), and recon 2026-10-08 found NO human or browser caller
-- of either function: the only callers are the worker's applier (apply.ts) and assist
-- (assist.ts) clients, both of which send the header (b2a4a36). An exemption would
-- only give a browser a way to drop a running agent's lease.
--
-- SAME FAIL-SAFE AS 160000: while applyy_internal.agent_key is EMPTY,
-- agent_key_state() returns 'unconfigured' and both functions behave exactly as
-- today, with a WARNING. Enforcement turns on for all three functions at once when
-- the hash is seeded; deleting the row turns it off for all three.
--
-- Bodies are copied verbatim from 20260909235100 (the latest definition of both, and
-- byte-identical to live per recon); every change is tagged NEW-CLAIMGUARD.
-- Signatures are unchanged, so CREATE OR REPLACE keeps the comments; grants are
-- tightened explicitly below. WRITTEN, NOT APPLIED. Must run after 20261008160000,
-- which creates applyy_internal.agent_key_state().
-- =============================================================================

-- The claim, with the key check first. Same signature, so this replaces in place.
create or replace function public.claim_applications(
  p_status public.application_status,
  p_claimed_by text,
  p_limit integer,
  -- NULL means "use the user's configured lease", so the common caller passes three args.
  p_lease_seconds integer default null
)
returns setof public.applications
language plpgsql
set search_path = ''
as $$
declare
  -- Resolved once; every predicate below is scoped to this user by RLS anyway, but
  -- naming it keeps the intent visible.
  v_uid uuid := (select auth.uid());
  v_enabled boolean;
  v_lease integer;
  -- NEW-CLAIMGUARD: whether this request proved it is a machine agent.
  v_key_state text;
begin
  -- NEW-CLAIMGUARD — only a proven machine may call this (see the file header). Checked
  -- first, before any row is read, locked or written.
  v_key_state := applyy_internal.agent_key_state();
  -- No hash seeded yet: enforcement OFF, today's behaviour, with a visible warning.
  if v_key_state = 'unconfigured' then
    -- WARNING, not exception: keeps working until applyy_internal.agent_key is seeded.
    raise warning 'agent key not configured: claim_applications called without proof (enforcement off until applyy_internal.agent_key is seeded)';
  -- Seeded, and this request did not carry the matching key: refuse.
  elsif v_key_state <> 'valid' then
    -- 42501, the same code advance_application_status uses for the same refusal.
    raise exception 'claim_applications requires a valid x-applyy-agent-key header (%); only machine agents claim or release work', v_key_state
      using errcode = '42501';
  end if;

  -- Read the control panel first, exactly as every agent is supposed to.
  select s.system_enabled, coalesce(p_lease_seconds, s.claim_lease_seconds)
    into v_enabled, v_lease
    from public.system_settings s
   where s.user_id = v_uid;

  -- No settings row at all means the account was never bootstrapped. FAIL CLOSED:
  -- a missing kill switch must read as "off", never as "no objection".
  if v_enabled is null or not v_enabled then
    return;
  end if;

  return query
  update public.applications a
     set claimed_at = now(),
         claimed_by = p_claimed_by,
         -- The lease, not the claim time, is what the sweeper compares against — so a
         -- slow agent can be given a longer lease without touching the sweeper.
         claim_expires_at = now() + make_interval(secs => v_lease)
   where a.id in (
     -- The inner select is what takes the locks. SKIP LOCKED makes a row another
     -- transaction already grabbed invisible to this one rather than a wait.
     select c.id
       from public.applications c
      where c.user_id = v_uid
        and c.status = p_status
        -- Unclaimed only. Matches the partial index applications_claimable_idx.
        and c.claimed_by is null
      -- FIFO. Oldest discovery first, which is also what the freshness argument wants.
      order by c.created_at
        for update skip locked
      limit p_limit
   )
  returning a.*;
end;
$$;

-- Never callable signed-out: an anon caller has no auth.uid() and gets nothing anyway, so
-- the grant was pure exposure. PUBLIC goes too, so a future role does not inherit it.
revoke all on function public.claim_applications(public.application_status, text, integer, integer) from public, anon;
-- The worker signs in as the app user, i.e. `authenticated`.
grant execute on function public.claim_applications(public.application_status, text, integer, integer) to authenticated;
-- Parity with the existing grant; no code uses service_role today.
grant execute on function public.claim_applications(public.application_status, text, integer, integer) to service_role;

-- The release, with the key check first. Same signature, so this replaces in place.
create or replace function public.release_application_claim(
  p_application_id uuid,
  p_agent public.agent_name,
  -- e.g. 'all_keys_cooling'. Free text because the reasons are open-ended and none of
  -- them changes what happens next.
  p_reason text default null
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_user_id uuid;
  -- NEW-CLAIMGUARD: whether this request proved it is a machine agent.
  v_key_state text;
begin
  -- NEW-CLAIMGUARD — only a proven machine may call this (see the file header). Checked
  -- first, before any row is read, locked or written.
  v_key_state := applyy_internal.agent_key_state();
  -- No hash seeded yet: enforcement OFF, today's behaviour, with a visible warning.
  if v_key_state = 'unconfigured' then
    -- WARNING, not exception: keeps working until applyy_internal.agent_key is seeded.
    raise warning 'agent key not configured: release_application_claim called without proof (enforcement off until applyy_internal.agent_key is seeded)';
  -- Seeded, and this request did not carry the matching key: refuse.
  elsif v_key_state <> 'valid' then
    -- 42501, the same code advance_application_status uses for the same refusal.
    raise exception 'release_application_claim requires a valid x-applyy-agent-key header (%); only machine agents claim or release work', v_key_state
      using errcode = '42501';
  end if;

  update public.applications a
     set claimed_at = null,
         claimed_by = null,
         claim_expires_at = null
   where a.id = p_application_id
     -- No status assignment anywhere in this statement. That is the point of the
     -- function: releasing must be incapable of moving a row.
  returning a.user_id into v_user_id;

  if v_user_id is null then
    raise exception 'application % not found (or not yours)', p_application_id
      using errcode = 'P0002';
  end if;

  -- Log it, so "why did this sit for an hour" has an answer on the health page.
  insert into public.application_events (user_id, application_id, event_type, agent, detail)
  values (v_user_id, p_application_id, 'release', p_agent, jsonb_build_object('reason', p_reason));
end;
$$;

-- Same reasoning as the claim: anon gets P0002 from RLS anyway, so the grant was exposure.
revoke all on function public.release_application_claim(uuid, public.agent_name, text) from public, anon;
-- The worker's signed-in session.
grant execute on function public.release_application_claim(uuid, public.agent_name, text) to authenticated;
-- Parity, as above.
grant execute on function public.release_application_claim(uuid, public.agent_name, text) to service_role;
