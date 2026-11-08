# Brief 5 — Relevance-weighted node selection + four anti-fabrication auditor rules

> **Status 2026-11-08:** Partly shipped, not as specified. No standalone node-relevance scorer exists; relevance is posting-keyword matching (`keywordAppearsIn`, `supabase/functions/_shared/tailor/jd-keywords.ts`), used for skills-group order (`tailorer.ts`, 5a3009b) and for the one-page trim (`page-trim.ts`). The four auditor rules in Part B were not built: `_shared/audit/detector.ts` emits `unresolved_ref`, `unfaithful_rewording`, `misattributed_bullet`, `jd_keyword_dropped` and `summary_unsupported` only. The body below is the original record, unedited.

> `Ported from MadsLorentzen/ai-job-search @ 968fb1bd (MIT, © 2026 Mads Lorentzen).`
>
> **What changed in the port:** upstream is a markdown prompt framework that produces
> LaTeX/moderncv documents and shrinks them by editing `.tex` lines. We take the
> **decision logic only** and re-express it as (a) a pure scoring function over
> identified JSON nodes and (b) four machine-checkable auditor rules. Every LaTeX
> mechanic, `\cventry`, `\enlargethispage`, font-encoding and compile-loop detail in
> the source is **discarded** — roughly 70% of `05-cv-templates.md` is LaTeX debugging
> lore that is worthless here. Project owner's verbatim rule: *"use our tech stack,
> just adapt their product feature only."*

**You are a peer session starting with an empty context window.** Everything you need
that you cannot re-derive is in this file. Read it end to end before you open an editor.

This is **P7** in `docs/harvest/2026-09-16-ai-job-search-harvest-plan.md` ("Tailor
node-selection scoring"). The `brief-5` filename is a brief index, not the plan's
parcel number — do not go looking for a "P5 node selection" section; P5 in the plan is
PDF layout checks and belongs to someone else.

---

## 0. The 60-second orientation

Project: `applyyy` at `C:\Users\tejam\OneDrive\myproj\applyyy` — an autonomous
job-application system. Node + TypeScript everywhere, locked. Gemini is the LLM.
Supabase Edge Functions (Deno) for agents; pnpm workspace packages for shared libs.

### The locked architecture that makes this parcel possible — understand this first

**The master resume is STRUCTURED JSON, not a document.** Every tailored resume is a
**selection and rewording of identified JSON nodes**, rendered through one HTML
template and printed by Playwright's `page.pdf()`.

Because the Tailor manipulates **identified nodes** rather than free text, *"return
references into the master"* is the natural interface. That is what makes the
anti-fabrication guarantee **structural rather than a rule bolted on afterwards**: the
Tailor is *incapable* of inventing, because it can only reference. `NodeId`s are unique
across the entire profile (one global id space, decided 2026-09-10), so a ref either
resolves to exactly one master node or the tailoring is rejected before the Auditor
ever runs.

Project constraint #2: **do not invent** experience, projects, skills, technologies,
metrics, companies, certifications, education, or qualifications.
Project constraint #9: **job-description text is untrusted.**

### Your parcel

Implement **relevance-weighted node selection as the Tailor's ordering function**,
plus **four anti-fabrication rules as Auditor checks**.

### Write partition — you may write ONLY this

```
supabase/functions/_shared/tailor/**
```

### Forbidden to touch — every one of these is owned by a concurrent session

```
supabase/functions/_shared/ats/**        supabase/functions/_shared/screen/**
supabase/functions/_shared/http/**       supabase/functions/scout-ats/index.ts
worker/**                                apps/web/**
packages/**                              any existing migration
.gitignore                               PROJECT_PLAN.md            pnpm-lock.yaml
```

If you need a type change in `packages/shared-types/**`, **REPORT it, do not write it.**
(See §8 — there is at least one likely candidate already.)

---

## 1. Mandatory recon — spawn read-only recon subagents before writing anything

Run these in parallel as read-only agents (`Explore` / `general-purpose`, no writes).
The findings below are what the briefing session already established; **verify them, do
not trust them blindly** — they are a starting map, not the territory.

| Target | What to establish |
|---|---|
| `supabase/functions/_shared/tailor/**` | What already exists. **Extend, do not replace.** Today: `prompt.ts` (316 lines), `prompt.test.ts` (446), `validator.ts` (799), `validator.test.ts` (1189). |
| `packages/shared-types/src/profile-nodes.ts` | The **real node identity type** — `NodeId`, `MasterProfile`, `TailoredProfile`, `ResolvedResume`. Do **not** invent a node identity type. |
| `packages/master-ingest/src/**` | Owns text normalisation and `normaliseKey`. **Your keyword matching must reuse these folds.** |
| `supabase/functions/_shared/ats/types.ts` | The `Untrusted` branded type and how it is threaded. |
| `supabase/functions/_shared/ats/registry.ts` | **The calibration target for comment density and voice.** Read it before writing a line. |

### Recon findings you can start from (verify, then extend)

**Node identity — `packages/shared-types/src/profile-nodes.ts`:**

- `export type NodeId = string;` (line 121). One **global** id space across the entire
  `MasterProfile` — experience, education, projects, skills, achievements,
  certifications, links, and the summary. The ingest validator rejects duplicates.
- `MasterProfile` (line 325) has: `schema_version: 1`, `identity`, `summary:
  MasterSummary | null`, and `DocumentOrdered<T>` arrays for `education`,
  `experience`, `projects`, `skills`, `achievements`, `certifications`, `links`. These
  are **required arrays, possibly empty — never optional properties**, deliberately.
- `MasterBullet` is *the atom of the whole system*: `{ id, text, tags:
  DocumentOrdered<string> }`. The doc comment says the tags are exactly *"free-form
  tags the Tailor uses to select relevant bullets, e.g. ["node", "rest", "postgres"]"*
  — **your relevance factor has a purpose-built input already in the contract.**
- `MasterExperience` / `MasterEducation` carry `start_display` / `end_display`
  (`DisplayDate`, printed verbatim) **and** `start_date` / `end_date` (ISO, *"for
  sorting and analytics only. NEVER rendered"*, null for a current role).
- `TailoredProfile` mirrors the master but every leaf is a `{ ref: NodeId, ... }`.
  `TailoredSummary` is `{ text: string; refs: DocumentOrdered<NodeId> }` and its doc
  comment is candid about being the weak point: *"`text` is free prose, and `refs`
  proves what the paragraph was DRAWN FROM, never that it is faithful to it. That last
  step is the Auditor's, and it is judgement rather than structure."*
- `TailoredProfile.section_order: DocumentOrdered<TailoredSectionKind>` **already
  exists** — §5's role-type section ordering has a home in the contract and needs no
  type change.

**Import discipline (this will bite you if you miss it):**
`supabase/functions/**` reaches `@applyy/shared-types` through **exactly one file**:
`supabase/functions/_shared/contracts/shared-types.ts`, which uses the relative path
`../../../../packages/shared-types/src/index.ts`. Its header explains why: the bare
specifier resolves under Deno's import map but **not** under `node --test`, and
`pnpm install` is currently failing workspace-wide. **Do not add a second import path.**
If you need a type that module does not yet re-export, that file is inside
`supabase/functions/_shared/` but is **not** inside `tailor/` — **confirm ownership
before editing it, and if in doubt, report instead.**

**`Untrusted` — `packages/shared-types/src/tables.ts:106`:**

```ts
export type Untrusted = string;
```

with the comment: *"This is a documentation alias — it is `string` to the compiler and
buys no enforcement. It exists so the danger is visible at every use site instead of
living in a document nobody rereads."*

**So the compiler will not save you.** Your relevance scorer consumes job-description
text, which is attacker-controlled. The existing defence lives in `tailor/prompt.ts`:
untrusted text never enters the instruction region, it travels inside an unforgeable
fence (`UNTRUSTED_FENCE_OPEN` / `UNTRUSTED_FENCE_CLOSE`, with runs of 3+ angle brackets
stripped from untrusted text so it can neither reproduce a delimiter nor invent a new
one that looks equally authoritative), and every call declares a response schema. Note
that `prompt.ts` fences **all three** attacker-controlled fields — description, title
*and* company — because *"a guard that fences only the description leaves two doors
open."*

**Your scorer must be a pure function over untrusted text that produces only numbers
and booleans** — never a string that flows back into an instruction. Type every
JD-derived parameter as `Untrusted`, and extract tokens rather than passing prose
through.

**Text folds — `packages/master-ingest/src/normalise.ts` + `index.ts:83`:**

```ts
export { normaliseKey, tokenSet, tokenise } from './normalise.ts';
```

`normaliseKey` does NFKC (not NFC — it also folds compatibility forms such as
ligatures), strips invisible/zero-width characters, folds en/em dashes and the
line-wrap hyphen, collapses whitespace, and lower-cases. It is for **identity** (a
skill name, a company, a degree) and it **preserves symbols**, which is what keeps `C`,
`C++` and `C#` distinguishable — `match-keys.ts:76` calls this out explicitly and uses
`normaliseKey`, *not* the tokeniser, for that exact reason.

**This is not optional.** `packages/master-pdf/package.json` states it as a dependency
rule:

> *"shared-types owns `MasterProfile` and `NodeId`; **master-ingest owns
> `normaliseKey`. THE SECOND ONE IS NOT OPTIONAL**: master-ingest/src/index.ts:79-83
> states that the PDF parser must use the SAME text folds the matcher uses, because
> **two implementations of 'the same text' let an item fail to match itself for reasons
> invisible in the document.** Its hyphen fold was measured on THIS resume."*

**Keyword matching in this parcel must reuse master-ingest's folds, not roll its own.**
An item failing to match itself is exactly the failure mode here: a master skill
`Node.js` and a posting saying `Node.js` must fold to the same key, or the relevance
score is silently wrong and nothing in the output looks broken.

⚠ **Practical hazard to resolve in recon, not at the keyboard:** `packages/**` is
forbidden to you for *writing*, and the Deno tree imports `packages/` only through
`contracts/shared-types.ts` — which is `export type` **only**, deliberately, so that no
runtime dependency is created. `normaliseKey` is a **runtime value**, not a type.
Establish early how you will reach it — most likely a relative import confined to a
single `tailor/`-owned module, mirroring the `contracts/` quarantine technique so that
changing the specifier later is a one-line edit. **If reaching it cleanly requires
touching anything outside your partition, stop and report rather than duplicating the
fold.** A duplicated fold is the one outcome the rule above forbids.

**Voice calibration — `supabase/functions/_shared/ats/registry.ts`:** every file in
this repo explains *why*, at length, in prose, in comments. Its opening comment is a
design argument, not a description:

> *"WHY `toJobInsert` LIVES HERE AND NOT IN EACH ADAPTER — this is the load-bearing
> decision of the whole `ats/` directory. […] what the boards disagree about is
> per-adapter; what the system must agree with itself about is here."*

---

## 2. COMMENT RULE — NON-NEGOTIABLE

**Every statement, declaration and block carries a comment saying WHY it is there, not
what it does.** Structural lines (`}`, blank lines, closing tags) are the only
exception. **At least one comment line per code line.** This applies to TypeScript,
tests, SQL and everything else you write.

The reason: Teja learns from worked examples in his own code, and a bare line teaches
nothing when he reads it back. Calibrate against `ats/registry.ts` and
`tailor/validator.ts` — both run at or above that density, and both use comments to
record *decisions* and *rejected alternatives*, not restatements of the code.

Retro-commenting is a second pass nobody budgets for. **Write the comments as you write
the code.**

---

## 3. PART A — The selection algorithm

### A.1 Quoted verbatim, `05-cv-templates.md:333-358`

> ## Relevance-weighted cutting (the right way to shrink a CV)
>
> **Cut by signal, not by section.** Static priority lists ("remove oldest education
> first, then shorten the earliest role...") are wrong when a relevant "lower-priority"
> item is competing with an irrelevant "higher-priority" item. An older-role bullet
> that speaks directly to the posting is worth more than a recent-role bullet that does
> not.
>
> For every candidate line, score three things:
>
> 1. **Relevance to THIS posting** — does the line hit a named tool, keyword, or stated
>    responsibility in the job ad?
> 2. **Uniqueness** — is it the only place this claim appears, or is it duplicated
>    elsewhere in the CV?
> 3. **Narrative load** — does the cover letter depend on it? If cutting the line would
>    force you to rewrite a cover-letter paragraph, it is load-bearing.
>
> Cut the lowest-total-score line first, regardless of which section it sits in.
>
> ### Practical order of cuts (easiest → last resort)
>
> 1. **Redundancy.** If an achievement appears in both Core Competencies AND a role
>    bullet, the Core Competencies version is usually the cleaner cut (the experience
>    bullet is more concrete evidence).
> 2. **Profile-statement fluff.** A sentence that just restates what Publications or
>    Skills will show. ("Peer-reviewed publications on X..." is already a Publications
>    entry — profile can claim it once and stop.)
> 3. **Low-relevance experience bullets.** A bullet about work that does not touch
>    posting keywords, wherever it sits. This cuts across sections before touching the
>    structural list.
> 4. **Low-relevance supporting content.** An older-role bullet that does not speak to
>    the target role. A certification that does not touch the posting's stack. A
>    language entry that can be condensed to one line.
> 5. **Low-relevance publications.** Keep 1-2 publications that best match the posting.
>    Cut the rest before touching experience bullets.
> 6. **Last-resort structural cuts.** Oldest education entry, tightening an older role
>    to 2 bullets, collapsing Certifications into a single line. These only happen if
>    the relevance-weighted cuts above have already been exhausted.
>
> ### Pitfalls to avoid
>
> - Do not mechanically cut from the bottom of a static section list without checking
>   relevance. "Cut the oldest role first" is wrong if that role is literally about the
>   skill the posting asks for.
> - Do not cut the one concrete example the cover letter leans on. **Relevance is
>   measured against the cover letter you wrote, not just the job posting — interviewers
>   will have read both.**

(The third pitfall — *"Do not cut to fit if the fit is borderline (2.02 pages). Prefer
`\enlargethispage{2-3\baselineskip}`"* — is a LaTeX mechanic. **Discard it.** Near-miss
handling belongs to the HTML/`page.pdf()` layer, which is not your partition.)

### A.2 Expressed as a scoring function over JSON nodes

The port is mechanical because "candidate line" in a LaTeX document is exactly
"identified node" in our JSON master. Shape it roughly like this — the names are yours
to improve, the *structure* is the point:

- A **selectable node** is anything with a `NodeId` that can be cut independently: a
  `MasterBullet`, a `MasterSkill`, a `MasterProject`, a `MasterEducation`, a
  `MasterAchievement`, a `MasterCertification`, the `MasterSummary`.
- `scoreNode(node, context) -> { relevance, uniqueness, narrativeLoad, total }`,
  where `context` carries the folded posting keyword set (derived from `Untrusted`
  text), a duplicate-claim index over the master, and the narrative-load set.
- **Ordering, not deletion, is the deliverable.** Produce a total order over nodes; the
  budget layer (§5) then takes the prefix that fits. Keeping selection and budgeting
  separate makes the ordering testable without a renderer, and it is the same
  separation upstream implies by scoring first and cutting second.

Three factors, each needing a decision you should write down in the file header:

**(1) RELEVANCE to this posting.** Does the node hit a named tool, keyword or stated
responsibility in the ad? Inputs: `MasterBullet.tags` (purpose-built for this),
`MasterSkill.name` + `category`, node text. Fold **both sides** with `normaliseKey`
before comparing. Prefer set-overlap over substring matching — substring matching makes
`Java` match `JavaScript`, which is a fabrication-adjacent bug that will look like a
scoring quirk.

**(2) UNIQUENESS.** Is this the only place the claim appears, or is it duplicated? Build
a duplicate index over the master using the **same folds** (`match-keys.ts` is the
worked example — it composes `normaliseKey` outputs into primary/tiebreak keys). A claim
appearing in both a skill and a bullet scores lower on uniqueness for the *skill* copy,
per practical-cut rule 1: *"the Core Competencies version is usually the cleaner cut
(the experience bullet is more concrete evidence)."*

**(3) NARRATIVE LOAD.** Does the cover letter depend on it? If cutting it forces a
cover-letter rewrite, it is load-bearing. In our system the cover letter, like the
summary, can carry `refs` into the master — **so narrative load is computable, not a
judgement call: a node is load-bearing iff a cover-letter ref names it (or names its
parent).** That is a genuine improvement over upstream, where it was eyeballed. (See §8
item 3 if that refs contract does not yet exist.)

Then: **cut the lowest total first, REGARDLESS of section.** Section membership must not
appear anywhere in the comparator. §9 requires a test proving exactly that.

### A.3 The ordering dependency you must resolve and document

Narrative load **cannot be computed before the cover letter exists**. But the cover
letter is written against the tailored resume. That is a cycle, and upstream never names
it because a human doing this by hand resolves it implicitly.

**You must decide and document which resolution this codebase takes.** Put the decision
*and the rejected alternative* in the module header, in the house style. The options:

1. **Two passes.** Pass 1 scores with `narrativeLoad = 0` for every node and produces a
   provisional selection. The cover letter is drafted against that. Pass 2 re-scores
   with real narrative load and re-orders. Honest about the cycle; costs a second
   scoring run (cheap — it is pure) and requires the pipeline to call you twice.
2. **Seed from a draft.** Narrative load is seeded from a cover-letter *draft*'s refs,
   or from a provisional "the letter will lean on the top-N most relevant nodes"
   heuristic, and never revised. One pass, but the seed can be wrong in exactly the case
   the rule exists to protect against.

**Recommendation, with the reasoning exposed so you can disagree with the reasoning
rather than just the conclusion:** take (1), two passes, and make the function *pure and
re-runnable* so the second pass costs nothing but a call. The scorer takes
`narrativeLoad` as an **input** (a `ReadonlySet<NodeId>`), never computes it, and never
reaches for a cover letter itself. That keeps the cycle out of this module entirely —
the caller owns the sequencing — and it means the function is testable with a
hand-written set. The technique has a name worth knowing: **dependency seam** — push the
unresolved dependency out to a parameter instead of embedding a guess about it.

Whatever you choose, the pitfall quote is the acceptance criterion: *"Relevance is
measured against the cover letter you wrote, not just the job posting — interviewers
will have read both."* A design where the letter's load-bearing example can be cut is
wrong regardless of how clean the code is.

### A.4 The practical cut order is the tie-break, not the algorithm

Quoted at §A.1 above (`05:345-352`). Encode it as the **tie-break heuristic** when two
nodes have equal totals — a stable, documented ordering over node *kinds*
(redundant-duplicate → summary fluff → low-relevance bullets → low-relevance supporting
content → structural). It must never override the total score; that would reintroduce
the static priority list the whole rule rejects. A comment saying so, right at the
comparator, is worth more than the code around it.

---

## 4. PART B — The four anti-fabrication rules, as Auditor checks

Where these live: `validator.ts` already runs **before** the Auditor (its header cites
PROJECT_PLAN §20 step 6, *"validator *before* Auditor"*) and returns a discriminated
union — `TailorValidation` is `{ ok: true, resume: ResolvedResume }` or
`{ ok: false, violations: readonly TailorViolation[] }`, *"a union rather than a throw,
because the caller must persist the violations for the dashboard rather than lose them
in a stack trace."* `TailorViolation` is a closed union of `{ kind, ... }` members:
`unresolved_ref`, `misattributed_bullet`, `duplicate_ref`, `empty_selection`,
`master_version_mismatch`, `summary_without_refs`, `invented_metric`,
`unverifiable_token`, `ambiguous_master_ids`.

**Extend that union with new `kind`s. Do not invent a parallel error channel.** Follow
the existing convention: each member carries enough payload to name the offending node
(`ref`, plus `where` for location), because the dashboard renders these.

Note `RHETORICAL_VOCABULARY` in `validator.ts:85` — a **deny-by-default allowlist** of
connectives and framing verbs a rewording may introduce, with the reasoning spelled out:
*"a blocklist of every technology in the world is unbounded and will always miss the
next one. An allowlist of connectives and framing verbs is small, closed and reviewable
— the bounded side of the problem. Everything factual must come from the master."* It is
also flagged as *"deliberately a TUNING SURFACE: adding a word here loosens the honesty
gate by exactly that word, which is a decision a human should make on purpose."* Your
rule 4 guard should follow the same shape and say so.

### B.1 PAST DRAFTS ARE PHRASING REFERENCES, NEVER FACT SOURCES

**This is the most important rule in the parcel.**

Quoted verbatim, `05-cv-templates.md:146`:

> Statements labeled *[Used for: <company>_<role>]* were extracted from archived
> application drafts by `/setup` Path A. They are **phrasing references, never fact
> sources**: when drafting from one, every factual claim still comes from
> `01-candidate-profile.md` — **a past tailored draft does not vouch for its own
> accuracy.**

**Express this as a provenance-DAG rule:** a Tailored node may inherit **WORDING** from
a prior tailoring, but must inherit **FACTS** only from Master.

Why it matters more than it looks: this system will accumulate prior tailorings, and
reusing them as phrasing references is genuinely valuable — it is how a voice stays
consistent across applications. But a prior tailoring is *model output that passed a
check*, not truth. Without this rule, one fabrication that slipped past the Auditor once
becomes a **source** the next tailoring cites, and the anti-fabrication guarantee
degrades silently over time, each generation looking locally justified. That is
compounding provenance drift, and it is precisely what structural guarantees exist to
prevent.

Check to implement: every `ref` in a `TailoredProfile` must resolve into the **pinned
`MasterProfile`** — never into a prior `TailoredProfile`. If a prior draft is supplied
as a phrasing reference, it must enter through a channel that is structurally incapable
of being a ref target (wording only, with ids stripped at the boundary), and any ref
that resolves only in the prior draft is a violation. Name the violation kind for what
it is — something like `fact_from_prior_draft` — so the dashboard message *is* the
lesson.

Existing leverage: `master_version_mismatch` already encodes "answered against a master
version other than the one pinned to this application." Your rule is its sibling — same
instinct, different axis. `agent/port.ts:210-211` notes that *"the Auditor reads THE
SAME PINNED VERSION, not the latest"*; stay consistent with that.

### B.2 A CLOSED YEAR RANGE READS AS A COMPLETED CREDENTIAL

Quoted verbatim, `05-cv-templates.md:160-176` (LaTeX snippet omitted):

> #### In-progress qualifications must say so explicitly
>
> **A bare year range is not enough.** An entry reading `2025–2026`, seen partway
> through 2026, looks like a *finished* degree, because a reader skimming a CV treats a
> closed range as closed. **A profile statement that says "currently completing…" does
> not fix it: the education entry is where a reader checks the credential, so it has to
> stand on its own.**
>
> State completion inside the entry itself: […]
>
> Any consistent form works: `In progress, expected <Month Year>.` / `Expected
> completion <Month Year>.` / a date field of `2025–present`.
>
> Claiming a credential not yet held is a factual misstatement, and it is the kind
> **discovered at transcript or reference check rather than at interview**. It costs
> nothing to prevent. The same applies to in-progress certifications and courses.
>
> **Check for agreement:** for a current student, the profile statement, the education
> entry, and any availability or work-permit note **must all give the same completion
> date. Contradiction between them is worse than any single version.**

Two checks, and the second is the one people forget:

1. **Standalone check.** An education (or certification) node whose range reads closed
   while the credential is not yet held is a violation. Your inputs: `end_display`
   (printed verbatim) and `end_date` (ISO, sorting only, null for current). A closed
   `end_display` with an `end_date` in the future — or a bare closed year range with no
   in-progress marker while the credential is in progress — is the violation. The fix
   the renderer must be able to express is a marker *inside the entry*, never in the
   summary.
2. **Agreement check.** Summary text, the education entry and any availability note must
   give the **same** completion date. Contradiction is worse than any single version, so
   this is its own violation kind, not a variant of the first.

⚠ **Likely `packages/shared-types/**` report — do not write it.** `MasterEducation`
today is `{ id, institution, degree, field, start_display, end_display, start_date,
end_date, grade_display, bullets }`. There is **no explicit in-progress flag**. You can
implement check 1 by inference from `end_date` versus now, but inference is weaker than
a declared fact, and `DisplayDate` is explicitly *"printed verbatim"* with the template
forbidden from computing dates. **Establish in recon whether an in-progress marker
already exists somewhere; if not, report the gap with this reasoning and implement the
inference-based check meanwhile, saying so in a comment.**

### B.3 TENURE VS VISIBLE OUTPUT

Quoted verbatim, `05-cv-templates.md:183-197` (condensed only where marked):

> #### Check tenure against visible output
>
> Before finalizing, look at each role the way a stranger will: **date span versus how
> much work is shown.** A two-year role represented by a single project reads as low
> output, whether or not that is fair. The reader cannot know what filled the time, so
> they guess, and the guess is unflattering.
>
> This bites hardest on **career changers** […], on **long-cycle work** […], and on
> anyone whose employer kept them on a single account or product.
>
> Three honest fixes, in order of preference:
>
> 1. **Surface more real work.** Ask what else the period contained. There are often
>    real secondary projects, internal tooling, or support work that never reached the
>    CV because it felt minor. Best fix when the material exists.
> 2. **Make the phases within the role explicit.** If the span genuinely had stages, say
>    so — an initial period learning the domain or supporting the team, then ownership
>    of the named work through to delivery. A phased arc reads as a growth curve; an
>    undifferentiated multi-year block reads as stagnation.
> 3. **Name what made the cycle long.** Data collection from a live environment,
>    validation with domain experts, deployment and iteration against real output.
>    Reviewers who know the domain accept this immediately.
>
> **Never** pad with invented projects, and **never** quietly shorten the employment
> dates so the ratio looks better. **Both are discoverable, and both are worse than the
> perception problem being solved.**

As an auditor check: compute span (from `start_date`/`end_date` — the ISO fields exist
for exactly this kind of analytics) against **selected** bullet count for each
experience node, and **flag** a low ratio. Fix 1 is the only one an automated selector
can act on: *surface more real work* means "pull in more real master bullets for that
role", which is a legitimate re-weighting inside the selection function. Fixes 2 and 3
are human editorial work — the flag should surface them as guidance, not attempt them.

**The prohibition is the hard part and it must be structural.** Padding with invented
projects is already impossible (refs must resolve to master). **Quietly shortening
employment dates must be made equally impossible:** any rendered date must be the
master's `*_display` value verbatim — the Tailor never computes, adjusts or reformats a
date. Assert it as a check, not a convention. `DisplayDate` being *"printed verbatim"*
and the ISO fields being *"NEVER rendered"* is the contract that makes this checkable.

### B.4 KEYWORD INSERTION GUARD

Quoted verbatim from `05-cv-templates.md:287` (the `verify_pdf.py`/LaTeX remainder of
that bullet is discarded):

> **Keyword coverage.** Match the posting's required/preferred terms against the
> extracted text, in the posting's language. **Prefer the posting's exact term over a
> synonym when it is truthfully applicable — ATS matching is often literal. Never add a
> keyword the profile does not support.**

Supporting, from `05:~139`: *"Use the posting's own core term in the matching bullet's
bold label when it truthfully applies — ATS and skim-reading hiring managers match
literally, and 'MLOps' in a heading outperforms a paraphrase like 'ML Deployment'."*

**The tension you must resolve, stated plainly:** Part A's relevance scoring *rewards*
nodes that hit posting keywords. That creates pressure to emit the posting's exact term.
The guard says never emit a keyword the profile does not support. These pull in opposite
directions, and a rule written as prose in a prompt will eventually lose that fight.

**Make the guard structural:** a keyword may only be emitted if it **resolves to a
master node**. Concretely — a posting term may replace a master term in rendered text
only when it folds (via `normaliseKey`) to a term a referenced master node actually
contains, or when an explicit, human-maintained synonym mapping in the master sanctions
it. Anything else is a violation.

This is the same instinct as the existing `unverifiable_token` check (*"a word in a
rewording that traces back to nothing in the master profile"*) — **check whether you can
extend `unverifiable_token`** rather than add a near-duplicate kind. Two violation kinds
meaning nearly the same thing will drift apart, and drift between two checks that both
claim to guard honesty is worse than one slightly broader check.

A synonym mapping, if you add one, is a **tuning surface** exactly like
`RHETORICAL_VOCABULARY`: adding an entry loosens the honesty gate by exactly that entry,
and that should be a decision a human makes on purpose. Say so in a comment.

---

## 5. PART C — Budgets and structure worth encoding

### C.1 The page budget table, `05-cv-templates.md:315-331`

> ## Page Budget - Hard 2-Page Limit
>
> The CV **must** fit on exactly 2 pages when compiled. Use these content limits as a
> guide:
>
> | Section | Max budget |
> |---------|-----------|
> | Profile statement | 3-4 lines |
> | Skills | 5 items, each 1-2 lines |
> | Most recent role | 4-5 bullets |
> | Previous role | 2-3 bullets |
> | Older roles | 2 bullets (1 line each) |
> | Education | 2-3 entries |
> | Publications | 2-3 entries |
> | Awards | 3 entries, single line each |
> | References | "Available upon request." (single line) |
>
> **If in doubt, cut rather than squeeze.** Reducing `\vspace` or geometry scale to
> force-fit content makes the CV look cramped.

Encode the table as **declared, named budget constants** in your module, not as numbers
scattered through the selector. "If in doubt, cut rather than squeeze" ports directly:
the selection layer reduces *content*; it must never attempt to shrink presentation.
(Our squeeze equivalent would be tightening CSS in the HTML template — which is not your
partition anyway, so the architecture already enforces the right rule.)

Two adaptations to state explicitly in comments:

- **Publications / Awards / References** map onto our `achievements` / `certifications`
  arrays and whatever the template supports. Do not invent sections; map onto what
  `TailoredSectionKind` already allows.
- The budgets are **calibrated for moderncv/LaTeX line heights**. Ours render as HTML
  through `page.pdf()`. Treat them as a **starting point to be retuned**, and say so —
  the harvest plan makes the identical call for P5's thresholds (*"theirs are calibrated
  for moderncv/LaTeX, ours run against HTML → `page.pdf()`"*), so this is house
  precedent, not your invention.

### C.2 Role-type-dependent section ordering, `05-cv-templates.md:360-379`

> ## Recommended Section Order
>
> The section order varies by role type:
>
> **For technical / data science / ML roles:**
> 1. Profile statement / elevator pitch
> 2. Core competencies / Skills
> 3. Professional Experience (reverse chronological)
> 4. Education (reverse chronological)
> 5. Languages
> 6. Publications & Awards
> 7. References
>
> **For domain-specific / specialist roles:**
> 1. Profile statement / elevator pitch
> 2. Core competencies / Skills
> 3. **Education (reverse chronological) - credentials are a key qualifier**
> 4. Professional Experience (reverse chronological)
> 5. Publications & Awards
> 6. References

The inversion is the entire content: **technical / DS / ML roles put Experience before
Education; domain-specialist roles invert it because credentials are the qualifier.**
Encode it as a small, named, commented mapping from role type to `section_order`, and
note in a comment that `TailoredProfile.section_order` already exists, so this needs
**no** type change.

Do not over-build a role classifier. Two documented orderings plus a conservative
default (technical, since that is this candidate's run) beats a taxonomy nobody
validated.

---

## 6. PART D — The cover-letter rules

These are the Auditor's side of the cover letter. Quoted from
`06-cover-letter-templates.md`.

### D.1 Salutation ladder (`06:126-133`)

> ## Tailoring Guidelines
>
> ### Salutation
> - If you know the hiring manager's name: "Dear [First Last],"
> - If you know the team: "Dear [Company] hiring team,"
> - Generic: "Dear [Company]," (avoid "To whom it may concern")

A three-rung ladder, and therefore checkable: take the highest rung for which you hold a
**verified** fact, and **never** emit "To whom it may concern". Note the
anti-fabrication overlap — a hiring manager's name is a fact like any other and may not
be invented to reach a higher rung.

### D.2 Length budget (`06:134-139`)

> ### Length - Hard 1-Page Limit
> - Target: 1 page including signature block
> - Maximum: **never exceed 1 page**
> - **Word budget: 250-300 words** of body text (not counting LaTeX markup). This is the
>   safe maximum. **350 words will overflow.**
> - **Always count**: opening paragraph + bullet list paragraph + closing paragraph = 3
>   blocks. Add a 4th only if the others are short.
> - **When adding company-specific content, trim other content to compensate rather than
>   adding net length**

"250-300 words, 350 will overflow" is a **measured number from a real search** (69
applications, 20 first interviews, a signed contract), not a style preference — encode
it as a constant with that provenance in the comment. "not counting LaTeX markup"
becomes "not counting HTML markup"; that is the whole translation.

The compensation rule — *trim other content to compensate rather than adding net length*
— is the cover-letter twin of Part A: a **zero-sum budget**, where adding requires
cutting, and what gets cut is chosen by the same relevance-weighted scoring. Worth
stating in a comment, because it is the sentence that makes the two halves of this
parcel one idea rather than two.

Also from `06:143-146`: **3-5 bullets is ideal**, each starting with a bold label or an
action verb.

### D.3 The pre-submit checklist (`06:163-175`) — a ready-made Auditor checklist

> ## Checklist Before Finalizing
> - [ ] No em-dashes (use commas or periods instead)
> - [ ] No cliches or empty filler
> - [ ] Every claim backed by specific example
> - [ ] Forward-looking framing: focuses on tasks you'll solve, not just past duties
> - [ ] Motivation section references this specific company's mission/values
> - [ ] Company name and role are correct throughout
> - [ ] Date is current
> - [ ] Fits on one page
> - [ ] Language matches the job posting language
> - [ ] Salutation is appropriate (named person if possible)
> - [ ] Headline is engaging and specific, not generic

Port it **as a checklist data structure** — each item an auditor check with a name and a
verdict — not as prose inside a prompt. Several are mechanically checkable today
(em-dashes, word count, company/role correctness against the pinned job row, date).
Others are judgement calls belonging to the Auditor's LLM pass. **Mark which is which in
the type**, so nobody later assumes a judgement item is enforced by code.

### D.4 Transferable anti-generic-prose rules, from `03-writing-style.md`

Take these; they are stack-independent:

- *"**NO em-dashes.** Use commas, periods, or restructure the sentence instead."*
- *"**NO cliches or filler phrases.** Cut: 'I am passionate about', 'I believe I would be
  a great fit', 'leverage my skills', 'hit the ground running', 'drive results',
  'synergies'."* — a **closed, reviewable list**, exactly the bounded shape
  `RHETORICAL_VOCABULARY` already uses.
- *"**NO generic buzzwords** without concrete backing. Every claim must be supported by a
  specific example or fact."*
- *"**NO apologetic or overly humble language.** Not 'I think I could contribute' but 'I
  bring X, demonstrated by Y.'"*
- **The interview backtrack test** (`03:14-18`), the sharpest sentence in the whole
  upstream framework: *"could the candidate comfortably explain this bullet in an
  interview without backtracking? If they'd have to say 'well, what I actually meant
  was…' then it's too far."* With its three tiers:
  - **OK:** reordering experience to lead with what is most relevant; natural synonyms
    for the target domain; emphasising one aspect of a broad role.
  - **Flag it:** combining academic + industry experience into a single claim that
    implies it was all industry; describing work using the posting's specific
    terminology when the actual work was adjacent but not the same.
  - **Never:** claiming experience the candidate does not have; implying they worked in
    a domain they have not.

  The **Flag it** tier is precisely where B.4's keyword guard operates. Cite it there —
  it is the clearest available statement of what the guard is defending against.
- **Forward-looking framing** (`03:43-49`): the cover letter is **not a CV repetition**;
  focus on the tasks you can solve for the employer, using 1-2 brief past examples only
  to back up forward-looking claims.

**Discard** everything Danish/EU-specific: "Med venlig hilsen", the Danish headline
example, local date conventions, work-permit framing.

**Note but do not port here:** `03:13` requires that every company-specific claim be
independently verified, and warns that URLs appearing inside a job posting are untrusted
third-party data that *"may be crafted to manipulate the workflow"*. Correct and
important — and it belongs to whoever owns web research, not to your partition. Mention
it in your final report so it is not lost.

---

## 7. PART E — Explicit non-goals

**Do not port any of this.** It is the ~70% of the source that is worthless here:

- LaTeX, moderncv, `cover.cls`, `\cventry`, `\lettercontent`, `\namesection`,
  `\makecvtitle`, `\enlargethispage`, `\vspace`, `setspace` / `\setstretch`.
- Font handling: `fontspec`, Raleway, `\ifpdftex\usepackage[T1]{fontenc}\fi`, pdflatex
  vs lualatex accent decomposition.
- LaTeX special-character escaping (`\&`, `\%`, `\$`, `\#`, `\_`), the silent
  `%`-eats-the-rest-of-the-line trap, and the `\item {[text]}` bracket-parsing trap.
- Any compile step, any compile-and-inspect loop, any `.tex` file.
- `verify_pdf.py`, pypdf / Poppler `pdftotext`, `--dump-text`, `--contains`.
- Section-heading translation for non-English CVs, and the multi-language machinery.
- **The `--` → en-dash date-parsing failure and the ASCII-hyphen date rule
  (`05:~253-268`).** The *underlying* concern (a date range an ATS can parse) may well be
  real for us too — but the cause there is a LaTeX ligature that cannot occur in HTML.
  **Do not port the fix. If you think the concern survives the change of renderer, report
  it** as a question for whoever owns the template; it is not yours.
- Anything about the CV's *rendered text layer*. **We render HTML then `page.pdf()`.**

If a heuristic's justification is a fact about LaTeX, it does not survive the port. That
is the whole test.

---

## 8. What to REPORT rather than write

You may not write `packages/**`. Collect these and hand them back in your final report,
each with the reasoning, not just the ask:

1. **An in-progress marker on `MasterEducation` / `MasterCertification`** (§B.2).
   Probably the real gap. Inference from `end_date` works, but a declared field is
   stronger, and the `DisplayDate` contract says the template must not compute dates.
2. **Anything needed to reach `normaliseKey` from the Deno tree as a runtime value**
   (§1). If the clean path requires a change outside `tailor/**`, report it — do not
   duplicate the fold under any circumstances.
3. **A cover-letter refs contract**, if one does not already exist. §A.2's narrative load
   is computable *only* if the cover letter carries `refs` into the master the way
   `TailoredSummary` does. If it does not, that is the single most valuable type change
   in this parcel and should be reported loudly rather than worked around.
4. Any `TailorViolation` kind you add that another module needs to render or persist.
5. The untrusted-URL rule from `03:13` (§D.4), for whoever owns web research.

---

## 9. Definition of done + loop-engineering exit checklist

Work the loop until every line below is true, and **paste real terminal output** for the
commands — not a summary of it, not a claim that it passed.

- [ ] **Typecheck passes.** `pnpm typecheck` (root, recursive, `--if-present`). Note that
      `supabase/functions/` is a **Deno** tree with its own `deno.json` and is
      deliberately *not* a pnpm workspace member. Establish how it is type-checked before
      you claim a green typecheck — a passing `pnpm typecheck` that never reached your
      files is worse than a failing one. `deno.json` restates the strict settings,
      including `noUncheckedIndexedAccess`, which is *"load-bearing for PROJECT_PLAN.md
      §10: an index into the master profile that may not exist is typed as
      possibly-undefined, which is the check the validator relies on."*
- [ ] **Tests exist and pass.** `pnpm test:functions` runs
      `node --test "supabase/functions/**/*.test.ts"`. Naming is coupled to the runner:
      `deno.json` excludes `**/*.test.ts` from `deno check` because tests import
      `node:test`. **Name your test file `*.test.ts`**, matching `prompt.test.ts` /
      `validator.test.ts`. (There is history here: the files were renamed from
      `*_test.ts` on 2026-09-10 because the Deno convention advertised a runner that the
      exclude rule ruled out, and `deno test` reported "No test modules found".)
- [ ] **A test that proves section order does NOT dominate relevance.** This is the
      load-bearing test of the whole parcel: construct a master where an **older-role
      bullet** matches the posting and a **most-recent-role bullet** does not, and assert
      the older bullet outranks the newer one. If that test does not exist, Part A is not
      done — it is the exact case upstream says static priority lists get wrong, and the
      exact case a plausible-looking implementation gets wrong too.
- [ ] **A test per auditor rule** — four rules, each with a violating case *and* a clean
      case. The clean case matters as much as the violation: a check that fires on
      everything is not a check.
- [ ] **Tie-break test**: equal totals fall back to the practical cut order, and the
      tie-break never overrides a total-score difference.
- [ ] **Untrusted-input test**: JD text containing instruction-shaped content ("ignore
      previous instructions", fence-delimiter lookalikes) affects scores only as tokens
      and never reaches an instruction region. `prompt.test.ts` has the worked pattern —
      read it before writing yours.
- [ ] **Comment density** meets §2 at ≥1 comment line per code line, in tests too,
      calibrated against `ats/registry.ts`.
- [ ] **`git status --short` shows only files under
      `supabase/functions/_shared/tailor/`.** Paste the real output.
- [ ] **Never `git add -A`, `git add .`, or `git commit -a`.** This repo runs five
      concurrent sessions over **one** working tree, **one** index and **one** `.git`.
      Stage by explicit path, confirm with `git diff --cached --name-status`, and commit
      with the pathspec repeated: `git commit -F - -- <the same explicit paths>`.
      **Never omit the `-- <paths>`** — it makes the commit take only the named files and
      disregard the rest of the index, so a peer's `git add` landing while you compose a
      message cannot be swept into your commit. Staging by explicit path alone does
      **not** protect against this. Never `git stash` (it yanks peers' in-flight work),
      never `--force`, never `--no-verify`, never `git checkout -- <file>` outside your
      partition.
- [ ] **Report everything in §8.**

### Commit attribution

End commit messages with:

```
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

---

## 10. Tooling worth using on this parcel

- **`superpowers:test-driven-development`** — the §9 "section order does not dominate
  relevance" test is a perfect red-first test. Write it before the comparator and it will
  shape the design correctly; write it after and you will write a test that agrees with
  whatever you happened to build.
- **`superpowers:dispatching-parallel-agents`** for the §1 recon fan-out. The five recon
  targets are independent reads with no shared state — textbook fan-out.
- **`superpowers:verification-before-completion`** before reporting done. §9 demands
  pasted real output; this skill exists precisely to stop "tests pass" from being
  asserted rather than demonstrated.
- **`/code-review`** on your own diff before handing back — the comment rule and the
  partition boundary are both mechanically reviewable.
- **`superpowers:systematic-debugging`** if a fold-mismatch bug appears. It will present
  as "the score is just wrong", and the cause will be an item failing to match itself.

**Capability gap worth flagging back to Teja:** there is no repo-level guard that a
session wrote only inside its partition. A pre-commit hook comparing staged paths
against a declared partition would make write-ownership partitioning *enforced* rather
than *disciplined*. That is an `/update-config` hooks job, it is not yours to do
mid-parcel, and it is worth reporting.

---

## 11. Source provenance

| Item | Value |
|---|---|
| Upstream | `MadsLorentzen/ai-job-search` |
| Pinned commit | `968fb1bd` |
| Licence | MIT, © 2026 Mads Lorentzen |
| Local path | `reference/ai-job-search-upstream/` (**gitignored** — read from, never vendored) |
| Files read | `.claude/skills/job-application-assistant/05-cv-templates.md`, `06-cover-letter-templates.md`, `03-writing-style.md` |
| Line ranges | `05:130-197`, `05:272-313`, `05:315-331`, `05:333-379`; `06:126-150`, `06:163-180`; `03` (transferable rules only) |

**Attribution rule for this repo** (from `docs/harvest/README.md`): anything ported
carries a header naming the upstream file and commit. MIT requires the copyright and
permission notices be retained; a header also tells the next reader where to look when
upstream fixes a bug we inherited. **Put that header at the top of every file you create
in `tailor/`,** naming the specific upstream file and line range that file derives from.
