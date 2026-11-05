-- WHY THIS MIGRATION EXISTS (2026-11-05, Teja ruled 22:55 IST).
--
-- Teja answers each blocking required form question ONCE, on the Answer bank page. Until now
-- the only persisted trace of a blocker was application_events.detail.unanswered: a list of
-- LABELS on the approved -> blocked_needs_human event (worker/src/apply-one.ts). No normalised
-- key (so the page could not save an answer the planner would ever meet), no reason (so it
-- could not tell "never seen" from "only a planner rule can answer this"), no control kind
-- and no options. The read-only submit-readiness sweep of 2026-11-05 measured 98 distinct
-- required unanswered keys over 44 rows, none of them visible to Teja anywhere.
--
-- One row per (user, normalised question key): the SAME question on ten forms is one card
-- that "blocks 10 applications". The worker writes through record_unanswered_questions()
-- below whenever planFill refuses a required field; the page reads the table and saves the
-- answer into answer_bank through the normal browser path (no agent key), so the existing
-- trigger answer_bank_stamp_attestation stamps attested_by_human = true.
--
-- WHAT IT DOES NOT DO: decide anything. A row here is a report, never an answer. The planner
-- still reads only answer_bank. A stale row (the job closed, the answer saved) is harmless:
-- the page hides keys answer_bank already holds and counts only applications still open.
--
-- DEPLOY ORDER: this migration FIRST, then the worker hook (bf) that calls the RPC. A worker
-- that calls it before it exists gets a PostgREST 404, which the hook logs and ignores.
--
-- Not re-runnable as written (bare create table / create policy): run once.

-- The report table. Shape-checked columns, so a malformed write is refused, not stored (CLAUDE.md §6).
create table public.unanswered_questions (
  -- Defaulted from the caller's session so no client sends it; RLS below refuses any other value.
  -- Cascade like every per-user table: the questions leave with the user.
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  -- normaliseKey(label) as the worker computes it (worker/src/profile-answers.ts): the exact
  -- string the planner looks answer_bank up by, so saving under it is what unblocks the form.
  -- Lowercase tokens joined by "_"; the regex makes a raw label unrepresentable here. Capped like
  -- question_text (a key is never longer than its label): real Canonical keys run to 429 chars.
  question_key text not null check (question_key ~ '^[a-z0-9]+(_[a-z0-9]+)*$' and char_length(question_key) <= 2000),
  -- UNTRUSTED: the label as scraped from the ATS page. Display escaped; never interpolate.
  question_text text not null check (char_length(question_text) between 1 and 2000),
  -- Why the planner refused, from FillBlocker['reason'] (worker/src/plan-fill.ts). Closed, so the
  -- page's "answerable here" vs "needs a planner rule" split can never meet an unknown value.
  reason text not null check (reason in (
    'no_answer', 'awaiting_human_answer', 'human_only', 'invalid_answer', 'ambiguous_answer_key', 'no_matching_option'
  )),
  -- The extracted control kind (FormField['kind'], worker/src/extract-fields.ts). Kept raw: the
  -- page maps it to an input, and a checkbox is never fillable at all, which the page must know.
  field_kind text not null check (field_kind in (
    'text', 'email', 'tel', 'file', 'textarea', 'combobox', 'native_select', 'radio_group', 'checkbox'
  )),
  -- The form's own option labels when the extractor could read them; NULL means "unknown"
  -- (react-select options are never captured yet), which is a different fact from "no options".
  options jsonb check (options is null or jsonb_typeof(options) = 'array'),
  -- Every application this question has blocked. The page counts only those still open.
  blocked_application_ids uuid[] not null default '{}',
  -- The last time any form asked it: the page sorts by it, and an old row is visibly old.
  last_seen_at timestamptz not null default now(),
  -- One card per question per user; also the upsert's conflict target.
  primary key (user_id, question_key)
);

comment on table public.unanswered_questions is
  'Required form questions the worker planner refused, one row per normalised key; a report for the Answer bank page, never an answer source. See 20261105230000.';

-- RLS on, like every table here.
alter table public.unanswered_questions enable row level security;

-- Owner-only, every command: the page reads and dismisses its own rows; the RPC (security
-- invoker) upserts as the same signed-in user. Same shape as answer_bank's "own answers".
create policy "own unanswered questions" on public.unanswered_questions
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- anon never reaches it; authenticated gets exactly what the policy then narrows.
revoke all on public.unanswered_questions from anon;
-- Explicit grants, so the table does not depend on the default privileges 20261105203000 changes.
grant select, insert, update, delete on public.unanswered_questions to authenticated;

-- The worker's one write path: record every refused required field of one application.
--
-- p_items is a JSON array of {key, label, reason, kind, options?}. Every item is shape-checked
-- and the WHOLE call is refused on the first bad one (22023), so a half-understood payload never
-- lands as rows. SECURITY INVOKER: it runs as the caller, so RLS decides ownership, and the
-- application must be one the caller can see (otherwise 42501, never a row for someone else's id).
-- Not agent-key gated on purpose: it writes no status and no answer, only a report.
-- Returns the number of questions recorded.
create function public.record_unanswered_questions(p_application_id uuid, p_items jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- One element of p_items while looping.
  v_item jsonb;
  -- Rows written, returned so the caller can log a count instead of trusting silence.
  v_count integer := 0;
begin
  -- The payload must be an array; an object or null is a caller bug, not "nothing to record".
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'record_unanswered_questions: p_items must be a JSON array' using errcode = '22023';
  end if;
  -- The application must exist AND be visible to this user under RLS; else refuse.
  if not exists (select 1 from public.applications a where a.id = p_application_id) then
    raise exception 'record_unanswered_questions: application % not found for this user', p_application_id using errcode = '42501';
  end if;
  -- Validate every item before writing any, so the call is all-or-nothing in intent too.
  for v_item in select value from jsonb_array_elements(p_items) loop
    -- Each item is an object with string key/label/reason/kind; options absent, null or an array.
    if jsonb_typeof(v_item) <> 'object'
      or jsonb_typeof(v_item -> 'key') is distinct from 'string'
      or jsonb_typeof(v_item -> 'label') is distinct from 'string'
      or jsonb_typeof(v_item -> 'reason') is distinct from 'string'
      or jsonb_typeof(v_item -> 'kind') is distinct from 'string'
      or (v_item ? 'options' and jsonb_typeof(v_item -> 'options') not in ('array', 'null')) then
      raise exception 'record_unanswered_questions: malformed item %', v_item using errcode = '22023';
    end if;
  end loop;
  -- Write: one upsert per item. The column CHECKs refuse a bad key, reason or kind (23514).
  for v_item in select value from jsonb_array_elements(p_items) loop
    insert into public.unanswered_questions as q
      (question_key, question_text, reason, field_kind, options, blocked_application_ids, last_seen_at)
    values (
      v_item ->> 'key',
      v_item ->> 'label',
      v_item ->> 'reason',
      v_item ->> 'kind',
      -- JSON null and an absent key both mean "options unknown".
      nullif(v_item -> 'options', 'null'::jsonb),
      array[p_application_id],
      now()
    )
    on conflict (user_id, question_key) do update set
      -- The latest form's wording, reason and kind win: they describe the question as asked now.
      question_text = excluded.question_text,
      reason = excluded.reason,
      field_kind = excluded.field_kind,
      -- Known options are never erased by a later form that could not read them.
      options = coalesce(excluded.options, q.options),
      -- Set union: re-recording the same application does not count it twice.
      blocked_application_ids = case
        when p_application_id = any (q.blocked_application_ids) then q.blocked_application_ids
        else q.blocked_application_ids || p_application_id
      end,
      last_seen_at = now();
    -- Counted per item written.
    v_count := v_count + 1;
  end loop;
  -- How many questions this call recorded.
  return v_count;
end;
$$;

comment on function public.record_unanswered_questions(uuid, jsonb) is
  'Worker hook: upserts the planner''s refused required fields for one application into unanswered_questions. Security invoker; all-or-nothing shape check. See 20261105230000.';

-- Only signed-in callers (browser, edge, worker all run as `authenticated`); never anon/public.
revoke execute on function public.record_unanswered_questions(uuid, jsonb) from public, anon;
-- The worker calls it as the app user.
grant execute on function public.record_unanswered_questions(uuid, jsonb) to authenticated;
