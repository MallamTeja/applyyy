# applyy — Schema Contract

**Owner:** the schema stream (`supabase/migrations/**`, `packages/shared-types/**`).
**Audience:** the Edge Functions, web, and worker streams.
**Purpose:** build against the database without asking the schema owner a question.

This document explains the *reasoning*. The *rules* are the migrations and
`src/status-flow.ts`; where this file and the database disagree, the database is right
and this file is a bug.

---

## 1. What exists

Seven migrations in `supabase/migrations/`, applied in filename order:

| File | Contents |
|---|---|
| `…234500_enums.sql` | 15 enum types |
| `…234600_helpers.sql` | `applyy_internal` schema, `pacific_today()`, shared trigger functions |
| `…234700_core_tables.sql` | `system_settings`, `master_profiles`, `jobs`, `applications` |
| `…234800_supporting_tables.sql` | the other ten tables |
| `…234900_status_transition_guard.sql` | the transition table, its seed, and the guard trigger |
| `…235000_rls_policies.sql` | every RLS policy |
| `…235100_queue_and_pool_functions.sql` | the seven RPCs |

**15 physical tables: 14 domain + 1 config.** The config table is
`application_status_transitions`, which holds rules rather than user data.

**Nothing has been applied to the hosted project.** These are files on disk.
`supabase link` and `supabase db push` are gated on Teja's explicit approval.

---

## 2. Import surface

```ts
import { APPLICATION_STATUSES, canTransition, type ApplicationRow } from '@applyy/shared-types';
```

One entry point. Never deep-import — the internal file layout is not contract.

Constraints this package meets, and that anything importing it must also meet:
pure ESM; relative specifiers carry an explicit `.ts` extension (there is **no build
step** — Node, Deno and Vite all consume the source); erasable-syntax-only TypeScript.

**Never turn a `const` tuple into a TS `enum` here.** A TS `enum` is not erasable
syntax: it runs fine under Deno and throws at parse under Node v24. The failure would
appear only in the worker, only at runtime, only in CI — the worst possible shape.

---

## 3. The tables

### `system_settings` — one row per user. **Every agent reads this first.**

| Column | Why it matters |
|---|---|
| `system_enabled` | **The kill switch. Defaults FALSE.** A fresh deploy cannot start submitting. |
| `dry_run` | **Defaults TRUE.** Forms filled and screenshotted, nothing submitted. |
| `gemini_daily_call_budget` | Nullable. **NULL = uncapped.** The only number in the schema permitted to stop work. |
| `gemini_calls_today` / `gemini_budget_date` | Self-resetting counter, **dated in US/Pacific** (§8.4). |
| `max_applications_per_company_per_week` | Default 2. The knob only — the count is derived by query. |
| `max_applications_per_day`, `freshness_window_days`, `claim_lease_seconds` | Operating limits. |

You do not need to check `system_enabled` yourself before claiming work —
`claim_applications()` and `claim_gemini_key()` check it internally and return nothing
when it is off. Safety that depends on nine callers remembering is not safety.

### `master_profiles` — versioned, **immutable**

Editing inserts version N+1. Old versions never change. `version` is assigned by a
trigger; never supply it. There is no `MasterProfileUpdate` type because there is no
legal update.

Immutability is enforced **twice**: an RLS policy granting no UPDATE/DELETE, *and* a
trigger that raises. The policy covers the dashboard and Edge Functions; the trigger
covers a service-role key and a human in the SQL editor, which RLS does not. Either
alone would be a false sense of safety.

### `jobs` — one posting per user, deduped across sources

`UNIQUE(user_id, fingerprint)`. One posting found on Naukri *and* LinkedIn *and*
Greenhouse is **one row** with three entries in `source_refs`.

- `apply_url` + `ats_provider` are the **canonical submit target**, decided once at
  normalize time. This is what makes "a LinkedIn sighting never becomes a submit path"
  structurally true rather than a convention the worker is trusted to follow — and
  LinkedIn matters because auto-apply there gets accounts restricted.
- `posted_at` is **NOT NULL**. Absence is carried by `posted_at_source`, never by a
  null date.
- `disappeared_at` / `repost_count` carry the reposted-job signal: a job that vanished
  and came back means they are still hiring and the last batch did not work out — a
  *stronger* signal than a fresh posting.

### `applications` — **this table is the queue**

`UNIQUE(user_id, job_id)` is constraint #7 as a database constraint. A code check
would be bypassed by a race between two GitHub Actions runs; the database refuses.

`(user_id, master_version)` is a **composite foreign key** into
`master_profiles(user_id, version)`. Together with the immutability triggers, this
makes resume pinning a property of the schema: an application cannot reference a
version that does not exist, and the version it references can never change.

- `tailored_profile` holds a **`ResolvedResume`** — see §5.
- `tailor_refs` holds the Tailor's raw ref output, kept for the Auditor's trace and for
  the injection regression suite.
- `previous_status` is **informational only. Never branch on it.** See §8.2.
- `block_reason` + `block_detail` say *why* a row is parked at `blocked_needs_human`.

### `company_watchlist` — and the cold-start guard

The bug this table fixes: the natural fallback for an unknown posting date is
`first_seen_at` — if you poll daily, anything never seen must be new. Sound in steady
state, **wrong on day one of any new board**, when the whole back catalogue arrives
with `first_seen_at = today` and eighty stale postings all look three days old.

`first_seen_at_is_trustworthy` is a **generated column** (`poll_count >= 1`). Generated
rather than computed by each caller so the answer is already on the row — there is
nothing for a peer to forget to work out. When it is false, store everything from that
board as `posted_at_source = 'unknown'`.

### The rest

`answer_bank` (`needs_human` is constraint #4 made concrete), `application_events`
(append-only, same double enforcement as `master_profiles`), `agent_runs`,
`gemini_key_state`, `search_preferences`, `filter_rules`, `company_blocklist`,
`email_events`, `matcher_eval_cases`.

**`matcher_eval_cases` is the labelling surface, not the test fixture.** The CI gate
has no database, so the harness must export these rows to a JSON fixture committed to
the repo. Fixtures in git are diffable and reviewable in a pull request; fixtures in a
database are neither. *A table alone does not satisfy that item.*

---

## 4. The status flow

```
discovered → deduped → passed_filters → scored → tailored
  → audit_clean | audit_flagged → awaiting_approval → approved
  → applying → applied → employer_screening → oa_pending → interview → offer | rejected

off-ramps: dropped_filter · dropped_duplicate · blocked_needs_human
           needs_verification · failed
```

Two values differ from PROJECT_PLAN §9, renamed before any code existed:
`screened` → **`passed_filters`** (we filtered it, pre-apply) and
`screening` → **`employer_screening`** (they are reviewing you, post-apply).

### The structural payoff — the reason the guard table earns its keep

> `awaiting_approval → approved` is the only edge into `approved`, and
> `approved → applying` is the only edge into `applying` in the entire graph.
> **Constraint #15 is therefore unreachable-by-construction rather than
> enforced-by-review.**

No bug in any agent can skip the human approval gate, because there is no other door.

### The human-only lanes

These carry the anti-double-submit guarantee, and no reader will infer them from the
column types:

| Edge | Why human-only |
|---|---|
| `needs_verification → approved` | The only way a row re-enters the submit path. **A machine must never decide that a possibly-submitted application was not submitted.** |
| `audit_flagged → tailored` | An automated retry loop here would burn quota rewriting the same flagged bullet. |
| `failed → needs_verification` | The only edge out of `failed`, and it leads to verification rather than to the queue. |
| `awaiting_approval → approved` | Constraint #15. |

`applying → needs_verification` is `['sweeper', 'human']` — **not** sweeper-only.
`human` is present deliberately: §14 says scheduled jobs die silently, so a
sweeper-only edge would leave a stuck row unresolvable by the one person who must
resolve it.

**Two different questions, easy to conflate:** *human-only* edges
(`allowedAgents.length === 1 && [0] === 'human'`) number **11**; *human-permitted*
edges (`allowedAgents.includes('human')`) number **31**. A UI completeness check wants
the **wider** predicate — otherwise it reports full coverage while the manual control
for a safety-critical shared edge is missing.

`allowedAgents` is consumed by the frontend as well as by the trigger. Adding an edge
without a matching UI control should surface as a visible defect, not as rows silently
stalling.

### There are no backward edges

PROJECT_PLAN §6 says an agent that finds every Gemini key cooling "returns the row to
its prior status". **That rollback does not exist, and must not be built.** Claiming
sets `claimed_by` / `claim_expires_at` and does *not* advance `status`, so a row being
worked on never left the status it was in. An agent that cannot get a key calls
`release_application_claim()`; the row is picked up next run.

Deleting the rollback rather than authorising it means the graph has no backward path
for a bug to wander down.

---

## 5. The anti-fabrication types — and what §11 now means

PROJECT_PLAN §11's worked example shows a skills line gaining `PostgreSQL` and
`Docker` that the master never contained. **That example is now structurally
inexpressible.** `TailoredSkill` is `{ ref: NodeId }` with *no text field*: there is
nowhere to type "Docker" that is not an id, and an id absent from the pinned master
fails the whole tailoring before the Auditor runs.

Read §11 as the design brief that *motivated* this schema, not as a live scenario.

**The two fabrication vectors that survive**, and where the Auditor should aim:

1. `TailoredBullet.text` — a real `ref` with a lying rewording. The ref proves a real
   bullet is being reworded; it does not prove the rewording is faithful.
2. `TailoredSummary.text` — free prose. Prose cannot be ref-constrained the way a
   bullet can, and it is exactly where a model writes *"during my time leading a team
   of five…"* about something that never happened. **This is the weakest point in the
   design.** Mitigations: `refs` must be non-empty, and the Auditor gates summaries
   even though §18.8 exempts cover letters from human approval.

Both surface as `AuditFinding { path, claim, reason, confidence }`.

### Three types, three stages, one direction

```
MasterProfile          human-maintained truth; versioned, immutable
   │ Tailor (Gemini) — may only select and reword; emits refs, never prose nodes
   ▼
TailoredProfile        refs + rewordings. Cannot introduce a fact.
   │ validator (typed code, no LLM) — resolves every ref against the PINNED version
   ▼
ResolvedResume         fully denormalised. Frozen onto the application. THE RENDER INPUT.
```

`renderResumeHtml(resume: ResolvedResume): string` — one parameter, no master, no
lookups. The template *cannot* resolve a ref even by accident, which is what makes
"what you approved is byte-for-byte what gets sent" a property of the types.

**`ref` is non-optional everywhere. Keep it that way** — an optional `ref` would
quietly reopen the hole while every test still passed.

### Two rendering contracts

- **`DisplayDate`** — every rendered date is a pre-formatted string decided upstream.
  The renderer does zero date maths. `Intl`/`toLocaleDateString` make output a function
  of host timezone and ICU build, so the Windows preview and the Ubuntu PDF could
  differ while every test passed on one machine — breaking both the approval guarantee
  and `tailored_hash` as a cache key.
- **`DocumentOrdered<T> = readonly T[]`** — array order *is* document order, and it is
  a tailoring decision. **Nothing may sort.** Sorting would make two different
  tailorings render identically and collide on `tailored_hash`, silently serving the
  wrong cached PDF. `readonly` makes a stray `.sort()` a compile error.

---

## 6. How to write an agent

```ts
// 1. Open a run BEFORE doing work, so a crash leaves a visible stuck row.
//    A missing row and a successful run look identical.
const { data: run } = await sb.from('agent_runs').insert({ agent: 'matcher' }).select().single();

// 2. Sweep first. Cheap, and it makes a crashed peer self-heal.
await sb.rpc('sweep_stale_claims');

// 3. Claim. Returns [] when the kill switch is off — that is not an error.
const { data: rows } = await sb.rpc('claim_applications', {
  p_status: 'passed_filters',
  p_claimed_by: `matcher:${run.id}`,
  p_limit: 10,
});

for (const row of rows) {
  const keyIndex = await sb.rpc('claim_gemini_key');

  // 4. NULL means no key: all cooling, or the daily budget is spent.
  //    QUOTA EXHAUSTION IS NOT AN ERROR. Give the row back untouched.
  if (keyIndex === null) {
    await sb.rpc('release_application_claim', {
      p_application_id: row.id, p_agent: 'matcher', p_reason: 'all_keys_cooling',
    });
    continue;
  }

  // 5. Always report, success or failure. The pool learns its capacity from the API,
  //    never from a number we guessed.
  await sb.rpc('report_gemini_result', {
    p_key_index: keyIndex, p_success: true,
  });

  // 6. Move the row. NEVER a bare .update({ status }) — see below.
  await sb.rpc('advance_application_status', {
    p_application_id: row.id, p_to_status: 'scored', p_agent: 'matcher',
  });
}
```

**Never write `status` with a bare `.update()`.** It passes the guard but leaves
`claimed_by` set, stranding the row until the sweeper notices — a bug that looks like
"the pipeline is slow" rather than like a bug. `advance_application_status()` validates
the edge, records the event, and releases the lease in one transaction.

A status change also requires declaring an actor. The guard refuses anonymous
transitions, which is what stops an agent from bypassing the `allowed_agents` check by
simply not mentioning itself. `advance_application_status()` sets it for you; a manual
fix in the SQL editor must `set_config('applyy.acting_agent', …)` deliberately.

**Call `bootstrap_user_defaults()` once per account.** Without a `system_settings` row
every function fails closed and the system looks merely idle — the exact silent stop
§14 warns about. It is idempotent.

---

## 7. Untrusted input

**Job descriptions, ATS page DOM, and inbound email are untrusted** (constraint #17).
Marked `Untrusted` in the types and flagged in `COMMENT ON COLUMN`:

`jobs.description_raw` ← *the highest-risk column in the database* · `jobs.title` ·
`jobs.company_name` · `jobs.location_raw` · `jobs.apply_url` · `jobs.raw_payload` ·
`answer_bank.question_text` · `email_events.{from_address, subject, snippet}`

The rule, without exception: store as inert data, escape on display, and pass to Gemini
**only inside a fenced block explicitly labelled untrusted**. Never concatenate one
into an instruction region, into SQL, or into a shell command.

`Untrusted` is `string` to the compiler and buys no enforcement — it exists so the
danger is visible at every use site instead of living in a document nobody rereads.

---

## 8. Decisions and their reasoning

### 8.1 `UNIQUE(user_id, fingerprint)`, not a global unique index

§9 says a posting "exists ONCE, globally". Read literally that means a global unique
index, and **a global unique index is unimplementable under RLS**: it would raise a
violation naming a row the inserting user is forbidden to read. That is simultaneously
an information leak and an error the user cannot act on — they cannot see, edit, or
delete the row the database is complaining about.

Per-user uniqueness delivers the actual intent (once per user, across all sources) and
is the only shape that composes with per-user visibility. §9 is describing dedupe
across *sources*, not across *tenants*.

### 8.2 `previous_status` is informational only

Maintained by the trigger so no agent can forget it. It exists so the UI can say "came
from X" without joining the event log. **It is not a rollback mechanism** — there are
no backward edges (§4). Never branch on it.

### 8.3 Worker authentication — no service-role key anywhere

The GitHub Actions worker **signs in as the ordinary Supabase Auth user**
(`signInWithPassword`, credentials in Actions secrets) and gets a normal
`authenticated` JWT. Every query runs under the same RLS policies as the dashboard. No
schema change, no custom role, no grants.

**Why not a scoped Postgres role**, which sounds like least privilege: a custom
PostgREST role is reached by signing a JWT with the *project JWT secret*, so the worker
would have to hold that secret — and anyone holding it can mint a token claiming
`role: service_role`. The scoped role would read as least privilege in the migration
while being a god-mode key in the runner. **That is the worst kind of control: one that
reads as safe.**

**Why not the service-role key:** blast radii are not close. Service-role key leaked =
every table, RLS bypassed, and rotating it means redeploying every consumer. App-user
password leaked = one account's data, revocable in the dashboard in seconds, and the
ceiling is what that user could already do through the web UI.

Under this design, *"the worker cannot do anything the human could not do from the
dashboard"* is literally true — worth having as a property on the one component that
touches real employers.

*Setup, pending and gated on Teja: create the worker's auth user; set
`APPLYY_WORKER_EMAIL` / `APPLYY_WORKER_PASSWORD` as Actions secrets.*

### 8.4 Quota counters are dated in **US/Pacific**

`system_settings.gemini_budget_date` and `gemini_key_state.quota_date` both default to
`public.pacific_today()`.

Gemini's RPD resets at Pacific midnight; Teja is in IST. An IST-dated counter would
reset **five and a half hours after** the quota it tracks, so the circuit breaker would
open during precisely the window it exists to protect — once a day, at night. It would
look like flaky quota rather than a bug. **Do not "fix" this to `current_date`.**

### 8.5 No hardcoded quota number, anywhere

`gemini_key_state.requests_today` is **observability only, never a gate** — it
deliberately has no ceiling and no CHECK. Google no longer publishes free-tier limits,
with credible reports of Flash being cut 250 → 20 RPD, so any constant is a guess that
breaks silently the day they change it. The pool is purely reactive: use a key until it
429s, believe its `retry_after`, move on.

The *only* gate is `system_settings.gemini_daily_call_budget`, which a human set.
Nothing in the schema assumes a key count — `gemini_key_state` is keyed on `key_index`,
so six keys and fifteen keys are the same schema.

### 8.6 A reason code, not a new status

Constraint #4 ("never guess when a question cannot be answered") is carried by
`block_reason = 'unanswerable_question'` on a row parked at `blocked_needs_human`, with
`block_detail.question_key` naming the missing answer — **not** by a new status.

An unanswerable question and a captcha need the identical operator action ("a human
takes it from here"), and a status that shares an existing handler grows the graph
without adding meaning. The rule of thumb: **add a STATE when the handler differs; add
a REASON when only the explanation differs.**

`block_reason` is an enum (`captcha`, `mfa`, `unanswerable_question`,
`unsupported_form`, `login_required`, `submission_unconfirmed`, `other`) rather than
free text, because the UI branches on it and free text is how you get three spellings
of one reason. It is **kept** after the block is resolved — that history is what the
health page wants.

### 8.7 `posted_at_source = 'unknown'` has exactly one cause

**It means "this board is not yet trusted". It NEVER means a parse failure.** Every
degraded input — malformed string, epoch 0, missing field, unparseable prose — resolves
to `derived` via `first_seen_at`.

No column type can express that, and a reader who assumes `unknown` signals a bad parse
will write the wrong filter.

`unknown` **fails** the staleness check rather than bypassing it. That policy is a
setting, not a buried constant: `filter_rules.config.treat_unknown_posted_at_as_fresh`,
default `false`. On a board's first poll only `derived` degrades to `unknown` — a
genuine `exact` date from Lever or Ashby stays `exact`, because the cold-start bug lives
entirely in the `first_seen_at` fallback path.

### 8.8 RLS conventions

Every policy is `to authenticated` and uses `(select auth.uid())`, not bare
`auth.uid()`. The subquery lets Postgres evaluate it **once per statement** as an
InitPlan instead of once per row — on a thousand-row scan, one call instead of a
thousand. **Do not simplify the parentheses away.**

Policies use `for all` with **both** `using` and `with check`. `using` filters what you
can see; `with check` validates what you write. A policy with only `using` would let you
update a row you can see into a row belonging to someone else.

The RPCs are `security invoker`, never `security definer` — they must run with the
caller's RLS in force. A definer function reachable over the REST API would make every
caller act as the owner and RLS would stop meaning anything. The only definer functions
are the two triggers, which are not API-reachable.

---

## 9. Changing the schema

An enum lives in **two** places. Change one and you must change the other:

- `supabase/migrations/…_enums.sql`
- `packages/shared-types/src/enums.ts`

Same for the status graph: `…_status_transition_guard.sql` (the rule) and
`src/status-flow.ts` (the mirror the UI reads).

There is no codegen enforcing this. This checklist is the enforcement.

Adding a status transition also means adding a UI control for it if any human is in
`allowed_agents` — see §4.

---

## 10. Not done

- **Nothing is applied to the hosted project.** Migrations are files on disk. Gated on
  Teja.
- **Not yet validated against a live Postgres.** `supabase db reset` needs Docker.
- `matcher_eval_cases` is empty — ~20 labels are Teja's to write.
- The JSON fixture export + CI gate for the eval set belong to the Edge Functions
  stream, not to this schema.
- Generated types (`supabase gen types typescript`) should eventually be produced as a
  **check** on `src/tables.ts`, not a replacement: this file carries the comments, the
  generated one carries the proof.

### Deliberately not built

**A/B resume testing** (§17, second tier) is fenced as unapproved. It would mean two
competing master lineages, which is a schema change rather than a feature —
`master_profiles` is single-lineage versioned-immutable, `UNIQUE(user_id, version)`.

If it is ever approved, the change is additive and cheap: a `lineage` column plus
`UNIQUE(user_id, lineage, version)`, and `applications` gains a lineage reference
alongside `master_version`. **No decision here makes that expensive later** — recorded
so nobody has to re-derive it.
