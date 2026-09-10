# `@applyy/web` — the operator console

Nine pages (`PROJECT_PLAN.md` §15) plus the resume diff view. React 18 + Vite 6
+ TypeScript, static bundle, no server of its own.

**Scope of this file.** Only what is true of `apps/web`. Cross-stream status
lives in `docs/PROGRESS.md` and the schema contract in
`packages/shared-types/SCHEMA_CONTRACT.md` — this file deliberately does not
restate either, because two homes for one fact drift apart and start
contradicting each other.

---

## Commands

```
pnpm --filter @applyy/web typecheck   # tsc --noEmit
pnpm --filter @applyy/web test        # node --test, no framework
pnpm --filter @applyy/web build       # typecheck then vite build
pnpm --filter @applyy/web dev         # vite, port 5173, strict
```

**Verified 2026-09-10:** `typecheck` exit 0, `build` exit 0 (dist: 1.86 kB
html, 17.75 kB css, 233.89 kB js / 73.62 kB gzip), `test` 36/36 passing. This
was the package's first successful build.

### Why `node --test` and not vitest

Zero test dependencies. Node runs the `.ts` sources directly by stripping the
types — which works **only** because `erasableSyntaxOnly` in
`tsconfig.base.json` guarantees every file in the repo is type-strippable. That
flag was added to stop `export enum` breaking the worker at runtime; the test
runner is a side benefit.

> **Trap, and it cost time.** `node --test test/` **fails** on Node 24.14.0 —
> it resolves the bare directory as a module and dies with `MODULE_NOT_FOUND`.
> `./test/` fails identically. Only the glob form works:
> `node --test "test/**/*.test.ts"`. Worth knowing repo-wide: another package's
> red `pnpm test` was attributed to a missing fixtures folder and is probably
> this same invocation bug.

---

## Why this package had never compiled

Not the reason everyone was told. The `"typescript": "5.7.2"` pin versus
`erasableSyntaxOnly` (needs ≥ 5.8) was a real hazard but had already been
fixed. The actual cause:

`tsconfig.json` and `tsconfig.node.json` each overrode `moduleResolution:
"Bundler"` while inheriting `module: "nodenext"` from the base config. **`module`
and `moduleResolution` are a coupled pair — override half and tsc rejects it
outright** (TS5095 + TS5109).

- The app project now restates `module: "ESNext"` alongside its `Bundler`
  resolution, which is the correct Vite pairing.
- `tsconfig.node.json` **dropped** its `Bundler` override instead. `vite.config.ts`
  is genuinely Node code importing only bare package specifiers, so inheriting
  the base `nodenext` pair is the honest setting — a Node file should not be
  told it is bundled.

*Generalisable: when a config inherits a coupled pair, override both halves or
neither.*

---

## Invariants — do not break these without reading why

### One import surface for domain types

`src/data/contract.ts` re-exports `@applyy/shared-types` and **no domain type is
declared anywhere else under `apps/web`.** Keep it that way. The status graph,
the enums and the table shapes have exactly one definition and this package is a
*reader* of them. A reader that keeps its own copy is not a reader.

Concretely this has already paid for itself twice:

- **Kanban columns and card actions are derived, not listed.** Columns come from
  `APPLICATION_STATUSES`, per-card moves from `nextStatuses(status, 'human')`,
  and lane grouping falls back to `isTerminal`. A status added upstream lands in
  a sensible column with no edit here. A hardcoded column list would mean rows
  in a new status exist but appear nowhere — a silent stall, which is the exact
  failure class §14 is about.
- **Keying page copy by a schema enum turns a fabrication into a build error.**
  `PROVIDER_HINTS` in `WatchlistPage.tsx` is `Partial<Record<AtsProvider, …>>`.
  It caught an invented `workday` provider at compile time (the real enum is
  greenhouse / lever / ashby / workable / smartrecruiters / unknown / other).
  Copy keyed by a plain string would have shipped a page describing an ATS that
  does not exist. **Worth copying in every stream.**

### Untrusted text is never HTML

Constraint #17. Job descriptions, company names and board data are all
`Untrusted`. There is **no `dangerouslySetInnerHTML` anywhere in this package**
and no second escaper — `packages/resume-template` exports `escapeHtml` and
`safeHref` if one is ever needed. React text children only.

### Nothing here can approve an application

Constraint #15. `awaiting_approval → approved` is `allowedAgents: ['human']`
and is the only door into the submit path. No control in this package fires it
automatically; every pipeline control is disabled and visibly so.

### Two visual languages, not two shades

The diff view's traced content is deliberately quiet; fabricated content is loud
with four redundant signals (colour, weight, underline, a named provenance
footer, a screen-reader announcement) so it survives colour-blindness, greyscale
and a tired glance at row 30 of 35. A diff where every change is highlighted
equally is a diff nobody reads.

`--alarm-ground` (the dark surface) appears in **exactly one place** — the
Bucket B alert band. Its scarcity is the signal. Do not reuse it.

### Approve stays disabled until every flagged claim has a named decision

A radio between "Cut it" and "Keep it, I can defend it" — never an
acknowledgement checkbox. An acknowledgement is satisfied by clicking; a named
choice cannot be satisfied without reading. Both outcomes are legitimate:
sometimes the master is genuinely incomplete, and a gate that only permits
deletion would train the operator to lie to it.

§18.7 coverage is **one bar with two segments** (supported-by-master vs
coverage-bought-with-flagged-claims). A single percentage rewards fabrication —
going 50% → 100% by inventing two things would read as success.

### Human lanes: the predicate is in the name

`src/data/humanLanes.ts` exposes `HUMAN_ONLY_LANES` (`allowedAgents ===
['human']`, 11 edges) and `HUMAN_REACHABLE_LANES` (`.includes('human')`, 31
edges) as **separately named** sets. `MISSING_HUMAN_CONTROLS` filters the wide
one.

An earlier version filtered the narrow one and therefore reported **full UI
coverage while the control for the safety-critical `applying →
needs_verification` edge was missing.** The bug came entirely from a set whose
name did not state its predicate. Coverage is checked *per source status*, not
per edge, so a screen that builds its buttons from `nextStatuses` keeps covering
new edges as the graph grows.

### System health reports age, not status

A job that stopped a month ago has a perfectly successful last run, so
"succeeded" is the wrong indicator. Freshness is the signal. This is a dead
man's switch read from the consumer side: silence must render as loudly as
failure, which is why `.unknown` is italic muted text and never a blank cell —
a blank reads as zero, and zero is the opposite claim.

---

## Tested code

Two pure modules, both extracted specifically so they could be tested, both
mutation-checked by hand.

### `src/data/keyRole.ts` — the anon-key guard

`supabase.ts` refuses to construct a client unless the key's JWT `role` claim
reads `anon` (§10 defense 4). The service-role key must never enter a bundle
Vercel serves.

**The check was previously untestable, not merely untested.** `readRoleClaim`
was module-private inside `supabase.ts`, and that module throws *at import
time* — so any test importing it had to satisfy the guard before it could test
the guard. Extracting the pure decision (never throws, no environment) and
leaving the side effect (refusing to boot) in `supabase.ts` fixed that.

*Pattern: **separate the pure decision from the side effect.** The decision is
the part that can be subtly wrong; the side effect is what makes it hard to
reach.*

**Mutation, measured.** Changed `=== 'anon'` (allowlist of one) to `!==
'service_role'` (blocklist) — the plausible wrong implementation:

| | |
|---|---|
| Result | **14 tests, 2 passed, 12 failed** |
| Survived | "anon key accepted", "service_role key rejected" |
| Killed | 11 fail-closed malformed-input cases + a plain `authenticated` role |

**The two survivors are the two anyone would have written.** Right key passes,
wrong key fails — and a guard with a hole wide enough to admit an unreadable key
*and every role Supabase invents from now on* sails through both.

Three inputs became fourteen because **"malformed" is a family, not an input**:
wrong segment count, undecodable base64, non-JSON payload, valid-JSON-but-not-an-object,
object with no role, role as number / null / object. Unreadable **must fail
closed** — that is the case that gets missed, because the tempting shortcut is to
shrug at a token you cannot parse and carry on, admitting a key precisely when
you understand it least.

> **Known gap: nothing imports `supabase.ts` yet, so this guard is currently
> unreachable** — module-level code does not run until something imports the
> module. It is correct, tested, and protecting nothing until the read path
> lands. Corollary: the app does *not* white-screen on missing env vars today,
> because the client is never constructed.

### `src/features/settings/masterIngest.ts` — master profile ingest

Takes `unknown`, never throws, returns findings. Result is a **discriminated
union on `ok`**, so a caller cannot read `.profile` without handling the failure
case — the compiler refuses to let anyone store a profile that had blocking
findings.

**The integrity rule it enforces, and why it matters:**

> Every node id must be unique **across the whole profile**, not per section.

`validator.ts`'s `indexBullets` builds one flat `Map` keyed by bullet id across
experience, projects *and* education. A `Map` overwrites. So two bullets sharing
an id means the second silently replaces the first — and the
`misattributed_bullet` check then compares against **the wrong parent**. A
genuinely misattributed bullet can pass the audit, decided only by which
duplicate was indexed last. No error is raised anywhere.

A duplicate id is also the likeliest defect in hand-written JSON, because the
way anyone adds a bullet is to copy the one above it.

**Mutation, measured.** Gave each section its own id ledger — uniqueness per
section, which reads as the *more* sensible rule:

| | |
|---|---|
| Result | **36 tests, 34 passed, 2 failed** |
| Killed | cross-section bullet collision; skill id colliding with a bullet id |
| Survived | everything else, **including** the within-section duplicate test |

A per-section checker passes 34/36, catches the mistake people make most often,
and still leaves the audit corruptible. **Two tests out of thirty-six
discriminate between the correct design and the plausible wrong one.**

*Second confirmation in this package: the tests that tell a right design from a
convincing wrong one are almost never the obvious ones. The only way to learn
which of your tests are load-bearing is to break the code on purpose and see
which ones notice.*

Findings split `blocking` (breaks a downstream guarantee) from `advisory` (legal
but disappointing — an untagged bullet is never selected, so it is invisible
rather than invalid). A stricter check is not a better check. Every finding
carries a dotted path (`experience[2].bullets[0].id`) that can be pasted into an
editor's search box, and states the *consequence* rather than the rule.

---

## Known gaps — stated, not worked around

| Gap | Owner |
|---|---|
| Nothing imports `supabase.ts`; no page reads real data yet | this package |
| The nine pages are laid out but not wired — every one carries a `.not-wired` banner | this package |
| No master profile editor; ingest reports but does not store | this package |
| **No real master resume exists anywhere in the repo** — only a synthetic `ResolvedResume` fixture. Do not fabricate résumé content to fill it | content, needs Teja |
| `validator.ts` should fail closed on duplicate master bullet ids — ingest cannot be the only defence, since migrations and direct DB writes bypass this page | schema/validator stream |
| `AuditFinding` is `{path, claim, reason, confidence}` — no `kind`, no `parentRef`, so the validator's `misattributed_bullet` discrimination is **discarded at the persistence boundary** and the provenance footer cannot name claimed-vs-actual parent | schema stream |
| `BLOCK_REASONS` has one `unanswerable_question`; `block_detail` carries only `question_key`. Cannot tell "no answer stored" from "uncertain match" from "refused on principle" — and collapsing the first two loses the answer-bank write-back trigger, which is the whole value of a bank that grows itself | schema stream |
| `answer_bank.needs_human` is a boolean trying to express three states that need three different operator actions | schema stream |

`.not-wired` means "this UI is unfinished and will be finished".
`.contract-gap` means "the data cannot express what this screen needs, and no
amount of frontend work fixes it". They are separate classes on purpose —
conflating them would hide a cross-stream dependency behind a to-do note.
