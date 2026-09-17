-- =============================================================================
-- Closes the INSERT bypass in the status transition guard.
--
-- THE HOLE. 20260909234900_status_transition_guard.sql:266 declares the guard as
--     create trigger guard_status_transition
--       before update on public.applications
-- BEFORE UPDATE only. There is no INSERT trigger. So a row inserted directly at
-- `status: 'approved'` — or at 'applying' — has traversed no edge, consulted no
-- `allowed_agents`, and written no application_events witness. The entire
-- transition graph is opt-in by way of ARRIVING THROUGH AN UPDATE.
--
-- That guard's header calls itself "THE SAFETY CASE FOR THE WHOLE SYSTEM" and
-- argues constraint 15 — never submit without human approval — is UNREACHABLE BY
-- CONSTRUCTION, because every edge into `approved` is human-only and
-- `approved -> applying` is the only edge into `applying`. Every word of that is
-- true OF THE GRAPH. An INSERT simply never enters the graph.
--
-- Found by applyyy-c8, 2026-09-17.
--
-- WHY A TABLE-LEVEL CONTROL WHEN A CONTROL ALREADY EXISTS. It is already closed on
-- the one path that matters today: supabase/functions/_shared/screen/screen-batch.ts:44
-- declares `type ScreenedInsertStatus = "passed_filters" | "dropped_filter"`, and
-- its comment at :28-43 names this exact bypass as the reason. That is a real
-- control and a well-reasoned one — c8 documented this hole, it did not leave it.
-- But a TypeScript union binds only code that imports it. It does not bind the
-- REST API, the SQL editor, a future module, or the browser, all of which can
-- insert into `applications` directly. This trigger binds the table.
-- =============================================================================

-- =============================================================================
-- THE ALLOWLIST IS ENUMERATED, NOT ASSUMED.
--
-- Exhaustive search of the repo (excluding node_modules, reference/ and the
-- compiled apps/web/dist) found FIVE insert sites writing THREE distinct values,
-- and ZERO `insert into public.applications` statements in any migration:
--
--   'passed_filters'  worker/src/cli/scout.ts:314, scout-ats/index.ts:402
--   'dropped_filter'  the same two sites
--   'discovered'      scout.ts:312, scout-ats:400   <- screener-unavailable fallback
--                     scout-remote.ts:343           <- tier-3 aggregator, never screened
--                     discoveryService.ts:358, :505 <- both browser discovery paths
--                     core_tables.sql:313           <- the column DEFAULT
--
-- 'discovered' IS NOT A LEGACY VALUE, and reading it as one is the trap this
-- allowlist was nearly built around. scout.ts:312 and scout-ats:400 fall back to
-- it on ANY transient failure of the four screener context reads — filter_rules,
-- company_blocklist, applications history, search_preferences. That path is live.
--
-- SO REFUSING 'discovered' WOULD BREAK BOTH SCREENED SCOUTS PRECISELY WHEN THE
-- DATABASE IS ALREADY HAVING A BAD DAY. That is a guard which fires hardest exactly
-- when the system is least able to absorb it, converting a recoverable blip into an
-- outage. It is the mirror image of the usual failure: not a guard that passes when
-- it should fail, but one that fails when it should pass. The instinct that
-- produces it — "this value looks vestigial, tighten it" — feels like diligence.
-- =============================================================================

create or replace function applyy_internal.guard_status_insert()
returns trigger
language plpgsql
-- NOT `security definer`, unlike guard_status_transition(). That one is definer
-- because it must read application_status_transitions regardless of the caller's
-- role. This function reads NO table at all, so definer would grant privileges it
-- has no use for — and an unused privilege on a trigger reachable from every insert
-- is a surface with no upside.
set search_path = ''
as $$
begin
  -- THE WHOLE CHECK: the status the row is being BORN at must be one nothing has to
  -- earn. All three are upstream of the human approval gate, so no insert can
  -- manufacture a row already sitting at or past it.
  --
  -- JUDGES new.status ALONE. THIS IS LOAD-BEARING AND THE REASON IS NOT OBVIOUS.
  -- Every applications upsert in this repo uses `ignoreDuplicates: true`, i.e.
  -- ON CONFLICT DO NOTHING. In Postgres a BEFORE INSERT trigger fires BEFORE
  -- conflict detection, so on every re-poll this runs for (user_id, job_id) pairs
  -- THAT ALREADY EXIST — including pairs whose stored row is currently 'approved'
  -- or 'applied'.
  --
  -- So the tempting "smarter" version — look up the existing row and refuse a
  -- re-insert over an approved one — WOULD REFUSE ROUTINE RE-POLLING OF THE USER'S
  -- MOST ADVANCED APPLICATIONS. Daily occurrence; presents as the scout mysteriously
  -- failing on exactly the jobs that matter most.
  --
  -- GENERAL RULE, worth carrying to any trigger on this table:
  --   A TRIGGER THAT CONSULTS OTHER ROWS IS REASONING ABOUT A WORLD THAT
  --   `ON CONFLICT` HAS NOT RESOLVED YET.
  if new.status not in ('discovered', 'passed_filters', 'dropped_filter') then
    raise exception
      'application may not be INSERTED at status %. Inserts are limited to discovered, passed_filters and dropped_filter; every later status must be reached through advance_application_status() so the transition guard can validate the edge.',
      new.status
      using errcode = '42501';
  end if;

  -- No null branch, deliberately, and it would be DEAD CODE rather than caution.
  -- `status` is declared `not null default 'discovered'` (core_tables.sql:313), and
  -- column defaults are applied BEFORE row triggers — so an INSERT omitting status
  -- arrives here already carrying 'discovered'. An INSERT explicitly setting NULL
  -- reaches here as NULL, where `null not in (...)` evaluates to NULL rather than
  -- true, so this function correctly declines to fire and the column's NOT NULL
  -- constraint rejects the row a moment later with a clearer error than ours.
  return new;
end;
$$;

comment on function applyy_internal.guard_status_insert() is
  'Refuses an INSERT into public.applications at any status past the human approval gate. Companion to guard_status_transition(), which is BEFORE UPDATE and therefore never sees an insert.';

-- Dropped first so this migration is re-appliable. `create or replace` exists for
-- functions but NOT for triggers, so a bare `create trigger` fails with 42710 on a
-- second run. Supabase applies each migration once, so this is not needed in
-- production — it is what lets the file be applied repeatedly against a THROWAWAY
-- LOCAL POSTGRES, which is the only way anything in this repo can test a migration
-- before Teja runs it against the real database. A migration that can only be run
-- once cannot be rehearsed.
drop trigger if exists guard_status_insert on public.applications;

-- BEFORE, so an illegal row never reaches the table — matching the phrasing and the
-- reasoning of the UPDATE guard it completes.
create trigger guard_status_insert
  before insert on public.applications
  for each row execute function applyy_internal.guard_status_insert();

-- =============================================================================
-- A DUPLICATED FACT, DUPLICATED ON PURPOSE. DO NOT "FIX" THIS BY DELETING EITHER COPY.
--
-- The three values above also live in
-- supabase/functions/_shared/screen/screen-batch.ts:44 as `ScreenedInsertStatus`
-- (two of them; that module never writes 'discovered'). Duplicated facts drift, and
-- normally the answer is to keep one. Not here:
--
--   THE TRIGGER IS THE AUTHORITY. It binds every caller — the REST API, a human in
--   the SQL editor, a future module nobody has written, the browser. The TypeScript
--   union binds only code that imports it.
--
-- Collapsing them would mean trusting the application layer to bind the database
-- layer, which is exactly the arrangement this migration exists to end. The two
-- copies serve different enforcement domains and both are needed.
--
-- The drift is real in both directions, so watch both:
--   * Widen the union without widening this trigger  -> production INSERT failures.
--   * Widen this trigger without cause               -> the approval gate reopens.
--
-- WHAT THIS DELIBERATELY DOES NOT DO, so the omissions are decisions on the record:
--   1. It does not check that an inserted row is REACHABLE in the transition graph.
--      A row born at 'passed_filters' has skipped 'discovered' and 'deduped', and
--      that is intended — scout-ats/index.ts states the design: "The row is BORN at
--      its verdict rather than inserted at 'discovered' and then transitioned."
--   2. It does not write an application_events witness for inserts. The UPDATE path
--      has one via log_status_change(); inserts do not, so a row's history begins at
--      its first transition rather than at its creation. Worth closing later; it is
--      an observability gap, not a safety one, and bundling it here would widen a
--      security fix into a schema change.
-- =============================================================================
