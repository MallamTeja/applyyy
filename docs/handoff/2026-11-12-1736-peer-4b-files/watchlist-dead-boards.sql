-- Fix or deactivate the 11 watchlist boards that failed every poll (peer 4b, 2026-11-12). PREPARED, NOT RUN.
-- Each verdict is from a LIVE probe on 2026-11-12 (scratchpad dead-boards.tsv) plus the scout log of run
-- 43089389444. Live counters before: poll_count 0 and consecutive_failures 15-23 on all 11.
-- One transaction, so a wrong count leaves nothing half-applied. Expected counts are in each comment.
begin;

-- DEACTIVATE (6): the company left Greenhouse/Lever for an ATS we do not read, or one we must not read.
-- Atlassian -> iCIMS; CleverTap -> Darwinbox; Rippling -> its own ats.rippling.com; Apna -> Workable;
-- Swiggy -> SmartRecruiters (banned by the 2026-11-01 robots ruling); Walmart -> Workday walmart.wd5, which
-- answers HTTP 422 to every request, robots.txt included (re-test before adding it as a workday board).
-- Disabled, never deleted: the row keeps its history and is one UPDATE away from coming back. Expect 6.
update public.company_watchlist set enabled = false, updated_at = now()
where user_id = '0f4b24da-e85b-40bb-8606-c81824493b45'
  and (ats_provider, board_token) in (('greenhouse','atlassian'), ('greenhouse','clevertap'), ('lever','rippling'),
                                      ('lever','apna'), ('lever','swiggy'), ('lever','walmart'));

-- MOVE PROVIDER (2): the Greenhouse boards are gone (404); both companies now post on Workday. Old rows are
-- disabled (expect 2) and the Workday boards inserted (expect 2). Postman: 41 jobs, 14 in India; BrowserStack:
-- 31 jobs, 28 in India; locations facets are their India sites as the tenant names them.
update public.company_watchlist set enabled = false, updated_at = now()
where user_id = '0f4b24da-e85b-40bb-8606-c81824493b45'
  and (ats_provider, board_token) in (('greenhouse','postman'), ('greenhouse','browserstack'));
insert into public.company_watchlist (user_id, ats_provider, board_token, company_name, company_slug, enabled)
values
  -- Postman's Workday site, Bangalore + Hyderabad facets.
  ('0f4b24da-e85b-40bb-8606-c81824493b45', 'workday', 'postman.wd108/careers?locations=7760d87eb31d1000b5b6a68f8e750000,7760d87eb31d1000b5b6b29394320000', 'Postman', 'postman', true),
  -- BrowserStack's Workday site, India Remote + Mumbai Remote + Mumbai WFO facets.
  ('0f4b24da-e85b-40bb-8606-c81824493b45', 'workday', 'browserstack.wd3/External?locations=07564020a4451005a3027f2ca2d60000,880034dbc3281000c58cd519fd640000,ab822483adc710009d4b55d085e60000', 'BrowserStack', 'browserstack', true)
on conflict (user_id, ats_provider, board_token) do nothing;

-- RENAME (1): Yugabyte's board is live (14 jobs, 3 in India) but reports itself as "YugabyteDB", so the
-- identity gate refused every poll ("Identity mismatch: board reports \"YugabyteDB\", watchlist says
-- \"Yugabyte\""). The name the board reports is the truth to match. consecutive_failures reset so the
-- Health page does not keep it flagged. Expect 1.
update public.company_watchlist set company_name = 'YugabyteDB', consecutive_failures = 0, updated_at = now()
where user_id = '0f4b24da-e85b-40bb-8606-c81824493b45' and ats_provider = 'greenhouse' and board_token = 'yugabyte';

-- NOT CHANGED HERE (2): Amgen (749 India jobs) and PwC (571) are live, but the Workday read fails the WHOLE
-- board at its 20-page cap ("page cap of 20 reached before the last page"), 400 jobs. That is a code issue,
-- reported to the orch; a data workaround would be narrowing their facets to Indian cities.

commit;
