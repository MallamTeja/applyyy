# Verification traps

**One family of bug, six instances.** Every entry here is a check that
**reported success for a reason other than the one you believed**. None of them
were caught by a failing test, because in every case the test passed.

This page exists because `applyy` is built on layered defences — §10 alone
stacks four — and layering has a real, non-obvious cost that this document
names. Read it before writing a test for a guard, and before believing a green.

---

## THE RULE

> **A test that passes when you delete the guard it is named after is testing
> the composite, not the guard. Redundant defences make each other untestable —
> when two guards can both catch a case, isolating one needs an input that ONLY
> that guard catches.**

Recorded verbatim, as a first-class rule rather than a footnote. It is the
genuine cost of defence-in-depth: each additional layer reduces the
observability of every other layer.

### How to test a guard, given the rule

1. **Read the guard first.** Enumerate every path by which it can refuse. If it
   has more than one, a bare "it failed" result is meaningless.
2. **Neutralise the other paths.** Construct the input so that only the path
   under test can fire.
3. **Capture the failure text, not the fact of failure.** A typo'd column name
   also raises an error. "It errored" is exactly the composite result the rule
   warns about.
4. **Add the positive control.** Feed it a case the guard must *admit*, differing
   in as few dimensions as possible from the case it must refuse. A guard that
   refuses everything is not a guard, and only the control distinguishes them.
5. **Ask the mutation question:** *would this test still pass if I deleted the
   guard?* If yes, it is not a test of that guard.

---

## Instance 1 — the `aria-hidden` guard that guarded nothing

A regression test named for an `aria-hidden` guard **passed with that guard
commented out.** A second, unrelated guard (`if (!label) continue`) had been
catching the case all along. Both guards existed; only one was load-bearing; no
test could distinguish them. **The product's real protection was never the thing
documented as protecting it.**

**How it would have broken** — and this is the part worth internalising, because
the trigger is a *good* change:

1. Someone adds a label fallback so more ATS vendors parse. A plausible
   improvement, reviewed and merged.
2. The previously-unlabelled cases now have labels.
3. The label guard therefore stops catching them.
4. `aria-hidden` becomes the sole defence — with nothing proving it works.
5. Green suite. Clean review. Broken product.

The failure is not the bug; the failure is that **no signal existed at the
moment the protection changed hands.**

## Instance 2 — the boot-time check in a module nobody imports

`apps/web/src/data/supabase.ts` contains an anon-key role check at lines 80-89.
It has **zero importers.**

Module-level code does not run until something imports the module. So the check
is not merely untested — it is **unreachable**. It cannot fail, cannot pass, and
cannot protect anything. This is worse than instance 1, where the dead guard at
least executed.

`resolveSubmissionMode` has the same shape: **zero callers.**

**Generalised:** before asking "is this guard tested?", ask "**does this guard
run?**" Coverage tooling reports an unimported module as uncovered, which reads
as a gap in testing rather than as a guard that does not exist. Grep for
importers.

## Instance 3 — `pnpm rebuild` manufacturing a false green

After editing the build-allowlist, `pnpm install` may report "Already up to
date" and skip re-running scripts. The tempting fix is `pnpm rebuild`.

**Never do this.** `pnpm rebuild` runs postinstall scripts *unconditionally*, so
it makes the failure disappear **on your machine while the repository stays
broken**. The next clean clone — and CI — fails identically, but now nobody
believes the allowlist is the cause, because "it works here."

**Generalised:** a fix that works by *forcing* the effect you wanted, rather
than by correcting the *condition* that produces it, converts a reproducible
failure into an unreproducible one. That is strictly worse than the original bug.

## Instance 4 — the exit code that described a different program

`supabase db reset` **exited 1**. The SQL had fully succeeded; the failure was
`supabase_storage_applyyy container is not ready: unhealthy` — a sibling service
timing out on its healthcheck, unrelated to migrations. All 7 migrations were in
the ledger and all 15 tables existed.

Read on the exit code alone, the conclusion would have been the **exact
opposite** of the truth, on the single most important question in the project.

**Generalised:** an orchestrator's exit code aggregates many things. When it
disagrees with what you can observe directly, **query the state, not the
wrapper.** See [`audit/2026-09-10-schema-invariants-verified.md`](audit/2026-09-10-schema-invariants-verified.md).

## Instance 5 — `$?` after a pipe

Measuring a command's exit status after piping it reports the **last** stage of
the pipeline, not the command you cared about. A failing command piped into a
successful `tail` looks like success.

Use `${PIPESTATUS[0]}`, or do not pipe. This produced a real
mis-measurement earlier in this project: `supabase start` was briefly believed
to have exited 0 on a migration failure — which would have been a serious CI
trap worth reporting — when it had correctly exited 1 and the 0 belonged to the
`echo` after it. **Checking prevented a phantom bug report**, which is the same
discipline in the opposite direction: green claims and red claims both need
evidence.

## Instance 6 — silence that means "checked nothing"

`actionlint` returned **exit 0 with no output** on both workflows. That is
indistinguishable from the linter never having parsed the files at all — a
mounted-path typo produces byte-identical silence.

**The fix is cheap and should be habitual:** feed the *identical invocation* a
deliberately broken input and confirm it complains. It flagged an unknown runner
label plus three `shellcheck` errors inside a `run:` block, which also proved
`run:` blocks are genuinely covered and not just the YAML schema. Only then is
the green a green.

**Generalised:** for any tool whose success output is empty, **an empty result is
not evidence.** Prove the harness can fail before trusting it to pass.

---

## Where this bites hardest in `applyy`

Layered defences are the deliberate design here, so the cost applies throughout:

- **The Tailor validator** — the existence check and the parent-scope check can
  both reject the same fabricated ref. Isolating either needs a ref that only
  one of them catches.
- **The status transition guard** — three distinct rejection paths (no acting
  agent `42501`, no such edge `23514`, agent not permitted `42501`). A bare
  `UPDATE` fails on the *first* path and tells you nothing about the edge table.
  Worked example of testing this correctly:
  [`audit/2026-09-10-schema-invariants-verified.md`](audit/2026-09-10-schema-invariants-verified.md).
- **RLS enabled vs. a policy existing** — these fail *identically* from the
  outside. A table with RLS on and no policy is locked; a table with RLS off is
  wide open; the owner sees neither. Two assertions, two catalogues
  (`pg_class.relrowsecurity` and `pg_policies`), never one probe.
- **`UNIQUE(user_id, job_id)` vs. the transition guard** — some illegal states
  are refusable by either. Test the constraint with a straight duplicate that is
  otherwise perfectly legal; test the guard with an `UPDATE` on a row whose pair
  is already unique.

## The one-line test

Before recording anything as verified, answer this:

> **If the mechanism I am claiming to have verified were deleted, would my check
> have noticed?**

If the answer is no — or "I'm not sure" — the check is evidence of something,
but not of that.
