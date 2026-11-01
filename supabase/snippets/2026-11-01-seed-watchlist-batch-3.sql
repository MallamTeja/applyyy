-- =============================================================================
-- Watchlist batch 3: +12 verified boards on the five JSON providers (2026-11-01).
--
-- WHY THIS EXISTS: Teja asked (2026-11-01 14:55 IST) to "add all 13" boards from
-- the 14:35 IST probe. Each passed one live GET (HTTP 200 + provider shape + >0
-- postings, controls groww/cred PASS and zz-no-such-board-xx FAIL) and an identity
-- check against the board's own company name / locations.
-- Unacademy (smartrecruiters:unacademy) is deliberately LEFT OUT: its 3 postings
-- date from 2018-2020 and one is titled "Test Jerin" - a dead account whose rows
-- would enter the pipeline as fake current jobs (CLAUDE.md section 6).
-- Canonical has 0 India postings but many "Home based - Worldwide" roles; kept
-- on Teja's instruction, the screener's country filter decides per posting.
--
-- ADDITIVE ONLY, idempotent via the same on-conflict update as the earlier seeds.
-- =============================================================================

do $$
declare
  -- The owning account; auth.uid() is NULL outside a user session (CLAUDE.md section 7).
  v_user_id uuid;
  -- Honest reporting: how many rows the insert actually wrote or updated.
  v_written integer;
begin
  -- Resolve the account by email, aborting rather than seeding nobody.
  select id into v_user_id
  from auth.users
  where lower(email) = lower('tejamallam00@gmail.com');

  -- No owner means no seed; a silent no-op would read as success.
  if v_user_id is null then
    raise exception 'ABORTED - no auth.users row for tejamallam00@gmail.com';
  end if;

  -- One row per verified board; slug derived exactly as the prior seeds did.
  insert into public.company_watchlist (
    user_id, ats_provider, board_token, company_name, company_slug, enabled
  )
  select
    v_user_id,
    b.provider::public.ats_provider,
    b.board_token,
    b.company_name,
    trim(both '-' from regexp_replace(lower(b.company_name), '[^a-z0-9]+', '-', 'g')),
    true
  from (values
    -- 731 postings (latest 2026-10-30), 15 India on page 1.
    ('smartrecruiters', 'ServiceNow', 'ServiceNow'),
    -- 34 postings, 21 India (Bangalore).
    ('greenhouse', 'glance', 'Glance'),
    -- 61 postings, 16 India (Bangalore).
    ('greenhouse', 'commvault', 'Commvault'),
    -- 39 postings, 15 India (Bengaluru office).
    ('ashby', 'ema', 'Ema'),
    -- 206 postings, 10 India.
    ('ashby', 'clickhouse', 'ClickHouse'),
    -- 10 postings, 6 India (Noida, Bengaluru).
    ('greenhouse', 'sumologic', 'Sumo Logic'),
    -- 52 postings, 4 India.
    ('greenhouse', 'newrelic', 'New Relic'),
    -- 31 postings, 4 India (Bangalore).
    ('ashby', 'composio', 'Composio'),
    -- 28 postings, 3 India.
    ('ashby', 'redis', 'Redis'),
    -- 13 postings, 3 India; board name "YugabyteDB".
    ('greenhouse', 'yugabyte', 'Yugabyte'),
    -- 12 postings, 2 India (Bangalore).
    ('lever', 'pocketfm', 'Pocket FM'),
    -- 314 postings, 0 India-located but many worldwide-remote.
    ('greenhouse', 'canonical', 'Canonical')
  ) as b(provider, board_token, company_name)
  -- Re-running updates the name and re-enables instead of erroring.
  on conflict (user_id, ats_provider, board_token) do update set
    company_name = excluded.company_name,
    enabled = true;

  -- Capture the written count for the report below.
  get diagnostics v_written = row_count;

  -- Matched vs written, reported (repo DB rule: counts, not silence).
  raise notice 'Watchlist batch 3: wrote % row(s) (expected 12).', v_written;
end
$$;
