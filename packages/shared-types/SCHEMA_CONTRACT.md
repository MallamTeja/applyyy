# applyy — Schema Contract

_Last verified against code: 2026-11-08 (2a9ac31)._

**Owner:** the schema stream (`supabase/migrations/**`, `packages/shared-types/**`).
**Audience:** the Edge Functions, web, and worker streams.
**Purpose:** build against the database without asking the schema owner a question.

This document explains the *reasoning*. The *rules* are the migrations and
`src/status-flow.ts`; where this file and the database disagree, the database is right
and this file is a bug.

---

## 1. What exists

The schema is the migration files in `supabase/migrations/`, applied in filename order.
Do not trust a count in any doc. Regenerate the facts:

| Fact | Command |
|---|---|
| Migration files | `ls supabase/migrations` |
| Migrations applied live | the Supabase MCP `list_migrations`, compared with the list above |
| Tables created | `grep -hoiE 'create table (if not exists )?public\.\w+' supabase/migrations/*.sql` |
| Row types declared | `grep -n 'export interface \w*Row ' packages/shared-types/src/tables.ts` |
| Live tables, and RLS on each | `select relname, relrowsecurity, relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'` |
| Live status edges | `select count(*) from public.application_status_transitions` |

Run a live SELECT with `env -u SUPABASE_ACCESS_TOKEN supabase db query --linked "<select>"`
(repo `CLAUDE.md` §4). The user env var belongs to the wrong account.

**The first seven files are the base schema.** Every later file is a change on top, and
each carries a header saying why it exists.

| File | Contents |
|---|---|
| `20260909234500_enums.sql` | the enum types |
| `20260909234600_helpers.sql` | `applyy_internal` schema, `pacific_today()`, shared trigger functions |
| `20260909234700_core_tables.sql` | `system_settings`, `master_profiles`, `jobs`, `applications` |
| `20260909234800_supporting_tables.sql` | the first set of supporting tables |
| `20260909234900_status_transition_guard.sql` | the transition table, its seed, and the guard trigger |
| `20260909235000_rls_policies.sql` | the first RLS policies |
| `20260909235100_queue_and_pool_functions.sql` | the queue and key-pool RPCs |

**The tables, grouped by job.** Each has a `<Table>Row` type in `src/tables.ts`. The
table-parity test fails if one is missing (§9).

| Group | Tables | Added by |
|---|---|---|
| Control | `system_settings` | base |
| Rules (config, not user data) | `application_status_transitions` | base |
| Resume | `master_profiles` | base |
| Queue | `jobs`, `applications` | base |
| Audit logs (append-only) | `application_events`, `resume_chat_messages`, `gemini_usage` | base, `20261101120000`, `20261104200000` |
| Agents and Gemini pool | `agent_runs`, `gemini_key_state` | base |
| Search settings | `search_preferences`, `filter_rules`, `company_watchlist`, `company_blocklist` | base |
| Answers | `answer_bank`, `unanswered_questions` | base, `20261105230000` |
| Email | `email_events` | base |
| Evaluation | `matcher_eval_cases` | base |
| Phase 3 outputs | `follow_up_nudges`, `skill_gap_reports`, `interview_prep_packs` | `20260918213000` |

Two more tables live in the private `applyy_internal` schema: `agent_key` and
`agent_key_emergency` (`20261008160000`, `20261102210000`). They hold the machine-agent
key state. They are not reachable over the REST API and have no Row type on purpose.

As of 2026-11-08 the live database matched the migrations: 21 public tables, RLS on all
21, 53 status edges (queries above). Re-run the queries; do not quote these numbers.

**The hosted project is live.** Type-level defects in this package are live-system
defects. The link files in `supabase/.temp/` are gitignored, so no project identifier is
committed (constraint #11).

**A lesson from the first local load (2026-09-10).** Getting to a clean load took one fix
worth remembering as a *shape*: a partial index
on `company_blocklist` whose predicate called `now()` was rejected as not `IMMUTABLE`
(`42P17`), which aborted the run at **file 4 of 7** — so the guard, the RLS policies and
the RPCs (files 5, 6, 7) had never executed at all. An early failure in a numbered
sequence says nothing about the files it never reached, and a partial run reports as one
error rather than as three unverified files.

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

**The unexpected dividend, and the best argument for the const-tuple style.**
`erasableSyntaxOnly` was added to stop `export enum` breaking the worker at runtime.
Because it guarantees every file in this repo is type-strippable, `node --test` runs the
`.ts` sources **directly** — no vitest, no ts-node, no build step, zero test
dependencies. A compiler flag added for one reason bought a test runner for free. That
is a more persuasive case for the style than "the linter says so", and it is why
`test/enum-parity.test.ts` can import the real contract at runtime rather than
re-parsing it as text.

### Two toolchain traps that have each cost a session

**1. `node --test` needs a GLOB, not a directory.** On Node 24.14.0 a bare `test/`
argument is resolved as a *module* and dies with `MODULE_NOT_FOUND: …\test`; `./test/`
fails identically. The working form, used by both packages here:

```jsonc
"test": "node --test \"test/**/*.test.ts\""
```

The error is easy to misread: "MODULE_NOT_FOUND on a test dir that has no fixtures" is a
coherent story, and it was the wrong one.

**2. The `"// key": "explanation"` pseudo-key trick is only safe where nothing validates
the object.** It is used widely in `package.json` and is fine there — npm does no schema
validation. It is **fatal** in two places we have now hit:

| Location | Result |
|---|---|
| inside `compilerOptions` | `TS5025: Unknown compiler option '// noEmit'` |
| inside `dependencies` / `devDependencies` | `ERR_PNPM_INVALID_DEPENDENCY_NAME` |

Tolerated at the tsconfig **root** (`"// extends"` passes) because TypeScript ignores
unrecognised top-level keys — which is exactly why the pattern half-works and survived
review. `tsconfig.json` is JSONC, so use **real `//` comments** there instead. For a
validated block like `devDependencies`, put the explanation on a sibling top-level key.

The general rule, which is the transferable part: **a self-documenting convention that
relies on a parser ignoring what it does not recognise fails wherever that parser is
strict — and it fails at the place you add it, not where you learned it.**

---

## 3. The tables

### `system_settings` — one row per user. **Every agent reads this first.**

| Column | Why it matters |
|---|---|
| `system_enabled` | **The kill switch. Defaults FALSE.** A fresh deploy cannot start submitting. |
| `dry_run` | **Inert. Nothing reads it.** Do not flip it to stop submission. Whether a run submits is decided by `apply.yml`: its `dry_run` input on a manual run, and the repo variable `APPLYY_CRON_LIVE` on a scheduled run (`20261105202000_system_settings_dry_run_comment_inert.sql`). |
| `auto_apply_on_approve` | Default FALSE. When TRUE, approving a job starts the applier through `dispatch-apply` (`20261105140000_auto_apply_on_approve.sql`). |
| `gemini_daily_call_budget` | Nullable. **NULL = uncapped.** The only number in the schema permitted to stop work. |
| `gemini_calls_today` / `gemini_budget_date` | Self-resetting counter, **dated in US/Pacific** (§8.4). |
| `max_applications_per_company_per_week` | Default 2. The knob only — the count is derived by query. |
| `max_applications_per_day` | **Nullable since `20261105140000`. NULL = no daily cap.** |
| `freshness_window_days`, `claim_lease_seconds` | Operating limits. |

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
- `description_preview` and `description_requires_degree` are **generated stored
  columns** derived from `description_raw` (migration `20261108170000`, live
  2026-11-08). **No writer sets them; Postgres computes them.** `description_preview` =
  `left(description_raw, 600)`, so list views show a card without detoasting the whole
  description; it is as untrusted as its source (§7). `description_requires_degree` is
  the degree_mismatch regex ported to Postgres (`false` when `description_raw` is null),
  the one copy of that rule. Types: `JobRow` in `src/tables.ts`.

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

| Table | What to know |
|---|---|
| `answer_bank` | `needs_human` is constraint #4 made concrete. `attested_by_human` is set by a trigger, never by the caller: a write with no agent-key header counts as human (`20261009160000_answer_bank_attested_by_human.sql`). |
| `unanswered_questions` | A **report** for the Answer bank page, never an answer source. The planner reads only `answer_bank`. Written through `record_unanswered_questions(p_application_id, p_items)` (`20261105230000`). |
| `application_events` | Append-only. Triggers raise on UPDATE and DELETE, and UPDATE, DELETE and TRUNCATE are revoked from `anon` and `authenticated` (`20261101140000`). A correction is a new event. |
| `resume_chat_messages` | One message of an AI chat about one application's resume. Append-only, same enforcement as `application_events`. |
| `gemini_usage` | One row per Gemini attempt the key pool claimed, with token counts. Append-only. Written by `recordUsage` in `supabase/functions/_shared/gemini/client.ts`; queries in `docs/tooling/2026-11-02-gemini-usage.md`. |
| `jobs.tombstoned_at` | A dropped job's row is slimmed and stamped, not deleted, by `tombstone_dropped_jobs()` (`20261105200000`). |
| `follow_up_nudges`, `skill_gap_reports`, `interview_prep_packs` | Phase 3 agent outputs (`20260918213000`). |
| `agent_runs`, `gemini_key_state`, `search_preferences`, `filter_rules`, `company_blocklist`, `email_events`, `matcher_eval_cases` | See their Row type comments in `src/tables.ts`. |

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

> **Every edge into `approved` is `['human']`-only**, and `approved → applying` is the
> only edge into `applying` in the entire graph.
> **Constraint #15 is therefore unreachable-by-construction rather than
> enforced-by-review.**

No bug in any agent can skip the human approval gate, because there is no other door
into `applying`, and no automated actor can open the door into `approved`.

**Corrected 2026-09-10.** This block previously read "`awaiting_approval → approved` is
the only edge into `approved`". That was false: there are **two** in-edges,
`awaiting_approval → approved` and `needs_verification → approved` (the latter is listed
in the human-only table 15 lines below, so the document contradicted itself). The
safety property was never in danger — both are `['human']` — but the *stated* reason for
it was wrong, and a reader who checked the graph would have found the document unreliable
exactly where it is most load-bearing.

The replacement wording is **strictly stronger**: "the only edge" breaks the moment a
second recovery lane is added, whereas "every edge into `approved` is human-only" keeps
holding. Both facts are now asserted in `test/enum-parity.test.ts` against the seeded
SQL, so the next person to add an in-edge gets a failing test rather than a stale
sentence.

Verified against a running Postgres on 2026-09-10, not merely read off the seed:
`approved → applying` is the only row with `to_status = 'applying'`
(`allowed_agents = {applier}`), the guard rejects `tailored → applying` with
`illegal status transition`, and — the control that makes that meaningful — the legal
`approved → applying` move with the same agent **succeeded** and set
`previous_status = approved`. The guard discriminates between edges rather than
blanket-refusing writes.

### The human-only lanes

These carry the anti-double-submit guarantee, and no reader will infer them from the
column types:

| Edge | Why human-only |
|---|---|
| `needs_verification → approved` | The only way a possibly-submitted row re-enters the submit path. **A machine must never decide that a possibly-submitted application was not submitted.** |
| `audit_flagged → tailored` | An automated retry loop here would burn quota rewriting the same flagged bullet. |
| `failed → needs_verification` | Sends a failed row to verification rather than to the queue. |
| `failed → passed_filters` | Re-tailors a row that failed **before** approval. A BEFORE UPDATE trigger, `applyy_internal.guard_failed_rerun`, refuses the move for a row that failed after approval, because that row may already be submitted (`20261102203000_failed_before_approval_reruns.sql`). |
| `awaiting_approval → approved` | Constraint #15. |
| `awaiting_approval → passed_filters`, `approved → passed_filters` | Re-run after the master resume changes. Withdraws the approval so the row is re-scored and re-tailored (`20261101173000_master_change_reruns_pipeline.sql`). |
| `approved → applied`, `approved → failed` | "Mark applied" / "Mark failed" on the Manual apply page, for a job Teja sent by hand (`20261105121500_human_resolves_approved_from_manual_apply.sql`). |
| `discovered → passed_filters` | The pasted-link path. No agent may take it (`20261031200000_human_pasted_link_reenters_passed_filters.sql`). |
| `discovered → applied` | "Add to Applied" on the Emails page: a job applied to outside the portal, tracked from its email (`20261105124600_email_add_to_applied_and_read_at.sql`, RPC `track_email_as_applied`). |

`applying → needs_verification` is `['sweeper', 'human']` — **not** sweeper-only.
`human` is present deliberately: §14 says scheduled jobs die silently, so a
sweeper-only edge would leave a stuck row unresolvable by the one person who must
resolve it.

**Two different questions, easy to conflate:** *human-only* edges
(`allowedAgents.length === 1 && [0] === 'human'`) and *human-permitted* edges
(`allowedAgents.includes('human')`). Count both from `STATUS_TRANSITIONS` in
`src/status-flow.ts`, or live with
`select count(*) filter (where allowed_agents = '{human}'), count(*) filter (where 'human' = any(allowed_agents)) from public.application_status_transitions`.
As of 2026-11-08 the mirror gave 19 and 40. A UI completeness check wants
the **wider** predicate — otherwise it reports full coverage while the manual control
for a safety-critical shared edge is missing.

`allowedAgents` is consumed by the frontend as well as by the trigger. Adding an edge
without a matching UI control should surface as a visible defect, not as rows silently
stalling.

### There is no backward edge on the automated forward path

PROJECT_PLAN §6 says an agent that finds every Gemini key cooling "returns the row to
its prior status". **That rollback does not exist, and must not be built.** Claiming
sets `claimed_by` / `claim_expires_at` and does *not* advance `status`, so a row being
worked on never left the status it was in. An agent that cannot get a key calls
`release_application_claim()`; the row is picked up next run.

**Corrected 2026-09-10 — this section used to be titled "There are no backward edges",
and that is false.** Backward edges exist, deliberately; they are the recovery lanes.
"Backward" means the target comes earlier in `application_status` declaration order.
The test pins their number (eleven as of 2026-11-08, `test/enum-parity.test.ts`), so a
new one fails the suite until the count and this table are updated:

| Backward edge | Allowed agents | Added by |
|---|---|---|
| `dropped_filter → passed_filters` | `['human']` (a pasted link overrules the filter) | `20261031200000` |
| `audit_flagged → tailored` | `['human']` | base |
| `awaiting_approval → passed_filters` | `['human']` | `20261101173000` |
| `approved → passed_filters` | `['human']` | `20261101173000` |
| `interview → oa_pending` | **`['tracker', 'human']`** | base |
| `blocked_needs_human → applied` | `['human']` | base |
| `blocked_needs_human → dropped_filter` | `['human']` | base |
| `needs_verification → applied` | `['human']` | base |
| `needs_verification → approved` | `['human']` | base |
| `failed → needs_verification` | `['human']` | base |
| `failed → passed_filters` | `['human']`, plus the `guard_failed_rerun` trigger | `20261102203000` |

The true statement, and the one the old wording was reaching for: **no backward edge
exists on the automated forward path, and every backward edge except one is
human-only.** The exception is `interview → oa_pending` — **the one reverse edge a
machine can walk** — because a multi-round loop legitimately sends a further assessment
after an interview.

Why the precision earns its space: a reader who believes "zero backward edges"
concludes the actor check on reverse moves is redundant and skips it. It is not
redundant. It is the entire safety property, and it is doing real work on exactly one
edge. Both facts — the backward-edge count and the single machine-walkable exception —
are asserted in `test/enum-parity.test.ts`.

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

3. **`TailoredExperience.bullets[].ref` pointing at a real bullet from the WRONG
   PARENT.** See the next subsection — this one is invisible to a fact-check and was
   not previously written down anywhere.

All three surface as `AuditFinding`, which is a **discriminated union on `kind`** as of
2026-09-10 (it was a single flat shape, which is why vector 3 had nowhere to live):

```ts
type AuditFinding = MisattributedBulletFinding | JdKeywordDroppedFinding | GenericAuditFinding;
// every member also carries: path, ref_path?, claim, reason, confidence (AuditFindingBase)
// MisattributedBulletFinding: kind 'misattributed_bullet'
//                             + ref, claimed_parent_ref, actual_parent_ref (all required)
// JdKeywordDroppedFinding:    kind 'jd_keyword_dropped' + keywords?: readonly string[]
// GenericAuditFinding:        kind 'unresolved_ref' | 'unfaithful_rewording'
//                             | 'summary_unsupported' | 'other'
```

Source: `packages/shared-types/src/tables.ts:513` (kinds: `AUDIT_FINDING_KINDS` in
`src/enums.ts`), verified 2026-11-08.

`AUDIT_FINDING_KINDS` is TypeScript-only: it discriminates one element of the
`applications.audit_findings` jsonb **array**, and a row-level enum column cannot type a
per-element field. Switch on `kind` exhaustively — with `noFallthroughCasesInSwitch`, a
newly added kind becomes a compile error at every consumer instead of being silently
rendered as "other".

### A ref is only valid inside its correct PARENT — not merely existent

**THE RULE: validating a ref means checking it resolves *under the node it was emitted
under*, not that it exists somewhere in the master.** Existence-only checking passes an
attack that a fact-check also passes.

The attack, concretely. A bullet that genuinely belongs to `proj-portfolio` is emitted
by the model inside `TailoredExperience { ref: 'exp-eventportal', bullets: [...] }`:

- the bullet id **exists** in the master → every existence check passes
- the wording is **faithful** to the master text → the rewording check passes
- the numbers are **real**, the work **happened** → a line-by-line human fact-check
  passes, and the candidate can talk about it for ten minutes

…and the resume now credits personal-project work to a named employer. This is
**fabricated experience assembled entirely out of true parts**: every individual claim
survives verification, and the fabrication lives in the *structure* rather than in any
string. Nothing that inspects claims one at a time can see it.

It is `misattributed_bullet` and **not** `unresolved_ref`, because the two have
different fixes:

| Finding | What the model did | The fix |
|---|---|---|
| `unresolved_ref` | **invented** an id | reject the output |
| `misattributed_bullet` | **reassembled truth** | re-parent the bullet |

Same severity in an interview room; opposite remedies. Collapsing them would tell a
reviewer to throw away output that is entirely true and merely mis-filed.

**Why this is written down here:** the nested shape of `TailoredExperience` /
`TailoredProject` is what made the attack *visible* — a flat list of bullets could not
express a parent, so it could not express a wrong one either. The next person to write a
validator will otherwise implement `masterBulletIds.has(ref)`, which is the obvious
implementation, is what the type system alone appears to ask for, and silently reopens
this hole. The type guarantees a real bullet is being referenced; **only the validator
can guarantee it is being referenced from the right place.**

`MisattributedBulletFinding` requires `ref`, `claimed_parent_ref` **and**
`actual_parent_ref` — not optional fields. A misattribution with no parents named is
unactionable, since the whole question is "under which employer did this appear, and
where does it belong", so the union makes a nameless one unrepresentable rather than
merely discouraged. Same move as `ref` being non-optional.

**The defect this fixed was a lossy boundary, not a missing concept.** `TailorViolation`
in `validator.ts` already models `{kind: 'misattributed_bullet', ref, parentRef}` and
the validator already performs the check (`found.parentRef !== parentRef`). The
discrimination was computed correctly and then **discarded on the way into the
database**, because the stored shape had no `kind` and no parent fields. No amount of UI
work could recover it. Worth recognising as a shape, since it is unlikely to be the only
instance: a type that is **rich at the point of computation and lossy at the point of
storage** leaves every consumer downstream of the database working with less information
than the system actually derived — and it is harder to spot than a missing concept,
because both types look reasonable read on their own. The defect lives only in the
mapping, which is nobody's file.

Naming: `kind` values are **identical** on both sides and must stay so. The field names
differ by convention — camelCase in the validator (function-internal TS), snake_case in
the stored jsonb (matching the columns around it) — and `parentRef` becomes
`claimed_parent_ref` because a bare `parentRef` does not say *which* parent it means,
and the stored shape carries both. One documented translation, not an undocumented
divergence.

### `NodeId` is unique across the WHOLE master profile — one global id space

**Decided 2026-09-10.** Every `NodeId` must be unique across the entire
`MasterProfile`: across experience, projects, education, skills, links, achievements,
certifications, the summary node, the links nested inside a project, and every bullet
nested inside any parent. **Not per section. Not per node kind.**

That list is exhaustive as of 2026-09-11 and it is a list that grows. **Every new
id-bearing place must be added to `collectNodeIds` in `packages/master-ingest` in the
same change that adds it here** — a kind missing from the walk does not fail a test, it
silently stops participating in uniqueness while every existing test stays green.

This follows from the tailored types rather than being a preference. `TailoredBullet` is
`{ref, text}` and `TailoredSkill` is `{ref}` — a bare id with **no section qualifier and
no kind tag** — so resolution has nothing to go on but the id. Under per-section
uniqueness a bullet ref could resolve to a skill, or to a bullet under a different
parent, and no consumer could disambiguate. The alternative design is qualifying every
ref, which is strictly more machinery for no gain.

**The ingest validator must reject any duplicate `NodeId` across all kinds, and fail
closed.** That is the only place it can be enforced: `type NodeId = string` buys no
enforcement, and by the time a ref is being resolved the collision has already been
absorbed. The failure mode is silent — a `Map` overwrites on duplicate key, so the
misattribution check compares against the *wrong* stored parent and a genuine
misattribution passes as clean, with nothing reporting a problem.

Why this was worth deciding explicitly: the ambiguity was itself load-bearing. The
validator's flat index assumes global; a reader of `profile-nodes.ts` could reasonably
assume per-section. Both readings could call the other's code a bug, so the contract has
to say which — and a confirmed collision bug already existed in that gap.

### The four things the contract could not represent — closed 2026-09-11

Teja's real resume carried four facts the type contract had no field for, so ingest
dropped them **silently**: three achievements, four certifications, his summary
paragraph, and a project that has both a live URL and a GitHub URL. Nothing errored;
the data simply did not survive the parse.

| Added | Shape | Why this shape |
|---|---|---|
| `MasterSummary` | `{ id, text }` | **A node with a `NodeId`, never a bare `summary: string`.** The id is the entire point — see below. |
| `MasterAchievement` | `{ id, label, description, bullets }` | Bulleted parent, **no date fields**. The document writes achievements undated, so a `date_display` would have one honest value and one tempting inferred one. |
| `MasterCertification` | same shape, separate interface | `description`, **not `issuer`**: the half after the dash is an issuing body on some lines and a platform or a year on others, and a field named `issuer` holding `"2025"` is a name that lies. |
| `MasterProject.links` | `DocumentOrdered<MasterLink>`, **replacing** `url: string \| null` | One slot silently discarded the second address on every upload. Not `url2`/`repo_url`: a second scalar shrinks the loss without removing it and leaves `url` meaning "the first one, whichever that was". |

**Why the summary had to become a node.** `TailoredSummary.refs` is required and must be
non-empty, so every generated summary declares which master nodes it drew on. Before
`MasterSummary` existed, the one source a summary most obviously draws on — the
paragraph the human wrote — was the only thing it could not cite. Stored as a bare
string it would have been the single piece of prose in the system that the Tailor could
draw on with no way for the validator to check that it had. The danger was never that a
summary exists; it is a summary with nothing behind it.

**Why these are required fields, not optional ones.** `summary: MasterSummary | null` and
required-but-possibly-empty `achievements` / `certifications` arrays. `summary?:` would
let a construction site that forgot the summary compile clean and store a profile with
the paragraph dropped — which is the exact bug being fixed. The required form converts
every un-updated construction site into a compile error that names it. Verified rather
than assumed: a `MasterProfile` literal omitting all three fails with `TS2739` naming
`summary, achievements, certifications`, and the same literal with them present compiles.

**The change was carried through Tailored and Resolved too, deliberately.** A section the
master can store but `TailoredSectionKind` cannot name is a section the renderer is never
told to emit — so Master-only types would have *moved* the silent drop from ingest to
tailoring rather than removed it. `ResolvedResume.summary` stays a bare `string | null`
and only there: that is the end of the pipeline, the renderer has no master to resolve
against, and an id at that point would refer to nothing.

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

**Two optional `TailoredProfile` fields, both copied AS HELD.** Absent means the
output from before the field existed, so every stored `tailor_refs` still re-validates
to its frozen resume (`rebuildOriginal`). Never write a default (`?? null`) into a copy
that gets stored: an absent field must stay absent.
- `summary_variant?: NodeId | null` — which master summary variant prints; null or
  absent = the default. An id the master lacks is refused.
- `headline_title?: string` (2026-11-08) — the header's role title: the job title with
  seniority words removed, never invented. The tailor sets it (`cleanRoleTitle` in
  `_shared/tailor/content-rules.ts`); the validator prints it as `identity.headline`
  ahead of the variant's and the master's. A value outside the cleaned shape is refused.

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

**First, send the agent key.** A machine agent's client must carry the
`x-applyy-agent-key` header, built by `agentKeyHeaders()` in
`supabase/functions/_shared/db/agent-key.ts` from the `APPLYY_AGENT_KEY` secret.
`advance_application_status`, `claim_applications`, `release_application_claim` and
`sweep_stale_claims` check it through `applyy_internal.agent_key_state()` and refuse a
machine agent without it (`42501`). Since `20261102210000` an empty key table locks every
machine agent out (fail-closed). Repo `CLAUDE.md` §7 has the details.

```ts
// 1. Open a run BEFORE doing work, so a crash leaves a visible stuck row.
//    A missing row and a successful run look identical.
const { data: run } = await sb.from('agent_runs').insert({ agent: 'matcher' }).select().single();

// 2. Sweep first. Cheap, and it makes a crashed peer self-heal.
//    `returns table (...)` so this resolves to an ARRAY, even though it can only ever
//    yield one row. `data.released_count` is undefined; `data[0]` is the row.
const { data: sweptRows } = await sb.rpc('sweep_stale_claims');
const swept = sweptRows?.[0];

// 3. Claim. Returns [] when the kill switch is off — that is not an error.
const { data: rows } = await sb.rpc('claim_applications', {
  p_status: 'passed_filters',
  p_claimed_by: `matcher:${run.id}`,
  p_limit: 10,
});

for (const row of rows) {
  // DESTRUCTURE `data`. `sb.rpc()` resolves to { data, error }, never to the value —
  // and because `claim_gemini_key` returns `smallint`, `data` IS the index (a bare
  // number), not `{ key_index }`. Getting either half wrong fails silently: the
  // `=== null` guard below can never match an object, so the agent would sail past
  // quota exhaustion and pass garbage to report_gemini_result.
  const { data: keyIndex, error: keyError } = await sb.rpc('claim_gemini_key');
  if (keyError) throw keyError;

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

**Optimistic check.** `advance_application_status` also takes
`p_expected_updated_at timestamptz default null` (`20261008160000`, the latest
definition). Pass the `updated_at` you last read and the move is refused if the row
changed since. NULL means "do not check". `AdvanceApplicationStatusArgs` in
`src/tables.ts` does not declare this parameter yet (§10).

**Default rows are seeded at signup.** A trigger on `auth.users`,
`on_auth_user_created_seed_defaults`, calls `applyy_internal.seed_user_defaults(NEW.id)`
(`20261008180000`). Without a `system_settings` row every function fails closed and the
system looks merely idle — the exact silent stop §14 warns about. **Do not call
`bootstrap_user_defaults()` from an agent:** EXECUTE on it was revoked from
`authenticated` in `20261105203000`. To repair a user with missing defaults, run
`select applyy_internal.seed_user_defaults('<user uuid>');` as `postgres` (idempotent).

---

## 7. Untrusted input

**Job descriptions, ATS page DOM, and inbound email are untrusted** (constraint #17).
Marked `Untrusted` in the types and flagged in `COMMENT ON COLUMN`:

`jobs.description_raw` ← *the highest-risk column in the database* (and its generated
prefix `jobs.description_preview`) · `jobs.title` ·
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
from X" without joining the event log. **It is not a rollback mechanism** — the
backward edges that exist are explicit recovery lanes with their own rules (§4). Never
branch on it. One trigger reads it on purpose: `applyy_internal.guard_failed_rerun` uses
it to tell a row that failed before approval from one that failed after (§4).

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

**Setup, done.** The worker and the dashboard share the app's single auth user (RLS
scopes rows by `auth.uid()`, so a second user would split the data). Its credentials
are the `APPLYY_APP_USER_EMAIL` / `APPLYY_APP_USER_PASSWORD` secrets, read by
`.github/workflows/apply.yml` and `apply-kit.yml`. The sign-in is in
`worker/src/cli/apply.ts` and `supabase/functions/_shared/db/client.ts`.

**The one gap this design leaves, and the control added for it (2026-10-08).** The
browser, the Edge Functions and the worker all sign in as the same user, so `auth.uid()`
cannot tell a person from an agent. The `x-applyy-agent-key` header is the only
discriminator (§6). Any holder of the user's JWT who omits the header is still treated
as human.

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

`block_reason` is an enum (`BLOCK_REASONS` in `src/enums.ts`; `robots_refused` was added
by `20261009233000`) rather than free text, because the UI branches on it and free text is how you get three spellings
of one reason. It is **kept** after the block is resolved — that history is what the
health page wants.

#### Two reason vocabularies, at two granularities. Do not merge them.

Added 2026-09-10 because the overlap looks like duplication and is not. Someone will
see two enums both containing "reasons" and consolidate them; this is why that is wrong.

| Enum | Types | Granularity | Question it answers |
|---|---|---|---|
| `BLOCK_REASONS` | `applications.block_reason` — a real Postgres enum **column** | ROW | why is this whole application parked? |
| `ANSWER_BLOCK_REASONS` | a field inside `applications.block_detail` (**jsonb**) | FIELD | which question stopped it, and what kind of stop? |

The relationship is fixed and total: **if any field carries an `ANSWER_BLOCK_REASONS`
value, the row's `block_reason` is `'unanswerable_question'`.** Never `captcha` or
`mfa` — those are page-level walls with no field attached, which is exactly why they
live only in the row-level enum and are **deliberately not repeated** in the field-level
one.

Two structural reasons one enum cannot serve both, so this is not a style preference:

1. One row can be blocked by **several** unanswerable fields at once. An enum *column*
   holds one value, so it cannot carry a per-field list. `block_detail.fields` is an
   array for that reason — the Applier surfaces every blocking question in one go, so a
   human answers them in one pass instead of unblocking, re-running, and blocking again
   on the next field.
2. Merging would put values in a column that can only ever describe one of them.

**The three field-level cases, and why three and not two.** The operator action *and*
the answer-bank effect differ in each, and the bank growing itself is the entire value
of §15:

| `ANSWER_BLOCK_REASONS` | Operator action | Answer-bank effect |
|---|---|---|
| `answer_missing` | answer it once | **INSERT** — never asked again. This is the bank growing itself. |
| `answer_low_confidence` | confirm or correct | **UPDATE** in place, clear `needs_human` |
| `answer_refused` | the human answers on the real form, every time | **NONE — never write back** |

Collapsing `answer_missing` into `answer_low_confidence` would lose the INSERT trigger,
so the system would stop learning new questions — which is the feature, not a detail.

`answer_refused` is the one worth explaining: the system has an answer, or could compose
one, and refuses to submit it automatically. Two grounds — the honest answer is not
among the options the widget offers, or the question is one no automation should answer
on someone's behalf (EEO and self-identification, disability, veteran status,
sponsorship, expected CTC). **Never write these back to the bank.** Caching a legal or
demographic declaration for silent reuse is a decision that belongs to the human on
every application. It is constraint #3 at its sharpest: the failure is not a gap in the
bank, so filling the gap is the wrong fix.

**One vocabulary, one spelling.** `worker/src/plan-fill.ts` declares a local
`'no_answer' | 'awaiting_human_answer'`. Import `AnswerBlockReason` instead:

- `no_answer` → **`answer_missing`** (one concept, two names — this was the drift)
- `awaiting_human_answer` → **`answer_low_confidence`** (bank row exists, `needs_human`)

As of 2026-11-08 that rename is **still not applied in the worker** —
`worker/src/plan-fill.ts` still declares `'no_answer' | 'awaiting_human_answer'`. This
table is the agreed target, not a description of shipped code.

Open question for whoever owns the answer bank: `answer_bank.needs_human` is one
boolean trying to express three states. Either it becomes the storage for the sub-kind,
or it stays a coarse "a human must look" and the sub-kind is derived at plan time.
Not decided here; flagged so it is decided once rather than twice.

### 8.7 `posted_at_source = 'unknown'` has exactly one cause

**It means "this board is not yet trusted". It NEVER means a parse failure.** Every
degraded input — malformed string, epoch 0, missing field, unparseable prose — resolves
to `derived` via `first_seen_at`.

No column type can express that, and a reader who assumes `unknown` signals a bad parse
will write the wrong filter.

`unknown` **fails** the staleness check rather than bypassing it. That policy is a
setting, not a buried constant: `filter_rules.config.treat_unknown_posted_at_as_fresh`,
default `false`.

#### The degradation axis is WHERE THE DATE CAME FROM, not how confident we are

**Corrected 2026-09-10 — the implementation was right and this document's wording was
wrong.** It previously read "on a board's first poll only `derived` degrades to
`unknown`", which read literally degrades a real Greenhouse `updated_at`. What
`posted-at.ts` actually does: **both `exact` and `derived` survive a board's first poll.
Only a date that would have come from `first_seen_at` becomes `unknown`.**

**There are two distinct defects here and they need two distinct mechanisms.** Keeping
them apart is the whole point, and conflating them is the mistake this subsection exists
to prevent:

1. **The cold-start bug (§13) lives entirely in the inference from our own poll
   history.** "Anything we have never seen must be new" is sound in steady state and
   false on a board's first poll, when the entire back catalogue arrives stamped today.
   A real board timestamp's value **does not depend on when we started polling**, so the
   cold-start error cannot reach it. Downgrading a Lever `createdAt` would discard a
   fact to defend against a guess we never made — and supply is already the scarce
   thing (§13: a 3-day window over a 50-company watchlist yields single digits a day,
   not 35).
2. **Separately, Greenhouse's `updated_at` is a poor proxy for a posted date** — a
   description edit resets it, so a job open since March but edited yesterday looks
   fresh. **But that is true on EVERY poll, not just the first.** Folding it into the
   cold-start guard would "fix" it on poll 1, leave it broken from poll 2 onward, and —
   worst of the three — make it look handled. It belongs to the `derived` confidence
   level's own filter policy, which is why Greenhouse is `derived` and never `exact`
   regardless of how well-formed its timestamp is.

#### `unknown` has exactly one cause: the cold-start guard. Never a parse failure.

Every degraded input — malformed string, epoch-0 sentinel, absent field, unparseable
prose — carries the same information (nothing), so all of them fall through to the
`first_seen_at` path and resolve to **`derived`** on any poll after the first. No column
type can express this, and a reader who assumes `unknown` signals a bad parse will write
the wrong filter.

**A caveat on how that guarantee is currently enforced, because it is more fragile than
it looks.** `readSourceDate` *does* return `confidence: 'unknown'` on an unparseable
date — but only ever paired with `date === null`, and `extractPostedAt` reads
`fromSource.confidence` **only inside its `if (fromSource.date !== null)` branch**. So
those `unknown` values are unreachable in the output, and the guarantee holds because of
the *caller's* control flow rather than because of the confidence values themselves.

Consequence worth stating plainly: a future refactor that trusted
`fromSource.confidence` unconditionally — which reads like a harmless simplification —
would silently start emitting `unknown` for parse failures and break this guarantee with
no other symptom. If you touch `extractPostedAt`, the invariant to preserve is
**"`unknown` is written by exactly one line, the cold-start ternary"**, not "the
confidences are correct".

### 8.8 RLS conventions

Every policy is `to authenticated` and uses `(select auth.uid())`, not bare
`auth.uid()`. The subquery lets Postgres evaluate it **once per statement** as an
InitPlan instead of once per row — on a thousand-row scan, one call instead of a
thousand. **Do not simplify the parentheses away.**

Policies use `for all` with **both** `using` and `with check`. `using` filters what you
can see; `with check` validates what you write. A policy with only `using` would let you
update a row you can see into a row belonging to someone else.

The agent-facing RPCs are `security invoker` — they must run with the caller's RLS in
force. A definer function reachable over the REST API would make every caller act as the
owner and RLS would stop meaning anything.

**The definer exceptions, and why each is safe.** Regenerate the list with
`grep -li "security definer" supabase/migrations/*.sql` and read the latest definition
of each function.

| Function | Why it is definer | Why it is safe |
|---|---|---|
| `applyy_internal.*` trigger and helper functions | They write rows the caller may not (event log, seed rows, attestation stamp). | Triggers cannot be called directly. EXECUTE on the trigger functions was revoked from PUBLIC (`20261008190000`); `seed_user_defaults` is granted to no one. |
| `public.bootstrap_user_defaults()` | Wraps the private seed body. | EXECUTE revoked from `authenticated` (`20261105203000`). Nothing calls it. |
| `public.rls_auto_enable()` | An event trigger that turns RLS on for every new table (`20261102211000`). | Returns `event_trigger`, so it cannot be called as an RPC. EXECUTE revoked in `20261105203000`. |

**Re-verify RLS as two separate assertions** (one alone would be a false comfort — RLS
enabled with no policy is a locked table, and a policy on a table without RLS is dead
code): every public table has `relrowsecurity = t` (query in §1), and every public table
has at least one row in `pg_policies`. First verified 2026-09-10 on 15 tables. As of
2026-11-08 all 21 public tables had RLS on.

**Exceptions to the FORCE RLS pattern.** As of 2026-11-08 two public tables have
`relrowsecurity = t` but `relforcerowsecurity = f` (query in §1):

- `application_status_transitions` — the read-only reference seed, not user data.
  Defensible, and recorded here so nobody assumes it was an oversight.
- `unanswered_questions` (`20261105230000`) — user data. Every other user-data table has
  FORCE RLS on. This looks like an omission, not a decision. Open for the migrations
  stream: add `force row level security`, or state the exemption in a migration.

**A limit on the word "verified" above, because the general claim would mislead.** The
verifying role had `rolbypassrls = TRUE`. The `SECURITY DEFINER` audit trigger did write
its witness row into `application_events` through FORCE RLS — but it did so *because of*
BYPASSRLS, not because FORCE RLS exempts table owners (**it does not**). So "the audit
trigger writes through FORCE RLS" is true for this deployment and **unproven for a
plain-owner one.** Re-test before relying on it in a deployment whose owner lacks
BYPASSRLS.

---

## 9. Changing the schema

An enum lives in **two** places. Change one and you must change the other:

- `supabase/migrations/…_enums.sql`
- `packages/shared-types/src/enums.ts`

Same for the status graph: `…_status_transition_guard.sql` (the rule) and
`src/status-flow.ts` (the mirror the UI reads).

A table lives in two places too: the migration and its `<Table>Row` / `Insert` /
`Update` types in `src/tables.ts`. **Add the Row type in the same change as the
migration.** A new column goes into the Row type in the same change as well.

**A TEST is the enforcement, not this checklist.** Run it from the repo root, the same
way CI does:

```bash
node --test "packages/shared-types/test/**/*.test.ts"    # test/enum-parity.test.ts
```

Read `tests`, `fail` and `cancelled` together: `tests 0` with `fail 0` is a glob that
matched nothing (repo `CLAUDE.md` §5). **CI runs this suite** in `.github/workflows/ci.yml`,
step "shared-types tests (node --test), and assert tests ran" (added 2026-11-01, after
`4f53c25` landed a table without a Row type on a green main). It still pays to run it by
hand after writing a migration, before you push.

It parses `supabase/migrations/**` and diffs it against the imported TypeScript, and it
fails in **both** directions. What it covers:

- every Postgres enum has a TS mirror with the same values **in the same order**
- no TS enum mirror lacks a Postgres declaration (a value added here and forgotten in
  the migration would otherwise typecheck everywhere and fail as a runtime
  `22P02 invalid_text_representation` on the first insert — in production, from an
  agent, at 3am)
- **table parity:** every `create table public.X` in the migrations has a Row type
- **column parity:** every Row type has exactly the column names its table has, both
  directions. The parser replays `create table` and `alter table … add column` in
  filename order. It refuses `drop column` / `rename`, so teach it those before you use
  them. A NON-VACUITY control test proves the parser catches a missing and an extra
  column.
- every transition edge matches, including `allowed_agents` **and** the user-visible
  `note` text
- the invariants: every edge into `approved` is human-only; the backward-edge count is
  pinned and exactly one backward edge is machine-walkable; `TERMINAL_STATUSES` is
  exactly the no-outgoing-edge set; `applying` has one in-edge

**Why the change matters more than it looks.** This section previously said "This
checklist is the enforcement", and a checklist is a guard nobody runs. It had already
failed: `eval_label` and `matcher_eval_cases` shipped in SQL with no TS mirror while
§1 of this document claimed 15 tables, and nothing noticed. The test was
mutation-checked when written — reordering two values of one enum (same members,
swapped order), adding a TS-only value, and adding a second edge into `applying` each
produce a failure.

**Declaration order is part of the contract, not cosmetics.** Postgres sorts an enum by
declaration order, so `ORDER BY status` yields pipeline order only while both sides
agree. Reorder one side and nothing breaks loudly — every value still exists, every
insert still succeeds, every other test still passes — and the kanban board silently
sorts wrong, surfacing months later as "the board looks odd" with no change to blame.

**Notes have a single source of truth: the SQL.** `application_status_transitions.note`
is `text not null` and the frontend renders it, so a mismatch means the UI and the
database disagree about what a transition *means* to a user. Change the migration first,
then sync `status-flow.ts`. (9 of 44 differed on 2026-09-10 — 4 punctuation-only, 5
substantive — and were converged onto the SQL text.)

**What the test cannot cover, so you still must:** per-column **types and nullability**,
and RPC signatures. A TypeScript `interface` is erased at runtime, so the suite reads
`tables.ts` as *text* and checks only names. Re-diff types against the live database
with the query in the `src/tables.ts` header (`information_schema.columns`), or with
`supabase gen types typescript` — see §10. One known, deliberate disagreement:
`company_watchlist.first_seen_at_is_trustworthy` is nullable live and non-null in
`tables.ts` (see that column's comment).

Adding a status transition also means adding a UI control for it if any human is in
`allowed_agents` — see §4.

---

## 10. Not done

- `matcher_eval_cases` is empty (0 rows live on 2026-11-08:
  `select count(*) from public.matcher_eval_cases`). About 20 labels are Teja's to
  write. The table and its `eval_label` enum are mirrored in `src/tables.ts` as
  `MatcherEvalCaseRow` / `Insert` / `Update`.
- **No real master resume is committed to the repo.** Teja's master lives in
  `master_profiles` in the live database. The only `ResolvedResume` instance in git is
  the synthetic `zomato-backend-intern` fixture in
  `packages/resume-template/test/fixtures/`. Do not read the fixture as Teja's history,
  and do not invent résumé content.
- The JSON fixture export + CI gate for the eval set belong to the Edge Functions
  stream, not to this schema.
- Generated types (`supabase gen types typescript`) should eventually be produced as a
  **check** on `src/tables.ts`, not a replacement: this file carries the comments, the
  generated one carries the proof. Column **names** are now checked by the column-parity
  test (§9); column types, nullability and RPC signatures are not.
- **RPC types lag the SQL** (as of 2026-11-08, `src/tables.ts`):
  `AdvanceApplicationStatusArgs` lacks `p_expected_updated_at`, and these public
  functions have no Args/Result type: `application_status_counts`,
  `track_email_as_applied`, `tombstone_dropped_jobs`, `set_gemini_key_pool_size`.
  Regenerate the function list with the `create … function public.` grep over
  `supabase/migrations/*.sql`.
- `unanswered_questions` has RLS but not FORCE RLS (§8.8).

### Deliberately not built

**A/B resume testing** (§17, second tier) is fenced as unapproved. It would mean two
competing master lineages, which is a schema change rather than a feature —
`master_profiles` is single-lineage versioned-immutable, `UNIQUE(user_id, version)`.

If it is ever approved, the change is additive and cheap: a `lineage` column plus
`UNIQUE(user_id, lineage, version)`, and `applications` gains a lineage reference
alongside `master_version`. **No decision here makes that expensive later** — recorded
so nobody has to re-derive it.
