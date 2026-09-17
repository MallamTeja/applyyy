-- =============================================================================
-- Seed `public.company_watchlist` with the 23 ATS boards that were verified
-- pollable on 2026-09-17.
--
-- WHY THIS FILE EXISTS AT ALL — read this before "simplifying" it.
--
-- 1. It is a SNIPPET, not a migration. Migrations describe schema, which is the
--    same for every user. This is one person's row data, keyed to one account,
--    and it must never run automatically against a fresh database. Putting it in
--    `supabase/migrations/` would make every future `supabase db push` re-seed
--    somebody else's watchlist with Teja's companies.
--
-- 2. It is run BY HAND in the Supabase SQL editor. No Claude session in this
--    repo can authenticate as Teja — the `supabase` MCP server is configured but
--    unauthenticated — so no session can insert these rows itself. The operator
--    is the only path, and that makes the operator's experience the thing this
--    file is designed around: it must be safe to read, safe to re-run, and it
--    must be impossible to walk away believing it worked when it did not.
--
-- 3. Every board_token below was established by a live HTTP probe on
--    2026-09-17, not derived from the company name. Several of them CANNOT be
--    derived from the company name (see Razorpay). Losing this file means
--    re-probing 65 companies to recover 23 strings.
--
-- 4. Only three of the seven `ats_provider` enum values are pollable —
--    greenhouse, lever, ashby (`_shared/ats/registry.ts:38-45`). A row naming
--    `workable` or `smartrecruiters` is accepted by the schema and then silently
--    skipped by the Scout, so it LOOKS configured while polling nothing. This
--    file therefore emits only the three supported providers, deliberately, even
--    where a company's real board is known to be on another provider. See
--    `docs/watchlist/2026-09-17-board-token-verification.md` for that list.
--
-- Companion evidence doc (probe method, the 42 companies that are NOT pollable,
-- and the traps found while probing):
--   docs/watchlist/2026-09-17-board-token-verification.md
--
-- HOW TO RUN: paste the whole file into the Supabase SQL editor and execute. It
-- is idempotent — re-running inserts nothing and reports the same totals.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Part 1 — the insert, wrapped in a DO block.
--
-- WHY A DO BLOCK RATHER THAN A PLAIN `insert ... select`: plain SQL has no
-- `raise`, so a plain statement cannot fail loudly when the account is missing.
-- An `insert ... select ... from auth.users where email = '...'` with no match
-- inserts ZERO rows and reports `INSERT 0 0` — a success status for a complete
-- no-op. That is exactly the repo's recurring bug shape (CLAUDE.md §5): a
-- missing input quietly becoming an answer. PL/pgSQL lets us assert the shape we
-- expect BEFORE writing anything, and abort with a message the operator cannot
-- misread.
-- ---------------------------------------------------------------------------
do $$
declare
  -- The account these rows belong to. Resolved at run time from the email so
  -- that no uuid is hardcoded here — a hardcoded uuid would make this file
  -- account-specific in a way that is invisible when reading it, and would go
  -- stale silently if the account were ever recreated.
  v_user_id uuid;
  -- How many users the email matched. Counted separately from the id lookup
  -- because zero and two are DIFFERENT failures needing different messages, and
  -- a bare `select ... into` would silently take the first row in the two case.
  v_match_count integer;
  -- Rows actually written by the insert. Distinguishes a first run from a
  -- re-run; both are correct, but the operator should be told which happened.
  v_inserted integer;
begin

  -- Count the matches first. `lower(email)` on both sides because Postgres
  -- compares text case-sensitively while email addresses are not — an account
  -- stored as `TejaMallam00@gmail.com` must still be found.
  select count(*) into v_match_count
  from auth.users
  where lower(email) = lower('tejamallam00@gmail.com');

  -- FAIL LOUDLY #1 — no such account. This is the failure this whole DO block
  -- exists to catch: without it the script prints a success line and writes
  -- nothing. The message names the email so the operator can see immediately
  -- whether it is a typo or the wrong project.
  if v_match_count = 0 then
    raise exception
      'ABORTED - no auth.users row for tejamallam00@gmail.com. NOTHING WAS INSERTED. Check you are connected to the right Supabase project, and that this account has signed in at least once (a user row is created on first sign-in, not on invite).';
  end if;

  -- FAIL LOUDLY #2 — more than one match. Should be impossible (Supabase
  -- enforces email uniqueness in the default configuration), but if it ever
  -- happens, picking one arbitrarily would seed the watchlist onto whichever
  -- account the planner returned first, and the operator would never know.
  if v_match_count > 1 then
    raise exception
      'ABORTED - % auth.users rows match tejamallam00@gmail.com. NOTHING WAS INSERTED. Refusing to guess which account the watchlist belongs to.', v_match_count;
  end if;

  -- Exactly one match, so this lookup is now unambiguous by construction.
  select id into v_user_id
  from auth.users
  where lower(email) = lower('tejamallam00@gmail.com');

  -- ------------------------------------------------------------------------
  -- The insert.
  --
  -- `user_id` is supplied EXPLICITLY even though the column defaults to
  -- `auth.uid()`. That default is correct for the web app and useless here:
  -- `auth.uid()` is NULL in the SQL editor, so relying on it would trip the
  -- NOT NULL constraint on every row.
  --
  -- `company_slug` is COMPUTED here rather than typed out, so it cannot drift
  -- from what the app writes. The expression is a literal translation of
  -- `WatchlistPage.tsx:150-153`:
  --     name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')
  -- `regexp_replace(..., 'g')` is the `replace(/…/g, '-')`, and `trim(both '-')`
  -- is the leading/trailing strip. The slug is what `jobs.company_slug` joins
  -- against for the blocklist and the per-company weekly cap, so a hand-typed
  -- slug that disagreed with the app's would break those joins for exactly the
  -- companies seeded here and no others — the worst kind of partial breakage.
  -- ------------------------------------------------------------------------
  insert into public.company_watchlist (
    user_id,
    ats_provider,
    board_token,
    company_name,
    company_slug,
    enabled
  )
  select
    -- The account resolved and asserted above.
    v_user_id,
    -- Cast to the enum explicitly. An unlisted provider string fails HERE with a
    -- cast error naming the bad value, instead of being coerced or accepted.
    b.provider::public.ats_provider,
    -- The probe-verified token. Never derived from the name; see the notes.
    b.board_token,
    -- Display name, shown in the Watchlist page and copied onto discovered jobs.
    b.company_name,
    -- The app's slug rule, reproduced exactly (see the comment block above).
    trim(both '-' from regexp_replace(lower(b.company_name), '[^a-z0-9]+', '-', 'g')),
    -- Seeded enabled. Every one of these boards returned live postings on
    -- 2026-09-17, so there is no reason to land any of them switched off.
    true
  from (values
    -- ====================================================================
    -- The 23 verified boards. `provider`, `board_token`, `company_name`.
    -- Each comment records WHY this token and the job count observed on
    -- 2026-09-17 — the count is the evidence the board was real and live,
    -- not a well-formed empty response.
    -- ====================================================================

    -- 19 postings. Token is the REGISTERED LEGAL ENTITY NAME, not the brand.
    -- Found only by scraping razorpay.com/jobs; no name-derived guess
    -- ("razorpay", "razorpay-software") produces it. If this row is ever lost,
    -- it cannot be reconstructed by guessing.
    ('greenhouse', 'razorpaysoftwareprivatelimited', 'Razorpay'),

    -- 8 postings. The PUBLIC board is served from Greenhouse's EU cluster
    -- (job-boards.eu.greenhouse.io), but the canonical boards-api.greenhouse.io
    -- endpoint the adapter uses answers correctly for this token — verified, not
    -- assumed. Do not "fix" this row to an EU host; the adapter has one origin.
    ('greenhouse', 'groww', 'Groww'),

    -- 11 postings.
    ('lever', 'cred', 'CRED'),

    -- 346 postings.
    ('ashby', 'snowflake', 'Snowflake'),

    -- 879 postings — the largest board in this set. Worth knowing before the
    -- first poll: one board can dominate a day's discovery volume.
    ('greenhouse', 'databricks', 'Databricks'),

    -- 21 postings.
    ('ashby', 'confluent', 'Confluent'),

    -- 148 postings.
    ('greenhouse', 'twilio', 'Twilio'),

    -- 322 postings.
    ('greenhouse', 'okta', 'Okta'),

    -- 360 postings.
    ('greenhouse', 'elastic', 'Elastic'),

    -- 313 postings.
    ('lever', 'palantir', 'Palantir'),

    -- 153 postings.
    ('greenhouse', 'figma', 'Figma'),

    -- 261 postings.
    ('greenhouse', 'brex', 'Brex'),

    -- 110 postings.
    ('ashby', 'plaid', 'Plaid'),

    -- 654 postings.
    ('greenhouse', 'stripe', 'Stripe'),

    -- 220 postings.
    ('greenhouse', 'coinbase', 'Coinbase'),

    -- 40 postings. NAMED "Microsoft AI", NOT "Microsoft", AND THAT IS
    -- DELIBERATE. The board token `microsoftcorporation` is real, but every
    -- posting it returns carries company_name "Microsoft AI" — it is the MAI
    -- org's board, not Microsoft's corporate requisitions, which live on the
    -- in-house careers.microsoft.com portal and are not reachable by any
    -- adapter we have. Calling this row "Microsoft" would claim coverage of a
    -- company we do not cover, and the claim would be invisible afterwards.
    ('greenhouse', 'microsoftcorporation', 'Microsoft AI'),

    -- 163 postings.
    ('greenhouse', 'airbnb', 'Airbnb'),

    -- 204 postings.
    ('lever', 'paytm', 'Paytm'),

    -- 49 postings.
    ('lever', 'meesho', 'Meesho'),

    -- 107 postings.
    ('ashby', 'uipath', 'UiPath'),

    -- 41 postings.
    ('greenhouse', 'dropbox', 'Dropbox'),

    -- 160 postings. THE TOKEN CONTAINS A LITERAL DOT — it is `checkout.com`,
    -- not `checkout` or `checkout-com`. Verified safe end to end: the Ashby
    -- adapter wraps the token in `encodeURIComponent`
    -- (`_shared/ats/ashby.ts:60`) and `.` is an unreserved character, so it
    -- passes through unchanged into the request URL. Consequence for anyone
    -- adding board_token validation later: a `[a-z0-9-]+` regex would reject a
    -- token we have PROVEN works. Widen the regex; do not drop the row.
    ('ashby', 'checkout.com', 'Checkout.com'),

    -- 40 postings on GREENHOUSE. Thoughtworks ALSO has an Ashby board, and that
    -- board is a trap rather than a bad token: it returns HTTP 200 with a
    -- well-formed `{"jobs":[]}` body. A probe that only checked the status code
    -- would have recorded the empty Ashby board as valid and this company would
    -- have polled zero jobs forever while looking correctly configured. Use the
    -- greenhouse row; do not "add the Ashby one too for coverage".
    ('greenhouse', 'thoughtworks', 'Thoughtworks')

  ) as b(provider, board_token, company_name)
  -- IDEMPOTENCE. The conflict target is the table's own unique constraint,
  -- `company_watchlist_user_board_key (user_id, ats_provider, board_token)`
  -- (`20260909234800_supporting_tables.sql:295`).
  --
  -- `do nothing` rather than `do update` ON PURPOSE. An upsert here would
  -- overwrite whatever the operator has since changed by hand — a row disabled
  -- because its board went quiet would be silently re-enabled by a re-run. It
  -- would also blank any column this statement does not name, which is the
  -- unguarded-upsert failure listed in CLAUDE.md §5. This file's job is to ADD
  -- boards that are missing, never to assert authority over ones already there.
  on conflict (user_id, ats_provider, board_token) do nothing;

  -- Capture what the insert actually did. `row_count` after an `on conflict do
  -- nothing` counts only rows WRITTEN, so this is the first-run/re-run signal.
  get diagnostics v_inserted = row_count;

  -- Report it. NOTICE and not EXCEPTION because zero inserted rows is a
  -- perfectly correct outcome HERE — it means "already seeded". The dangerous
  -- zero (no such account) was already turned into an exception above, which is
  -- why this one can be reported calmly.
  raise notice
    'company_watchlist seed: % new row(s) inserted for tejamallam00@gmail.com (% already present and left untouched).',
    v_inserted, 23 - v_inserted;

end
$$;

-- ---------------------------------------------------------------------------
-- Part 2 — verification, as a SELECT.
--
-- WHY THIS IS NOT JUST THE `raise notice` ABOVE: NOTICE output goes to the
-- message channel, which some clients collapse, truncate or hide entirely. A
-- result grid is the one thing the SQL editor always puts in front of the
-- operator. This is the same discipline as the repo's "prove the gate ran"
-- rule — do not let the only evidence live somewhere that can be skipped.
--
-- It also verifies something the insert's own row count cannot: it reads the
-- table BACK, so it catches the case where rows were written and then not
-- visible (wrong account, RLS, uncommitted).
-- ---------------------------------------------------------------------------
select
  -- Group by provider so the three-way split is legible at a glance; it should
  -- read 14 greenhouse / 4 lever / 5 ashby rather than one opaque total of 23.
  w.ats_provider,
  -- How many boards are configured for this provider.
  count(*) as boards,
  -- How many are actually pollable. A board with enabled = false is invisible
  -- to the Scout, so a total that ignores this column can overstate coverage.
  count(*) filter (where w.enabled) as enabled_boards,
  -- Which ones, alphabetically, so a missing company is spotted by eye rather
  -- than by arithmetic on the count.
  string_agg(w.company_name, ', ' order by w.company_name) as companies
from public.company_watchlist w
-- Join back through auth.users on the email for the same reason the insert did:
-- no uuid in the file, and the verification is scoped to the same account the
-- insert targeted rather than to whatever the session happens to be.
join auth.users u on u.id = w.user_id
where lower(u.email) = lower('tejamallam00@gmail.com')
group by w.ats_provider
-- Deterministic ordering, so two runs are diffable against each other.
order by w.ats_provider;

-- ---------------------------------------------------------------------------
-- Expected result after a successful run — 23 boards total:
--
--   greenhouse | 14 | 14 | Airbnb, Brex, Coinbase, Databricks, Dropbox,
--                          Elastic, Figma, Groww, Microsoft AI, Okta,
--                          Razorpay, Stripe, Thoughtworks, Twilio
--   lever      |  4 |  4 | CRED, Meesho, Palantir, Paytm
--   ashby      |  5 |  5 | Checkout.com, Confluent, Plaid, Snowflake, UiPath
--
-- 14 + 4 + 5 = 23. If the totals differ, the difference is rows that were
-- already present before this run, not rows this file failed to write — the
-- `do nothing` clause makes those two outcomes indistinguishable in the grid,
-- which is what the NOTICE in Part 1 is for.
--
-- A NOTE ON RLS, because it will otherwise be the first thing that confuses the
-- operator. `company_watchlist` has RLS enabled AND forced
-- (`20260909234800_supporting_tables.sql:298-299`), and its only policy is
-- granted `to authenticated` (`20260909235000_rls_policies.sql:133-135`). The
-- Supabase SQL editor runs as `postgres`, which carries BYPASSRLS, so both
-- statements above see and write every row. If you instead run this file
-- through an authenticated client session, the insert will be REFUSED with
-- SQLSTATE 42501 unless that session is signed in as this very account — which
-- is a loud failure, not a silent one, and therefore fine.
-- ---------------------------------------------------------------------------
