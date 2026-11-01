-- =============================================================================
-- Watchlist batch 4: +44 NEW verified-pollable boards (2026-11-01 ~16:30 IST).
--
-- WHY THIS EXISTS: Teja asked (2026-11-01 16:25 IST, "add all") to add the 50
-- India-eligible companies suggested after batch 3. Only boards a live probe could
-- MEASURE are seeded: a row whose token polls nothing renders as coverage forever
-- (CLAUDE.md §6).
--
-- PROBES (2026-11-01, read-only, 1 req/s/host):
--   * 14 boards on greenhouse/lever/ashby: HTTP 200 + provider JSON shape + >0
--     postings, then identity-checked by board name and posting locations.
--     Controls groww/cred/snowflake PASSED, zz-no-such-board-xx FAILED.
--   * 34 Workday boards: POST /wday/cxs/{tenant}/{site}/jobs PASSED (garbage
--     tenant control FAILED with 422). The India facet was then READ from each
--     tenant's own facet tree and re-POSTed: every facet below returned >0
--     postings whose locations are Indian.
--
-- WORKDAY TOKEN RULE (MAX_BOARD_PAGES=20 x 20 = 400 postings per read):
--   * country facet exists  -> use it (one stable id, skips non-India noise).
--   * only city ids, <=400  -> read UNFILTERED: a full read is complete, and a
--                              frozen city list would miss a new India office.
--   * only city ids, >400   -> city ids are the only way to reach India rows.
--     ponytail: city-id lists go stale when an office opens; re-probe facets
--     if one of these boards' India yield drops.
--   Amgen (740) and PwC (613) still exceed 400 India postings, so a read takes
--   the first 400.
--
-- LEFT OUT (measured, not guessed):
--   * robots.txt disallows the exact site the token reads: Equinix (Disallow:
--     /External/), Citi (/2/), Caterpillar (/CaterpillarCareers/), Synchrony
--     (/careers/). The CXS path /wday/cxs/... is not literally matched, but it
--     serves the same listing the owner told crawlers to skip: the same call
--     Teja made for SmartRecruiters (Disallow: /, all SR rows off 16:02 IST).
--     Every other tenant here was checked: no Disallow on its site.
--   * ashby rows (Airwallex, Atlys) depend on the pending ruling on how the
--     robots gate treats api.ashbyhq.com/robots.txt answering 401.
--   * Bank of America  ghr.wd1/Lateral-US: no India value in its facet tree
--     (US-only site; India hiring is on another site not yet found).
--   * Elevance Health  elevancehealth.wd1/ANT: same, no India value (Carelon
--     India hires elsewhere).
--
-- ADDITIVE ONLY, idempotent via the same on-conflict update as the earlier
-- 2026-11-01 seeds (supabase/snippets/2026-11-01-seed-watchlist-batch-3.sql).
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
    -- 312 postings, ~14 India by location text (probe 2026-11-01 ~16:00 IST).
    ('greenhouse', 'agoda', 'Agoda'),
    -- 499 postings, ~11 India by location text (probe 2026-11-01 ~16:00 IST).
    ('ashby', 'airwallex', 'Airwallex'),
    -- 34 postings, ~6 India by location text (probe 2026-11-01 ~16:00 IST).
    ('greenhouse', 'starburst', 'Starburst'),
    -- 65 postings, ~5 India by location text (probe 2026-11-01 ~16:00 IST).
    ('greenhouse', 'neo4j', 'Neo4j'),
    -- 18 postings, ~18 India by location text (probe 2026-11-01 ~16:00 IST).
    ('lever', 'fampay', 'FamPay'),
    -- 30 postings, ~6 India by location text (probe 2026-11-01 ~16:00 IST).
    ('greenhouse', 'coursera', 'Coursera'),
    -- 39 postings, ~6 India by location text (probe 2026-11-01 ~16:00 IST).
    ('greenhouse', 'turing', 'Turing'),
    -- 27 postings, ~24 India by location text (probe 2026-11-01 ~16:00 IST).
    ('ashby', 'atlys', 'Atlys'),
    -- 16 postings, ~9 India by location text (probe 2026-11-01 ~16:00 IST).
    ('greenhouse', 'enterpret', 'Enterpret'),
    -- 20 postings, ~9 India by location text (probe 2026-11-01 ~16:00 IST).
    ('lever', 'netomi', 'Netomi'),
    -- 9 postings, ~3 India by location text (probe 2026-11-01 ~16:00 IST).
    ('lever', 'tala', 'Tala'),
    -- 36 postings, ~14 India by location text (probe 2026-11-01 ~16:00 IST).
    ('lever', 'acceldata', 'Acceldata'),
    -- 19 postings, ~14 India by location text (probe 2026-11-01 ~16:00 IST).
    ('greenhouse', 'cloudsek', 'CloudSEK'),
    -- 23 postings, ~13 India by location text (probe 2026-11-01 ~16:00 IST).
    ('greenhouse', 'truefoundry', 'TrueFoundry'),
    -- 278 postings unfiltered -> 38 with country facet = India.
    ('workday', 'adobe.wd5/external_experienced?locationCountry=c4f78be1a8f14da0ab49ce1162348a5e', 'Adobe'),
    -- 373 postings unfiltered -> 27 with country facet = India.
    ('workday', 'workday.wd5/Workday?Location_Country=c4f78be1a8f14da0ab49ce1162348a5e', 'Workday'),
    -- 365 postings unfiltered -> 34 with country facet = India.
    ('workday', 'crowdstrike.wd5/crowdstrikecareers?locationCountry=c4f78be1a8f14da0ab49ce1162348a5e', 'CrowdStrike'),
    -- 372 postings, 51 India via cities(5) ids; <=400 so read UNFILTERED (a city list would miss a new office).
    ('workday', 'broadcom.wd1/External_Career', 'Broadcom'),
    -- 241 postings, 28 India via cities(3) ids; <=400 so read UNFILTERED (a city list would miss a new office).
    ('workday', 'blackrock.wd1/BlackRock_Professional', 'BlackRock'),
    -- 156 postings unfiltered -> 11 with country facet = India.
    ('workday', 'ciena.wd5/Careers?Location_Country=c4f78be1a8f14da0ab49ce1162348a5e', 'Ciena'),
    -- 344 postings unfiltered -> 38 with country facet = India.
    ('workday', 'marvell.wd1/MarvellCareers?Country=c4f78be1a8f14da0ab49ce1162348a5e', 'Marvell'),
    -- 370 postings, 6 India via cities(3) ids; <=400 so read UNFILTERED (a city list would miss a new office).
    ('workday', 'fiserv.wd5/EXT', 'Fiserv'),
    -- 308 postings unfiltered -> 26 with country facet = India.
    ('workday', 'broadridge.wd5/Careers?Location_Country=c4f78be1a8f14da0ab49ce1162348a5e', 'Broadridge'),
    -- 352 postings unfiltered -> 55 with country facet = India.
    ('workday', 'spgi.wd5/SPGI_Careers?Location_Country=c4f78be1a8f14da0ab49ce1162348a5e', 'S&P Global'),
    -- 160 postings unfiltered -> 35 with country facet = India.
    ('workday', 'nasdaq.wd1/Global_External_Site?Location_Country=c4f78be1a8f14da0ab49ce1162348a5e', 'Nasdaq'),
    -- 119 postings, 18 India via cities(4) ids; <=400 so read UNFILTERED (a city list would miss a new office).
    ('workday', 'expedia.wd108/search', 'Expedia'),
    -- 2000 postings unfiltered -> 238 with India cities(6) ids (no country facet on this tenant).
    ('workday', 'nvidia.wd5/NVIDIAExternalCareerSite?locations=91336993fab910af6d6fb9748af4c1df,f28ae3c49d2601aff203e114d301695f,91336993fab910af6d6fb2be0974c1d0,91336993fab910af6d6fabbb968cc1c1,91336993fab910af6d6fb0782884c1cb,91336993fab910af6d6fb4ee7634c1d5', 'NVIDIA'),
    -- 807 postings unfiltered -> 91 with India cities(2) ids (no country facet on this tenant).
    ('workday', 'intel.wd1/External?locations=1e4a4eb3adf101f44070f976bf8184cf,fabab36f05f51000ba74e9448dc20000', 'Intel'),
    -- 2905 postings unfiltered -> 315 with India cities(7) ids (no country facet on this tenant).
    ('workday', 'micron.wd1/External?locations=7797c68d45371000f1413adec9aa0000,bff7a31dbdd301629be4a1b46401e408,bff7a31dbdd301f4102c28b56401600a,bff7a31dbdd30184310850b464010808,2caad8548f761001335d2c9d04e60000,67142bd46d6d100141f9cff3fe940000,7797c68d45371000f16c9d425bcc0000', 'Micron'),
    -- 1988 postings unfiltered -> 740 with country facet = India. Still >400: a read takes the first 400 India postings.
    ('workday', 'amgen.wd1/Careers?LocationCountry=c4f78be1a8f14da0ab49ce1162348a5e', 'Amgen'),
    -- 857 postings unfiltered -> 117 with country facet = India.
    ('workday', 'novartis.wd3/Novartis_Careers?locationCountry=c4f78be1a8f14da0ab49ce1162348a5e', 'Novartis'),
    -- 547 postings unfiltered -> 26 with country facet = India.
    ('workday', 'pfizer.wd1/PfizerCareers?Location_Country=c4f78be1a8f14da0ab49ce1162348a5e', 'Pfizer'),
    -- 533 postings unfiltered -> 33 with India cities(3) ids (no country facet on this tenant).
    ('workday', 'bristolmyerssquibb.wd5/BMS?locations=6c25a1ca27e601a7e32273da7430745e,89e594b8a1c310019d5e525647720000,45d56408185c01923d073186cca16d07', 'Bristol Myers Squibb'),
    -- 3813 postings unfiltered -> 613 with India cities(29) ids (no country facet on this tenant). Still >400: a read takes the first 400 India postings.
    ('workday', 'pwc.wd3/Global_Experienced_Careers?locations=e57e6863118d01f411ec8989342b58c9,e57e6863118d0160ef6ca477342bd0b1,e57e6863118d01c410d0a777342bd5b1,e57e6863118d01c9b91fc587342becc6,e57e6863118d017a7a40f887342b36c7,606b09f912311013e7b7a6099f390000,e57e6863118d01c26419ae7a342b2bb6,393a0869abd710143a2beaf60b670000,e57e6863118d013f3b2da177342bcbb1,e57e6863118d0143538d8d89342b5dc9,e57e6863118d0159272aef87342b2cc7,e57e6863118d013a81f1f387342b31c7,d3d4fd4264d2101d8cfff7a82dbe0000,480ed971333f01ac180c364b7b21c8de,e57e6863118d01be5ed2aa7a342b26b6,e57e6863118d01b854445d88342bb8c7,654a31e587e4016effd02a459109a45e,351cca8db89f101a78acb2ea6c5f0000,e57e6863118d011c2d21d779342bffb4,7141d600d2881018dbf3c0a366600000,e57e6863118d01def7f26488342bc2c7,4b594efa2b6c01cfc90002b5270301c1,e57e6863118d011ca7026188342bbdc7,e57e6863118d0101d840b17a342b30b6,e57e6863118d01e1230f4288342b9ac7,e57e6863118d01c0b8b9ff87342b40c7,4286c2c7092210052a2351a32a610000,e57e6863118d01cf86b0d379342bfab4,e57e6863118d0192617a4988342ba4c7', 'PwC'),
    -- 671 postings unfiltered -> 205 with country facet = India.
    ('workday', 'lseg.wd3/Careers?locationCountry=c4f78be1a8f14da0ab49ce1162348a5e', 'LSEG'),
    -- 512 postings unfiltered -> 113 with India cities(8) ids (no country facet on this tenant).
    ('workday', 'fis.wd5/SearchJobs?locations=a2088ec533f41026992d77049749a891,a2088ec533f41026992e5a04dbb3a995,a2088ec533f41026992e481e6765a97c,bbc5678ae20c0100b02e92a2fe4b0000,a2088ec533f41026992e20cf8ae5a945,191f7c57cf8c1001bb496d0089360000,f3837ff2985c015f5cf3d7635118d0a2,a2088ec533f41026992fbf03338faaad', 'FIS'),
    -- 532 postings unfiltered -> 114 with country facet = India.
    ('workday', 'cigna.wd5/cignacareers?Location_Country=c4f78be1a8f14da0ab49ce1162348a5e', 'Cigna'),
    -- 1092 postings unfiltered -> 185 with country facet = India.
    ('workday', 'statestreet.wd1/Global?Location_Country=c4f78be1a8f14da0ab49ce1162348a5e', 'State Street'),
    -- 618 postings unfiltered -> 79 with country facet = India.
    ('workday', 'ntrs.wd1/northerntrust?locationCountry=c4f78be1a8f14da0ab49ce1162348a5e', 'Northern Trust'),
    -- 1047 postings unfiltered -> 165 with India cities(23) ids (no country facet on this tenant).
    ('workday', 'gehc.wd5/GEHC_ExternalSite?locations=442510cb8a8f100164fd00ec678d0000,eadc0b38d126100164fa06a5e8a70000,442510cb8a8f100165022af032b30000,442510cb8a8f100164ffe81dc2c10000,442510cb8a8f100164f9a9903a330000,442510cb8a8f100164fa7a19e0590000,442510cb8a8f100165042b8af7600000,442510cb8a8f100164fba86d3b890000,442510cb8a8f100164fd3b8a63720000,442510cb8a8f10016502d59f10af0000,442510cb8a8f100164f86518aaed0000,eadc0b38d126100164f15728a8f20000,442510cb8a8f100165026bfdd9930000,442510cb8a8f10016504b7d7c4d70000,60a7adef26471000b9b2accd4e6a0000,442510cb8a8f100164fe6134995c0000,14f787ffd58a10019f80eb63e0790000,442510cb8a8f100164fd7b2d07920000,442510cb8a8f100165008fe3bc310000,442510cb8a8f100164fe037e15420000,442510cb8a8f100164ff4e0d948f0000,442510cb8a8f100164fb8dd121ee0000,eadc0b38d126100164f5beb2340a0000', 'GE HealthCare'),
    -- 786 postings unfiltered -> 56 with India cities(7) ids (no country facet on this tenant).
    ('workday', 'philips.wd3/jobs-and-careers?locations=477471c84a9210a11576c522c0961038,477471c84a9210a11577020e1eaf107e,477471c84a9210a11576bc2a0902102e,477471c84a9210a1157ef9fcc59119af,477471c84a9210a1157e0ceeb46c18a1,477471c84a9210a115771b3a391f109c,477471c84a9210a11576ed2b386e1065', 'Philips'),
    -- 1194 postings unfiltered -> 17 with India cities(3) ids (no country facet on this tenant).
    ('workday', 'astrazeneca.wd3/Careers?locations=2c1433a5f2960105bea682732237fbc7,f3d89509ad0b102de2bc63a063d5793f,b914f96b1779102cc97003ec79c2b016', 'AstraZeneca'),
    -- 753 postings unfiltered -> 91 with country facet = India.
    ('workday', '3m.wd1/Search?Location_Country=c4f78be1a8f14da0ab49ce1162348a5e', '3M'),
    -- 1009 postings unfiltered -> 93 with country facet = India.
    ('workday', 'medtronic.wd1/MedtronicCareers?locationCountry=c4f78be1a8f14da0ab49ce1162348a5e', 'Medtronic')
  ) as b(provider, board_token, company_name)
  -- Re-running updates the name and re-enables instead of erroring, on the live
  -- unique key company_watchlist_user_board_key (user_id, ats_provider, board_token).
  on conflict (user_id, ats_provider, board_token) do update set
    company_name = excluded.company_name,
    enabled = true;

  -- Capture the written count for the report below.
  get diagnostics v_written = row_count;

  -- Matched vs written, reported (repo DB rule: counts, not silence).
  raise notice 'Watchlist batch 4: wrote % row(s) (expected 44).', v_written;
end
$$;
