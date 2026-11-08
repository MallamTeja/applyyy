# Verification traps

_Last verified against code: 2026-11-08 (2a9ac31)._

**One family of bug, many instances** (count: `grep -c '^## Instance' docs/verification-traps.md`). Every entry here is a check that
**reported success for a reason other than the one you believed**. None of them
were caught by a failing test, because in every case the test passed.

This page exists because `applyy` is built on layered defences — §10 alone
stacks four — and layering has a real, non-obvious cost that this document
names. Read it before writing a test for a guard, and before believing a green.

Instances 1-23 are records of real incidents. Their stories are kept as written.
Instances 24-34 are the tooling traps listed in `CLAUDE.md` §4 and §5, added on
2026-11-08 so the full list lives in one place.

### Status of each trap against current tooling (2026-11-08)

"Live" means the trap can still fire today. "Guarded in CI" means `ci.yml` now
fails loudly on it, but a local run can still be fooled. No instance is fully
obsolete: each one still teaches the rule, even where the specific cause is gone.

| # | Trap | Status 2026-11-08 | Evidence |
|---|---|---|---|
| 1 | Test passes with its guard removed | Live (a rule, not a tool bug) | — |
| 2 | Guard in a module nobody imports | Cause fixed; rule live | `grep -rn "data/supabase" apps/web/src`; `resolveSubmissionMode` called in `worker/src/apply-one.ts`, `worker/src/claim-loop.ts`, `worker/src/cli/apply.ts` |
| 3 | `pnpm rebuild` false green | Live | — |
| 4, 16 | `supabase db reset` exit code wrong both ways | Live (not re-measured) | — |
| 5 | `$?` after a pipe | Guarded in CI; live locally | `.github/workflows/ci.yml:83` sets `shell: bash -eo pipefail {0}` |
| 6 | Empty linter output | Live | — |
| 7 | Tool writes into the tree + sweeping `git add` | Half fixed: `.playwright-mcp/` is ignored | `.gitignore:64` |
| 8 | Accurate error, wrong cause | Live | — |
| 9 | Fail-closed checked in prod | Positive record | — |
| 10 | Invariant held by the caller | Live (a rule) | `supabase/functions/_shared/normalize/posted-at.ts` |
| 11 | Migration files vs live DB | The two named migrations are applied; rule live | `supabase migration list --linked` |
| 12 | Old dev server still listening | Live | — |
| 13 | Vacuous expectation, twin | Live (a rule) | — |
| 14 | Guard reports instead of prevents | Fixed by a build-time refusal | `apps/web/vite.config.ts:52`, `apps/web/src/data/supabaseConfig.ts`, `apps/web/src/data/keyRole.ts` |
| 15 | "Tree stopped changing" means "done" | Live | — |
| 17 | plpgsql body not parsed at `CREATE` | Live (Postgres behaviour) | — |
| 18 | Validate the rollback harness | Live (a rule) | — |
| 19 | `&&` hides later reports | Fixed in the root script; rule live | `package.json:16` runs `test:functions` first |
| 20, 21 | Composite guards, per-section uniqueness | Live (rules) | — |
| 22 | Count field invites skipping the list | Live (design rule) | — |
| 23 | A "reader" command writes the lockfile | Live | `package.json:15` (`pnpm -r ... typecheck`) |
| 24-34 | Tooling traps from `CLAUDE.md` §4-§5 | See each entry | — |

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
6. **Prove it can PASS for the right reason** — feed it a *correct* input and
   assert success. Steps 1-5 only ever prove a guard can *fail*, and **a guard
   that rejects every input satisfies all of them.** The cheapest form is the
   *twin*: two inputs identical in every respect except the one property under
   test, one asserted to fail and one asserted to pass. See instance 13, where an
   expectation was satisfied by the very input it existed to reject.

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

`apps/web/src/data/supabase.ts` contained an anon-key role check that, as of 2026-09-10,
had **zero importers.** (It is imported now; re-check with `grep -rn "data/supabase" apps/web/src`.)

Module-level code does not run until something imports the module. So the check
is not merely untested — it is **unreachable**. It cannot fail, cannot pass, and
cannot protect anything. This is worse than instance 1, where the dead guard at
least executed.

`resolveSubmissionMode` had the same shape at the time: **zero callers.** (Now called from `worker/src/apply-one.ts` and `worker/src/cli/apply.ts`.)

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

Use `${PIPESTATUS[0]}`, or do not pipe. In CI every `run:` step uses
`shell: bash -eo pipefail {0}` (`.github/workflows/ci.yml:83`), so a failing
first stage fails the step there. Your local shell has no such default. This produced a real
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

## Instance 7 — a tool that writes into the tree, plus staging that sweeps it

Playwright MCP wrote seven console logs and **page snapshots** into
`.playwright-mcp/` at the repo root when a peer drove a real browser. That path
was not in `.gitignore`, so the files sat untracked-but-visible — and a
`git add -A` would have committed **browser snapshots of Teja's console**.

This is the second instance in one family. The first: a `git add -A` swept a
security guard that had been **deliberately sabotaged mid-mutation-test** into a
commit, capturing the broken state as though it were intended.

**The hazard is the COMBINATION, not either half.** A tool that writes into the
working tree is fine. Staging that sweeps whatever it finds is fine. Together
they commit things nobody chose. Both mitigations are therefore worth having, and
they are independent:

- **Stage by explicit path.** Never `git add -A` — which is already the standing
  rule here, and this is *why* rather than merely *that*.
- **Ignore the path**, removing one half so the combination cannot fire even if
  someone forgets the first rule.

**Generalised:** when auditing for this, do not ask "is this tool safe?" or "is
my staging safe?" Ask **"what writes into this tree that I did not write, and
what would sweep it up?"** The answer is usually a tool somebody ran once.

## Instance 8 — an accurate error message pointing at the wrong cause

After Teja reset the database password, `supabase migration list` failed with:

```
password authentication failed for user "postgres"
```

The password was **correct**. The reset had simply not propagated yet. Sixty
seconds later the same command connected and confirmed all seven migrations on
both sides.

The message is not wrong — authentication *did* fail. It describes the symptom
precisely and says nothing about the cause, and the cause a reader infers from it
("we have the wrong password") sends them hunting through credential stores for a
string that was already right.

**Generalised:** distinguish *"this error is inaccurate"* from **"this error is
accurate and its most natural reading is wrong."** The second is far more
dangerous, because the message survives scrutiny. For anything just
reconfigured, **retry before diagnosing** — propagation delay and
misconfiguration produce identical errors.

Same family as instance 4: there, an exit code described a different program;
here, an error describes a different cause.

## Instance 9 — a guard verified in production, which no test could do

`email-tracker-intake` was deployed with `EMAIL_INTAKE_SHARED_SECRET` **unset**.
It returned **500 "server misconfigured"** — not 401, and critically **not 202**.

This is the inverse of every other entry here, and it is worth having as a
category: a guard **confirmed working in a live deployment** rather than in a
test. It matters because the failure mode it rules out is one a unit test can
only ever *predict*: the function needed to **fail closed**, so that an unset
secret does not silently become an **open public writer** into the tracking
tables. A forged application-status email is worse than a missing one, because it
looks authoritative.

The distinction between the three possible responses is the whole result:

- **202** would have meant the endpoint was open — the disaster case.
- **401** would have meant it was treating "no secret configured" as "caller
  unauthorised" — safe by accident, and it would break the moment someone decided
  401 meant "retry with credentials".
- **500** is correct: *the server is broken, not the caller.*

**Generalised:** for anything whose safety depends on a configuration value being
present, **test the absent case in the deployed environment**, not only in unit
tests. Deployment is where configuration actually lives, and "fails closed" is a
claim about the deployment, not about the code.

## Instance 10 — an invariant that holds because of the caller, not the callee

`posted-at.ts`'s `readSourceDate` returns `confidence: 'unknown'` at **five**
separate sites. All five are unreachable in the output — but **only because**
`extractPostedAt` reads `fromSource.confidence` exclusively inside its
`if (fromSource.date !== null)` branch.

So the documented guarantee — *"unknown has exactly one cause"* — holds because
of the **caller's control flow**, not because the callee's confidence values are
correct. Nobody had recorded that.

**The refactor that breaks it reads like a harmless simplification:** trusting
`fromSource.confidence` unconditionally. Do that and parse failures silently
start emitting `unknown` with no other symptom, because the five dead branches
come alive.

The invariant to write down is therefore **"unknown is written by exactly one
line, the cold-start ternary"** — a statement about *where the value comes from*
— and **not** "the confidence values are correct", which is a statement about the
values and happens to be false.

**Generalised:** when a property holds, ask **which** part of the system makes it
hold. If the answer is "the caller", the callee is free to be wrong, and it
usually is. Same shape as instances 1 and 2: a property true for a reason nobody
has recorded is a property that disappears silently.

## Instance 11 — the migration files and the live database disagree

Two corrective migrations (`20260910185900_add_keepalive_agent_name.sql`,
`20260910190000_fix_sweep_count_bootstrap_seed_and_blocked_edge.sql`) existed as
files with **empty `remote` entries** in `supabase migration list` (both applied since;
re-check with `supabase migration list --linked`). The live database therefore did not have the `keepalive` agent value, does not have the
`approved -> blocked_needs_human` edge, and still ran the un-fixed
`bootstrap_user_defaults` and `sweep_stale_claims`.

**Nothing errors.** A peer reading the files gets one answer; the same peer
querying the database gets another.

This will recur with **every** corrective migration, so it is a standing rule
rather than an incident:

> **Read the files for intent. Query the database for behaviour. Never assume they
> agree while any migration has an empty `remote` entry.**

Third member of a family this project keeps producing — **two artifacts
disagreeing with no error anywhere.** The others: CRLF (source bytes vs. rendered
bytes across platforms), and editing an already-applied migration (file text vs.
what actually ran).

## Instance 12 — the server you believed you had killed

`TaskStop` killed a `vite preview` **wrapper** and left vite itself still
listening. The next preview exited 1 on `--strictPort` — and **the page then
loaded was served by the server that was supposed to be dead.** `netstat`
confirmed the old PID.

It was caught only by a contradiction that should have been impossible: the
background task reported **failure** while the page loaded **fine**.

**It fails in the safe-looking direction, which is what makes it dangerous.** You
see a working page, so you conclude your change works. The stale server serves
the *old* bundle, so a broken change looks correct and a correct change looks
confirmed — both for the same wrong reason.

Same family as instance 3 (`pnpm rebuild`): **a step that can produce the desired
outcome by itself destroys the test.** A running old server produces "a page that
loads" whether or not your new build works.

**Rule: after stopping a dev server, confirm the port is actually free before
trusting anything loaded from it — and prefer a fresh port when you cannot.**

## Instance 13 — the vacuous expectation, and the twin that fixes it

This is the entry that closes a hole every other measurement in this document
leaves open.

Two tests asserted that interleaved extraction is detected, using the expected
sequence `['EXPERIENCE', 'Built a REST API']`. But that sequence **survives
interleaving intact** — a heading still precedes its own bullet even when columns
scramble. **The expectation was satisfied by the very input it existed to
reject.**

Two fixes, and the second is the important one:

1. Require the sequence to **alternate**, so section N's *body* precedes section
   N+1's *heading*. That is the property interleaving actually destroys.
2. Add the **twin**: identical fragments, identical expectations, **differing only
   in emission order**, asserted to **PASS**.

The twin is what makes "detects interleaving" unsatisfiable by a checker that
simply rejects everything.

**THE HOLE THIS CLOSES.** Every mutation measurement here — 12/14, 2/36, 4/8 —
proves a guard **can fail**. **None of them proves a guard can PASS for the right
reason.** A guard that fires on *all* inputs is indistinguishable from a correct
one if you only ever test the failing side, and it would score perfectly on every
mutation test in this document.

That is why the checklist below has a sixth step.

## Instance 14 — a guard that reports the incident instead of preventing it

`vite build` exited **0** with a `service_role` token embedded **verbatim** in
`dist/assets/index-*.js` — decoded out of the bundle to confirm it was really
there.

The runtime anon-key guard works exactly as designed: it stops the console
operating with a wrong-role key, and it **announces the problem in the first
visitor's console**. What it does not do — and never could — is stop the key from
being **shipped**.

**The asymmetry is the whole point.** On a dev machine, a wrong-role key is
nearly free: you see the console error and fix it. **On a deploy it is the entire
ballgame** — the URL goes live carrying an RLS-bypassing credential, the guard
reports it to whoever visits first, and by the time anyone reads that message the
key has already been served and must be rotated. A CI gate on the build would not
have caught it, **because the build passes.**

The fix is a **build-time refusal**, and two of its design choices are worth
copying:

- It reads the **role claim of every `VITE_`-prefixed variable** rather than
  pattern-matching variable names. Names are a convention; the claim is the fact.
- It is **deliberately asymmetric with the runtime guard**: a *missing* key must
  **not** fail the build, because an unconfigured preview is legitimate. Only a
  *present and wrong-role* key fails.

That refusal now lives in `apps/web/vite.config.ts` (the "applyy build refused"
errors at lines 52-81). It calls `resolveSupabaseConfig` from `apps/web/src/data/supabaseConfig.ts`, which reads the role claim with `readRoleClaim` from `apps/web/src/data/keyRole.ts`.

**Generalised:** **a guard that reports an incident is not a guard that prevents
one, and the difference only appears at the boundary where the artifact escapes.**
When auditing a guard, ask *where* it runs relative to the point of no return.
Runtime is after the artifact has shipped.

---

## Instance 15 — a stability check cannot tell "finished" from "not started"

Four subagents were reported as writing into `apps/web/**` and
`supabase/functions/**`, with the instruction: *"`git status --short` twice, a
little apart; if those paths stop changing, the agents are done."*

Followed exactly, at 21:06: **0 lines, twice.** Conclusion drawn and written
into an audit document: the agents produced nothing. At 21:11 the same command
returned six changed paths. **The agents had been alive the whole time and had
simply not reached their first write.**

**Both states present as an unchanging tree.** Two identical readings feel like
corroboration and are not — they are one measurement taken twice, and neither
can see a process that has produced nothing *so far*.

**It was doubly vacuous.** `find -newermt` was then used as independent
corroboration, but it interrogates the same underlying fact — no writes yet —
through a second interface. **Two views of one absence is still one
observation.** Corroboration requires an independent *signal*, not a second
window onto the same one.

**What actually discriminates: ask whether the PRODUCER is alive, not whether
the PRODUCT exists.** `ListAgents`, or a process check. An idle tree plus a live
agent means *wait*; an idle tree plus no agent means *nothing came*. Only the
second licenses the conclusion.

**Generalised:** **never conclude a background worker has finished from the
absence of its output.** Confirm the worker itself is gone. Absence of evidence
is the specific thing this whole document is about, and it arrived here through
a door nobody recognised — dressed up as a *stability* check, which sounds
active and is not.

---

## Instance 16 — the same command exits 0 while failing *completely*

Instance 4 records `supabase db reset` exiting **1 while succeeding** — the
storage container failed a healthcheck after the migrations had fully applied.

Tonight it did the opposite. The Postgres image pull died with `unexpected EOF`,
every retry failed with `open //./pipe/dockerDesktopLinuxEngine: The system
cannot find the file specified` because Docker Desktop had stopped, and the
final payload was:

```json
{"_tag":"Error","error":{"code":"LegacyImagePrepullError", ... }}
```

**The wrapper returned 0.** Nothing was reset, no container ever started, no SQL
was ever parsed — and a script chaining `supabase db reset && next-step` would
have proceeded straight into the next step.

**Both directions from one command, which is the point.** A tool whose exit code
is unreliable is not *sometimes* wrong; it carries no information at all, and
you must read the state either way.

**And the two directions are not equally dangerous.** Exit 1 while succeeding is
the *honest* failure — it makes someone look. **Exit 0 while failing is a green
that means nothing**, and greens are precisely what nobody investigates. When a
tool is known to lie in one direction, check whether it lies in the other before
trusting the direction you like.

---

## Instance 17 — a plpgsql function body is not parsed when the function is created

A migration adding `applyy_internal.assign_master_profile_content_hash()` was
validated against the live schema inside `begin; … rollback;`. The function
object was confirmed **created**. It would have been natural to call the body
verified.

**It was not.** PostgreSQL does not parse a plpgsql function's body at `CREATE`
time — only at first execution. So `create function` succeeding proves the
*signature* is well-formed and says **nothing** about whether the identifiers
inside it resolve. The specific worry — whether `pg_catalog.sha256(bytea)`
resolves under `set search_path = ''` — was exactly the kind of thing a
successful create does not answer.

It was closed by evaluating the expression standalone under an empty
`search_path`, which also turned two *documented* claims into *measured* ones:
`jsonb` normalises key order (`{"b":2,"a":1}` and `{"a":1,"b":2}` hash
identically), and numeric scale genuinely collides (`1.0` and `1.00` do not).

**Generalised:** **"the thing was created" and "the thing works" are different
claims, and deferred compilation is where they come apart.** Same family as
Instance 2 — a check that exists but never executes. Anywhere a language defers
parsing (plpgsql bodies, dynamic SQL, a lazily-imported module, a template
rendered only on one branch), creation-time success is not execution-time
evidence.

---

## Instance 18 — validate the validator before you trust what it tells you

With Docker unavailable, a migration was validated against the **live** database
using `begin; <migration>; rollback;`. That is only evidence if the harness
behaves — and **a rollback that silently never ran and a rollback that worked
produce identical observations afterwards: the object is absent either way.**

So the harness was tested first, with a throwaway probe requiring **both**
readings:

| Reading | Required | Proves |
|---|---|---|
| object visible **INSIDE** the transaction | 1 | the DDL genuinely executed, not silently ignored |
| object absent **AFTER** rollback | 0 | the rollback genuinely discarded it |

Either reading alone is worthless. "Absent afterwards" alone is satisfied by a
harness that never ran anything at all.

**Generalised: the non-vacuity twin applies to test HARNESSES, not just to
guards.** Before trusting a mechanism that reports absence, make it report
presence once. The same discipline says *don't accept a green from a runner you
haven't seen go red* — which is how the 249 previously-unreachable tests were
confirmed to be genuinely wired: a guard was mutated and 15 tests failed.

---

## Instance 19 — `&&` hides the report you added the step for

A root script was written as `test:workspace && test:functions`, specifically to
surface 31 kill-switch tests that no runner had been reaching. The `&&` risk was
noticed at the time and documented as acceptable.

**It fired on the very first real invocation.** An unrelated pre-existing failure
in the worker suite stopped the chain, and the kill-switch results never
printed — hiding exactly what the change existed to reveal.

**`&&` masks whatever follows it precisely when something is already wrong**,
which is the moment you least want a safety-critical guard to go quiet. Fixed by
running the fast, safety-critical half **first**, so it always reports; the chain
still returns one non-zero exit for CI. Today the root `test` script is
`pnpm run test:functions && pnpm run test:api && pnpm run test:workspace`
(`package.json:16`). CI does not use this chain: each suite is its own step,
gated on `!cancelled()`, so one red step does not hide the next
(`.github/workflows/ci.yml`).

**Generalised:** ordering inside a `&&` chain is not cosmetic — it decides *what
you still learn on a bad day.* Put the check whose silence would mislead you
earliest, not last. Note also that documenting a known risk as "accepted" did
nothing to prevent it; only the reordering did. **A comment is not a control.**

---

## Instance 20 — a precondition test that passed because the POSTCONDITION caught it

Found by `applyyy-48` in the master-profile reconciler.

A guard checking a **precondition** was mutation-tested and killed **zero**
mutations. Not "few" — none. Every input the precondition was supposed to reject
was *also* rejected further downstream by a **postcondition** guard checking the
output. The test named after the precondition passed on every mutation, because
something else was doing the work.

**This is THE RULE in its purest form: the test was measuring the composite, not
the guard it was named after.** Removing the precondition entirely would not have
failed it.

**The fix is the instructive half**, and it is not "add more tests". It is
constructing the one input **only the precondition can catch**: both offending
nodes are *dropped* during reconciliation, so the output comes out clean and the
postcondition has nothing to fire on. The precondition is then the only thing
standing between that input and a silent pass.

A second change came out of it: **both guards now assert on the message**, not
merely that something threw. Two guards that both throw are indistinguishable
from one guard that throws twice, so a test asserting only "it threw" cannot
tell you *which* defence caught the input — and that is precisely the
information a mutation test needs.

**Generalised: redundant defences make each other untestable, and the more
reliable the outer one, the more thoroughly it hides the inner.** To test a
guard, you must find the input that *only* it rejects. If no such input exists,
you have not got two guards — you have one guard and one decoration.

---

## Instance 21 — the per-section uniqueness result, reproduced independently

`profile-nodes.ts` recorded a mutation of a duplicate-id checker from **global**
to **per-section** uniqueness: 36 tests, 34 passed, 2 failed — and the survivor
was *the within-section duplicate test*, the case anyone writes first.

`applyyy-48` hit the same mutation in **different code** (the reconciler's
`node-id-uniqueness` check) and got the same shape: global→per-section killed
**9** tests, and **the within-section duplicate test still passed.**

**Two independent measurements of the same phenomenon in unrelated code
upgrades it from an anecdote about one file to a property of the invariant
itself.** Global uniqueness and per-section uniqueness agree on every input
anyone reaches for naturally; they differ *only* on a duplicate spanning two
sections — an id shared between, say, a bullet and a skill.

**Why the weaker design is the plausible one, and therefore the dangerous one:**
per-section uniqueness is what most people would implement, it reads as more
precise, and it passes the obvious test suite. It is wrong here because
`TailoredBullet` and `TailoredSkill` carry a **bare `ref` with no section
qualifier** — so under per-section uniqueness a bullet ref could resolve to a
skill with nothing able to disambiguate.

**Generalised: when two candidate invariants agree on every ordinary input, your
test suite is not choosing between them — your implementation is, silently.**
Write the cross-section case first.

---

## Instance 22 — a count field is an invitation to skip the list

Not a failed check; a design rule that prevents one, and it belongs here because
the failure it prevents is *a verification step that stops verifying*.

`applyyy-48` deliberately put **no count fields anywhere** in the reconciliation
report — no `carriedCount`, no `mintedCount`. The reasoning: **a count field is
an invitation to render the count and skip the list.**

A UI that says *"14 ids carried forward"* has told the human nothing they can
act on, while looking exactly like a confirmation step. The human clicks
through. The screen exists to be looked at, and it has quietly become a screen
that is looked *past*.

That matters most precisely where it is easiest to add: the reconciler's
similarity threshold is unsafe in both directions and **fails silently both
ways** — too low and wrong bullets match, carrying an id onto the wrong claim;
too high and every old pin breaks. **No threshold is safe by construction**,
which is exactly why every non-exact match must be *shown* rather than totalled.

**Generalised: a confirmation step that can be satisfied without reading the
evidence is theatre.** The same argument makes the approval queue a diff rather
than a score. If a number can be rendered instead of the thing it summarises,
someone eventually will — so do not provide the number.

---

## Instance 23 — a single-owner file written by a command nobody calls a writer

`pnpm-lock.yaml` was given **one designated owner** precisely because it is the
most collision-prone file in a five-session tree, and the task of running
`pnpm install` was routed deliberately to that owner rather than left to whoever
noticed first.

By the time the owner ran it, the lock **already contained** the new package's
importer entry. `pnpm install` reported `Already up to date` and changed nothing.

The writer was **`pnpm -r run <script>`**. Recursive script runs perform an
implicit dependency-status install first, and that install can write the
lockfile. Nobody had run `pnpm install`; several sessions had run `pnpm test` and
`pnpm run typecheck`.

**So "nobody ran the writing command" is not the same as "the file was not
written."** Write-ownership partitioning protects a file from the commands you
have *classified* as writers. A command whose stated purpose is to *read* — run
the tests, check the types — silently held a write.

**Generalised, and it goes well past pnpm:** when you assign an owner to a
mutable file, enumerate what can write it by *effect*, not by *name*. Formatters
invoked by a lint check, a build that refreshes a manifest, a test runner that
updates a snapshot, a CLI that rewrites its own config on startup — each is a
writer that reads as a reader. The tell here was benign; the general case is a
concurrent write nobody was watching for, in the one file everybody agreed to be
careful with.

Related and already recorded: `supabase/functions/deno.json` warns that Deno, walking up the tree
looking for a workspace root, will **rewrite the repo's root `package.json`** to
add a `workspaces` key. Same mechanism — a tool writing a file that belongs to
someone else, as a side effect of being run for another reason.

---

## Tooling traps (from `CLAUDE.md` §4 and §5)

These are short. Each one names the trap, the check that is fooled, and the
command or guard that catches it today. The commands to run are in `CLAUDE.md` §5.

## Instance 24 — `pnpm run typecheck` does not check the edge functions

`typecheck` is `pnpm -r --if-present run typecheck` (`package.json:15`). It runs
only in workspace packages. `supabase/functions/` is a separate Deno project with
no `package.json`, so it is never visited. A green typecheck says nothing about
the edge functions. Check them with `deno check` (Instance 26). The same command
can also rewrite `pnpm-lock.yaml` (Instance 23). Typecheck one package at a time.

## Instance 25 — `pnpm --filter web` matches nothing

The web package is named `@applyy/web` (`apps/web/package.json:2`). A filter on
`web` matches no package. pnpm then runs nothing and can still look like it
succeeded. Use the full name, or run the tool from `apps/web/` directly.

## Instance 26 — `deno check` over zero files exits 0

An empty file list, or a glob that matches nothing, gives exit 0 and no output.
So does naming only `*.test.ts` files, because `supabase/functions/deno.json`
excludes `**/*.test.ts` (it prints "No matching files found"). Count what was
checked:

```bash
deno check --reload <paths> 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -c "^Check"
```

The count must **equal** the number of files, not just be above zero.
**Guarded in CI:** `.github/workflows/ci.yml` (step "deno check --reload, and
assert it checked files") fails on an empty list and on any count mismatch.
Test files are checked only by `node --test`.

## Instance 27 — `tests 0` with `fail 0` is a glob that matched nothing

`node --test "<glob>"` from the wrong directory matches no files and reports
`tests 0`, `fail 0`, exit 0. Always read the two numbers together. Two more
silent cases:

- **`cancelled`**: a `before()` hook that cannot import cancels its tests. They
  neither pass nor fail. Read the `cancelled` line.
- **A `describe()` body that throws** before its first test drops those tests
  with `fail 0`, `cancelled 0` and exit 0 (measured on Node 24). Its only trace
  is a line starting with `✖`.

**Guarded in CI:** every `node --test` step in `ci.yml` fails on `tests 0`, on
`cancelled > 0`, and on any `✖` line. A local run has none of these checks.
For vitest, CI relies on vitest itself: it exits non-zero on a failure and on
"no test files found" (`ci.yml`, step "worker vitest run").

## Instance 28 — `deno check` writes `deno.lock`

Running `deno check` can modify `supabase/functions/deno.lock`, which is a tracked
file. A verification run therefore leaves a diff. Never commit that diff as a
side effect of a check. Same family as Instance 23: a reader that writes.

## Instance 29 — `--lockfile-only` leaves the old version installed

`pnpm install --lockfile-only` updates `pnpm-lock.yaml` but not `node_modules`.
A green local run after it tested the **old** version. Verify a dependency or
supply-chain fix on CI, which runs `pnpm install --frozen-lockfile` from scratch
(`ci.yml`, step "pnpm install --frozen-lockfile").

## Instance 30 — a test double that throws when the real client returns

supabase-js does not throw on a database or network error. It returns
`{ data, error }`, and a dropped connection shows as status 0. A fake that throws
instead certifies an error path that never runs in production, while the real
`{ error }` path stays untested. Make every double return what the real
dependency returns.

## Instance 31 — test counts are timestamps

Peers land tests while you work. A total that changed between two runs does not
mean your change added or lost tests. Compare only `fail 0` (plus the checks in
Instance 27), never the total, unless no one else is writing.

## Instance 32 — reading "CI green" from the wrong run

Three ways to read the wrong verdict:

- **Short SHA:** it can match a newer push. Use the full 40-character SHA.
- **No `--workflow`:** the lookup lists every workflow at that SHA (keepalive,
  pre-gate sweep, dispatches). The first row is often not CI.
- **Docs-only push:** `ci.yml` has `paths-ignore` for `docs/**` and `**/*.md`
  (`ci.yml:36-55`). Such a push runs no CI. An empty result then means "not
  triggered", not "pending" or "failed". Read the newest code commit at or
  before it instead.

```bash
gh run list --commit <full-40-char-sha> --workflow=ci.yml
```

`worker/test/ci-workflow.test.ts` checks that the `push` and `pull_request`
ignore lists stay identical.

## Instance 33 — a sentinel that never existed passes "absent"

To check that production web runs the new bundle, fetch `/assets/index-*.js`
from https://applyyy.vercel.app/ and grep for **two** strings: one that must be
present and one that must be absent. First prove the "absent" string really is
in the old bundle and really is gone from the new source. A string that was
never there passes the "absent" check without proving anything.

## Instance 34 — prove the gate ran

The general form of most entries above. Before you trust a green, see the same
gate go red: inject an error and watch it get caught, or revert the fix and
watch a **named** test fail. A test that stays green when the fix is reverted
guards nothing. Report "written, not run" rather than a green on a command that
never executed your code.

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

---

## Mutation testing: three measurements, so it is a law rather than an anecdote

Each number is *assertions that failed when the code they cover was deliberately
broken* — i.e. assertions actually doing work:

| Suite | Survived mutation | Meaning |
|---|---|---|
| §19 injection suite | **12 / 14** | 2 assertions passed against broken code |
| Status-flow / graph assertions | **2 / 36** | **34 assertions proved nothing** |
| §17.2 extractor harness | **4 / 8** | half the suite rode on incidental formatting |

**The §17.2 case is the most instructive.** Deleting the extractor's
block-boundary awareness left **all 8 assertions passing** — because the
extractor was riding on the renderer's incidental **pretty-printed source
newlines** rather than on its own layout logic. The fix (collapse whitespace
before inserting any) is also the *more faithful model*, since a real ATS parser
reads a DOM and never sees source indentation.

**The survivor pattern is consistent across all three, and it is the actionable
finding: the assertions that survive mutation are the ORDER-INSENSITIVE ones.** In
the §17.2 suite the survivors included **"every skill is readable"** — the obvious
test, and *the one the whole feature exists for*.

That is the uncomfortable lesson. The test you would write first, the one stating
the feature's purpose most directly, is the one most likely to pass against broken
code — because a broad "nothing is missing" assertion is satisfied by many wrong
implementations. **Specificity is what makes a test load-bearing**, and the obvious
test is rarely specific.

**But mutation testing alone is not enough**, which instance 13 demonstrates: all
three numbers above prove a guard **can fail** and none proves it can **pass for
the right reason**. A guard that rejects every input scores perfectly here. Pair
every mutation measurement with a positive twin.

**The practice this justifies:** for any guard or extractor whose correctness
matters, **break it on purpose and confirm the suite goes red**, then **feed it a
correct input and confirm it goes green.** One measurement is an anecdote; three
in one project is a property of how tests get written here.


## The one-line test

Before recording anything as verified, answer this:

> **If the mechanism I am claiming to have verified were deleted, would my check
> have noticed?**

If the answer is no — or "I'm not sure" — the check is evidence of something,
but not of that.
