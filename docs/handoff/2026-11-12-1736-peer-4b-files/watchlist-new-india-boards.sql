-- New India fresher-relevant boards for company_watchlist (peer 4b, 2026-11-12). PREPARED, NOT RUN: the orch runs it.
-- WHY: inflow is bounded by supply; most watched boards post sales/finance/senior roles. Each board below was
-- read LIVE on 2026-11-12 (JSON with jobs, company identity confirmed, >=1 India software role); Workday tokens
-- match workday.ts TOKEN_SHAPE and their site path is allowed by robots.txt. No SmartRecruiters (robots ruling).
-- user_id is carried explicitly: its default auth.uid() is NULL outside a user session. ON CONFLICT keeps a
-- board that already exists untouched, so a re-run inserts nothing twice.
-- Expected: 30 rows inserted (20 enabled, 10 disabled).
insert into public.company_watchlist (user_id, ats_provider, board_token, company_name, company_slug, enabled)
values
  -- Drivetrain: 6 India software roles at probe time
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'lever'::ats_provider, 'drivetrain', 'Drivetrain', 'drivetrain', true),
  -- Merkle Science: 3 India software roles at probe time
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'lever'::ats_provider, 'merklescience', 'Merkle Science', 'merkle-science', true),
  -- Anaplan: 23 India software roles at probe time
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'greenhouse'::ats_provider, 'anaplan', 'Anaplan', 'anaplan', true),
  -- project44: 6 India software roles at probe time
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'greenhouse'::ats_provider, 'project44', 'project44', 'project44', true),
  -- Smartsheet: 8 India software roles at probe time
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'greenhouse'::ats_provider, 'smartsheet', 'Smartsheet', 'smartsheet', true),
  -- HighLevel: 27 India software roles at probe time
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'lever'::ats_provider, 'gohighlevel', 'HighLevel', 'highlevel', true),
  -- Coupa Software: 9 India software roles at probe time
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'lever'::ats_provider, 'coupa', 'Coupa Software', 'coupa-software', true),
  -- Beghou Consulting: 10 India software roles at probe time
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'lever'::ats_provider, 'beghouconsulting', 'Beghou Consulting', 'beghou-consulting', true),
  -- Saviynt: 4 India software roles at probe time
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'lever'::ats_provider, 'saviynt', 'Saviynt', 'saviynt', true),
  -- Entrata: 2 India software roles at probe time
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'lever'::ats_provider, 'entrata', 'Entrata', 'entrata', true),
  -- Acron Aviation: 1 India software roles at probe time; senior-only today, so added DISABLED
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'lever'::ats_provider, 'acronaviation', 'Acron Aviation', 'acron-aviation', false),
  -- Eudia: 1 India software roles at probe time
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'greenhouse'::ats_provider, 'eudia', 'Eudia', 'eudia', true),
  -- Headout: 2 India software roles at probe time
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'greenhouse'::ats_provider, 'headoutcareers', 'Headout', 'headout', true),
  -- Truveta: 11 India software roles at probe time; senior-only today, so added DISABLED
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'greenhouse'::ats_provider, 'truveta', 'Truveta', 'truveta', false),
  -- Emergent Labs: 7 India software roles at probe time; senior-only today, so added DISABLED
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'greenhouse'::ats_provider, 'emergentlabsinc', 'Emergent Labs', 'emergent-labs', false),
  -- Amtech Software: 6 India software roles at probe time; senior-only today, so added DISABLED
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'greenhouse'::ats_provider, 'amtechsoftware', 'Amtech Software', 'amtech-software', false),
  -- Netradyne: 6 India software roles at probe time; senior-only today, so added DISABLED
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'greenhouse'::ats_provider, 'netradyne', 'Netradyne', 'netradyne', false),
  -- ChargePoint: 3 India software roles at probe time; senior-only today, so added DISABLED
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'greenhouse'::ats_provider, 'chargepoint', 'ChargePoint', 'chargepoint', false),
  -- Appian Corporation: 1 India software roles at probe time; senior-only today, so added DISABLED
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'greenhouse'::ats_provider, 'appian', 'Appian Corporation', 'appian-corporation', false),
  -- Poppulo: 2 India software roles at probe time; senior-only today, so added DISABLED
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'greenhouse'::ats_provider, 'poppulo', 'Poppulo', 'poppulo', false),
  -- EarnIn: 1 India software roles at probe time; senior-only today, so added DISABLED
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'greenhouse'::ats_provider, 'earnin', 'EarnIn', 'earnin', false),
  -- Nirmata: 1 India software roles at probe time; senior-only today, so added DISABLED
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'greenhouse'::ats_provider, 'nirmata', 'Nirmata', 'nirmata', false),
  -- Sarvam AI: 27 India software roles at probe time
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'ashby'::ats_provider, 'sarvam', 'Sarvam AI', 'sarvam-ai', true),
  -- HP Inc.: 20 India software roles at probe time
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'workday'::ats_provider, 'hp.wd5/ExternalCareerSite?Location_Country=c4f78be1a8f14da0ab49ce1162348a5e', 'HP Inc.', 'hp-inc', true),
  -- Analog Devices: 9 India software roles at probe time
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'workday'::ats_provider, 'analogdevices.wd1/External?locationCountry=c4f78be1a8f14da0ab49ce1162348a5e', 'Analog Devices', 'analog-devices', true),
  -- Motorola Solutions: 23 India software roles at probe time
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'workday'::ats_provider, 'motorolasolutions.wd5/Careers?locationCountry=c4f78be1a8f14da0ab49ce1162348a5e', 'Motorola Solutions', 'motorola-solutions', true),
  -- KLA: 16 India software roles at probe time
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'workday'::ats_provider, 'kla.wd1/Search?Country=c4f78be1a8f14da0ab49ce1162348a5e', 'KLA', 'kla', true),
  -- athenahealth: 5 India software roles at probe time
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'workday'::ats_provider, 'athenahealth.wd1/External?locationCountry=c4f78be1a8f14da0ab49ce1162348a5e', 'athenahealth', 'athenahealth', true),
  -- Trimble: 6 India software roles at probe time
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'workday'::ats_provider, 'trimble.wd1/TrimbleCareers?locationCountry=c4f78be1a8f14da0ab49ce1162348a5e', 'Trimble', 'trimble', true),
  -- Gartner: 6 India software roles at probe time
  ('0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, 'workday'::ats_provider, 'gartner.wd5/EXT?locationCountry=c4f78be1a8f14da0ab49ce1162348a5e', 'Gartner', 'gartner', true)
on conflict (user_id, ats_provider, board_token) do nothing
returning ats_provider, board_token, enabled;
