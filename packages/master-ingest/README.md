# `@applyy/master-ingest`

_Last verified against code: 2026-11-08 (2a9ac31)._

The master-profile **identity reconciler**. Pure functions over JSON: no UI, no
network, no PDF, no database, no clock, no randomness.

```ts
reconcileMasterProfile({ previous, incoming, mintId }) -> { profile, report }
```

Given the previously-stored `MasterProfile` and a freshly-parsed incoming one,
it carries node ids forward for nodes that are the same thing and mints new ids
only for genuinely new ones.

---

## What it exports, and who uses it

Everything is exported from `src/index.ts`. Import from `@applyy/master-ingest`,
never from a deep path.

| Export | File | Used for |
|---|---|---|
| `reconcileMasterProfile`, `ReconciliationError` | `src/reconcile.ts` | The entry point and the one error it throws |
| `reviewableRows`, `needsHumanReview`, `nonExactCarries` and the report types | `src/report.ts` | Rendering and gating the review list |
| `findDuplicateNodeIds`, `collectNodeIds` | `src/node-id-uniqueness.ts` | The global `NodeId` uniqueness rule, for any profile |
| `DEFAULT_BULLET_SIMILARITY_THRESHOLD`, `SCORE_TIE_TOLERANCE`, `diceSimilarity`, `scoresAreTied` | `src/similarity.ts` | The bullet metric and its knobs |
| `normaliseKey`, `tokenise`, `tokenSet` | `src/normalise.ts` | The text folds; the PDF parser must use the same ones |
| `skillKey`, `experienceKey`, `educationKey`, `projectKey`, `linkKey`, `achievementKey`, `certificationKey` | `src/match-keys.ts` | The per-kind match keys |
| `assignDeterministically` | `src/assign.ts` | The tie-aware assignment, testable with hand-written scores |

Consumers in the repo (regenerate with
`git grep -n "@applyy/master-ingest" -- apps packages ':!packages/master-ingest'`):

- **The web master upload.** `apps/web/src/features/settings/MasterUploadReview.tsx`
  calls `reconcileMasterProfile`; `apps/web/src/features/settings/masterReview.ts`
  builds the review list from `reviewableRows`. The web, not this package, stores
  the result (`apps/web/src/features/settings/masterStore.ts`), because this
  package is pure by charter.
- **The pasted-JSON check.** `apps/web/src/features/settings/masterIngest.ts`
  uses `findDuplicateNodeIds` for uniqueness (see "One rule, one home" below).
- **The PDF front half.** `packages/master-pdf` turns a PDF into a
  `MasterProfile`. It declares this package as a dependency
  (`packages/master-pdf/package.json:26`) so both halves can fold text the same
  way. As of 2026-11-08 its `src/` does not import any code from here yet; it
  only reuses the report vocabulary by convention. This package stays "no PDF":
  the parser lives there.

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
   *head* of `name`; links on `url`; achievements and certifications on `label`.
   **Bullets are the only fuzzy match**, because bullets are the only thing that
   gets reworded between uploads. Every key has a **tiebreak** consulted only when
   the primary key is ambiguous — never part of the primary key, or editing the
   tiebreak field alone would churn ids the primary key could have carried.

   The **summary** has no key at all and does not need one: `MasterProfile.summary`
   is a single nullable node, so if a previous and an incoming summary both exist
   there is exactly one candidate and exactly one claimant. Ambiguity there is not
   unlikely, it is *unrepresentable* — the type cannot hold a second summary. So a
   rewritten summary keeps its id, which is the right answer: `TailoredSummary.refs`
   points at that id and Teja rewrites the paragraph constantly.

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
  Only `fuzzy_text` needs a human. `kind` is one of `link`, `skill`, `experience`,
  `education`, `project`, `achievement`, `certification`, `summary`, `bullet` —
  the last three added 2026-09-11, each a separate member because `kind` is what a
  review UI groups and filters by.
- `minted` — got a fresh id, with one of six reasons (`no_previous_profile`,
  `new_parent`, `no_candidate`, `below_threshold`, `candidate_taken`,
  `ambiguous`) and the near-miss score where one exists.
- `dropped` — **a previous node absent from the incoming profile.** This is the
  entry that earns the list-not-count rule: old pinned applications still
  reference it, so it is a dangling reference somebody has to decide about. If
  pdf.js drops a bullet, this list is the only place that becomes visible.
- `ambiguous` — where the reconciler refused to decide, naming exactly the
  candidate ids a human is choosing between.

Every row in the first three lists also carries **where it sits** — `parentId`
plus a **pre-rendered** `parentLabel` ("Full Stack AI Engineer at Northwind
Systems"). That is not decoration. The failure this package exists to prevent is
a *true* bullet under the *wrong* parent, so a row reading "Cut p95 latency 40% —
reworded" is only reviewable beside the job it sits under. Pre-rendered rather
than `{ company, role }` components, so two consumers cannot join them
differently and show Teja two different wordings.

`carried` additionally carries `previousLabel` — the text **as it was stored**.
A fuzzy carry is reviewed by reading previous against incoming side by side; the
score alone is just a number to nod at. It is also the one value a caller cannot
recover from the output profile, because the output is what replaced it.

There are deliberately **no count fields**. A count field is an invitation to
render the count and skip the list, and rendering the count is how this package
silently stops working. A clean re-upload should be a five-second glance
(`needsHumanReview === false`); a suspicious one should be loud.

### The review gate

`reviewableRows(report)` returns the rows a person must acknowledge, tagged
`fuzzy_carry` / `ambiguous` / `uncertain_mint` / `dropped`. **The policy lives
there and nowhere else** — a consumer that reimplements "which rows are risky"
will drift from this one, and the two will then disagree about the only question
that matters.

Two decisions inside it worth knowing:

- **An ambiguity produces ONE row, not two.** Every ambiguity appears in both
  `minted` (reason `ambiguous`) and `ambiguous`, which is deliberate — each list
  answers a different question completely. But a *gate* must count one decision
  once, or a reviewer reads one refusal as two problems and has to acknowledge
  it twice. The `ambiguous` row survives, because it carries the candidate ids.
- **Every `dropped` row is reviewable, including on a deliberate deletion.** If
  the parse loses a bullet, this is the only place it surfaces. Making Teja
  acknowledge the deletion he *meant* is the price of catching the one he did
  not.

`needsHumanReview` is derived from `reviewableRows`, so the boolean and the list
cannot disagree. It means "a human should look", **not** "refuse to store" —
gating an accept button on `false` would make a reworded bullet unacceptable
rather than reviewable, and leave Teja stuck.

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

### The four node kinds that had no home in the contract — CLOSED 2026-09-11

Until 2026-09-11 the real resume contained four things `MasterProfile` had no
field for, and this section reported them upstream as silent data loss on ingest.
**They landed in `packages/shared-types/src/profile-nodes.ts` on 2026-09-11 and
are reconciled here.** The table below is what the reconciler now does with each,
not what it cannot do.

| In the PDF | Contract | Match key | Reconciled as |
|---|---|---|---|
| **ACHIEVEMENTS** (3 entries, label + description) | `MasterAchievement` | `label`, tiebroken by `(label, description)` | A **bulleted parent**, through the same generic as experience and projects |
| **CERTIFICATIONS** (4 entries, `Name – Issuer`) | `MasterCertification` | `label`, tiebroken by `(label, description)` | A **bulleted parent**, separate pool from achievements |
| The summary paragraph (unlabelled, 4 lines) | `MasterSummary`, at `MasterProfile.summary` | *none — see below* | A single node: carried, minted or dropped with `kind: 'summary'` at path `summary` |
| A project's *second* link (live URL **and** GitHub) | `MasterProject.links` replaced `url: string \| null` | `url`, tiebroken by `(url, label)` | A **nested flat section**, reconciled inside its own already-reconciled project |

Three things about that are worth stating, because each is a place the obvious
implementation is wrong:

- **`label` is the primary key, not `(label, description)`.** The description is
  the reworded half — the same relationship `linkKey` has, where the URL is stable
  and the human-facing label is not. And an achievement is a *bulleted parent*, so
  a failed parent key mints the achievement id **and every bullet id under it**
  with no similarity search attempted. Reordering four words of a detail line would
  break every pinned reference beneath it. That is the `projectKey` cascade again,
  in a new section. Keying on the *description* instead is worse still: it is null
  on most real lines, so every description-less achievement would normalise to the
  same empty key and none of them would carry.

- **The summary is carried even when the paragraph is completely rewritten,** and
  it is reported as `exact_key` rather than `fuzzy_text`. There is one summary, so
  a rewritten paragraph is still *the* summary. Scoring it would put the summary in
  the human-review list on every single upload, which is how a review list stops
  being read.

- **Project links are matched only inside their own reconciled project.** A global
  link pool would let the `Source` link of project A inherit the id of the `Source`
  link of project B whenever the URLs matched — and forks, org renames and template
  repositories make that ordinary rather than contrived. It is the same
  misattribution as a bullet under the wrong employer, one level down, and it is
  prevented by the same mechanism: the pool handed to the matcher is
  `previousProject.links` and there is no code path that can widen it.

**And one bug this closed that the contract change did not cause.** A *deleted*
project reported its bullets individually and said nothing about its links, so
those ids went dangling with nothing anywhere reporting them — the silent half of
`dropped`, in a field that was one day old. Found by an exhaustive `deepEqual` on
the whole dropped list; a `dropped.some(...)` per id would have passed.

---

## One rule, one home (the old duplication is closed)

An earlier version of this README reported that the **global `NodeId`
uniqueness** rule had two implementations: one in
`apps/web/src/features/settings/masterIngest.ts` and one here. That is no longer
true. `masterIngest.ts` now imports `findDuplicateNodeIds` from this package
(`apps/web/src/features/settings/masterIngest.ts:61`), so
`src/node-id-uniqueness.ts` is the one home for the rule.

The web file still owns a different question: *presence* ("does this node have a
usable id at all?"). That has to run over raw `unknown` JSON, interleaved with
its own shape walk. `findDuplicateNodeIds` takes a typed `MasterProfile` and
reads it with no guards, so the web runs uniqueness **last**, only after the walk
has proven the shape. The reasoning is in the comment at
`apps/web/src/features/settings/masterIngest.ts:160`.

---

## Testing bar

The suite runs with `node --test` (see "Running it"). Do not trust a test count
written in a doc: read `tests`, `fail` and `cancelled` from the run itself. As of
2026-11-08 the run reports `fail 0` and `cancelled 0`.

Every guard is **mutation-tested**: broken on purpose, with a check that exactly
the tests naming it go red. Every guard is also paired with a **non-vacuity
twin** — an input it must *accept* — because rejection-only tests cannot
distinguish a correct guard from one that rejects everything.

The table below is the **record of the mutation runs made on 2026-09-10 and
2026-09-11**. It has not been re-run since. Tests added later can change the
kill counts, so treat the numbers as history and the mutations as the list of
guards worth re-checking.

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
| `parentId` on the fuzzy-carry row | 2 |
| `previousLabel` on the fuzzy row echoes the incoming text | 2 |
| Label truncation reinstated at 80 chars | 2 |
| Ambiguous mints counted as a second review row | 2 |
| `reviewableRows` omits dropped nodes | 3 |
| **Added 2026-09-11 with the four new node kinds** | |
| `achievementKey` primary `label` → `(label, description)` | 1 |
| `certificationKey` primary `label` → `description` | 2 |
| Summary carry → always mint | 19 |
| Summary drop row removed | 1 |
| Summary mint reason: `no_previous_profile` branch removed | 2 |
| **Project-link pool: parent-scoped → global** (the misattribution, one level down) | **19** |
| Nested mint reason `new_parent` → `no_candidate` | 2 |
| Dropped parent stops reporting its links | 3 |
| Achievements reconciled against an empty pool (silent re-identification) | 25 |
| Certifications reconciled against an empty pool | 20 |
| Project-link rows stop naming their project | 3 |
| Project links never reconciled at all | 7 |

Two results worth reading:

- **The per-section mutation kills 9 tests but leaves the within-section
  duplicate test passing.** That reproduces the repo's recorded finding that a
  per-section checker passed **34 of 36** ingest tests: the case anyone writes
  first passes under *both* designs, so on its own it is not evidence that the
  checker is global.
- **Two review fields were claimed to exist and did not.** `parentId` and a
  parent label were described to the consuming session as already present on
  `carried` / `minted` / `dropped`; they existed only on `AmbiguousMatch` —
  which was exactly the wrong list, since `ambiguous` is where the reconciler
  *refused* and a human is already looking hard. The dangerous list is `carried`
  with `fuzzy_text`, where a decision was made silently by a score. Caught by
  `applyyy-20` grepping the shipped code against the claim. Labels were also
  truncated at 80 characters, which would have cut every real 150–200 character
  bullet mid-sentence in the review UI.
- **The achievement key mutation kills exactly ONE test, and that is the right
  number.** Folding the description into the primary key only changes the answer
  for an achievement whose description was reworded and whose label was not — every
  other input still carries. A mutation that killed twenty tests here would have
  meant the suite was asserting the same thing twenty times.
- **The stored-profile precondition initially killed ZERO tests.** The test
  named after it was passing because the *postcondition* caught the same input —
  a composite result, and exactly `docs/verification-traps.md`'s THE RULE. It is
  now tested with an input only the precondition can catch: a duplicate on two
  nodes that are both **dropped**, so the output is clean and the postcondition
  has nothing to fire on.

---

## Running it

From the **repo root**, through the package's own scripts:

```sh
pnpm --filter @applyy/master-ingest run test        # node --test "test/**/*.test.ts"
pnpm --filter @applyy/master-ingest run typecheck   # tsc --noEmit, checker only, never an emitter
```

Or, with no pnpm at all, from `packages/master-ingest/`:

```sh
node --test "test/**/*.test.ts"
```

Report `tests` and `fail` together: `tests 0` with `fail 0` means the glob
matched nothing, not that everything passed.

Two things that have each cost a session:

- **The test glob is required.** `node --test test` — a bare directory — fails on
  Node 24 with `MODULE_NOT_FOUND`, and the error reads exactly like a missing
  fixture. The `test` script above already has the glob; run the script.
- **Do not use `pnpm -r`.** It can rewrite the shared `pnpm-lock.yaml` as a side
  effect, and it *topologically skips* the dependents of a failed package rather
  than failing them — so a red `shared-types` leaves `master-ingest` silently
  unchecked while the run still looks like it covered everything. `--filter` runs
  exactly the package named.

There is **no build step, and one must not be added.** Raw `.ts` source with a
source-only `exports` map, exactly like `resume-template`. That absence is what
lets a browser, Node and a Deno Edge Function all import the same file; a build
step would create a second, stale copy of the function that decides whether a
node id survives.

**Setup note:** the workspace dependency on `@applyy/shared-types` is resolved
through the package's own (gitignored) `node_modules/@applyy/shared-types` link.
As of 2026-11-08 that link exists and points at `packages/shared-types`. If it is
missing, the fix is a `pnpm install` at the repo root, which writes
`pnpm-lock.yaml`. Per the repo `CLAUDE.md` section 5, only the orchestrator
schedules that. Deno does not need the link: `deno.json` maps
`@applyy/shared-types` to `../shared-types/src/index.ts`.
