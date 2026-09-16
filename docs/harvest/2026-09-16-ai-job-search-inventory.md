# Upstream inventory — `MadsLorentzen/ai-job-search`

**Recon date:** 2026-09-16 · **Upstream pinned at:** `968fb1bd` (2026-09-16)
**Local checkout:** `reference/ai-job-search-upstream/` — **gitignored, never vendored**
**Licence:** MIT, © 2026 Mads Lorentzen. Porting is permitted **with attribution retained**.

This file is the *record of what is there*. The *decision about what to do* lives in
[`2026-09-16-ai-job-search-harvest-plan.md`](2026-09-16-ai-job-search-harvest-plan.md).
One fact, one home — an inventory that also argues for a plan drifts from the plan.

---

## The headline finding: the two repos are architecturally opposite

This matters more than any individual file, because it is the reason "copy the
features and code across" cannot be executed literally.

| | `ai-job-search` (upstream) | `applyyy` (ours) |
|---|---|---|
| Shape | Claude Code **prompt framework**; a human types `/apply` | **Autonomous** multi-agent pipeline, unattended on a cron |
| Implementation | Markdown specs **are** the implementation — no code behind them | TypeScript, Postgres, Edge Functions |
| Language | Python + Bun/TS + LaTeX | Node + TypeScript everywhere (locked) |
| Resume | LaTeX `.tex` → `lualatex` → PDF | Structured **JSON** → HTML → `page.pdf()` (locked) |
| Market | Denmark (Jobindex, Jobnet, Jobbank, Jobdanmark) | ATS APIs + international/remote |
| Storage | Files on disk + a CSV tracker | Supabase Postgres, 15 tables, RLS on all |
| Volume | One application at a time, human-paced | ~35/day batched |

Upstream states the markdown-is-the-implementation position explicitly
(`CONTRIBUTING.md:20`): *"The markdown specs ARE the implementation; a second copy
(another agent CLI, an orchestration layer, a wrapper command) drifts from the first
the moment either changes."*

**Consequence:** most of what looks like "code to copy" is either (a) prose that must
become a Gemini agent prompt, or (b) a Python/LaTeX implementation of an idea we must
re-implement in TypeScript. The genuinely copy-pasteable surface is small. The
genuinely *valuable* surface is much larger, and it is mostly **specifications**.

---

## What upstream does NOT have, that we already do

Recorded because it is the cheapest way to stop a future session from "harvesting"
something that would be a downgrade.

| Capability | Status upstream | Status here |
|---|---|---|
| Prompt-injection defence (constraint #9) | **None.** A case-insensitive grep of the entire repo for `injection`, `prompt injection`, `ignore previous instructions` returns **zero matches** | `Untrusted` branded type on every adapter-parsed field — `supabase/functions/_shared/ats/types.ts:40-52` |
| A database | None — JSON files + CSV, with a dedicated tool (`rank_state.py`) whose entire purpose is keeping the state file out of the LLM's context | Postgres, 15 tables, RLS, a DB-enforced status transition guard |
| Dedupe enforcement | A file-level linter that *reports* duplicate keys | `UNIQUE(user_id, fingerprint)` — the DB refuses |
| Discovery/submission separation | Conflated | `discovery_source` and `ats_provider` are separate enums, on purpose |
| Anti-fabrication *mechanism* | Prose rules only | Node-reference tailoring: the Tailor returns references into the master, so it is structurally incapable of inventing |

> **`tools/security_guards.py` is misleadingly named.** Despite the name it contains
> no prompt-injection defence of any kind. It is a supply-chain CI linter for
> upstream's *own* repo: permission-allowlist drift, a deliberately-empty hooks
> allowlist, and a ban on npm lifecycle scripts. Recorded here because the filename
> invites exactly the wrong conclusion, and a future session grepping for "security"
> will land on it.

---

## Portal adapters — `.agents/skills/*/cli/`

Six adapters, two families.

| Adapter | CLI framework | Runtime deps | Geography | Port cost |
|---|---|---|---|---|
| **linkedin-search** | hand-rolled `parseFlags` | **none** | **global** | ~2 lines (shebang) |
| **freehire-search** | hand-rolled `parseFlags` | **none** | **global** | ~2 lines (shebang) |
| jobbank-search | `@bunli/core` + zod | `node-html-parser`, zod | DK only | framework swap |
| jobdanmark-search | `@bunli/core` + zod | same | DK only | framework swap |
| jobindex-search | `@bunli/core` + zod | same | DK only | framework swap |
| jobnet-search | `@bunli/core` + zod | zod | DK only | framework swap |

**The four Danish adapters are market-locked**, not merely market-flavoured: Danish
hosts, Danish query params (`amt`, `udd`, `erf`, `branche`, `fjernarbejde`), Danish
month names, Danish labels (`Ansøgningsfrist`, `Udgivet`, `Løbende`), Danish entity
decoding, CVR numbers, `countryCode: "DK"` defaults. Their *structure* transfers;
their *content* does not.

### Bun coupling — the actual porting cost

Production `src/` is almost entirely portable. All I/O is WHATWG (`fetch`, `Response`,
`AbortSignal.timeout`, `URLSearchParams`) plus `process.*` — **all native on Node 24
and on Deno**. Verified absent across every `src/`: `Bun.serve`, `Bun.file`,
`Bun.spawn`, `Bun.$`, `bun:sqlite`, `import.meta.main`, `import.meta.dir`.

The coupling is in two places only:

1. **Shebangs** — `#!/usr/bin/env bun`, 2 files, cosmetic.
2. **`@bunli/core`** — 16 import sites across the four Danish adapters.

**Tests are a different story:** `import … from "bun:test"` on line 1 of **all 44 test
files**, plus `Bun.spawn` and `import.meta.dir` in all six `tests/helpers.ts`. The
assertion API maps 1:1 to vitest; the six helpers need rewriting (~25 lines each).

### The transport layer — the cleanest single port in the repo

The same retry wrapper is copy-pasted **8 times** across the six adapters. Canonical
form at `jobdanmark-search/cli/src/helpers.ts:4-33`. Contract:

- **7 attempts total** (1 + 6 retries)
- Retry **only** on `429` and `>= 500`. A plain 4xx throws immediately.
- Delay `500ms`, doubling, capped at `5000ms` (Danish four) / `8000ms` (linkedin, freehire)
- Jitter `+ Math.floor(Math.random() * 500)` — **added**, not multiplied
- `AbortSignal.timeout(15000)` — **per attempt**, not per retry budget
- Self-identifying User-Agent, exported as a constant so tests can assert on it
- 404 behaviour is **deliberately per-adapter** (empty string / `null` / throw / raw `Response`)

**What it lacks, and we must add:** no `Retry-After` header support, no concurrency
cap, no configurable timeout, and **no rate limiting at all** beyond 429 backoff —
with one exception, a hardcoded 300 ms politeness sleep at
`jobbank-search/cli/src/commands/search.ts:136`.

One genuinely good failure mode worth copying: jobbank detects Cloudflare bot-blocking
(`403` + body matching `/just a moment|cloudflare|cf-chl/i`) and surfaces an
actionable message **instead of retrying** — `jobbank-search/cli/src/helpers.ts:92-100`.

### JSON-LD extraction

Only **2 of 6** parse schema.org `JobPosting` — jobbank and jobdanmark.

`jobbank-search/cli/src/helpers.ts:174-205` is the better implementation: it iterates
*all* `ld+json` scripts, `JSON.parse` inside a try/catch so one malformed script does
not block later ones, and recurses into `@graph`. jobdanmark's version handles a
top-level object and array but **misses `@graph`**.

jobdanmark contributes the better *fallback chain*
(`jobdanmark-search/cli/src/commands/detail.ts:212-216`): JSON-LD → rendered HTML →
`og:*` meta tags. jobindex contributes the title ladder:
`og:title ?? itemprop ?? <h1> ?? throw`.

### Two defects upstream fixed that we would otherwise rediscover

1. **Unknown flags were silently discarded** by bunli. Every adapter now carries an
   explicit `KNOWN_FLAGS` rejection guard. The rationale comment
   (`linkedin-search/cli/src/cli.ts:87-90`) is worth reading: a silently dropped
   filter once *"returned an entire portal's database as if it matched the query."*
2. **`parseInt()` truncated fractional flags.** `--jobage 0.5` became `0`, which
   silently dropped the freshness filter entirely. They use `Number()` and reject
   non-integers.

Both are the same failure shape: **a filter that fails open looks like a successful
broad search.** That is directly relevant to our Scout.

### Output shape — upstream's biggest weakness

There is **no shared result type**. Each adapter declares its own; only the *field
names* are a convention. The Danish four return `Record<string, unknown>` carrying the
portal's native field names **plus** contract aliases side by side. jobnet's `detail`
does not normalise at all — it prints the raw upstream response.

The envelope is consistent (`{ meta, results }`), and the contract fields are
`id · title · company · location · date (YYYY-MM-DD) · url`, with missing values as
`null` and never omitted.

**Do not replicate this.** Our `ParsedPosting` + `toJobInsert` split is already
strictly better, and for a documented reason
(`supabase/functions/_shared/ats/registry.ts:4-17`): what the boards disagree about is
per-adapter, what the system must agree with itself about is central.

---

## Python tools — `tools/` and `salary_lookup.py`

| File | Lines | Verdict | Why |
|---|---|---|---|
| `tools/robots_check.py` | 142 | **PORT** | Constraint #5. Fail-closed RFC 9309 gate. |
| `tools/job_key.py` | 179 | **PORT** | Constraint #7. Hash-suffixed truncation. |
| `tools/verify_layout.py` | 335 | **PORT** | Six geometric CV-layout heuristics. |
| `tools/verify_pdf.py` | 212 | **ADAPT** | `packages/master-pdf` covers most; take the fold table. |
| `tools/rank_state.py` | 380 | **ADAPT** | It is a workaround for having no database. Take the rules. |
| `salary_lookup.py` | 434 | **ADAPT** | **No data source exists.** Take only the fuzzy matcher. |
| `tools/convert_salary_excel.py` | 399 | SKIP | Danish union spreadsheet ETL. |
| `tools/security_guards.py` | 297 | SKIP | Supply-chain CI linter, not product logic. See warning above. |
| `tools/lint_skills.py` | 122 | SKIP | Repo maintenance. |
| `tools/upstream_triage.py` | 227 | SKIP | Fork maintenance. |
| `tools/check_upstream_updates.py` | 196 | SKIP | Fork maintenance, hardcoded upstream slug. |
| `tools/check_framework_version.py` | 147 | SKIP | Repo maintenance. |

### `robots_check.py` — the details that matter

**Fail-closed on everything except 404.** A 404 means no published policy, which
RFC 9309 says is permission. Timeout, curl error, non-200/404, or a body that does not
look like robots.txt → `UNCONFIRMED` → exit 1 → do not proceed.

Three defences worth carrying over verbatim:

1. **Soft-200 defence** (`robots_check.py:47-64`). A host answering `/robots.txt` with
   `200` and an HTML error page parses to **zero rules**, and zero rules means
   *allowed* — so a soft-200 grants permission that was never given. It validates the
   body contains at least one recognised directive token before trusting it.
2. **Percent-decoding the pattern before matching** (`:88-91`). Without it,
   `Disallow: /foo%20bar` never matches `/foo bar` — *"a fail-open on any site that
   encodes its own rules."*
3. **Ties go to `Disallow`** (`:99-107`), deliberately stricter than RFC 9309, which
   gives ties to `Allow`. It also checks **both** the `Claude-User` group and `*`, and
   denies if *either* denies — again stricter than the RFC.

**Gaps we must fill:** no caching (every call re-fetches), and `crawl-delay` is
*recognised as a valid token* but **never parsed or enforced**.

**One judgement call to escalate, not inherit:** it retries reading robots.txt with a
Chrome User-Agent when the honest UA is refused by a WAF (`:116-128`). It only ever
reads the *policy file* this way and then obeys it strictly — but presenting a browser
UA to get past a bot filter is arguably itself the thing constraint #5 prohibits.

### `job_key.py` — the earned bug fix

Key shape is `<company-slug>_<title-slug>`. **The URL is not part of the key**; it is
only a last-resort source for a numeric job id.

The nugget is **hash-disambiguated truncation** (`:71-82`). Plain truncation at a
character limit stored one posting twice, because two long titles truncated to the
same prefix:

```
deloitte_cyber-intelligence-center-security-analy
deloitte_cyber-intelligence-center-security-analyst-at
```

The fix appends the first 6 hex chars of SHA-1 **of the full slug** after truncating,
so two different long titles can never collide on their shared prefix. Also: keys must
never contain `/` (it split archive folder paths across directories), and a bare
`company_` prefix with an empty title is never emitted.

**Gap:** essentially no URL canonicalisation — only `url.rstrip("/")`. No scheme/host
lowercasing, no tracking-param stripping (`utm_*`, `gh_src`, `ref`), no query sorting.

### `salary_lookup.py` — there is no salary data

The single most important fact about this tool: **it ships no dataset and calls no
API.** It reads a `salary_data.json` the user hand-writes, which is gitignored. If the
file is absent the workflow silently skips the salary step.

Its matching logic is hard-coded Danish — `SPELLING_VARIANTS` for `ø/æ/å`, and
`STRIP_PATTERNS` for Danish legal-entity suffixes (`A/S`, `ApS`, `I/S`, `K/S`, `IvS`,
`AMBA`). Retargeting to India means `Pvt Ltd`, `Private Limited`, `Inc`, `LLC`,
`Technologies`, `Solutions`.

The reusable part is the **tiered 0–100 fuzzy company matcher** (`:190-250`): exact
normalised 100; substring containment `80 + ratio*10` with a guard so a short query
cannot match inside a long name; anglicised exact 85 / containment 75; word-overlap
`30 + coverage*40`; single-word queries must match a whole word or score 0; cutoff 30.
That is directly reusable for company dedupe and watchlist joins regardless of salary.

> **Constraint #2 risk:** a fabricated salary benchmark is an invented metric. Anything
> we build here must cite its source or emit nothing.

---

## Prompt skills — `.claude/skills/`

| File | Verdict | What to take |
|---|---|---|
| `04-job-evaluation.md` | **HARVEST AS PROMPT** | The whole rubric — see below |
| `01-candidate-profile.md` | HARVEST (schema addition) | Profile field schema |
| `02-behavioral-profile.md` | HARVEST (schema addition) | `keyword_map` + "don't overstate" |
| `03-writing-style.md` | ADAPT | Anti-generic-prose rules |
| `05-cv-templates.md` | ADAPT (4 sections near-verbatim) | Relevance-weighted cutting |
| `06-cover-letter-templates.md` | SKIP file, HARVEST checklist | Salutation ladder, word budget, final checklist |
| `07-interview-prep.md` | BUILD IT | Feature gap |
| `08-application-forms.md` | HARVEST | Don't-guess rules → constraints #3/#4 |
| `09-web-research.md` | BUILD IT | Company research, feature gap |
| `job-scraper/SKILL.md` | ADAPT | Query construction pattern |
| `upskill/SKILL.md` | ADAPT | Skill-gap analysis, feature gap |

### The fit rubric — `04-job-evaluation.md`

Structure: **two hard gates before scoring** → **five scored dimensions** →
**weighted average** → **five verdict bands**.

**Gate 1 — Eligibility.** A hard filter, not a dimension. Explicitly separate from
work-permit *timing*: *"timing asks 'can they work the required hours yet?', eligibility
asks 'are they permitted to hold this job at all?'. A candidate can pass timing and
still be categorically excluded."* Citizenship/PR requirements and security clearances
are FAIL — *do not score, do not draft*, and quote the exact wording back.

**Gate 2 — Language.** A requirement for a language absent from the candidate's table
is FAIL. An undeclared language is *"treated as a hard no, not a gap to smooth over."*

Gate verdicts are **persisted**, not ephemeral, and a FAIL is a **shortlist veto**
independent of score.

**The five dimensions**, each with 0–100 band definitions:

| Dimension | Weight | Notes |
|---|---|---|
| Technical Skills Match | **30%** | Bands 80-100 / 60-79 / 40-59 / 0-39 |
| Experience Match | **25%** | *"Match on the function and nature of the work performed, not the literal job title"* |
| Behavioral / Culture Fit | **15%** | Carries the only explicit red-flag list |
| Career Alignment & Motivation | **30%** | Tied heaviest — weights *want* as much as *can* |
| Location & Logistics | pass/fail | Not weighted. Relocation = FAIL; frequent intl travel = FLAG |

**Verdict bands:** 75 Strong Fit · 60 Good Fit · 45 Moderate Fit · 30 Weak Fit · 0 Poor Fit.

Two sub-filters inside Career Alignment worth taking wholesale: a **motivation filter**
(*"whether the tasks will energize you"* — energising vs. draining task lists) and a
**life-situation alignment** check (security, flexibility, growth priorities).

A sixth optional dimension, Salary Benchmark, is unweighted and skipped when
unconfigured — which, per the tools section above, is always.

### Relevance-weighted cutting — the Tailor's node-selection function

`05-cv-templates.md:333-358`. The highest-value non-rubric prose in the repo, because
it maps directly onto our locked JSON-node architecture.

> **Cut by signal, not by section.** Static priority lists ("remove oldest education
> first, then shorten the earliest role…") are wrong when a relevant "lower-priority"
> item is competing with an irrelevant "higher-priority" item. An older-role bullet
> that speaks directly to the posting is worth more than a recent-role bullet that
> does not.
>
> For every candidate line, score three things:
> 1. **Relevance to THIS posting** — does the line hit a named tool, keyword, or stated responsibility in the job ad?
> 2. **Uniqueness** — is it the only place this claim appears, or is it duplicated elsewhere?
> 3. **Narrative load** — does the cover letter depend on it? If cutting the line would force a cover-letter rewrite, it is load-bearing.
>
> Cut the lowest-total-score line first, regardless of which section it sits in.

And the pitfall: *"Relevance is measured against the cover letter you wrote, not just
the job posting — interviewers will have read both."*

**This is a per-node scoring function over master-resume nodes.** Our Tailor already
selects JSON node references; this gives it a principled ordering.

### Anti-fabrication rules we do not currently encode

1. **Past drafts are phrasing references, never fact sources** (`05:146`). *"A past
   tailored draft does not vouch for its own accuracy."* In our provenance DAG: a
   Tailored node may inherit **wording** from a prior tailoring but must inherit
   **facts** only from Master.
2. **A closed year range reads as a completed credential** (`05:160-176`). `2025–2026`
   seen mid-2026 looks finished. *"A profile statement that says 'currently
   completing…' does not fix it: the education entry is where a reader checks the
   credential, so it has to stand on its own."* Discovered at transcript check, not at
   interview.
3. **Tenure vs. visible output** (`05:183-197`). A two-year role shown by one project
   reads as low output. Three honest fixes are offered, then: *"**Never** pad with
   invented projects, and **never** quietly shorten the employment dates so the ratio
   looks better."*
4. **Keyword insertion guard** (`05:287`). Prefer the posting's exact term over a
   synonym *when truthfully applicable* — ATS matching is literal. *"Never add a
   keyword the profile does not support."*

### Structural pattern worth adopting wholesale

**Gates run before scoring, and gate verdicts are persisted with a quoted
justification.** The shape is `verdict ∈ {PASS, FAIL, FLAG}` plus
`note = the verbatim posting line that triggered it`. A `FAIL` is a shortlist veto
independent of score; `FLAG` is the designated escalate-to-human state.

That is exactly our two-bucket approval design, and quoting the triggering line is
what makes the human's review cheap.

---

## Commands — `.claude/commands/`

| Command | Verdict | Note |
|---|---|---|
| `/apply` | **BUILD IT** (partially) | Drafter→reviewer separation, 3-source grounding audit |
| `/add-portal` | **BUILD IT** (as a spec) | The portal-adapter contract |
| `/interview` | **BUILD IT** | Explicit feature gap |
| `/html-report` | **BUILD IT** | Explicit feature gap |
| `/expand` | **BUILD IT** | Profile enrichment from GitHub; autonomous-friendly |
| `/outcome` | **BUILD IT** (follow-up branch) | 10-day follow-up, 60-day stale sweep are gaps |
| `/rank` | ALREADY HAVE (graft rubric on) | Scout + approval queue cover it |
| `/gmail-sync` | ALREADY HAVE (graft heuristics on) | `email-tracker-intake` exists |
| `/setup` | ALREADY HAVE (steal question order) | Settings + answer bank exist |
| `/add-template` | SKIP | LaTeX/Typst toolchain plumbing |
| `/notion-sync` | SKIP | Our React dashboard owns the glanceable lane |
| `/reset` | SKIP | Human-operated start-over utility |

### `/apply` — the pipeline design

**Exactly ONE revision round.** Step 3 spawns one reviewer, Step 4 applies its feedback
once, and *"After all edits are applied, the two files on disk are the final drafts"*
(`apply.md:223`). There is no critique loop. The only loop in the workflow is a
compile/layout loop, which is a different thing.

Four rules worth transplanting:

1. **Standing rule — write new facts back to the profile** (`apply.md:7-11`).
   *"A fact that exists only in chat **will be treated as unsupported by a later
   session and stripped from drafts as a fabrication.** Anything absent from the
   sources does not exist as far as future drafting is concerned, and the loss is
   silent."*
2. **Every requirement is addressed — matched or honestly gapped, never silently
   omitted** (`apply.md:95-98`). A missing requirement gets an honest bridge
   (*"not in my daily toolkit yet; a natural extension of X"*), *"because omission
   reads as hiding once an interviewer asks."*
3. **Reviewer output is split into Part A (mechanical edits) and Part B (narrative
   judgement).** Part A applies directly; Part B is applied with judgement.
4. **Do not trust reviewer research at face value.** Every company claim the reviewer
   surfaces is re-verified before it enters a draft. A second agent's output is
   evidence, not fact — the same rule this session applied to its own recon agents.

### `/outcome` — two status enums, deliberately never merged

Upstream keeps the *application* status and the *follow-up* state in separate fields
rather than adding follow-up values to one enum. Our status transition guard would
benefit from the same discipline.

Genuine gaps: a **10-day follow-up threshold, maximum two follow-ups**, grounded in the
submitted materials only (*"a follow-up that introduces skills or experience the
submitted materials don't contain is a fabrication vector"*), 60–120 words,
**draft-only, never sent** — *"it must not be wired to tools that do"*. Plus a
**60-day stale sweep** with explicit batch confirmation.

### `/gmail-sync` — classification heuristics

Five signal buckets with trigger phrases, an ATS sender-domain list, company-name
normalisation, a guard that the signal must appear **in the subject or first few
lines**, and a hard boundary: **never infer `hired` or `offer_declined`** from email.

One rule worth copying exactly: an application acknowledgement moves `drafted →
applied` and *nothing else*. On a `drafted` row it is the one email that proves the
user submitted by hand; on any other status it is noise.

---

## Attribution

Anything ported from this repo carries, in the file header:

```
Ported from MadsLorentzen/ai-job-search @ 968fb1bd (MIT, © 2026 Mads Lorentzen).
<what was taken, and what was changed>
```

MIT requires the copyright and permission notices be retained. A header naming the
upstream file and commit satisfies that, and also tells the next reader where to look
when upstream fixes a bug we inherited.
