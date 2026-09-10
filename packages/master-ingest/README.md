# `@applyy/master-ingest`

The master-profile **identity reconciler**. Pure functions over JSON: no UI, no
network, no PDF, no database, no clock, no randomness.

```ts
reconcileMasterProfile({ previous, incoming, mintId }) -> { profile, report }
```

Given the previously-stored `MasterProfile` and a freshly-parsed incoming one,
it carries node ids forward for nodes that are the same thing and mints new ids
only for genuinely new ones.

---

## Why this exists

Teja builds his resume in Overleaf and re-uploads a fresh PDF whenever he adds a
project or a skill. Every bullet, skill, project and experience in the master
profile carries a stable `NodeId`, and those ids are load-bearing: the AI
tailoring a resume may only return **references** to existing ids, never free
text. That is what makes "invent a skill Teja doesn't have" **structurally
impossible rather than merely detectable**.

A PDF has no ids. So a naive re-parse mints brand-new ids on every upload and
silently re-identifies every node. **Nothing errors** — the database still sees
a valid version, the composite foreign key stays satisfied, and the ids inside
simply stop meaning what older applications assumed.

**A mis-carried id is worse than a missing one.** A missing reference fails
loudly at resolution. A mis-carried id re-parents a *true* bullet under the
*wrong* employer, producing fabricated experience assembled entirely from true
parts — where every individual claim survives a fact-check. That failure has a
name in this repo: `misattributed_bullet`.

---

## The four design decisions

1. **Parents are reconciled FIRST; bullets are matched ONLY within their
   already-reconciled parent.** Matching bullets globally would let a bullet
   migrate between employers whenever its text happened to score well — the
   misattribution above, reached by a mechanism nobody would notice. Scoping the
   search to one parent makes cross-parent migration **unrepresentable** rather
   than merely unlikely: no code path can express it, so no threshold setting and
   no future refactor can produce it.

2. **Different match keys per kind**, because the kinds have different
   stability. Skills match on normalised `name`; experience on
   `(company, role)`; education on `(institution, degree)`; projects on the
   *head* of `name`. **Bullets are the only fuzzy match**, because bullets are
   the only thing that gets reworded between uploads. Every key has a **tiebreak**
   consulted only when the primary key is ambiguous — never part of the primary
   key, or editing the tiebreak field alone would churn ids the primary key
   could have carried.

3. **Ambiguity fails loud; it never guesses.** A tie is precisely the case where
   a similarity threshold has no information to resolve anything, so it is
   reported in `ambiguous` and both nodes get fresh ids. Ties are detected on
   **both axes** — one incoming bullet tied between two previous ones, *and* one
   previous bullet tied between two incoming ones. The second is the direction a
   single-axis implementation forgets, and forgetting it means the losing bullet
   silently receives a fresh id.

4. **`mintId` is injected, never ambient.** It keeps `src/` free of every Node
   API so Deno, Node and the browser can all import this package, and it makes
   every test deterministic without stubbing a global.

**An incoming id is never used as an output id.** Unmatched nodes get a *minted*
id, not the id the parser happened to put on them. A parser that labels bullets
positionally produces `bullet-0` on every upload, and keeping that id would let
a brand-new first bullet inherit last month's first bullet's identity — a
misattribution with no similarity score anywhere in its causal chain.

---

## The knob that will bite someone later

`DEFAULT_BULLET_SIMILARITY_THRESHOLD = 0.6` **fails silently in both
directions**, and neither failure raises anything anywhere:

| Setting | Failure | Consequence |
|---|---|---|
| Too low | Two different bullets under one job match | An id carries onto a claim it was never about |
| Too high | A reworded bullet fails to match itself | Its id churns and every old pin dangles |

**No value is safe by construction**, and that is measured rather than
cautious — both numbers are asserted in `test/similarity.test.ts`:

- `Cut p95 latency 40%` vs `Reduced p95 latency by 40%` — the **same** bullet,
  reworded — scores **0.667**.
- `Built the auth service` vs `Built the billing service` — two **different**
  bullets — scores **0.75**.

The false pair scores *higher* than the true pair, so **no threshold exists**
that accepts one and rejects the other. Tuning the number cannot fix it: the
ordering is wrong, not the cut point.

**Which is why the mitigation is not a better number.** The ingest flow must
show a human **every** non-exact match — previous text, incoming text, score —
and never a total. `nonExactCarries(report)` exists for exactly that, and a UI
that renders a count instead of the list has removed the only defence this
package actually has.

---

## The report is the product

Four **lists**, not four counts:

- `carried` — kept its previous id, with `match: 'exact_key' | 'exact_text' | 'fuzzy_text'`.
  Only `fuzzy_text` needs a human.
- `minted` — got a fresh id, with one of six reasons (`no_previous_profile`,
  `new_parent`, `no_candidate`, `below_threshold`, `candidate_taken`,
  `ambiguous`) and the near-miss score where one exists.
- `dropped` — **a previous node absent from the incoming profile.** This is the
  entry that earns the list-not-count rule: old pinned applications still
  reference it, so it is a dangling reference somebody has to decide about. If
  pdf.js drops a bullet, this list is the only place that becomes visible.
- `ambiguous` — where the reconciler refused to decide, naming exactly the
  candidate ids a human is choosing between.

There are deliberately **no count fields**. A count field is an invitation to
render the count and skip the list, and rendering the count is how this package
silently stops working. A clean re-upload should be a five-second glance
(`needsHumanReview === false`); a suspicious one should be loud.

---

## Verified against the real resume, 2026-09-10

The match keys were originally reasoned from the type contract. They were then
checked against Teja's actual Overleaf PDF, and **one was wrong**:

- **Projects.** One real project is titled `One-on-One – AI-Powered Learning
  Platform`: a name plus a **rewordable tagline**. Keying on the whole string
  makes the tagline load-bearing, and because bullets only match within a
  reconciled parent, rewording four words of a subtitle would churn one project
  id **and all four of its bullet ids** — one edit, five broken references,
  nothing reported. The key is now the name **up to the first ` - `**, with the
  full name as the tiebreak. This is a change of key *derivation*, not a move to
  fuzzy matching: still exact, still deterministic.
- **Experience** — confirmed. Entries are written `Role – Company` with a
  separate date range, so `(company, role)` has two real fields to read.
- **Education** — confirmed. Rendered as a `Degree | Institute | Duration`
  table.
- **Skills** — confirmed. Grouped under eight bolded categories, so
  `MasterSkill.category` has a real source. Keyed on `name` alone so that
  re-filing a skill between categories does not churn its id.
- **Hyphenation.** The document is justified LaTeX and **hyphenates across line
  breaks** in six places. Where the break falls depends on every word before it,
  so editing one early word moves the hyphen and changes the token set of text
  that was never touched. `normalise.ts` folds `letter + '-' + whitespace` for
  exactly this reason. It also mangles rare constructions like `pre- and
  post-processing`, and that cost is accepted because **normalisation only has to
  be consistent, not linguistically correct** — both sides of every comparison
  pass through the same function.
- **Extraction order.** The text layer comes out in **true reading order**; the
  apparent inversions in a naive `y`-then-`x` sort are the bullet glyph sitting
  0.2pt off its own text baseline. Bucket `y` with a tolerance, or trust
  emission order.

### Node kinds with no home in the contract

The real resume contains three things `MasterProfile` has no field for. These
are **not** reconciler bugs — the reconciler cannot carry an id for a node the
type cannot hold — but they are silent data loss on ingest:

| In the PDF | Status |
|---|---|
| **ACHIEVEMENTS** (3 entries, label + description) | No field in `MasterProfile` |
| **CERTIFICATIONS** (4 entries) | No field in `MasterProfile` |
| The summary paragraph (unlabelled, 4 lines) | No field; `TailoredSummary` is generated per-job |
| A project's *second* link (live URL **and** GitHub) | `MasterProject.url` holds one |

`packages/shared-types/**` is another session's file, so these are reported
upstream rather than fixed here.

---

## Known duplication, stated rather than hidden

`apps/web/src/features/settings/masterIngest.ts` already implements the **global
`NodeId` uniqueness** rule correctly, for *pasted JSON before it is stored*.
`src/node-id-uniqueness.ts` is a second implementation for a different input — a
reconciler *output*. Two implementations of one rule drift apart, so this is
worth consolidating: the natural home is this package, whose name already says
so. Not done unilaterally because `apps/web/**` belongs to another session.

---

## Testing bar

68 tests. Every guard is **mutation-tested**: broken on purpose, with a check
that exactly the tests naming it go red. Every guard is also paired with a
**non-vacuity twin** — an input it must *accept* — because rejection-only tests
cannot distinguish a correct guard from one that rejects everything.

| Mutation | Tests killed |
|---|---|
| Parent-scoped bullet pool → global pool | 12 |
| Tie detection, axis 1 (incoming tied between previous) | 5 |
| Tie detection, axis 2 (previous tied between incoming) | 5 |
| Output global-uniqueness postcondition | 2 |
| Stored-profile precondition | 3 |
| **Global id space → per-section** (the plausible wrong design) | **9** |
| Deterministic sort tiebreaks | 2 |
| Project key truncated at tagline → full name | 2 |
| Skill key on `name` → `(name, category)` | 2 |
| Line-wrap hyphen fold | 3 |
| Exact-text pass before the fuzzy pass | 7 |
| Mint for unmatched bullets → keep the parse id | 2 |
| Soft-hyphen fold | 2 |

Two results worth reading:

- **The per-section mutation kills 9 tests but leaves the within-section
  duplicate test passing.** That reproduces the repo's recorded finding that a
  per-section checker passed **34 of 36** ingest tests: the case anyone writes
  first passes under *both* designs, so on its own it is not evidence that the
  checker is global.
- **The stored-profile precondition initially killed ZERO tests.** The test
  named after it was passing because the *postcondition* caught the same input —
  a composite result, and exactly `docs/verification-traps.md`'s THE RULE. It is
  now tested with an input only the precondition can catch: a duplicate on two
  nodes that are both **dropped**, so the output is clean and the postcondition
  has nothing to fire on.

---

## Running it

```sh
node --test "test/**/*.test.ts"   # the glob is required; a bare directory fails on Node 24
tsc --noEmit                       # checker only, never an emitter
```

There is **no build step, and one must not be added.** Raw `.ts` source with a
source-only `exports` map, exactly like `resume-template`. That absence is what
lets a browser, Node and a Deno Edge Function all import the same file; a build
step would create a second, stale copy of the function that decides whether a
node id survives.

**Setup note:** the workspace dependency on `@applyy/shared-types` needs one
`pnpm install` at the repo root to be linked normally. That writes
`pnpm-lock.yaml`, which is shared root config owned by another session, so it
has not been run from here — the package is verified against a directory
junction in its own (gitignored) `node_modules` instead.
