-- jobs.description_preview: a short, card-sized prefix of description_raw (2026-11-08).
--
-- WHY THIS EXISTS: the Discovered page (apps/web/src/features/discovery/DiscoveredJobsPage.tsx:259)
-- selected the FULL description_raw for every one of its 300 cards per page, only to show
-- jdPlainText(description_raw).slice(0, 220) on each card (:1015). The descriptions live in
-- jobs' TOAST table (91 MB, pglz, average 6.4 KB raw), so a cold page read cost 650 ms in the
-- database against 28 ms warm (EXPLAIN ANALYZE as `authenticated`; production pg_stat for that
-- query: mean 249 ms, max 6.2 s) and shipped ~1.9 MB of JSON. The card only ever needs the
-- first few hundred characters. Evidence: docs/status/2026-11-08-web-latency-db.md.
--
-- WHY 600 CHARACTERS (measured, not guessed): on 1,500 random live descriptions, running the
-- web's own jdPlainText over a prefix of N characters gave the SAME first 220 visible
-- characters as the full description for 0/1500 rows at N=100, 1499/1500 at N=230 and
-- 1500/1500 at N=250. Every one of the 7,072 live descriptions is plain text today (0 rows
-- match '<[a-z][^>]*>', 0 match '&lt;[a-z]'), because the scouts strip markup at ingest. 600
-- is a 2.4x margin for a future source that keeps entities or markup, and stays small enough
-- to sit inline in the heap row instead of in TOAST, which is the point of the column.
-- If a source ever stores heavy HTML, the card degrades to SHORTER text, never wrong text:
-- jdPlainText strips whatever tags the prefix holds, and a tag cut at the end lies past char 220.
--
-- WHY A STORED GENERATED COLUMN, NOT A TRIGGER: left(text, int) is IMMUTABLE, so Postgres can
-- own the value. It is recomputed on every write of description_raw, including the tombstone
-- trigger (jobs_keep_tombstone_slim) nulling it, so it can never drift from its source.
-- No writer has to remember it, and an INSERT that tries to set it is refused by Postgres.
--
-- LOCK COST: adding a STORED generated column rewrites jobs under an ACCESS EXCLUSIVE lock
-- (35,945 rows; 39 MB heap + 91 MB TOAST + 9.8 MB indexes on 2026-11-08). Expect seconds, not
-- minutes. Scouts and the web block on jobs for that time; they wait, they do not fail.
-- lock_timeout makes the migration GIVE UP after 5 s instead of queueing every other jobs
-- query behind it while it waits for a long-running reader. If it times out, re-run it in a
-- quiet window (between scout runs).
-- LOW-LOCK ALTERNATIVE, if a rewrite is ever unacceptable: add a plain nullable text column
-- (catalog-only, instant), keep it current with a BEFORE INSERT OR UPDATE OF description_raw
-- trigger, and backfill the 7,072 non-null rows in batches. That is more moving parts, so it
-- is not the default.

-- Give up fast rather than stall all jobs traffic behind the rewrite's lock wait.
set lock_timeout = '5s';

-- BOTH generated columns are added in ONE alter table, so Postgres rewrites jobs ONCE.
-- Two separate statements would rewrite the 142 MB table twice under the exclusive lock.
alter table public.jobs
  -- The card-sized prefix. NULL exactly when description_raw is NULL (left() is strict), so the
  -- card's existing "no description, no block" check keeps working when it reads this column.
  add column if not exists description_preview text
    generated always as (left(description_raw, 600)) stored,
  -- description_requires_degree (2026-11-08): the degree_mismatch filter's description check,
  -- precomputed. The web filter (apps/web/src/features/settings/filtersStore.ts:450) ran
  --   /\b(must have a master'?s|ph\.?d\.? required|master'?s degree required|ph\.?d required)\b/i
  -- over the FULL description_raw of every card, which is the one reason the Discovered page
  -- still needed the whole description after description_preview exists. With this column the
  -- web reads a boolean instead of 6.4 KB of TOASTed text per row.
  -- THE PORT, and why it is not a copy: in a Postgres regex `\b` means BACKSPACE, not a word
  -- boundary, and Postgres' own `\y` counts Unicode letters as word characters, where JS `\b`
  -- counts only [A-Za-z0-9_]. So each `\b` becomes an ASCII-only lookaround. Every alternative
  -- starts and ends with a word character, so "(?<![A-Za-z0-9_])" and "(?![A-Za-z0-9_])" are
  -- exactly JS `\b` there. `~*` is the JS `i` flag. The JS side lowercases first; for this
  -- all-ASCII pattern that changes nothing.
  -- PARITY, measured 2026-11-08: 7,072/7,072 live descriptions give the same verdict as the JS
  -- regex, but every one of those verdicts is "no", so a 20-case set covers the "yes" side:
  -- 20/20 agree, 12 of them positive (Ph.D./PhD/must have a master's/… plus boundary traps such
  -- as "xphd required", "phd_required", a curly apostrophe, double spaces, and "phd requiredé",
  -- which plain `\y` got WRONG). coalesce(…, false): the JS reads (description_raw || '') and
  -- answers false for a missing description, so NULL must not become a third answer here.
  -- `~*` (texticregexeq) is IMMUTABLE, which a generated column requires.
  add column if not exists description_requires_degree boolean
    generated always as (coalesce(description_raw ~* '(?<![A-Za-z0-9_])(must have a master''?s|ph\.?d\.? required|master''?s degree required|ph\.?d required)(?![A-Za-z0-9_])', false)) stored;

-- Documented in the catalog, so whoever finds the column in Studio knows why it is there and
-- that it is derived (never written directly).
comment on column public.jobs.description_preview is
  'First 600 chars of description_raw, generated and stored, so list views (Discovered cards) avoid detoasting the full description. 600 was measured 2026-11-08 (250 suffices for every live row). Read-only: Postgres computes it.';

-- Documented in the catalog for the same reason: a derived flag nobody should try to write.
comment on column public.jobs.description_requires_degree is
  'True when description_raw states a Master''s/PhD requirement; generated and stored. Exact port of the degree_mismatch regex in apps/web/src/features/settings/filtersStore.ts (JS \b ported as ASCII lookarounds); parity 7,072/7,072 live rows + 20/20 crafted cases, 2026-11-08.';

-- Back to the role default, so nothing later in this session inherits the short timeout.
reset lock_timeout;
