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

**Applied and verified against a LOCAL Postgres 17.6 on 2026-09-10:** all 7 migrations
load cleanly, 15/15 tables present, all 7 RPCs present, 44 transition edges seeded,
RLS enabled with at least one policy on 15/15 tables.

**The hosted project is now linked, and reportedly pushed.** `supabase/.temp/`
carries `linked-project.json` and `project-ref` as of 18:40 on 2026-09-10, and Teja is
reported to have pushed all 7 migrations at 18:45.

**Read that with its provenance.** What is verified here is the *link state on disk*.
Nobody has queried the remote to confirm it holds these 15 tables, 7 RPCs and 44 edges —
so "the hosted project has this schema" is currently a second-hand claim. Re-verify
against the remote before depending on it, and note the consequence: **type-level
defects in this package are now live-system defects, not future ones.** The link files
are gitignored, so no project identifier is committed (constraint #11).

Getting to that clean load took one fix worth remembering as a *shape*: a partial index
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

### There is no backward edge on the automated forward path

PROJECT_PLAN §6 says an agent that finds every Gemini key cooling "returns the row to
its prior status". **That rollback does not exist, and must not be built.** Claiming
sets `claimed_by` / `claim_expires_at` and does *not* advance `status`, so a row being
worked on never left the status it was in. An agent that cannot get a key calls
`release_application_claim()`; the row is picked up next run.

**Corrected 2026-09-10 — this section used to be titled "There are no backward edges",
and that is false.** Seven backward edges exist, deliberately; they are the recovery
lanes. Ordered by `application_status` declaration order:

| Backward edge | Allowed agents |
|---|---|
| `audit_flagged → tailored` | `['human']` |
| `interview → oa_pending` | **`['tracker', 'human']`** |
| `blocked_needs_human → applied` | `['human']` |
| `blocked_needs_human → dropped_filter` | `['human']` |
| `needs_verification → applied` | `['human']` |
| `needs_verification → approved` | `['human']` |
| `failed → needs_verification` | `['human']` |

The true statement, and the one the old wording was reaching for: **no backward edge
exists on the automated forward path, and every backward edge except one is
human-only.** The exception is `interview → oa_pending` — **the one reverse edge a
machine can walk** — because a multi-round loop legitimately sends a further assessment
after an interview.

Why the precision earns its space: a reader who believes "zero backward edges"
concludes the actor check on reverse moves is redundant and skips it. It is not
redundant. It is the entire safety property, and it is doing real work on exactly one
edge. Both facts — the count of seven and the single machine-walkable exception — are
now asserted in `test/enum-parity.test.ts`.

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
type AuditFinding = MisattributedBulletFinding | GenericAuditFinding;
// kind: 'unresolved_ref' | 'misattributed_bullet' | 'unfaithful_rewording'
//     | 'summary_unsupported' | 'other'
```

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

As of 2026-09-10 that rename is **not yet applied in the worker** — this table is the
agreed target, not a description of shipped code.

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

The RPCs are `security invoker`, never `security definer` — they must run with the
caller's RLS in force. A definer function reachable over the REST API would make every
caller act as the owner and RLS would stop meaning anything. The only definer functions
are the two triggers, which are not API-reachable.

**Verified live 2026-09-10, as two separate assertions** (one alone would be a false
comfort — RLS enabled with no policy is a locked table, and a policy on a table without
RLS is dead code): **15/15** public tables have `relrowsecurity = t`, and **15/15** have
at least one policy. Zero holes, zero locked tables.

**One documented exception to the FORCE RLS pattern.** `application_status_transitions`
has `relrowsecurity = t` but `relforcerowsecurity = f`; the other 14 tables have force
RLS on. It is the read-only reference seed rather than user data, so this is defensible
— but it is the single place the pattern differs, so it is recorded here rather than
left for someone to find and assume was an oversight. Open question, owned jointly with
the migrations stream: make it uniform, or state the exemption in the migration itself.

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

**A TEST is the enforcement, not this checklist.** As of 2026-09-10, run:

```bash
pnpm --filter @applyy/shared-types test    # test/enum-parity.test.ts
```

It parses `supabase/migrations/**` and diffs it against the imported TypeScript, and it
fails in **both** directions. What it covers:

- every Postgres enum has a TS mirror with the same values **in the same order**
- no TS enum mirror lacks a Postgres declaration (a value added here and forgotten in
  the migration would otherwise typecheck everywhere and fail as a runtime
  `22P02 invalid_text_representation` on the first insert — in production, from an
  agent, at 3am)
- every table in the migrations has a `Row` type
- all **44** transition edges match, including `allowed_agents` **and** the user-visible
  `note` text
- the invariants: every edge into `approved` is human-only; exactly one backward edge is
  machine-walkable; `TERMINAL_STATUSES` is exactly the no-outgoing-edge set; `applying`
  has one in-edge

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

**What the test cannot cover, so you still must:** per-column types and nullability. A
TypeScript `interface` is erased at runtime, so that half of the suite reads
`tables.ts` as *text* and only checks that a `Row` type **exists**. Closing that gap is
what `supabase gen types typescript` is for — see §10.

Adding a status transition also means adding a UI control for it if any human is in
`allowed_agents` — see §4.

---

## 10. Not done

- **Nothing is applied to the hosted project.** Gated on Teja. There is no
  `supabase link` state on disk, and no remote database exists — never describe the
  hosted project as migrated.
- ~~Not yet validated against a live Postgres.~~ **DONE 2026-09-10:** all 7 migrations
  apply cleanly to a local Postgres 17.6. It took one fix to get there — a partial index
  on `company_blocklist` whose predicate called `now()` was rejected as not `IMMUTABLE`
  (`42P17`), which had been aborting the run at file **4 of 7** and therefore leaving the
  guard, the RLS policies and the RPCs unexecuted. Worth remembering as a shape: an
  early failure in a numbered sequence does not report the files it never reached.
- `matcher_eval_cases` is empty — ~20 labels are Teja's to write. The table and its
  `eval_label` enum are now mirrored in `src/tables.ts` as
  `MatcherEvalCaseRow` / `Insert` / `Update` (added 2026-09-10; they were the one
  table and the one enum with no TypeScript twin).
- **There is no real master resume in the repo.** The only `ResolvedResume` instance is
  the synthetic `zomato-backend-intern` fixture in `packages/resume-template/test/`.
  `MasterProfile` and `ResolvedResume` are built to *ingest* a real one; do not invent
  résumé content to fill the gap, and do not read the fixture as Teja's actual history.
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
