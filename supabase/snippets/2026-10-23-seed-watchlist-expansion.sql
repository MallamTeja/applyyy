-- =============================================================================
-- Watchlist expansion, half B: +103 NEW verified-pollable boards (2026-10-23).
--
-- WHY THIS EXISTS: discovery coverage was the binding constraint — 54 watched
-- boards produced too few matching intern/new-grad/India/remote postings for
-- the ~20/day goal. Every row below was verified TODAY (2026-10-23 ~22:53 IST)
-- by one read-only GET to the provider's public board API (HTTP 200 + expected
-- JSON shape + >0 postings), rate-limited to 1 request/second/host. Tokens were
-- read from each company's own careers page by recon agents — never derived
-- from the company name (name-derived guesses are the known failure mode here;
-- see docs/harvest/2026-10-23-watchlist-expansion.md for evidence URLs).
--
-- ADDITIVE ONLY: unlike supabase/snippets/2026-09-18-seed-verified-watchlist.sql
-- this deliberately contains NO purge — peer work on the existing 54 rows'
-- tokens is in flight, and a delete here would race it.
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

  -- One row per verified board; slug derived the same way the 09-18 seed did,
  -- so slugs stay consistent across both seeds.
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
    ('ashby', 'skydio', 'Skydio'),
    ('ashby', '1password', '1Password'),
    ('ashby', 'amplify', 'Amplify'),
    ('ashby', 'harvey', 'Harvey'),
    ('ashby', 'cerebras', 'Cerebras'),
    ('ashby', 'quora', 'Quora'),
    ('ashby', 'cohere', 'Cohere'),
    ('ashby', 'sentry', 'Sentry'),
    ('ashby', 'qumulo', 'Qumulo'),
    ('ashby', 'patreon', 'Patreon'),
    ('lever', 'hevodata', 'Hevo Data'),
    ('ashby', 'red-gate', 'Redgate'),
    ('greenhouse', 'solutions', 'Cadence Solutions'),
    ('ashby', 'spruceid', 'SpruceID'),
    ('greenhouse', 'asteraearlycareer2027', 'Astera Labs'),
    ('greenhouse', 'graphcore', 'Graphcore'),
    ('greenhouse', 'muonspace', 'Muon Space'),
    ('greenhouse', 'scaleai', 'Scale AI'),
    ('greenhouse', 'perpay', 'Perpay'),
    ('greenhouse', 'point72', 'Point72'),
    ('greenhouse', 'doordashusa', 'DoorDash'),
    ('ashby', 'Sierra', 'Sierra'),
    ('greenhouse', 'togetherai', 'Together AI'),
    ('greenhouse', 'sigmacomputing', 'Sigma Computing'),
    ('greenhouse', 'singlestore', 'SingleStore'),
    ('greenhouse', 'drivewealth', 'DriveWealth'),
    ('greenhouse', 'klaviyocampus', 'Klaviyo'),
    ('greenhouse', 'purestorage', 'Pure Storage'),
    ('ashby', 'langchain', 'LangChain'),
    ('greenhouse', 'ziprecruiter', 'ZipRecruiter'),
    ('greenhouse', 'vercel', 'Vercel'),
    ('greenhouse', 'gcmgrosvenor', 'GCM Grosvenor'),
    ('greenhouse', 'twitch', 'Twitch'),
    ('greenhouse', 'idme', 'ID.me'),
    ('ashby', 'mistral.ai', 'Mistral AI'),
    ('greenhouse', 'gleanwork', 'Glean'),
    ('ashby', 'tessera-labs', 'Tessera Labs'),
    ('lever', 'parallelwireless', 'Parallel Wireless'),
    ('greenhouse', 'signifyd95', 'Signifyd'),
    ('ashby', 'decagon', 'Decagon'),
    ('ashby', 'chalk', 'Chalk'),
    ('lever', 'rhombus-systems', 'Rhombus'),
    ('ashby', 'steel', 'Steel'),
    ('greenhouse', 'rothesaygraduates', 'Rothesay'),
    ('greenhouse', 'courierhealth', 'Courier Health'),
    ('greenhouse', 'stateaffairs', 'State Affairs'),
    ('ashby', 'meow', 'Meow'),
    ('greenhouse', 'headlandstechnologiesllc', 'Headlands Technologies'),
    ('greenhouse', 'anthropic', 'Anthropic'),
    ('ashby', 'baseten', 'Baseten'),
    ('ashby', 'vanta', 'Vanta'),
    ('ashby', 'Deepgram', 'Deepgram'),
    ('ashby', 'temporal', 'Temporal'),
    ('ashby', 'fireworks', 'Fireworks AI'),
    ('ashby', 'kong', 'Kong'),
    ('ashby', 'render', 'Render'),
    ('greenhouse', 'fivetran', 'Fivetran'),
    ('lever', 'jumpcloud', 'JumpCloud'),
    ('ashby', 'lumaai', 'Luma AI'),
    ('ashby', 'workos', 'WorkOS'),
    ('greenhouse', 'launchdarkly', 'LaunchDarkly'),
    ('ashby', 'runway-ml', 'Runway'),
    ('greenhouse', 'sigmoid', 'Sigmoid'),
    ('lever', 'keyloop', 'Keyloop'),
    ('greenhouse', 'zenoti', 'Zenoti'),
    ('ashby', 'goteleport', 'Teleport'),
    ('ashby', 'cognition', 'Cognition'),
    ('ashby', 'amplitude', 'Amplitude'),
    ('lever', 'safe', 'Safe Security'),
    ('ashby', 'character', 'Character.AI'),
    ('ashby', 'n8n', 'n8n'),
    ('greenhouse', 'druva', 'Druva'),
    ('lever', 'mindtickle', 'Mindtickle'),
    ('lever', 'sonatype', 'Sonatype'),
    ('greenhouse', '6sense', '6sense'),
    ('greenhouse', 'planetscale', 'PlanetScale'),
    ('greenhouse', 'mixpanel', 'Mixpanel'),
    ('lever', 'gushwork', 'Gushwork'),
    ('ashby', 'vapi', 'Vapi'),
    ('greenhouse', 'meltplan', 'Meltplan'),
    ('ashby', 'apollo-graphql', 'Apollo GraphQL'),
    ('ashby', 'Snyk', 'Snyk'),
    ('greenhouse', 'axiad', 'Axiad'),
    ('greenhouse', 'bswiftindia', 'bswift India'),
    ('greenhouse', 'getwellnetwork', 'Get Well Network'),
    ('lever', 'valgenesis', 'ValGenesis'),
    ('ashby', 'suno', 'Suno'),
    ('greenhouse', 'sourcegraph91', 'Sourcegraph'),
    ('ashby', 'zapier', 'Zapier'),
    ('greenhouse', 'observeai', 'Observe.AI'),
    ('ashby', 'atlan', 'Atlan'),
    ('ashby', 'whoop', 'Whoop'),
    ('ashby', 'cartesia', 'Cartesia'),
    ('greenhouse', 'assemblyai', 'AssemblyAI'),
    ('greenhouse', 'netlify', 'Netlify'),
    ('ashby', 'Clerk', 'Clerk'),
    ('greenhouse', 'suki', 'Suki'),
    ('greenhouse', 'capstoneinvestmentadvisors', 'Capstone Investment Advisors'),
    ('greenhouse', 'imbue', 'Imbue'),
    ('greenhouse', 'browserbaseinc', 'Browserbase'),
    ('ashby', 'e2b', 'E2B'),
    ('ashby', 'magic.dev', 'Magic.dev'),
    ('greenhouse', 'buildkite', 'Buildkite')
  ) as b(provider, board_token, company_name)
  -- Re-running updates the name and re-enables rather than erroring: the
  -- unique key (user_id, ats_provider, board_token) is the live index
  -- company_watchlist_user_board_key, verified 2026-10-23.
  on conflict (user_id, ats_provider, board_token) do update set
    company_name = excluded.company_name,
    enabled = true;

  get diagnostics v_inserted = row_count;

  -- Matched vs written, reported (repo DB rule: counts, not silence).
  raise notice 'Watchlist expansion half B: wrote % row(s) (expected 103).', v_inserted;
end
$$;

-- Verification read: per-provider counts after the seed (expect total 157 =
-- 54 pre-existing + 103 new, fewer only if a token collided with half A work).
select ats_provider, count(*) as boards
from public.company_watchlist w
join auth.users u on u.id = w.user_id
where lower(u.email) = lower('tejamallam00@gmail.com')
group by 1 order by 1;
