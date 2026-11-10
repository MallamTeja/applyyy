-- =============================================================================
-- Watchlist: +21 verified boards from Teja's "top 100 Hyderabad companies" list (2026-11-10).
-- Teja, 2026-11-10 14:35 IST: "add all those 100 companies into watch list".
--
-- WHY ONLY 21 OF 100: a watchlist row is a board token, not a company name. scout-ats polls only
-- greenhouse, ashby, lever and workday (smartrecruiters is off by the 2026-11-01 robots ruling).
-- 5 read-only recon agents checked all 100 companies' careers sites live. 79 run on something the
-- scout cannot read: their own site (Google, Amazon, Apple, Meta, ADP, Pega), Oracle HCM,
-- SuccessFactors, Avature, Eightfold, iCIMS, Phenom, Taleo, Zwayam, RippleHire, Darwinbox,
-- Zoho Recruit, Workable, Jobvite, BrassRing, Njoyn, SenseHQ or HROne. A row for any of them would
-- poll nothing, or worse, a same-named stranger's board (an Ashby `infinite` board is a SF
-- stablecoin startup, not Infinite Computer Solutions).
--
-- LEFT OUT ON PURPOSE:
--   DBS, Synchrony and Franklin Templeton: robots.txt Disallows their Workday SITE.
--   Hitachi Vantara: the board is all of Hitachi and has 737 India postings, above the 400-posting read cap.
--   Qualcomm: its Workday site has 0 postings (its jobs are on Eightfold).
--   Lever `kpmg`: 0 postings, so the owner cannot be confirmed.
--
-- EVERY TOKEN BELOW was re-probed live on 2026-11-10 by the session that ran this snippet, not just by the recon agents:
-- HTTP 200; total in 1..400 (Workday reads at most 400); Workday tokens pass the scout's
-- TOKEN_SHAPE; robots.txt `User-agent: *` blocks neither the site nor /wday/cxs.
-- Identity came from posting detail (Workday hiringOrganization) or posting text / board name.
-- Garbage control `zz-no-such-tenant-xx`: greenhouse 404, ashby 404, lever 404, workday 422.
-- Evidence: the session scratchpad recon-a1..a5/result.json + verify21.json (not in the repo).
--
-- ADDITIVE ONLY: on conflict do nothing, so re-running it changes nothing.
-- =============================================================================

do $$
declare
  -- The owning account; auth.uid() is NULL outside a user session (CLAUDE.md §7).
  v_user_id uuid;
  -- Honest reporting: how many rows the insert actually wrote.
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
    -- 82 postings, unfiltered (fits the 400 cap); hiringOrganization "Silabs India Private Limited".
    ('workday', 'silabs.wd1/SiliconLabsCareers', 'Silicon Labs'),
    -- 103 postings, unfiltered; hiringOrganization "FactSet Systems India Private Limited".
    ('workday', 'factset.wd108/FactSetCareers', 'FactSet'),
    -- 6 postings (1 India); posting text names Model N.
    ('lever', 'modeln', 'Model N'),
    -- 20 postings (4 Hyderabad); description names Gainsight. Ashby robots 401 = no rules (2026-11-01 ruling).
    ('ashby', 'gainsight', 'Gainsight'),
    -- 69 postings (46 Hyderabad); greenhouse board name "HighRadius".
    ('greenhouse', 'highradius', 'HighRadius'),
    -- RTX's shared gateway (4597 postings) narrowed to its 6 India location ids -> 76; India postings name Collins Aerospace.
    ('workday', 'globalhr.wd5/REC_RTX_Ext_Gateway?locations=3a166a34da240152c9af9dfb4d984d8f,79468190d07e016ac7bf23499046889d,23af7b526505100200a1f8e1fa0d0000,9a32727a5b5f011711cee6d034a30000,8cd417527e3a01b109a1ff522b1baef8,8cd417527e3a0123db4f4a532b1bfef8', 'Collins Aerospace'),
    -- 101 APAC postings (9 India: Mumbai/Chennai, 0 Hyderabad). The Hyderabad GBS board was not found; this is the best public one.
    ('workday', 'ghr.wd1/Lateral-APAC', 'Bank of America'),
    -- 216 postings, unfiltered (48 Hyderabad); hiringOrganization "Invesco (India) Private Limited".
    ('workday', 'invesco.wd1/IVZ', 'Invesco'),
    -- 54 postings, all Hyderabad; the group's main LBG_Careers site has no India jobs.
    ('workday', 'lbg.wd3/Lloyds_Technology_Centre', 'Lloyds Technology Centre'),
    -- 329 postings, unfiltered (73 Hyderabad); near the cap: add locations=f08899aeb8ba10015e1ef5090d4f0000 if it passes 400.
    ('workday', 'vanguard.wd5/vanguard_external', 'Vanguard'),
    -- India country facet -> 33; host is wd115 (from careers.lilly.com apply links), not wd5.
    ('workday', 'lilly.wd115/LLY?locationCountry=c4f78be1a8f14da0ab49ce1162348a5e', 'Eli Lilly'),
    -- 1294 postings -> 74 with the India country facet.
    ('workday', 'sanofi.wd3/SanofiCareers?locationCountry=c4f78be1a8f14da0ab49ce1162348a5e', 'Sanofi'),
    -- 1013 postings -> 49 with the India country facet (this tenant spells it location_Country).
    ('workday', 'carrier.wd5/jobs?location_Country=c4f78be1a8f14da0ab49ce1162348a5e', 'Carrier'),
    -- 47 postings; the INTERNATIONAL site (the main `zoetis` site has 0 India jobs).
    ('workday', 'zoetis.wd5/zoetis_intl', 'Zoetis'),
    -- No country facet; India is 1064 (> cap), so the token names the 7 Hyderabad building ids -> 266. A new building is missed until added.
    ('workday', 'genpact.wd108/External_Careers?locations=faddece16d451000bf3a693d530e0000,faddece16d451000bf3431453ec10000,faddece16d451000bf39921bee4a0000,faddece16d451000bf32ffeb20950000,faddece16d451000bf3be21bae0f0000,b1404e288dc71000db08962858cc0000,faddece16d451000bf3799e932a70000', 'Genpact'),
    -- 1268 postings -> 179 with the India country facet (its Hyderabad id filters to 0, so not used).
    ('workday', 'dxctechnology.wd1/DXCJobs?locationCountry=c4f78be1a8f14da0ab49ce1162348a5e', 'DXC Technology'),
    -- 21 postings (2 Hyderabad); posting text names Egen.
    ('lever', 'egen', 'Egen'),
    -- 164 postings, unfiltered (73 India); hiringOrganization "Synechron Technologies Pvt. Ltd._INDIA".
    ('workday', 'synechron.wd1/SynechronCareers', 'Synechron'),
    -- 26 postings, unfiltered; hiringOrganization "Techwave Consulting India Pvt Ltd".
    ('workday', 'techwave.wd108/TechWave_Careers', 'Techwave'),
    -- 34 postings, 0 India today; kept because Teja asked for the company and the board is its own.
    ('lever', 'bounteous', 'Bounteous x Accolite'),
    -- 1484 postings -> 78 with the India country facet (the `external_india` site returns 0, so not used).
    ('workday', 'cnx.wd1/external_global?locationCountry=c4f78be1a8f14da0ab49ce1162348a5e', 'Concentrix')
  ) as b(provider, board_token, company_name)
  -- Additive only: an existing (user, provider, token) row is left exactly as it is.
  on conflict (user_id, ats_provider, board_token) do nothing;

  -- Count what the insert really wrote, so a full no-op is visible.
  get diagnostics v_written = row_count;

  -- Prefer a warning over an exception for "nothing written" (CLAUDE.md §7): a re-run is legitimate.
  raise warning 'hyderabad-100 seed: 21 boards offered, % written', v_written;
end
$$;
