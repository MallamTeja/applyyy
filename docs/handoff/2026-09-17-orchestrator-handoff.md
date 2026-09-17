# Orchestrator handoff — 2026-09-17

**From:** `applyyy-e7` (retiring) · **To:** the incoming orchestrator
**Repo state at handoff:** `e2bad26`, working tree **clean**, everything **pushed**.

Read [`CLAUDE.md`](../../CLAUDE.md) first — the rules, traps and verified facts live
there and are not repeated here. This file holds only what is *not* in a file yet:
what is in flight, what is decided, and what is still owed.

---

## 1. The single most important thing

**Two migrations are written, committed, and NOT APPLIED.** Neither has taken effect.

| Migration | What it repairs |
|---|---|
| `20260917124500_fix_bootstrap_filter_rule_seed_columns.sql` | A **live break**: `bootstrap_user_defaults()` inserts a column that does not exist, so every user bootstrapped after migration 14 has **no filter rules, no system settings, no search preferences**. Also restores a dropped `config` seed that silently inverted a ruled safety default. |
| `20260917130000_guard_application_status_on_insert.sql` | Closes the approval-gate bypass — the status guard is `BEFORE UPDATE` only, so INSERT walked past the whole transition graph. |

Until Teja runs them, **"the filter bugs are fixed" is false.** Do not report them as done.

Nothing in this repo type-checks SQL, and **Docker is off** — Teja has a standing
no-Docker rule. So both migrations ship on careful reading alone. Say so plainly.

---

## 2. What landed today, and what it actually means

| Commit | What it is | Honest status |
|---|---|---|
| `042bc78` | Screener wired — the filter cascade got its first caller | Correct, but **inert** until the migrations apply and rule configs are seeded |
| `4ca08ef` | `packages/master-robots` — robots.txt gate, 76 tests | Built, **not linked** into any caller |
| `8794e55` | Filter column fixes | Client half live; migration half **unapplied** |
| `f9a7571` | Bucket B + the approval **write path** | `settle()` now calls `advance_application_status`. **Never exercised against live data** |
| `7bb3ec7` | INSERT guard migration | **Unapplied** |
| `99c42e8` | W1 dependency remediation | Landed. Audit 26 → 21 |
| `629dc81` | Refuses to review an untailored application | Live |
| `e2bad26` | PipelineDrawer false-empty-state | Live |

### The approval queue is correct **and will be empty**
The only producer of `awaiting_approval` rows is the "Tailor & Queue" button, and
`629dc81` now refuses exactly those rows. Until a real Tailor and Auditor exist,
**100% of what that screen shows is rows the new gate refuses.** That is the honest
state — report it that way rather than as "the approval queue works now".

### W1 closed less than the count suggests
**Tier 1 is BETTER, NOT CLEAN.** Two react-router advisories — including the open
redirect the plan named as the actual attack story — need `>=7.18.0`, a **v6→v7 major**.
Never W1 scope. Needs its own window.

Also: the plan's target `6.30.4` was **itself vulnerable** (`>=6.30.2 <=6.30.5`), and
`6.28.0` sat *below* that range — installing the planned version would have **added**
an advisory. Shipped `6.30.6`. Anyone "correcting" it back to the plan's number
reintroduces it.

---

## 3. Open work — nothing is assigned, no partitions are held

Every worker from this morning has ended. **The partition map is empty.** Assign freely.

1. **W2–W4 dependency windows.** W2 vite 6.0.3→6.4.3, W3 playwright, W4 vitest **alone,
   last** (two-major jump, highest risk, lowest urgency). Plan:
   [`docs/security/2026-09-17-dependency-remediation-plan.md`](../security/2026-09-17-dependency-remediation-plan.md),
   already amended where it went stale. **W2 will not zero the vite count** — a second
   vite major (5.4.21) arrives via `@vitest/mocker` and leaves with W4.
2. **The `audit_clean` root cause** — `DiscoveredJobsPage.tsx`. Needs Teja's ruling first
   (§4). Whoever takes it decides whether that button should exist, not which statuses
   it stamps.
3. **`packages/master-robots` has no caller.** Also `worker/scripts/capture-fixture.ts`
   carries its own `ALLOWED_HOSTS` copy that should call the gate instead.
4. **The `supabase-js` / `postgrest-js` modernisation window** — 2.50.0 was deliberately
   the patched minimum; 2.116.0 carries a postgrest-js **major**. Its verification is a
   re-read of `PostgrestQueryBuilder` source, because `planJobUpsertGroups` depends on
   union-of-keys behaviour that no test would catch breaking.
5. **`packages/master-pdf/src/extract.ts` does not exist** — `pdfExtractor.ts` falls
   through to a hardcoded placeholder profile. If the PDF upload has been used against
   live Supabase, `master_profiles` may hold junk.
6. **No component render harness in `apps/web`.** The branch-order fixes are correct by
   construction and typecheck, never by execution.
7. **`ApprovalQueuePage` hand-rolls read-state** instead of using `src/data/readState.ts`
   (`classifyRead` / `describeEmptyState` / `isConclusive`), which six other files use.
   Correct as written, but the odd one out.
8. **Stale `PROJECT_PLAN.md` items** — the `screened`/`screening` diagram at ~:497, and
   §8's worked example built on `experience_ceiling`, the one rule that structurally
   cannot fire.

---

## 4. Decisions owed by Teja — do not decide these

1. **The `audit_clean` button.** The fast-path stamps rows as audited without the Auditor
   running, landing them in the one-click batch-approve lane. The schema names the
   consequence in its own seed data — `status_transition_guard.sql:126` seeds that edge
   `'Bucket A - eligible for one-click batch approval.'` Options written up: delete the
   button / make it real / make it honest.
2. **Agent identity (Gap 1).** `advance_application_status` takes `p_agent` as an
   unverified string. The real fix derives the actor from the JWT role — and **breaks the
   shipped fast-path button**, so it needs a coordinated landing, **frontend first**.
   Detail: [`docs/security/2026-09-17-pipeline-identity-gaps.md`](../security/2026-09-17-pipeline-identity-gaps.md).
3. **`salary_period`.** The salary gate is built, tested and **inert** — no period column
   exists on `jobs` or `search_preferences`, so it passes everything.
4. **Test comment density.** No test file meets the written 1:1 rule; observed band is
   0.69–0.83. Either amend the rule or schedule a deliberate retrofit — never pay it out
   of whoever finishes last.
5. **Seeding the nine default blocked titles.** They exist in the frontend
   (`filtersStore.ts:19-70`) and nowhere in the DB. Whether the DB seeds them or the UI
   pushes them on first save is a product call.

---

## 5. Coordination lessons that cost us today

The durable ones are in [`CLAUDE.md`](../../CLAUDE.md) §2 and §4. These are about
**running the orchestration**, and are not written down elsewhere:

- **Authorising the work is not assigning the writer.** Teja authorised a dependency
  window; two sessions each correctly believed they were executing it, and both were
  seconds from writing one lockfile. The principal does not hold the partition map —
  that question has to sit with one coordinator.
- **Broadcast the map, or it is not a map.** The near-collision happened because the
  assignment lived only in the orchestrator's head.
- **Put the state you reasoned from INTO the ruling.** A "confirm your state, then wait"
  and a "green light, install when ready" went out four minutes apart with no way for the
  recipient to tell which was current. Twice, a decision was overtaken by events.
- **An instruction whose premise has evaporated is not one to execute faster.** An undo
  order arrived resting on a fact that had gone false; executing it would have reopened a
  production-reachable vulnerability. Take the measurements back to the principal.
- **`git push` has no pathspec.** The index is protected; the push is not.
- **Verify every worker claim yourself.** Peers were right and the orchestrator wrong
  repeatedly — but only checking revealed which. The orchestrator issued a `deno check`
  guard that returned 0 on healthy runs, and cited dead code as production filtering.
- **A finding that says "do less" deserves more scrutiny than one that says "do more"**,
  because the cost of being wrong is silent.

---

## 6. The defect family this repo keeps producing

Two mirrored shapes. Both are in `CLAUDE.md` §5; this is the short form:

**Missing data becoming an answer** — the permissiveness of the reader is the fail-open.

**A confident assertion standing in for work that never happened** — the green "queue is
empty" on a *failed read*; "saved successfully" with the kill switch missing from the
payload; "Approve without 2 claims" over a handler that discarded them; `audit_clean`
with no Auditor.

The worst instance found: the approval page fell back to a resume built *from the master
profile* when `tailored_profile` was null, which trivially traced to master, so zero
findings, so **Bucket A: "Safe to batch-approve."** The clean verdict was manufactured by
the absence of the thing it claimed to have checked.

> **Every branch that concludes GOOD from an absence must prove the absence means what
> it says.**
