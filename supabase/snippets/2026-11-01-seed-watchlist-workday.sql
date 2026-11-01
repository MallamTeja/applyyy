-- =============================================================================
-- Watchlist Workday boards: +18 verified, pollable Workday careers sites (2026-11-01).
-- WRITTEN, NOT RUN. The orchestrator runs it, and only in this order:
--   1. migration 20261101124500_ats_provider_workday.sql (the enum value must exist,
--      or the `::public.ats_provider` cast below fails);
--   2. the scout-ats deploy carrying the Workday adapter (until then a 'workday' row
--      is skipped as "no adapter" on every poll);
--   3. the worker apply guard (parcel 2): a Workday row must park for a human
--      instead of being opened by the auto-apply worker. THE SEED IS BLOCKED UNTIL
--      THAT GUARD IS PUSHED (orchestrator ruling, 2026-11-01 12:17 IST).
--
-- WHY THIS EXISTS: 89 India-hiring companies matched none of the five supported
-- providers on 2026-11-01. A careers-page sweep (2 recon agents, each company's own
-- site, rendered where needed) named 19 on Workday; each was verified with one live
-- POST (HTTP 200 + {total, jobPostings[]} + total>0, identity from the posting
-- detail's hiringOrganization.name or its titles/locations). Garbage control
-- zz-no-such-tenant-xx FAILED (422). Evidence: docs/harvest/2026-11-01-workday-coverage.md.
--
-- EVERY TOKEN BELOW WAS READ IN FULL, LIVE, through the real adapter and the
-- shared page loop (collectBoardPages), and stored exactly its reported total.
-- Each also passes parseWorkdayToken, the closed shape the scout polls with.
-- A board is limited to 400 postings (MAX_BOARD_PAGES 20 x Workday's 20 per page).
-- So big boards carry an India facet: a country id where the tenant has one, else
-- the tenant's India city ids. City ids are a snapshot: a NEW India office on such a
-- tenant is not covered until its token is re-derived.
-- LEFT OUT: Accenture. Workday caps its total at 2000, and its India facet alone
-- lists 34,628, so no token can read it in full.
--
-- ADDITIVE ONLY, idempotent via the same on-conflict update as the prior seeds
-- (supabase/snippets/2026-11-01-seed-watchlist-india-expansion.sql).
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
    -- 117 postings, unfiltered (fits the 400 cap); read in full live 2026-11-01.
    ('workday', 'fractal.wd1/Careers', 'Fractal Analytics'),
    -- 76 postings, unfiltered (fits the 400 cap); read in full live 2026-11-01.
    ('workday', 'quantiphi.wd1/Careers_at_Quantiphi', 'Quantiphi'),
    -- 324 postings, unfiltered (fits the 400 cap); read in full live 2026-11-01.
    ('workday', 'paypal.wd1/jobs', 'PayPal'),
    -- 72 postings, unfiltered (fits the 400 cap); read in full live 2026-11-01.
    ('workday', 'sprinklr.wd1/careers', 'Sprinklr'),
    -- 76 postings, unfiltered (fits the 400 cap); read in full live 2026-11-01.
    ('workday', 'servicetitan.wd1/ServiceTitan', 'ServiceTitan'),
    -- 146 postings, unfiltered (fits the 400 cap); read in full live 2026-11-01.
    ('workday', 'zendesk.wd1/zendesk', 'Zendesk'),
    -- 836 postings unfiltered -> 95 with country facet = India; read in full live 2026-11-01.
    ('workday', 'visa.wd5/Visa?locationCountry=c4f78be1a8f14da0ab49ce1162348a5e', 'Visa'),
    -- 676 postings unfiltered -> 196 with country facet = India; read in full live 2026-11-01.
    ('workday', 'cadence.wd1/External_Careers?Location_Country=c4f78be1a8f14da0ab49ce1162348a5e', 'Cadence Design Systems'),
    -- 670 postings unfiltered -> 2 with country facet = India; read in full live 2026-11-01.
    ('workday', 'boeing.wd1/EXTERNAL_CAREERS?locationCountry=c4f78be1a8f14da0ab49ce1162348a5e', 'Boeing'),
    -- 804 postings unfiltered -> 12 with country facet = India; read in full live 2026-11-01.
    ('workday', 'fmr.wd1/FidelityCareers?locationCountry=c4f78be1a8f14da0ab49ce1162348a5e', 'Fidelity Investments'),
    -- 2000 postings unfiltered -> 63 with country facet = India; read in full live 2026-11-01.
    ('workday', 'target.wd5/targetcareers?Location_Country=c4f78be1a8f14da0ab49ce1162348a5e', 'Target'),
    -- 1497 postings unfiltered -> 81 with country facet = India; read in full live 2026-11-01.
    ('workday', 'wf.wd1/WellsFargoJobs?locationCountry=c4f78be1a8f14da0ab49ce1162348a5e', 'Wells Fargo'),
    -- 1551 postings unfiltered -> 91 with country facet = India; read in full live 2026-11-01.
    ('workday', 'salesforce.wd12/External_Career_Site?CF_-_REC_-_LRV_-_Job_Posting_Anchor_-_Country_from_Job_Posting_Location_Extended=c4f78be1a8f14da0ab49ce1162348a5e', 'Salesforce'),
    -- 1442 postings unfiltered -> 314 with India city ids (no country facet on this tenant) (8 ids); read in full live 2026-11-01.
    ('workday', 'cisco.wd5/Cisco_Careers?locations=662e524adea41001f4d0bd5a1ddd0000,3dbd26f9e73e1001f4d59df763f20000,026fa05becb01001f506953e0df00000,ef8a5a22403d1001f4fde228ba110000,6bed8334bf4b1001f5010f5b49d30000,6bed8334bf4b1001f4f15a1f787a0000,8676de3331b41001f4f96625fdde0000,8676de3331b41001f4eaac80a6280000', 'Cisco'),
    -- 1014 postings unfiltered -> 223 with India city ids (no country facet on this tenant) (9 ids); read in full live 2026-11-01.
    ('workday', 'mastercard.wd1/CorporateCareers?locations=8eab563831bf10acb5d384310bb7d5ec,8eab563831bf10acb97b7fba5feff76e,2e83df2db0851073b1d3be60012912d5,8eab563831bf10acb9d6f1103d78fa67,8eab563831bf10acbb7b5bf86d570af1,28905a74db1b10019f5bb16c36030000,8eab563831bf10acbc722e4859721571,8ffae25149e210718ae5b2e1cb1993bb,85a5bdf4e1831035984400a2fb698c94', 'Mastercard'),
    -- 622 postings unfiltered -> 298 with India city ids (no country facet on this tenant) (11 ids); read in full live 2026-11-01.
    ('workday', 'barclays.wd3/External_Career_Site_Barclays?locations=1110a9ca6540100196e1f0c315e90000,112c0542820110016378a0a3e68d0000,112c05428201100163788a5627320000,253dfca5ccfc10016b1361f46cfe0000,1ab48a98eb7c1001634cf23b210c0000,b8f75d1cb9781000cd91027a85e30000,1ab48a98eb7c100163423aff71b80000,112c0542820110016377af553b050000,112c0542820110016377c02c6ef00000,1ab48a98eb7c100163465bf6c3310000,112c05428201100163763bd6ad400000', 'Barclays'),
    -- 749 postings unfiltered -> 59 with India city ids (no country facet on this tenant) (3 ids); read in full live 2026-11-01.
    ('workday', 'nike.wd1/nke?locations=ec53caae37231002006ace9684340000,1e911696551b10018cf35ef9cbd50000,53aa8f3ea4191001f60e07d9bcdd0000', 'Nike'),
    -- 1743 postings unfiltered -> 377 with India city ids (no country facet on this tenant) (44 ids); read in full live 2026-11-01.
    ('workday', 'hpe.wd5/Jobsathpe?locations=e459dee6bf0a01df2022175c0824825d,3950c424ea1c01f4eab9295f422c5549,13b3e51a76aa1001318533a039bf0000,8ff86dd7fcb210012ff4dc545eac0000,645544f472251001ceb0ce4e52fb0000,2e0d9cc9554b0101dc0ab314422c3047,830a7b3bc18701b75affcf19da2b494b,782e7a0e92fd0111b8dab85523112b6b,782e7a0e92fd01373f27d9552311306b,86f8a5594c37011156e9bbe7d6450000,62b0c47c914b011dfdeb013405241e47,11d24e7aad931000b97d4e4cae760000,d34a1ee71b5a0167393362eb26113c73,98cbd30d374e10330bf0055e8fecb400,12c084a0914b1000b9466bff46760000,93d986c1945a01a4e588702a27112f9c,3b8353d6c173012121eb98b20b020000,b9a33b7c1124010ba345fd57c75c0000,d5f79f9a1bdb01ee6a161c7c451b6785,f607629c2aa1011403327531462ca864,830a7b3bc18701522e22d8f8d92b5f4a,5b54acb1785601188a21f76d94d40000,47385449f64a018e5d3f1896dd2bc961,15e0be34582201668f0b5df6ec1b4157,cefdc093573810012ff6b1471cc60000,15e0be34582201628dd864f6ec1b4657,62b0c47c914b01fee3d9527f0824bd5c,fc348b8878881000b93680b090350000,e69f9781661b1021919da4c6112bb1a7,11643b7f16a3100130f3a8f83f300000,830a7b3bc187010eedd3bd1cdd2b205f,e69f9781661b1021919c5ea5232dafef,e69f9781661b1021919d9a52b606b198,1b6e62a22ce510021e38221da8970000,47385449f64a01d68753990bde2bb264,62b0c47c914b015ebd99d77f0824c25c,f607629c2aa10111b59f6e32422cf949,ea367c739baa1001d314ec08e1840000,e69f9781661b1021919d9e094ba9b19d,3950c424ea1c010f3cc27c8a462c2c65,7e41a38a9de101ea8e933b83ce445b68,1e8ea98ebc7f1001d16f120253f30000,11db67a6781e013644570cd6fc16f13b,7ae759d9ac4f01a07908eb0af9161f3f', 'HPE')
  ) as b(provider, board_token, company_name)
  -- Re-running updates the name and re-enables instead of erroring, on the live
  -- unique key company_watchlist_user_board_key (user_id, ats_provider, board_token).
  on conflict (user_id, ats_provider, board_token) do update set
    company_name = excluded.company_name,
    enabled = true;

  -- Capture the written count for the report below.
  get diagnostics v_written = row_count;

  -- Matched vs written, reported (repo DB rule: counts, not silence).
  raise notice 'Watchlist Workday boards: wrote % row(s) (expected 18).', v_written;
end
$$;
