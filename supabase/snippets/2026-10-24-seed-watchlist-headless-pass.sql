-- =============================================================================
-- Watchlist headless pass: +14 NEW verified-pollable boards (2026-10-24).
--
-- WHY THIS EXISTS: these companies' careers pages are JS-rendered, so the
-- 2026-10-23 static sweep could not read their board tokens. A Playwright
-- headless render (network-sniffing the page's OWN ATS API calls) recovered
-- them; every row was then verified 2026-10-24 ~00:30 IST by one read-only GET
-- (HTTP 200 + provider JSON shape + >0 postings + identity check), 1 req/s/host.
-- Evidence per row: docs/harvest/2026-10-23-watchlist-expansion.md, section
-- "Headless pass (2026-10-24)". Name-derived guesses remained banned — note
-- harnessinc/pulumicorporation, which a name guess would have missed.
--
-- ADDITIVE ONLY: no purge, same reasoning as the half-B seed it mirrors
-- (supabase/snippets/2026-10-23-seed-watchlist-expansion.sql).
--
-- HOW TO RUN: paste into the Supabase SQL editor (or MCP execute_sql) as the
-- human-approved live write. Idempotent via the on-conflict update.
-- =============================================================================

do $$
declare
  -- The owning account; auth.uid() is NULL outside a user session, so the
  -- user_id must be carried explicitly (CLAUDE.md §7).
  v_user_id uuid;
  -- Honest reporting: how many rows the insert actually wrote/updated.
  v_inserted integer;
begin
  -- Resolve the account by email, aborting rather than seeding nobody.
  select id into v_user_id
  from auth.users
  where lower(email) = lower('tejamallam00@gmail.com');

  if v_user_id is null then
    raise exception 'ABORTED - no auth.users row for tejamallam00@gmail.com';
  end if;

  -- One row per verified board; slug derived the same way both prior seeds
  -- did, so slugs stay consistent across all three.
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
    ('greenhouse', 'xai', 'xAI'),
    ('greenhouse', 'towerresearchcapital', 'Tower Research Capital'),
    ('greenhouse', 'hackerrank', 'HackerRank'),
    ('greenhouse', 'devrev', 'DevRev'),
    ('greenhouse', 'grafanalabs', 'Grafana Labs'),
    ('greenhouse', 'harnessinc', 'Harness'),
    ('greenhouse', 'inmobi', 'InMobi'),
    ('greenhouse', 'circleci', 'CircleCI'),
    ('greenhouse', 'pulumicorporation', 'Pulumi'),
    ('ashby', 'tekion', 'Tekion'),
    ('ashby', 'docker', 'Docker'),
    ('ashby', 'astronomer', 'Astronomer'),
    ('ashby', 'airbyte', 'Airbyte'),
    ('ashby', 'prefect', 'Prefect')
  ) as b(provider, board_token, company_name)
  -- Re-running updates the name and re-enables rather than erroring: the
  -- unique key (user_id, ats_provider, board_token) is the live index
  -- company_watchlist_user_board_key (verified 2026-10-23; rubrik was
  -- deliberately left out above because that key already holds it).
  on conflict (user_id, ats_provider, board_token) do update set
    company_name = excluded.company_name,
    enabled = true;

  get diagnostics v_inserted = row_count;

  -- Matched vs written, reported (repo DB rule: counts, not silence).
  raise notice 'Watchlist headless pass: wrote % row(s) (expected 14).', v_inserted;
end
$$;

-- Verification read: per-provider counts after the seed (expect the live total
-- to rise by exactly 14 over the pre-seed count; fewer only if a token
-- collided with other in-flight watchlist work).
select ats_provider, count(*) as boards
from public.company_watchlist w
join auth.users u on u.id = w.user_id
where lower(u.email) = lower('tejamallam00@gmail.com')
group by 1 order by 1;
