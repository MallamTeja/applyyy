-- =============================================================================
-- applyy — 05: row level security policies.
--
-- Single user today. RLS anyway, from day one, because it is free to add now and
-- painful to retrofit — and because it is what lets an Edge Function talk to the
-- database with a SESSION TOKEN instead of a god-mode service-role key. The frontend
-- gets the anon key and nothing else; the worker signs in as an ordinary auth user.
-- Every one of those only works if RLS is doing the isolation.
--
-- THREE CONVENTIONS, USED ON EVERY POLICY BELOW:
--
-- 1. `(select auth.uid())`, NOT bare `auth.uid()`.
--    Wrapping it in a subquery lets Postgres evaluate it ONCE per statement as an
--    InitPlan instead of once per row. On a thousand-row scan that is the difference
--    between one function call and a thousand. This is a documented Supabase
--    performance pattern, not a style preference — do not "simplify" the parens away.
--
-- 2. `to authenticated`, always.
--    Without a role clause the policy is also evaluated for `anon`, doing work to
--    reach a foregone conclusion. Naming the role means anonymous requests are
--    rejected before any predicate runs.
--
-- 3. `for all` where every verb has the same rule, with BOTH `using` and `with check`.
--    `using` filters what you can SEE and touch; `with check` validates what you
--    WRITE. A policy with only `using` would let you update a row you can see into a
--    row belonging to someone else — visible on the way in, gone on the way out.
--
-- The two append-only tables break convention 3 deliberately, and that is the point.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- system_settings — the control panel, including the kill switch.
-- -----------------------------------------------------------------------------
create policy "own settings" on public.system_settings
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- -----------------------------------------------------------------------------
-- master_profiles — IMMUTABILITY, HALF TWO OF TWO.
--
-- SELECT and INSERT policies exist. There is NO update policy and NO delete policy,
-- so under RLS those verbs match nothing and affect zero rows. That covers the
-- dashboard and the Edge Functions.
--
-- It does NOT cover a service-role key, which bypasses RLS entirely. That is exactly
-- why migration 02 also puts a trigger on this table: the trigger raises for everyone,
-- including the table owner. Two mechanisms, two different threat models, and neither
-- one alone would be honest.
-- -----------------------------------------------------------------------------
create policy "read own profiles" on public.master_profiles
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- Insert is how you edit: a new version, never a mutation of an old one.
create policy "insert own profile version" on public.master_profiles
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

-- -----------------------------------------------------------------------------
-- jobs — postings, isolated per user. The per-user fingerprint UNIQUE in migration
-- 02 exists precisely so this isolation and that constraint can coexist.
-- -----------------------------------------------------------------------------
create policy "own jobs" on public.jobs
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- -----------------------------------------------------------------------------
-- applications — the queue.
--
-- Note what RLS does NOT do here: it does not stop you writing a status directly.
-- That is the transition guard's job, and the two are complementary — RLS answers
-- "whose row is this", the guard answers "is this move legal". Conflating them would
-- weaken both.
-- -----------------------------------------------------------------------------
create policy "own applications" on public.applications
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- -----------------------------------------------------------------------------
-- application_events — APPEND-ONLY, HALF TWO OF TWO.
--
-- Same shape and same reasoning as master_profiles: select and insert, no update, no
-- delete, backed by a trigger for the service-role case. An audit log that can be
-- rewritten by the thing it audits is decoration.
-- -----------------------------------------------------------------------------
create policy "read own events" on public.application_events
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- Agents insert notes, errors and llm_call rows directly. Status-change rows come
-- from the trigger, which runs as definer and is not subject to this policy.
create policy "append own events" on public.application_events
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

-- -----------------------------------------------------------------------------
-- agent_runs — the health page's raw data.
-- -----------------------------------------------------------------------------
create policy "own agent runs" on public.agent_runs
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- -----------------------------------------------------------------------------
-- gemini_key_state — pool state.
--
-- Note this is per-user like everything else. The keys themselves live in environment
-- secrets and never touch the database; this table holds only the BOOKKEEPING about
-- them. Nothing here would help an attacker who read it, which is the property you
-- want from a table that several agents write on every call.
-- -----------------------------------------------------------------------------
create policy "own key state" on public.gemini_key_state
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- -----------------------------------------------------------------------------
-- The five settings tables. Identical shape; the settings pages read and write them.
-- -----------------------------------------------------------------------------
create policy "own search preferences" on public.search_preferences
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own filter rules" on public.filter_rules
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own watchlist" on public.company_watchlist
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own blocklist" on public.company_blocklist
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own answers" on public.answer_bank
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- -----------------------------------------------------------------------------
-- email_events — inbound mail. Untrusted content, ordinary ownership.
-- -----------------------------------------------------------------------------
create policy "own email events" on public.email_events
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- -----------------------------------------------------------------------------
-- matcher_eval_cases — the golden eval set's labelling surface.
-- -----------------------------------------------------------------------------
create policy "own eval cases" on public.matcher_eval_cases
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- -----------------------------------------------------------------------------
-- application_status_transitions — GLOBAL CONFIG, READ-ONLY TO EVERYONE.
--
-- `using (true)` because the rules are not secret: every user has the same graph, and
-- the frontend needs to read it to decide which buttons to render.
--
-- There is deliberately NO insert, update or delete policy. The graph is changed by a
-- migration and by nothing else — which is what makes it a rule rather than a setting.
-- -----------------------------------------------------------------------------
create policy "read the graph" on public.application_status_transitions
  for select to authenticated
  using (true);
