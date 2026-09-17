# Two gaps in the pipeline's safety case — a proposal

**Status:** Gap 1 — PROPOSAL ONLY, no SQL, target recorded for a later coordinated
landing. Gap 2 — approach approved, SQL pending this document's review.
**Ruling 2026-09-17:** option **A** — close Gap 2 now, carry Gap 1 as a written
proposal targeting option **B**.
**Written:** 2026-09-17 by `applyyy-85`.
**Subject:** `supabase/migrations/20260909234900_status_transition_guard.sql`, the file
the repo calls *"THE SAFETY CASE FOR THE WHOLE SYSTEM"*, and
`public.advance_application_status()`.

> **Companion document:** `docs/security/2026-09-17-dependency-remediation-plan.md`
> is a *different* topic owned by a different session. This file covers pipeline
> identity and status-transition integrity only.

---

## The claim under examination

The guard's header states the safety case in one sentence:

> EVERY edge into `approved` is human-only, and `approved → applying` is the only edge
> into `applying` in the entire graph, so **CONSTRAINT 15 — never submit without human
> approval — is UNREACHABLE BY CONSTRUCTION** rather than enforced by code review.

That claim is **true of the transition graph** and I found no counterexample in it. Both
gaps below leave the graph intact and get around it by other means:

- **Gap 2** never enters the graph at all — the trigger is `BEFORE UPDATE`, so an
  INSERT walks past it.
- **Gap 1** enters the graph legitimately but as **whoever it says it is**, because the
  guard validates a *claimed* identity, not an authenticated one.

Both are the same disease this repo keeps finding: **something unverified becoming an
answer.** Here the unverified thing is *who is acting*, and the answer is *permission*.

---

## Gap 2 — the guard is `BEFORE UPDATE`; INSERT bypasses it entirely

### The hole

`20260909234900_status_transition_guard.sql:266`:

```sql
create trigger guard_status_transition
  before update on public.applications
  for each row execute function applyy_internal.guard_status_transition();
```

There is no INSERT trigger. A row inserted directly at `status: 'approved'` — or at
`'applying'` — has traversed no edge, consulted no `allowed_agents`, and written no
`application_events` witness. The entire transition graph is opt-in by way of *arriving
through an UPDATE*.

Found by `applyyy-c8`. Confirmed independently here.

### This is known, relied upon, and correctly bounded today

`supabase/functions/scout-ats/index.ts` states the dependency outright:

> *The row is BORN at its verdict rather than inserted at 'discovered' and then
> transitioned: the status guard fires only on UPDATE and its legal source state is
> 'deduped', which nothing in this repo ever writes.*

And `supabase/functions/_shared/screen/screen-batch.ts:28-44` already treats its insert
status as a **safety control**, naming this exact hole:

```ts
// THIS CLOSED UNION IS A SAFETY CONTROL, NOT A CONVENIENCE. The status transition guard
// (20260909234900_status_transition_guard.sql:266) is declared `before update on
// public.applications` — it does not fire on INSERT. ...
// So an insert helper that accepted the full `application_status` would be a way to
// manufacture a row already sitting at 'approved' or 'applying', bypassing the approval
// gate entirely.
export type ScreenedInsertStatus = "passed_filters" | "dropped_filter";
```

**So today the hole is closed by a TypeScript union in one Deno module.** That is a real
control and a well-reasoned one — but it binds only code that imports it. It does not
bind the REST API, the SQL editor, a future module, or the browser, all of which can
insert into `applications` directly. Widening that union, or writing a sixth insert
site that does not use it, silently reopens the gate.

*The type is a control over one call path. The gap is that the table has no control at
all.*

### The complete INSERT surface, enumerated

Exhaustive search of the repo (excluding `node_modules/`, `reference/`, and the
compiled `apps/web/dist/`). **Five write sites, three distinct status values.**

| # | Site | Status(es) written | When |
|---|---|---|---|
| 1 | `worker/src/cli/scout.ts:314` | `passed_filters`, `dropped_filter` | screener context loaded |
| 1b | `worker/src/cli/scout.ts:312` | `discovered` | **screener context unavailable — live fallback** |
| 2 | `supabase/functions/scout-ats/index.ts:402` | `passed_filters`, `dropped_filter` | screener context loaded |
| 2b | `supabase/functions/scout-ats/index.ts:400` | `discovered` | screener context unavailable |
| 3 | `worker/src/cli/scout-remote.ts:343` | `discovered` | always (tier-3 aggregator, unscreened) |
| 4 | `apps/web/src/data/discoveryService.ts:358` | `discovered` | always |
| 5 | `apps/web/src/data/discoveryService.ts:505` | `discovered` | always (Ashby direct-CORS path) |
| 6 | `core_tables.sql:314` — column DEFAULT | `discovered` | any INSERT omitting `status` |

**Zero SQL `insert into public.applications` statements exist in any migration.** No
seed file creates application rows.

**Minimum safe allowlist: `('discovered', 'passed_filters', 'dropped_filter')`.**

Anything narrower is an outage. Note particularly that `discovered` is **not** a
cold-start-only value: sites 1b and 2b fire on *any* transient failure of the four
screener context reads.

### A failure shape worth naming: the guard that fails when it should pass

I nearly proposed treating `discovered` as vestigial and excluding it. Had that shipped,
both screened scouts would break **on any transient failure of a screener context read**
— that is, the guard would fire hardest exactly when the database was already having a
bad day, converting a recoverable blip into an outage.

> Every other defect chased today was a guard that **passes when it should fail**. This
> is the mirror image: a guard that **fails when it should pass**.

It deserves its own name because the instinct that produces it *feels like diligence*.
"This value looks legacy, let's tighten it" is the same motion as "this input looks
unvalidated, let's check it" — and only one of them is safe to act on without
enumerating the callers first.

The defence is the same in both directions: **enumerate, don't assume.** An assumed
allowlist produces this trap; an enumerated one cannot.

### Two trigger-design traps, both of which I would have walked into

**1. `ON CONFLICT DO NOTHING` means the trigger fires on rows that are then discarded.**
Every applications upsert uses `ignoreDuplicates: true`. In Postgres a `BEFORE INSERT`
trigger fires **before** conflict detection, so on every re-poll the trigger runs for
`(user_id, job_id)` pairs that already exist — including pairs whose stored row is
currently at `approved` or `applied`.

> **Consequence: the trigger must judge `new.status` ALONE.** Any check that looks up
> the existing row — "is this a re-insert over an approved row?" — would refuse routine
> re-polling of a job the user has already applied to. That is a daily occurrence, and
> it would present as the scout mysteriously failing on exactly the user's most
> advanced applications.

> **A TRIGGER THAT CONSULTS OTHER ROWS IS REASONING ABOUT A WORLD THAT `ON CONFLICT`
> HAS NOT RESOLVED YET.** Worth carrying to any future trigger on this table.

I would have written the smart version. `ignoreDuplicates: true` is four tokens inside a
call nobody reads closely, and nothing about the surrounding code advertises that it
changes when the trigger fires.

**2. Column defaults are applied before `BEFORE` row triggers.** An INSERT omitting
`status` arrives at the trigger already carrying `'discovered'`, so a plain
`new.status not in (...)` covers the omitted case with no special handling.

### Proposed fix

A `BEFORE INSERT` trigger on `public.applications` that refuses any status outside the
three-value allowlist. Approximately fifteen lines of PL/pgSQL plus the trigger.

**Blast radius: none that I can find.** All five live insert sites write only allowed
values, verified above. The refusal surface is exactly the values nothing legitimately
inserts.

**What it does NOT do, deliberately:** it does not validate that an inserted row is
*reachable* in the graph, and it does not write an `application_events` witness for
inserts. Both are larger changes; this one closes the submit-gate bypass, which is the
part constraint 15 rests on.

**The desync risk, named so it can be watched:** the allowlist duplicates a fact that
also lives in `screen-batch.ts:44`. Widening that union without widening the trigger
produces a production insert failure; widening the trigger without cause reopens the
hole. The trigger is the authority — it binds every caller, the union binds one module
— and the migration comment will say so.

**Confidence: high.** Bounded, enumerable, and the enumeration was exhaustive.

---

## Gap 1 — identity is claimed, never authenticated

### The hole

`advance_application_status(p_application_id, p_to_status, p_agent, p_detail)` takes
`p_agent` as an **ordinary caller-supplied argument** and writes it into a
transaction-local setting:

```sql
perform pg_catalog.set_config('applyy.acting_agent', p_agent::text, true);
```

`guard_status_transition()` then reads that setting and checks it against
`allowed_agents`. The check is real; **the identity it checks is not.** Nothing anywhere
verifies that the caller claiming to be `'applier'` is the applier.

The function is `security invoker` — deliberately, with the rationale at
`queue_and_pool_functions.sql:12-18` — so RLS is in force.

### What this is NOT — stated first, because it cuts against the finding

**This is not cross-tenant.** RLS means a caller can only move *their own* rows. Nobody
can drive a stranger's pipeline. A headline of "a browser can impersonate the applier"
overstates it.

The real exposure is narrower and still worth fixing:

> The database cannot distinguish **"the human clicked approve"** from **"JavaScript
> running in the human's browser called approve."**

Constraint 15 rests on precisely that distinction, and the distinction does not exist in
the schema. The threat model is XSS, a malicious browser extension, or a compromised npm
dependency inside a bundle that already holds the anon key — not an external attacker.

### Why this cannot be fixed in a migration alone: **the dashboard already depends on it**

`apps/web/src/features/discovery/DiscoveredJobsPage.tsx:242-262`. The "Fast-tailor &
queue" button, from the browser, holding the anon key:

```ts
const pipelineSteps = [
  { to: 'deduped',           agent: 'normalizer' },
  { to: 'passed_filters',    agent: 'screener'   },
  { to: 'scored',            agent: 'matcher'    },
  { to: 'tailored',          agent: 'tailor'     },
  { to: 'audit_clean',       agent: 'auditor'    },
  { to: 'awaiting_approval', agent: 'auditor'    },
];
for (const step of pipelineSteps) {
  await supabase.rpc('advance_application_status', { ..., p_agent: step.agent });
}
```

**A browser impersonates six agents in sequence.** This is shipped and working, and it
works *only because* `p_agent` is unauthenticated. Any fix that authenticates identity
returns `42501` six times and breaks this button.

> The gap is not dormant. It is load-bearing.

### A separate and more serious problem on that same code path

Steps 5 and 6 claim `auditor` and write `audit_clean`, then `awaiting_approval` —
**without the Auditor having run.** No tracing, no fabrication check.

The row arrives in the human approval queue wearing an `audit_clean` badge that nothing
earned. PROJECT_PLAN §10 makes the Auditor defence-in-depth behind the Tailor validator;
the two-bucket approval design exists so a human can **batch-approve the clean ones** and
individually review the flagged ones.

> A row labelled clean without being audited is exactly the row that gets batch-approved
> unseen.

**The graph itself says so.** The final edge the button traverses is seeded at
`20260909234900_status_transition_guard.sql:126` with this note:

```sql
('audit_clean', 'awaiting_approval', array['auditor']::public.agent_name[],
 'Bucket A - eligible for one-click batch approval.'),
```

So the edge the browser walks while claiming to be the Auditor is the one the schema
explicitly designates as **the one-click batch-approval lane**. The row lands in the
lane designed for rows that were checked, having not been checked, and the diff it
presents shows nothing changed because nothing ran.

This is the day's recurring pattern at the highest stakes it has appeared: **a confident
assertion standing in for work that never happened.** The difference here is that
believing the label means sending an unaudited resume to a real employer.

`ApprovalQueuePage.tsx:254-259` states the safety case correctly — *"this function is the
single door to submission in the whole system"* — and that remains true. **The door is
sound. The label on what arrives at the door is not.**

This is `apps/web` (not this parcel's partition) and is a product decision besides. It is
recorded here because "batch-approve the fully-traced ones" is only safe if `audit_clean`
means audited, and for rows queued through that button it does not. **Routed to Teja.**

### Three options, with the trade-off exposed

| | Approach | Closes the hole? | Breaks the button? | Cost |
|---|---|---|---|---|
| **A** | Ship Gap 2 now; deliver Gap 1 as a written proposal requiring a coordinated `apps/web` change | Gap 2 only | No | Hole stays open until two partitions land together |
| **B** | Derive the actor from the JWT role: `anon`/`authenticated` may only ever act as `'human'`; service role may name a machine agent | Yes | **Yes** — all six impersonations collapse to `'human'`, and no `discovered → deduped ['human']` edge exists | Small in SQL, requires a matching frontend change |
| **C** | B, plus seed `['human']` edges for the six moves the dashboard makes | Yes | No | Changes the safety-case table; encodes *"a human may declare a row audit-clean"* as policy |

**Recommendation: A for this parcel, with B written up as the target.**

Reasoning, exposed so it can be disagreed with rather than just accepted:

1. **B and C both change who may do what.** That is a policy change wearing a security
   fix's clothes. Option C in particular would write into the graph that a human may
   personally declare a row `audit_clean` — which may well be the right answer for a
   single-user tool, but it is Teja's call and not a migration's.
2. **Both need a coordinated frontend landing** I cannot make safely: `apps/web` is
   `applyyy-ba`'s partition and is being edited right now.
3. **Gap 2 is a genuine construction hole with a bounded blast radius** and closes
   cleanly today. Shipping the closeable half beats holding both hostage to a
   cross-partition negotiation.

**Option B is the right long-term shape** — identity should come from the JWT, which the
caller cannot forge, rather than from an argument the caller chooses. Deriving authority
from something the caller cannot control is the same move as making the wrong answer
unrepresentable: it removes the choice rather than checking it.

**Ruled 2026-09-17: A, with B as the target.** Recorded below in enough detail to be
executed later without re-deriving it.

### Option B in detail — what it would actually take

**The SQL half (small).** Inside `advance_application_status`, stop trusting `p_agent`
and derive the actor from the request's JWT role:

- `auth.jwt() ->> 'role'` of `anon` or `authenticated` → the actor is forced to
  `'human'`, whatever `p_agent` says. `p_agent` becomes advisory or is dropped.
- `service_role` → `p_agent` is honoured, because only the worker and Edge Functions
  hold that key and it never ships to a browser.

The guard trigger itself does not change. It already checks the GUC against
`allowed_agents`; the fix is only that the GUC stops being caller-chosen. That is the
whole point — **the check was never the weak part.**

**The `apps/web` half (the expensive one).**
`apps/web/src/features/discovery/DiscoveredJobsPage.tsx:242-262` must stop impersonating
six agents. Under B, every one of its six calls would be attributed to `'human'`, and
**not one of the six edges it needs exists for `'human'`.** Verified against the seed at
`20260909234900_status_transition_guard.sql:101-126` — every one names exactly one
machine agent and none includes `'human'`:

| Edge the button traverses | Claimed agent today | Exists for `'human'`? |
|---|---|---|
| `discovered → deduped` | `normalizer` | **No** |
| `deduped → passed_filters` | `screener` | **No** |
| `passed_filters → scored` | `matcher` | **No** |
| `scored → tailored` | `tailor` | **No** |
| `tailored → audit_clean` | `auditor` | **No** |
| `audit_clean → awaiting_approval` | `auditor` | **No** |

So B is not a drop-in. It forces a decision that has been deferred by being
unenforceable: **what should that button do?** Three coherent answers, none of them
this document's to pick:

1. **Delete it.** The fast path exists to skip the pipeline; if the pipeline is the
   product, skipping it is the bug.
2. **Make it real.** Have it invoke the actual agents server-side, so the statuses it
   writes are earned. Correct, and much larger than a security fix.
3. **Make it honest.** Keep it, but let it write only statuses a human can truthfully
   claim — which means *not* `audit_clean`, and probably not `scored` either.

> **Naming the coordination cost rather than hiding it:** B cannot land as one commit
> by one session. It needs a DB migration and a `DiscoveredJobsPage.tsx` change to land
> **together**, owned by two different partitions, plus a product ruling on the three
> options above. Landing the SQL first breaks the button; landing the frontend first
> leaves the hole open but harms nothing. **If B proceeds, the frontend goes first.**

**This is also why Gap 1 and the `audit_clean` finding are the same work.** Gap 1 is the
*mechanism* that lets the browser write `audit_clean` without auditing; the finding is
the *consequence*. Fixing Gap 1 by option B forecloses the finding automatically,
because a browser restricted to `'human'` could not claim the Auditor's verdict. Fixing
the button alone would close the consequence and leave the mechanism. **Neither fix
makes the other redundant, but B makes the button's dishonesty impossible rather than
merely corrected.**

---

## Outstanding decisions

1. **Gap 1 stays open** until option B lands, which needs a product ruling on what the
   fast-path button should do, and a coordinated DB + `apps/web` landing. **Frontend
   first** — see the coordination note above.
2. **The `audit_clean`-without-audit finding is with Teja.** It is neither gap, it is
   outside this partition, and it is arguably more consequential than either: it is a
   correctness defect in the product's central safety claim rather than a security
   hole. Escalated 2026-09-17.
3. **Gap 2 proceeds now** under ruling A.

## Verification available for whatever is approved

A migration cannot be applied from here — that is Teja's remote database. Verification
will be: reading twice, confirming every `ON CONFLICT` target and every trigger
predicate against real constraints, and stating plainly that it is **written, not
applied**.

**One upgrade is one decision away:** Docker and the Supabase CLI are both installed on
this machine, but the daemon is not running. If Teja starts Docker Desktop, these
migrations can be applied against a throwaway local Postgres — a real parse-and-apply
check that touches nothing remote. That would become the standing verification for every
migration this repo writes, which matters more than either gap.
