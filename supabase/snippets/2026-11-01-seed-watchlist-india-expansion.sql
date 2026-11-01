-- =============================================================================
-- Watchlist India expansion: +11 NEW verified-pollable boards (2026-11-01;
-- 10 seeded ~11:50 IST, Arcesium added ~12:20 IST).
--
-- WHY THIS EXISTS: Teja asked (2026-11-01 ~11:39 IST) to add 99 India companies
-- (service, GCC, MNC, product, startups) to the watchlist. Only boards that a
-- live probe could MEASURE are seeded here: a row whose token polls nothing
-- renders as coverage forever (CLAUDE.md §6), which is exactly what the 23
-- legacy greenhouse name-guess rows found 404 in the same session prove.
--
-- PROBE (2026-11-01 ~11:45 IST): 146 candidate tokens x 5 providers = 730 GETs,
-- 1 req/s/host. PASS = HTTP 200 + provider JSON shape + >0 postings. Gate proven
-- non-vacuous: controls groww/cred/snowflake/Canva PASSED, zz-no-such-board-xx
-- FAILED everywhere. 28 passed; each pass was then identity-checked by the
-- board's own company name and posting locations:
--   REJECTED as a different company: greenhouse wise (Wise Worksite Field Sales),
--     greenhouse+lever porter (US Porter), ashby navi (SF), SR medianet (Tunis),
--     SR graviton (US), SR netskope (junk locations; greenhouse is the real board).
--   REJECTED as dead accounts (last posting 2018-2022): SR whatfix, upstox,
--     cars24, nobroker, servicetitan.
-- The other 89 companies are on no supported provider (Workday, SuccessFactors,
-- custom careers sites): they need an adapter, not a guessed row.
--
-- ADDITIVE ONLY, idempotent via the same on-conflict update as the 2026-10-24
-- seed (supabase/snippets/2026-10-24-seed-watchlist-headless-pass.sql).
-- =============================================================================

do $$
declare
  -- The owning account; auth.uid() is NULL outside a user session (CLAUDE.md §7).
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
    user_id,
    ats_provider,
    board_token,
    company_name,
    company_slug,
    enabled
  )
  select
    v_user_id,
    b.provider::public.ats_provider,
    b.board_token,
    b.company_name,
    trim(both '-' from regexp_replace(lower(b.company_name), '[^a-z0-9]+', '-', 'g')),
    true
  from (values
    -- 363 postings, 73 India (Mumbai, remote Tamil Nadu).
    ('greenhouse', 'zscaler', 'Zscaler'),
    -- 122 postings, 19 India.
    ('greenhouse', 'netskope', 'Netskope'),
    -- 81 postings, 33 India (Pune).
    ('greenhouse', 'pubmatic', 'PubMatic'),
    -- 23 postings, 14 India (Gurugram, Noida); board name "Graviton Research Capital LLP".
    ('greenhouse', 'gravitonresearchcapital', 'Graviton Research Capital'),
    -- 25 postings, 11 India (Mumbai); locations match Nium's offices.
    ('lever', 'nium', 'Nium'),
    -- 16 postings, 10 India ("SpotDraft HQ, Bengaluru").
    ('ashby', 'spotdraft', 'SpotDraft'),
    -- SR pages at 100; first page 30 India (Chennai, Bengaluru), company "Freshworks".
    ('smartrecruiters', 'Freshworks', 'Freshworks'),
    -- First page 10 India of 100; company "Bosch Group" (global board incl. BGSW).
    ('smartrecruiters', 'BoschGroup', 'Bosch Group'),
    -- First page 12 India (Hyderabad); company "Wise".
    ('smartrecruiters', 'wise', 'Wise'),
    -- First page 3 India (Pune/Mumbai studios); company "Ubisoft".
    ('smartrecruiters', 'Ubisoft2', 'Ubisoft'),
    -- Added 12:20 IST after Teja ruled "keep all, add verified" for the second 50.
    -- Token found by peer ce (the legal-entity slug a name guess misses), re-probed
    -- by the orchestrator: 44 postings, board name "Arcesium LLC", 17 India.
    ('greenhouse', 'arcesiumllc', 'Arcesium')
  ) as b(provider, board_token, company_name)
  -- Re-running updates the name and re-enables instead of erroring, on the live
  -- unique key company_watchlist_user_board_key (user_id, ats_provider, board_token).
  on conflict (user_id, ats_provider, board_token) do update set
    company_name = excluded.company_name,
    enabled = true;

  -- Capture the written count for the report below.
  get diagnostics v_written = row_count;

  -- Matched vs written, reported (repo DB rule: counts, not silence).
  raise notice 'Watchlist India expansion: wrote % row(s) (expected 11).', v_written;
end
$$;
