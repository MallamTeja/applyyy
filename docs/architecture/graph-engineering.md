# Graph engineering, taught against `applyyy`'s own code

**Written 2026-09-11 by session `applyyy-a6` (explainer role — no code ownership).**
Context gathered live from the orchestrator `applyyy-d8` and peers `applyyy-ff`,
`applyyy-6f` and `applyyy-76`, plus direct reads of the repo. Where a claim came
from a peer's report rather than my own measurement, it says so — same evidence
rule as [PROGRESS.md](../PROGRESS.md).

This doc answers three things: what graph engineering actually is, where this
repo is **already doing it** (more than you probably realise), and the specific
places where adopting it deliberately would catch bugs that line-by-line review
structurally cannot.

---

## 1. What graph engineering is

> **Graph engineering is the practice of promoting the *relations* in a system
> into first-class, stored, queryable objects — and then using graph algorithms
> and graph invariants as your correctness tools.**

The contrast is with the default, which is leaving relations **implicit in
control flow**. A rule like "an application may go from `approved` to `applying`,
but never from `tailored` to `applying`" can live in two places:

```ts
// IMPLICIT — the relation exists only as the shape of the code
if (status === 'approved' && target === 'applying') { /* allow */ }
else if (status === 'tailored' && target === 'applying') { throw new Error(); }
```

```sql
-- REIFIED — the relation is a row you can query, count, diff and render
insert into application_status_transitions (from_status, to_status, allowed_agents)
values ('approved', 'applying', array['applier']);
```

Both behave identically on the happy path. They differ in what you can **ask**.
Only the second lets you ask *"how many edges lead into `applying`?"* and get an
answer from the system rather than from a careful reading.

**That question is Constraint 15.** This repo's single most important safety
rule — never submit without human approval — is, stated precisely, a claim about
the **in-degree of one node**. Reification is what turns it from a rule you hope
holds into a number you can measure.

### The central move, named

**Reification** — take an implicit relation and make it a stored object with
properties. Everything else in graph engineering follows from having done this.

### The three levels, because they get conflated

| Level | What it means | In this repo |
|---|---|---|
| **1. Graph as data model** | Your domain entities and their relations are nodes and edges you persist | `MasterProfile` nodes + `ref` edges (§2.2) |
| **2. Graph as control structure** | The *allowed behaviour* of the system is itself a graph, stored and consulted at runtime | `application_status_transitions` (§2.1) |
| **3. Graph as reasoning tool** | You store no graph, but you *analyse* the system by drawing one | Build deps, peer write-ownership, verification coverage (§2.3, §5) |

Most teams only ever reach for level 1 and think that's the whole topic. **Level 2
is where the safety comes from, and level 3 is free** — it needs no code at all,
only the discipline to draw the thing.

### What graph engineering is NOT

**It is not "use a graph database."** Say this out loud before anyone suggests
Neo4j. This repo's status graph is ~20 nodes and 45 edges. A Postgres table with
a `WITH RECURSIVE` query handles it with room to spare, and it already does.
Adding a graph database here would add an operational dependency, a second source
of truth, and a sync problem, in exchange for nothing. See §6.

---

## 2. The graphs already in `applyyy`

You are further into this than you think. Four real graphs exist in the repo
today, and the best one is genuinely well engineered.

### 2.1 The status graph — a textbook level-2 implementation

`supabase/migrations/20260909234900_status_transition_guard.sql` creates
`public.application_status_transitions`: one row per legal move, with
`from_status`, `to_status`, `allowed_agents[]` and a `note`. A `BEFORE UPDATE`
trigger refuses any move not in the table. `packages/shared-types/src/status-flow.ts`
mirrors it for the client, and is explicit that it is **a mirror, not the rule**.

Three things here are done right, and each has a name worth knowing:

**(a) Edge-labelled authorisation.** `allowed_agents` is a property of the
**edge**, not of the node or the actor. This is the non-obvious choice and it is
the correct one. Node-level permissions ("the tailor may write applications")
cannot express "a machine may move `applied → interview` but only a human may
move `awaiting_approval → approved`" — because both are writes to the same table
by the same role. Putting authority on the edge makes the permission as granular
as the transition itself.

**(b) The single-entry invariant.** From `status-flow.ts`:

> `approved` is the ONLY row in this table whose `to` is `applying`. Constraint 15
> therefore cannot be violated by a bug in any agent, because no other edge into
> `applying` exists to be reached.

In graph terms that edge is a **bridge** (a cut edge): remove it and the
irreversible half of the graph becomes unreachable from the reversible half. The
safety argument is a **reachability** argument, and it holds against *any* agent
bug — you don't have to audit the agents, only the edge set. That is a much
stronger claim than "we reviewed the code."

**(c) The comment that corrected itself.** `status-flow.ts` originally claimed
"there is no backward path for a bug to wander down," was corrected on
2026-09-10 to name the seven real backward edges, and now states the narrower
true property: *no backward edge on the automated forward path, and every
backward edge but one is human-only.* Keeping the retraction visible is the right
call. Note what the correction is, structurally: **a claim about the whole graph
that was only ever verified edge by edge.** Hold that thought for §3.

### 2.2 The provenance DAG — level 1, and it's the anti-fabrication defence

`packages/shared-types/src/profile-nodes.ts` opens by declaring itself the
anti-fabrication defence, ahead of the Auditor agent. The mechanism is a graph:

```
MasterProfile          human-maintained truth; versioned, immutable
     │  Tailor (Gemini) may only SELECT and REWORD — emits refs, never prose nodes
     ▼
TailoredProfile        refs + rewordings. No field exists to put a new fact in.
     │  validator (typed code, no LLM) resolves every ref against the PINNED master
     ▼
ResolvedResume         fully denormalised; renders with no lookups
```

Read that as a graph and the defence becomes obvious: **every node in the output
must have an in-edge from the truth graph.** A prompt injection saying "add
Docker to the skills" can only produce either a `ref` to an id that isn't in the
master — caught by the validator, before the Auditor runs — or a reworded real
skill, which is harmless. The attack has nowhere to land because *there is no
node without a parent*.

This is **referential integrity applied to a semantic graph**, and the reason it
works is the one-line rule the file guards jealously: `ref` is non-optional
everywhere. An optional `ref` is an orphan node, and an orphan node is a
fabricated claim.

`applyyy-6f` reports a bug from exactly this graph: a **per-section** node-id
uniqueness checker passed 34 of 36 tests and nearly shipped, when ids must be
unique across the **entire** profile. The graph framing predicts that bug for
free — *if your edges carry a bare id, your node set must be flat and global.*
A per-section id space would require every ref to be a compound `(section, id)`
key. The uniqueness scope isn't a taste question; it's determined by the shape of
the edge.

### 2.3 Two graphs you already reason about without naming

**The agent pipeline** ([architecture/agents.md](agents.md)) is a DAG:
Scout → Normalizer → Screener → Matcher → Tailor → Auditor → human → Applier → Tracker.
Each stage is a node, each stage's output the next stage's input. The Screener
deliberately makes no Gemini call, so the expensive nodes sit *downstream* of the
cheap filters — that's **cost-aware topological ordering**, and it's the reason
the filter cascade exists at all.

**The content-hash chain** is a small Merkle-ish DAG that's currently in pieces:
`content_hash` on the master profile, `tailored_hash` as a cache key,
`resume_sha256` on applications (added today in
`20260911114300_add_resume_sha256_to_applications.sql`). Each hash names a node;
each derivation is an edge. Assembled, it answers a real product question — §4.4.

---

## 3. The technique that finds bugs: invariant-as-query

Here is the whole argument for graph engineering in one line:

> **Local review examines edges. Graph analysis examines the graph. They find
> different bugs, and only one of them scales.**

Once a graph is reified, properties of the *whole* become queries. Some that
matter here:

| Invariant | Query | Why it matters |
|---|---|---|
| In-degree of `applying` is exactly 1 | `count(*) where to_status='applying'` | **Constraint 15, as a number** |
| Every non-terminal status reaches a terminal one | recursive reachability | No dead-end rows that nothing can ever move |
| The machine-traversable subgraph is acyclic | cycle detection over edges whose `allowed_agents` is not human-only | **No unbounded automated loop** |
| Declared graph == live graph | diff `STATUS_TRANSITIONS` against the live table | The mirror is actually a mirror |

### 3.1 Running the third one by hand found something

I checked the third invariant against `status-flow.ts` and the migration, and it
**does not hold**. Two edges:

```ts
{ from: 'oa_pending', to: 'interview', allowedAgents: ['tracker', 'human'] }
{ from: 'interview',  to: 'oa_pending', allowedAgents: ['tracker', 'human'] }
```

Both are traversable by `tracker`, which is an automated agent that classifies
inbound email **with Gemini** ([agents.md](agents.md) row 9). So the
machine-reachable subgraph contains a 2-cycle, and I found no traversal counter,
no per-edge bound, and no `status_history` table anywhere in
`supabase/migrations/**` (grepped for `transition_count`, `status_history`,
`revisit`, `oscillat`).

**To be fair to the code, and precise:** the edge is correct and should exist —
multi-round loops really do send an assessment after an interview, and the file
says so. `status-flow.ts` even identifies it as *"THE ONE REVERSE EDGE A MACHINE
CAN WALK."* What was never stated is the **graph-level consequence** of that
observation: it is the only cycle in the machine-reachable subgraph, and nothing
bounds how many times a misclassifying LLM can walk it. A flaky classifier
alternating between "assessment invite" and "interview invite" on a noisy email
thread moves the row back and forth indefinitely, and every traversal is a legal,
audited, entirely unsuspicious status write.

**This is the lesson, not the bug.** The repo reviewed that edge carefully, one
edge at a time, and reached a correct conclusion *about the edge*. The cycle is a
property of the **pair**, and pairwise properties are exactly what edge-by-edge
review is structurally blind to. A twelve-line cycle-detection test finds it
mechanically and would have found it on day one.

**It is also the same shape as the correction already recorded in
`status-flow.ts`** — "no backward edges" was a whole-graph claim verified
edge-by-edge, and it was wrong. Second instance of one pattern. That is what makes
it worth a rule rather than a fix.

Not my call whether to bound the cycle or merely monitor it — that's a product
decision about how much you trust the classifier. Either is defensible; silently
not knowing is not.

### 3.2 Coverage is a reachability property

`applyyy-6f` reports two files that typecheck against nothing:
`apps/web/src/features/settings/masterIngest.ts` validates `unknown` and casts,
and `supabase/functions/deno.json` excludes `**/*.test.ts` from `deno check`, so
two typed `MasterProfile` fixtures there are checked by no tool at all.

Independently, [agents.md](agents.md) records that **31 kill-switch tests under
`supabase/functions/_shared/agent/` were unreachable by every runner in the repo**
until commit `5d367b4` — and nobody noticed, because the suite was green.

These are the same bug. Draw a bipartite graph: source files on one side,
verification tools (tsc, `deno check`, each test runner) on the other, an edge
wherever a tool actually checks a file. **The bug is a file with in-degree
zero.** "Typecheck passes" is then revealed as a statement about the *covered
subgraph* only — which is precisely the thesis of your own
[verification-traps.md](../verification-traps.md).

You have hit this at least three times now (31 tests, the `deno.json` exclusion,
the `unknown` cast). Three instances of one graph property is the point at which
you stop fixing instances and start computing the property. See §4.3.

### 3.3 The live demonstration: three sessions, three beliefs, one table

While I was writing this, the "how many migrations are applied" question was
answered three different ways within one hour:

| Source | Claim | Basis |
|---|---|---|
| `applyyy-d8` (orchestrator) | 4 unapplied | `docs/audit/2026-09-10-schema-invariants-verified.md:265` |
| `applyyy-ff` | 4 unapplied | same audit doc, reached independently |
| `applyyy-76` | **2 unapplied** | `supabase migration list` run against live at **11:46 on 2026-09-11** |

`applyyy-76` was right **on 2026-09-11**, and the other two were reading a document
that had aged. ~~Applied now: everything through `20260910212600`. **Genuinely
unapplied: exactly two** — `20260910220800_create_private_storage_buckets.sql` and
`20260911114300_add_resume_sha256_to_applications.sql`.~~ Per `76`, this makes
Instance 11 of [verification-traps.md](../verification-traps.md) **stale in its
specifics** while its rule — *read files for intent, query the database for
behaviour* — just proved itself again.

> **SUPERSEDED 2026-09-18 — and this section had become an instance of the very trap
> it documents.** The measurement above was written with a bare clock time, *"11:46"*,
> and no date. Two later sessions read it as current. It is **2026-09-11 11:46** (this
> file's commit `98b28bd` is 2026-09-11 12:09). **A time without a date is a claim
> without an expiry.**
>
> Re-measured 2026-09-18 ≈ 13:00 IST with `supabase migration list --linked`
> (CLI `2.117.0`, linked to `xynqxekcqizwhtskzqrq`): **18 local migrations, 15 applied,
> THREE pending** — `20260917124500`, `20260917130000`, `20260917174600`. **Both files
> named as unapplied above are now on the remote**, as are `20260911235500`,
> `20260912001500` and `20260912120000`. Confirmed independently for the first of them:
> all four `applyy owner%` policies on `storage.objects` exist live.
>
> **Do not quote a number from this page — run the command.** Any inventory here can
> drift, so it must point at what regenerates it rather than at the list alone:
>
> ```bash
> supabase migration list --linked     # authoritative; network only, no Docker
> ```
>
> The *lesson* of the table above survives intact and is the reason the section stays:
> two sessions agreeing from one document is one observation counted twice. The lesson
> aged well; the number did not. **Date-stamp every measurement, including this one.**

Two agreeing sessions were still wrong, because they shared a source rather than
a measurement. Agreement between readers of the same document is not
corroboration; it's one observation counted twice. Only `76` had an edge to the
database itself.

**And the enabling fact, which several sessions had wrong:** the remote *is*
reachable read-only with no Docker —

```
supabase db query --linked "<sql>"
```

goes via the Management API. Sessions had been assuming live-schema questions were
unanswerable without `supabase start`. They aren't. That single command is what
makes every "declared vs live" diff in §4 actually runnable today.

---

## 4. What to actually do — ranked by payoff, not by elegance

### 4.1 A contract test that diffs the declared graph against the live one — **do this first**

`status-flow.ts` says *"if you change one you must change both, and
SCHEMA_CONTRACT.md carries the checklist."* That's a **human protocol guarding a
machine-checkable property**, and it has already drifted: [agents.md](agents.md)
records the live table at **45 edges** while `PROJECT_PLAN` and several docs still
say 44. The docs were reconciled by someone noticing. That doesn't scale, and §3.3
is what "that doesn't scale" looks like in practice.

A test that reads `application_status_transitions` from the live database and
diffs it against `STATUS_TRANSITIONS` — as sets, both directions, including
`allowed_agents` — replaces the checklist with a failure. It is maybe forty lines,
`supabase db query --linked` already gives it the read path, and it retires an
entire class of drift.

It also generalises: **migrations-in-git vs migrations-applied is the same diff at
a different layer.** "File exists" and "edge exists in the live graph" are
different facts. A declared-vs-measured diff is the general remedy, and the status
table is the cheapest place to build the habit.

### 4.2 A graph-invariant test suite over the transition table

Six assertions, run against the live table:

1. In-degree of `applying` is exactly 1, and that edge's source is `approved`.
2. The `awaiting_approval → approved` edge is `['human']` only.
3. Every non-terminal status reaches a terminal status (no dead ends).
4. Every status except `discovered` has in-degree ≥ 1 (no unreachable nodes).
5. No self-loops — already enforced by a CHECK constraint; assert it anyway so the
   intent lives in the test suite and not only in DDL.
6. **The machine-traversable subgraph is acyclic** — this one fails today (§3.1),
   which makes it the most valuable test in the list. Write it red, watch it fail,
   *then* decide what the rule should be.

Note what #1 and #2 give you: Constraint 15 stops being a paragraph in
`PROJECT_PLAN` and becomes two assertions. A constraint you can't measure is a
constraint you're trusting, and this codebase has a good instinct for not trusting
things.

**Write these with `superpowers:test-driven-development`** — red first. In a suite
where "all-green on first run is suspicious" is already house doctrine, an
invariant test that passes immediately is telling you nothing about whether it
*can* fail.

### 4.3 Compute the verification-coverage graph

Enumerate every `.ts` file; enumerate what each tool actually checks (`tsconfig`
includes, `deno.json` includes/excludes, each runner's discovery glob); report
files with **zero** in-edges. Short script, not clever, and it would have caught
all three instances in §3.2 before any of them cost a debugging session.

Pair it with the count-before-and-after discipline the orchestrator already briefs
workers on ("verify your new tests actually RUN — count them before and after").
That discipline catches the *next* unreachable test. The coverage graph catches the
ones **already** sitting there — including, per `applyyy-6f`, two that are sitting
there right now.

### 4.4 Assemble the provenance DAG — the one with product value

The pieces exist: `content_hash` (master), `tailored_hash` (cache key),
`resume_sha256` (applications). What doesn't exist is the ability to traverse them.

The question this answers is real and will eventually be urgent:

> **"I just corrected a date on my master profile. Which already-submitted
> applications contain the old version?"**

That is an ancestor query on a provenance DAG — reverse-reachability from a master
node to every `ResolvedResume` that refs it, to every application that froze that
resume. Because `ref` is non-optional and node ids are stable across versions
(`profile-nodes.ts` is explicit that cross-version stability is what makes a ref
meaningful six months later), **the graph needed to answer it is already fully
determined by your types.** It just isn't persisted in a queryable form. That is
the only gap.

This is also the payoff for `applyyy-ff`'s current work: a re-uploaded profile that
preserves node ids keeps the provenance graph connected. One that mints new ids
severs every historical edge, and the corrected-fact query silently returns
nothing. Worth telling `ff` explicitly — id preservation isn't a nicety, it's what
keeps this query answerable at all.

### 4.5 Name what `master-ingest` actually is

`packages/master-ingest/src/match-keys.ts` + `reconcile.ts` are solving **entity
resolution over a node set**: given the old node set and a newly uploaded one, find
the correspondence, and carry ids across it. Calling it that unlocks the existing
literature — blocking keys, match confidence, the precision/recall trade-off on the
match threshold — and it clarifies the review surface: every node the matcher is
*unsure* about is an edge it might get wrong, and a wrong edge silently rewrites
history. Which is exactly why `ff`'s screen puts risky rows in front of a human — a
good instinct that the graph framing justifies rather than replaces.

---

## 5. The graph you are standing inside: peer-session orchestration

This is level 3, and it's the part that generalises past this repo.

**Write-ownership partitioning is graph colouring.** Build a *conflict graph*:
nodes are tasks, and an edge joins two tasks that write the same file. Your rule
"no two workers may write the same file" is exactly "assign tasks to workers so
that no two adjacent tasks share a worker." Today's partition:

| Session | Owns |
|---|---|
| `applyyy-d8` | orchestrator — **no repo writes, deliberately** |
| `applyyy-6f` | `packages/shared-types/**`, `packages/master-ingest/**` |
| `applyyy-76` | `worker/**`, plus `supabase/migrations/**` transferred ~11:42 |
| `applyyy-ff` | `apps/web/**` |
| `applyyy-65` | `packages/master-pdf/**` (new package) |
| — | `supabase/functions/**` — **unowned as of 11:47** |
| `applyyy-a6` (me) | nothing — explainer |

Four observations that only the graph view gives you:

**(a) The critical path is `applyyy-6f`.** Its four new fields land as *required*
on `MasterProfile`, breaking construction sites in `apps/web` (`ff`),
`worker/test` (`76`), `packages/resume-template` and
`supabase/functions/_shared/tailor`. Nothing inbound blocks `6f`; several things
wait on it. In a task DAG that's the longest path, and it's where an extra worker
actually buys wall-clock time. Adding a sixth worker to a leaf task buys none.

**(b) `applyyy-ff` did the right thing and it has a name.** It contained the blast
radius of `6f`'s change to a single fixture builder in its tests. Graph terms: **it
replaced N direct edges from call-sites to the type with a star through one hub
node.** That's fan-in reduction, and it turns an O(N) edit into an O(1) edit. Worth
stealing across the other partitions *before* `6f` lands — `76` and `65` will each
take the same break.

**(c) The partition has a hole, and it's the git index.** Five sessions share one
working tree, one index, one `.git`. The ownership graph partitions **file nodes**
— but `git add -A` and `git stash` operate on the **root**, crossing every
partition at once. That asymmetry is why `git add -A` cost this repo 392 lines on
2026-09-10. The remedy in force is the right one: stage by explicit path, and
`git commit -m "..." -- <the same explicit paths>`, where the pathspec is the actual
safety mechanism because it makes the commit ignore the rest of the shared index.
**General rule: a partition scheme is only as good as its coarsest operation.**

**(d) Shared reads are not free when the shared thing is stale.** §3.3 is a
partition failure of a kind the write-ownership rule doesn't cover: three sessions
read one document, two inherited its error. The rule prevents write collisions; it
says nothing about **correlated belief**. The fix isn't more partitioning, it's
preferring a measurement edge to the system over a citation edge to a document.

### 5.1 The best structural finding of the session isn't mine

`applyyy-d8` relayed a commit-authority override from Teja. **Two peers refused
it** — correctly, citing a rule `d8` had itself written into their briefs. Their
argument: from the receiving end, an accurate relay and a mistaken one are
indistinguishable; the cost of wrongly refusing is one command Teja types, the cost
of wrongly complying is a forbidden write in history shared by five sessions. `d8`
accepted it.

Stated as a graph property: **authority does not propagate along the coordination
graph.** The message graph (who can talk to whom) and the trust graph (whose say-so
authorises an action) are different graphs over the same nodes, and an edge in the
first does not imply an edge in the second. Trust is not transitive — a fact about
this topology, not a politeness.

Design consequence worth keeping: when you brief workers, give them rules that let
them refuse **you**. `d8` wrote the rule that caused its own relay to bounce, and
the system was safer for it.

---

## 6. What not to do

- **Do not add a graph database.** ~20 nodes, 45 edges. `WITH RECURSIVE` in
  Postgres is the correct tool, needs no new dependency, and keeps the graph in the
  same transaction as the rows it constrains. A separate graph store would create a
  second source of truth for the one table whose authority is the entire safety
  argument.
- **Do not move the status graph out of Postgres into TypeScript.** The trigger is
  what makes the rule hold for clients that never read `status-flow.ts`. That file
  is correct to call itself a mirror; keep the direction of authority as it is.
- **Do not reify relations that have no invariants.** Reification costs
  indirection. It pays when you have a whole-graph property to assert. A relation
  you only ever traverse one hop, and never assert anything about, is better as a
  foreign key.
- **Do not let a drawn graph go stale.** A diagram nobody diffs against reality
  becomes the most confidently wrong document in the repo — which is exactly the
  failure [agents.md](agents.md) opens by warning about, and exactly what happened
  to the migration count in §3.3.

---

## 7. Tooling, concretely

| Want | Use | Note |
|---|---|---|
| See the 45-edge status graph | Mermaid `stateDiagram-v2`, published as an **Artifact** | Artifacts render Mermaid natively, no library needed. Generate the source **from the live table**, never hand-drawn |
| The same on a FigJam canvas | `/figma-generate-diagram` | Installed, unused. Good for walking a human through the approval gate |
| Write the invariant tests | `superpowers:test-driven-development` | Red first — §4.2 #6 should fail on its first run |
| Review the invariant suite | `/code-review` | Reads a diff; point it at the new tests |
| Recursive reachability SQL | `supabase:supabase-postgres-best-practices` | Load **before** writing the CTE, per its own trigger rule |
| Read live schema with no Docker | `supabase db query --linked "<sql>"` | Via the Management API. Verified by `applyyy-76` at 11:46 |
| Sanity-check the ownership partition | `ListAgents` + `SendMessage` | How §5 was built; four messages, ten minutes |

**Capability gap in your setup:** there is no `pnpm` script anywhere that answers
*"does the live database match what the repo declares?"* Every check of that kind so
far has been a human running a query and writing a markdown file — and §3.3 shows
what happens to those markdown files a day later. That is the highest-leverage
missing automation in this repo, and §4.1 is its smallest useful version.

---

## 8. Two problems in the context I was given

Per the standing instruction to audit context rather than follow it blindly:

**(a) I got this wrong when I first wrote it, and the way I got it wrong is the
point.** The original text here said the memory file `git-commit-authority-granted.md`
contradicted a global `CLAUDE.md` that still read *"Never `git commit`"*, and asked
Teja to settle it.

**That was already false when I wrote it.** `applyyy-65` rewrote that section of
`~/.claude/CLAUDE.md` at **11:48:52** — verified by `stat` — and I wrote this doc at
about 11:52. The file on disk had authorised commit and push for four minutes. I was
reading the copy of `CLAUDE.md` loaded into my session prompt at startup, which
predated the edit, and never checked the file itself.

So: **a cached artifact, a real change, and a confident claim about current state
drawn from a snapshot.** That is Instance 11 of
[verification-traps.md](../verification-traps.md) — *read files for intent, query the
live system for behaviour* — arriving in the one document that spends a whole section
(§3.3) explaining why three other sessions fell into it. My session prompt was the
stale audit doc, and I cited it exactly the way `applyyy-d8` and `applyyy-ff` cited
theirs.

**The live state, measured 12:00:** `~/.claude/CLAUDE.md` mtime `2026-09-11 11:48:52`;
its git section now reads *"Git — commit and push are authorized (since 2026-09-11)"*,
mandates the `-- <explicit paths>` pathspec form, keeps `git add -A` and `git stash`
forbidden, and states that authority never travels by relay. Pre-edit backup at
`C:\Users\tejam\.claude\backups\CLAUDE.md.2026-09-11-pre-git-grant.md`.

**What still needs Teja, and it is not the contradiction I originally claimed:** the
grant's *scope* widened from `applyyy` to every project, including `1on1`, where "I
push to GitHub myself" was standing policy. And the edit lives outside every
repository, so no `git status`, diff or review will ever surface it. Details and the
full argument are in
[status/2026-09-11-session-accounting.md](../status/2026-09-11-session-accounting.md) §6.3.

**(b) The global `CLAUDE.md` does not know this project exists.** Its "Projects"
section documents `1on1` and `1on1_sb` in detail — including a long passage on the
naming collision between them — and says nothing about `applyyy`, where all of
today's work is happening. The generic rules (comment-every-line, the fan-out
protocol, pnpm-only, the git rules) do apply here and are being followed. But a new
session reading that file builds a detailed mental model of two repositories it is
not in. Worth a short `applyyy` entry, or a repo-local `CLAUDE.md` carrying the
stack, the `DRY_RUN` constraint, and the migrations-vs-live caveat.

---

## 9. The one-paragraph version

You are already doing graph engineering at level 2 — the status transition table is
a properly reified, edge-labelled control graph, and Constraint 15 is enforced as a
reachability property rather than as a code review. The gap is that **nothing
queries it as a graph.** Every whole-graph claim in this repo so far has been
verified edge by edge, by a human, in prose — and that method has now produced one
corrected claim ("no backward edges", 2026-09-10), one unstated consequence (the
`interview ↔ oa_pending` machine-traversable cycle, §3.1), and one stale fact that
two sessions inherited from a third (§3.3). Six assertions and a declared-vs-live
diff would convert the most important safety properties in the system from things
you believe into things you measure. That conversion — not any new dependency — is
the whole of what adopting graph engineering means here.
