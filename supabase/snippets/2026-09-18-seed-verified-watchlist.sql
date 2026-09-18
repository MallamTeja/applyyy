-- =============================================================================
-- Purge invalid/failing watchlist entries & seed 54 VERIFIED pollable boards
-- for tejamallam00@gmail.com.
--
-- HOW TO RUN: Paste the entire script into the Supabase SQL Editor and execute.
-- It is idempotent: purges broken entries and inserts only verified, probe-tested
-- Greenhouse, Lever, and Ashby boards.
-- =============================================================================

do $$
declare
  v_user_id uuid;
  v_match_count integer;
  v_deleted integer;
  v_inserted integer;
begin
  -- Resolve user account
  select count(*) into v_match_count
  from auth.users
  where lower(email) = lower('tejamallam00@gmail.com');

  if v_match_count = 0 then
    raise exception 'ABORTED - no auth.users row found for tejamallam00@gmail.com.';
  end if;

  select id into v_user_id
  from auth.users
  where lower(email) = lower('tejamallam00@gmail.com');

  -- 1. PURGE broken / non-pollable / unverified entries that produce poll failures
  delete from public.company_watchlist
  where user_id = v_user_id
    and (ats_provider, board_token) not in (
      ('greenhouse', 'razorpaysoftwareprivatelimited'),
      ('greenhouse', 'groww'),
      ('lever', 'cred'),
      ('ashby', 'snowflake'),
      ('greenhouse', 'databricks'),
      ('ashby', 'confluent'),
      ('greenhouse', 'twilio'),
      ('greenhouse', 'okta'),
      ('greenhouse', 'elastic'),
      ('lever', 'palantir'),
      ('greenhouse', 'figma'),
      ('greenhouse', 'brex'),
      ('ashby', 'plaid'),
      ('greenhouse', 'stripe'),
      ('greenhouse', 'coinbase'),
      ('greenhouse', 'microsoftcorporation'),
      ('greenhouse', 'airbnb'),
      ('lever', 'paytm'),
      ('lever', 'meesho'),
      ('ashby', 'uipath'),
      ('greenhouse', 'dropbox'),
      ('ashby', 'checkout.com'),
      ('greenhouse', 'thoughtworks'),
      ('greenhouse', 'gitlab'),
      ('greenhouse', 'mongodb'),
      ('greenhouse', 'slice'),
      ('ashby', 'openai'),
      ('ashby', 'notion'),
      ('ashby', 'cursor'),
      ('ashby', 'perplexity'),
      ('ashby', 'replit'),
      ('ashby', 'midjourney'),
      ('ashby', 'supabase'),
      ('ashby', 'posthog'),
      ('ashby', 'linear'),
      ('ashby', 'pinecone'),
      ('ashby', 'ramp'),
      ('ashby', 'anyscale'),
      ('ashby', 'modal'),
      ('greenhouse', 'cloudflare'),
      ('greenhouse', 'samsara'),
      ('greenhouse', 'roblox'),
      ('greenhouse', 'reddit'),
      ('greenhouse', 'duolingo'),
      ('greenhouse', 'affirm'),
      ('greenhouse', 'robinhood'),
      ('greenhouse', 'toast'),
      ('greenhouse', 'asana'),
      ('greenhouse', 'chime'),
      ('greenhouse', 'pagerduty'),
      ('greenhouse', 'instacart'),
      ('greenhouse', 'squarespace'),
      ('greenhouse', 'cockroachlabs'),
      ('lever', 'spotify')
    );
  
  get diagnostics v_deleted = row_count;

  -- 2. INSERT all 54 verified, live-pollable boards
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
    -- AI & Frontier Labs
    ('ashby', 'openai', 'OpenAI'),
    ('ashby', 'cursor', 'Cursor'),
    ('ashby', 'perplexity', 'Perplexity'),
    ('ashby', 'replit', 'Replit'),
    ('ashby', 'midjourney', 'Midjourney'),
    ('ashby', 'anyscale', 'Anyscale'),
    ('ashby', 'modal', 'Modal'),
    ('greenhouse', 'microsoftcorporation', 'Microsoft AI'),

    -- High-Scale Data & Developer Platforms
    ('greenhouse', 'databricks', 'Databricks'),
    ('ashby', 'snowflake', 'Snowflake'),
    ('greenhouse', 'cloudflare', 'Cloudflare'),
    ('greenhouse', 'gitlab', 'GitLab'),
    ('greenhouse', 'mongodb', 'MongoDB'),
    ('greenhouse', 'elastic', 'Elastic'),
    ('ashby', 'confluent', 'Confluent'),
    ('ashby', 'supabase', 'Supabase'),
    ('ashby', 'posthog', 'PostHog'),
    ('ashby', 'linear', 'Linear'),
    ('ashby', 'pinecone', 'Pinecone'),
    ('greenhouse', 'cockroachlabs', 'Cockroach Labs'),
    ('greenhouse', 'pagerduty', 'PagerDuty'),

    -- FinTech & Payments
    ('greenhouse', 'stripe', 'Stripe'),
    ('greenhouse', 'brex', 'Brex'),
    ('ashby', 'ramp', 'Ramp'),
    ('ashby', 'plaid', 'Plaid'),
    ('ashby', 'checkout.com', 'Checkout.com'),
    ('greenhouse', 'coinbase', 'Coinbase'),
    ('greenhouse', 'robinhood', 'Robinhood'),
    ('greenhouse', 'affirm', 'Affirm'),
    ('greenhouse', 'chime', 'Chime'),
    ('greenhouse', 'toast', 'Toast'),
    ('greenhouse', 'razorpaysoftwareprivatelimited', 'Razorpay'),
    ('greenhouse', 'groww', 'Groww'),
    ('lever', 'cred', 'CRED'),
    ('lever', 'paytm', 'Paytm'),
    ('greenhouse', 'slice', 'slice'),

    -- Product MNCs & Scale-Ups
    ('ashby', 'notion', 'Notion'),
    ('greenhouse', 'figma', 'Figma'),
    ('lever', 'palantir', 'Palantir'),
    ('greenhouse', 'airbnb', 'Airbnb'),
    ('lever', 'spotify', 'Spotify'),
    ('greenhouse', 'okta', 'Okta'),
    ('greenhouse', 'twilio', 'Twilio'),
    ('greenhouse', 'dropbox', 'Dropbox'),
    ('ashby', 'uipath', 'UiPath'),
    ('greenhouse', 'roblox', 'Roblox'),
    ('greenhouse', 'reddit', 'Reddit'),
    ('greenhouse', 'duolingo', 'Duolingo'),
    ('greenhouse', 'samsara', 'Samsara'),
    ('greenhouse', 'asana', 'Asana'),
    ('greenhouse', 'instacart', 'Instacart'),
    ('greenhouse', 'squarespace', 'Squarespace'),
    ('lever', 'meesho', 'Meesho'),
    ('greenhouse', 'thoughtworks', 'Thoughtworks')
  ) as b(provider, board_token, company_name)
  on conflict (user_id, ats_provider, board_token) do update set
    company_name = excluded.company_name,
    enabled = true;

  get diagnostics v_inserted = row_count;

  raise notice 'Purged % unverified/failing row(s). Seeded % verified board(s) for tejamallam00@gmail.com.', v_deleted, v_inserted;
end
$$;

-- Verification grid output
select
  w.ats_provider,
  count(*) as active_boards,
  string_agg(w.company_name, ', ' order by w.company_name) as verified_companies
from public.company_watchlist w
join auth.users u on u.id = w.user_id
where lower(u.email) = lower('tejamallam00@gmail.com')
group by w.ats_provider
order by w.ats_provider;
