-- WHY THIS MIGRATION EXISTS (W41, 2026-11-02).
--
-- Teja asked (2026-11-02 21:14 IST): log "both the call count and the token counts" of every
-- Gemini call, so "how many calls / tokens, per agent, per key, per day" has an answer.
-- Measured that evening, before this table:
--   * tokens were recorded nowhere: 0 'llm_call' events in application_events over 11 days;
--   * agent_runs.gemini_calls is filled by 3 of the 9 Gemini agents (matcher, referral,
--     cover-letter), 127 calls against ~333 in gemini_key_state.requests_today: ~60% invisible;
--   * requests_today resets every Pacific day, so the pool keeps no history at all.
--
-- One row per ATTEMPT, written by _shared/gemini/client.ts from inside the failover loop, right
-- after the attempt the claim_gemini_key() call counted. So count(*) here is the number the quota
-- counts, and a 429 or a timeout is a row too (it spent a request).
--
-- WHY NOT NEW PARAMETERS ON report_gemini_result(): the client skips that RPC on two attempt
-- exits (404, an unparseable 200), so it would undercount; adding parameters needs DROP + CREATE,
-- because a second overload makes PostgREST refuse the deployed 4-argument callers as ambiguous;
-- and an insert failing inside it would roll back the cooldown write the key pool depends on.
--
-- DEPLOY ORDER: this migration FIRST, then the 9 Gemini functions. Code deployed before it only
-- loses rows (the client logs a console.warn and carries on); it never fails a Gemini call.
--
-- Not re-runnable as written (bare create table / create policy): run once.
--
-- RENAMED 2026-11-04 from 20261102213000_gemini_usage_log.sql, never applied under that name. The
-- orchestrator applies 20261104193000 first; a 2026-11-02 file sorting before an applied migration
-- would make `db push` demand --include-all, so the timestamp moved past it.

-- The log. Shape-checked columns, so a malformed write is refused rather than stored (CLAUDE.md §6).
create table public.gemini_usage (
  -- bigint identity, not uuid: append-only, read in time order, and a monotonic key keeps
  -- inserts at the end of the index (same reasoning as application_events).
  id bigint generated always as identity primary key,
  -- Defaulted from the caller's session so the client never sends it; RLS below refuses any
  -- other value. Cascade like every per-user table: the history leaves with the user.
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  -- When the attempt finished. Defaulted, so the client does not choose it.
  created_at timestamptz not null default now(),
  -- The edge function that called, from Deno.mainModule ("matcher", "tailor", ...). "unknown"
  -- when the entrypoint path did not match: an honest gap, never a guessed name.
  agent text not null check (agent ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  -- The pool key spent; same domain as gemini_key_state.key_index. No foreign key on purpose:
  -- a key row may be removed later, and its history must not go with it.
  key_index smallint not null check (key_index > 0),
  -- The model id in the attempt's URL (the fallback after a 503 switch). NULL only for a direct
  -- caller of the failover loop that named no model; generateGeminiContent always names one.
  model text check (model is null or char_length(model) between 1 and 100),
  -- How the attempt ended, a closed vocabulary: ok, invalid_json, timeout, network_error, or the
  -- 3-digit HTTP status ("429", "503"). The regex makes any other label unrepresentable.
  outcome text not null check (outcome ~ '^(ok|invalid_json|timeout|network_error|[1-5][0-9]{2})$'),
  -- Google's usageMetadata, copied as sent. NULL means Google sent no usable count (every failed
  -- attempt, and any success without one), NEVER zero: a 0 would claim "Google said none".
  -- Input tokens (promptTokenCount), cached ones included.
  prompt_tokens integer check (prompt_tokens >= 0),
  -- Visible output tokens (candidatesTokenCount).
  output_tokens integer check (output_tokens >= 0),
  -- Thinking tokens (thoughtsTokenCount), billed as output but never shown.
  thoughts_tokens integer check (thoughts_tokens >= 0),
  -- Google's own total (totalTokenCount), stored rather than summed so nothing we do not read is lost.
  total_tokens integer check (total_tokens >= 0)
);

-- Per-user like every table here.
alter table public.gemini_usage enable row level security;
-- FORCE binds the table owner too, so only a BYPASSRLS role (postgres) skips the policies.
alter table public.gemini_usage force row level security;

-- APPEND-ONLY: the trigger function application_events uses. It raises for every role, the
-- service role included, so a usage history cannot be rewritten after the fact.
create trigger forbid_update
  before update on public.gemini_usage
  for each row execute function applyy_internal.forbid_mutation();

-- Same for delete. A correction is a new row, never an edit (CLAUDE.md §7).
create trigger forbid_delete
  before delete on public.gemini_usage
  for each row execute function applyy_internal.forbid_mutation();

-- The only read this table gets: one user's rows over the last N days (docs/tooling/2026-11-02-gemini-usage.md).
create index gemini_usage_user_created_idx on public.gemini_usage (user_id, created_at);

-- Supabase's default privileges grant ALL on a new public table to anon AND authenticated,
-- TRUNCATE included, which skips RLS and row triggers (lesson of 20261101140000). Start from none.
revoke all on public.gemini_usage from anon, authenticated;
-- Exactly the two verbs used: the edge functions append, a reader selects.
grant select, insert on public.gemini_usage to authenticated;

-- Read your own rows only.
create policy "read own gemini usage" on public.gemini_usage
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- Append your own rows only. No agent-key requirement, deliberately: this is self-reported
-- bookkeeping that gates nothing, so a forged row could only mislead its own author, and a
-- missing header must not silently drop the very calls this table exists to count.
create policy "append own gemini usage" on public.gemini_usage
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

-- Verify after applying:
--   select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.gemini_usage'::regclass;  -- t, t
--   select r, v, has_table_privilege(r, 'public.gemini_usage', v)
--     from unnest(array['anon', 'authenticated']) r, unnest(array['select', 'insert', 'update', 'delete', 'truncate']) v;
--     -- true ONLY for authenticated select and authenticated insert (2 of 10)
--   select tgname from pg_trigger where tgrelid = 'public.gemini_usage'::regclass and not tgisinternal;  -- forbid_delete, forbid_update
--   select polname, polcmd from pg_policy where polrelid = 'public.gemini_usage'::regclass;  -- 2 rows: r, a
