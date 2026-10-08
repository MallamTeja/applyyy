> **Historical record as of 2026-09-16.** Current state: [SYSTEM_ARCHITECTURE.md](../../SYSTEM_ARCHITECTURE.md) · [PROGRESS.md](../../PROGRESS.md).

# Brief 2 — `freehire` job-board adapter (P6 in the harvest plan)

**Read this whole file before you touch anything.** You are starting with an empty
context window and you cannot ask the orchestrator questions. Everything you need —
the upstream source code, the destination interface, the local conventions, three
real scope conflicts this parcel runs into, and the exit checklist — is quoted in
full below. **You do not need to open the upstream reference clone or re-read any
destination file this brief quotes from.**

---

## 0. Situation

**Repo:** `applyyy` at `C:\Users\tejam\OneDrive\myproj\applyyy`
An autonomous job-application system: Supabase Postgres + Deno Edge Functions,
React/Vite dashboard, Playwright worker on GitHub Actions, Gemini LLM.
Locked stack: Node + TypeScript everywhere, pnpm only.

**Your parcel (P6 in
[`2026-09-16-ai-job-search-harvest-plan.md`](../2026-09-16-ai-job-search-harvest-plan.md)):**
add a fourth `AtsAdapter` — `freehire`, a public job-search aggregator that fronts
~50 real ATS platforms behind one JSON API — following the pattern already
established by the three shipped adapters (`greenhouse.ts`, `lever.ts`, `ashby.ts`).
The harvest plan calls this the **highest strategic-value** parcel in the queue:
PROJECT_PLAN.md §2 states the daily application ceiling is **supply-bound, not
budget-bound**, and freehire is the cheapest way to add boards without writing 50
adapters.

### Write partition — you may create/modify ONLY these

1. **New** `supabase/functions/_shared/ats/freehire.ts`
2. **New**, co-located test file (e.g. `freehire.test.ts`), mirroring
   `adapters.test.ts`'s conventions
3. **One added entry** in `supabase/functions/_shared/ats/registry.ts`
4. **One new**, timestamped migration adding an enum value (append-only)

**Everything else in the repo belongs to other people working concurrently and must
not be touched** — including `scout-ats/index.ts` and `worker/src/cli/scout.ts`,
both of which show as modified in `git status` right now because another session
owns them. Read §7.1 and §7.2 below before you conclude you need a fifth file —
this brief found two places where the literal instruction above collides with an
existing, protected test, and gives you the evidence and the recommended call so you
do not have to guess.

**Attribution to record in your new file's header comment:**
`MadsLorentzen/ai-job-search`, commit `968fb1bd`, MIT licence, © 2026 Mads Lorentzen.
Model the header on the one already in this repo's `docs/harvest/README.md` sources
table and on `brief-1-http-retry.md` §8 — name the upstream file(s) you read, what you
took, what you changed, and what you deliberately left out.

---

## 1. Scope and file list — read the flags before you start

| # | Path | Status |
|---|---|---|
| 1 | `supabase/functions/_shared/ats/freehire.ts` | **create** |
| 2 | `supabase/functions/_shared/ats/freehire.test.ts` (or your chosen name) | **create** |
| 3 | `supabase/functions/_shared/ats/registry.ts` | **one added entry only** |
| 4 | `supabase/migrations/<timestamp>_add_freehire_discovery_source.sql` | **create, append-only** |

**Forbidden to touch — other concurrent sessions own these, and some already show
uncommitted changes from those sessions in `git status` right now:**

| Path | Why it is not yours |
|---|---|
| `supabase/functions/scout-ats/index.ts` | Another session owns it (currently modified — leave that diff alone) |
| `worker/src/cli/scout.ts` | Another session (currently modified) |
| `apps/web/**` | Another session (three files currently modified) |
| `supabase/functions/_shared/normalize/posted-at.ts` | See the flag in §5 — you need one line here and do not have permission to add it yourself |
| `supabase/functions/_shared/ats/adapters.test.ts` | See the flag in §7.1 — an existing assertion in this file will break the moment you touch the registry, and you may not edit this file to silence it |
| `packages/shared-types/src/enums.ts` | See the flag in §7.2 — a required companion edit that is outside your four-file list |
| `.gitignore`, `PROJECT_PLAN.md`, `pnpm-lock.yaml` | Untouched by this parcel entirely |

### The three scope conflicts, up front

This brief's own verification section (§10) will surface all three as **real test
failures**, not stylistic nitpicks, if you proceed on the literal four-file list
alone. Each is explained where it bites (§5, §7.1, §7.2); the short version:

1. **`posted-at.ts`'s `PostedAtInput` union has no `freehire` case**, and it is not
   in your file list. §5 gives you the honest in-scope workaround and the "correct
   but out-of-scope" fix, and tells you which one to prefer.
2. **`adapters.test.ts` pins `supportedProviders()` to exactly
   `["ashby", "greenhouse", "lever"]`.** Any entry you add to the `ADAPTERS` map in
   `registry.ts` — under any key — changes that array and fails this existing,
   off-limits test. §7.1 gives you the evidence and two ways out.
3. **`packages/shared-types/src/enums.ts` has an automated parity test
   (`test/enum-parity.test.ts`) that fails if a Postgres enum value has no TypeScript
   mirror.** Your migration adds a SQL enum value; the TS twin lives in a file
   outside your four-file list. §7.2 gives you the exact line to request permission
   for.

None of these three is a reason to stop. They are reasons to **surface them to
whoever is coordinating this parcel with an explicit, narrow request** ("I need one
line in `X`, here is why") rather than silently editing the file, or silently
leaving the tests red. Both silent options are worse than asking, and this brief
gives you the exact diff to propose in each case.

---

## 2. The freehire API, documented precisely

**Base URL:** `https://freehire.me`, overridable via the `FREEHIRE_API_URL`
environment variable (for a self-hosted instance). Verbatim from the reference
client's `helpers.ts`:

```ts
export const DEFAULT_BASE_URL = "https://freehire.me"

/** API base URL: FREEHIRE_API_URL (for a self-hosted instance) or the default. */
export function baseUrl(): string {
  const raw = (process.env.FREEHIRE_API_URL ?? "").trim()
  return (raw || DEFAULT_BASE_URL).replace(/\/+$/, "")
}
```

`process.env` is Node-only — Deno Edge Functions read `Deno.env.get(...)`. Your
adapter must not port this function verbatim; see §8 for how the destination's
`AtsAdapter.buildRequestUrl` shape sidesteps the question entirely (no adapter in
this codebase reads an env var directly — the base host is a file-scope constant,
exactly as `GREENHOUSE_API_ORIGIN` and `LEVER_API_ORIGIN` already are).

### Search endpoint

```
GET /api/v1/agent/jobs/search
```

This is **the agent variant** of the public search, not the plain
`/api/v1/jobs/search` the website itself uses. Quoted from `search.ts`:

```ts
// The agent variant of the job search: the same query, ranking, and facets as the
// web's /jobs/search, but each hit carries the posting's full description instead
// of the search index's truncated preview — so a run reads every result without a
// follow-up `detail` per hit.
const SEARCH_PATH = "/api/v1/agent/jobs/search"
```

This is the endpoint to poll from an adapter, for the same reason Greenhouse's
`?content=true` is what our own `greenhouse.ts` uses (see its header comment): one
request should hydrate every posting's full text, or the Scout would need one
follow-up request per job — and there is no such follow-up step anywhere in
`AtsAdapter.parse()`, which receives one already-fetched JSON payload and returns
synchronously.

**Query parameters**, built by the reference client's `buildQuery`:

```ts
function buildQuery(opts: SearchOpts): URLSearchParams {
  const p = new URLSearchParams()
  if (opts.query) p.set("q", opts.query)
  p.set("limit", String(opts.limit))
  p.set("offset", String((opts.page - 1) * opts.limit))
  p.set("semantic_ratio", "0") // keyword search; the semantic index is opt-in
  const hydrate = opts.includeDescription !== false
  p.set("include_description", hydrate ? "true" : "false")
  if (hydrate) p.set("description_format", opts.descriptionFormat)
  if (opts.jobage > 0 && opts.jobage < 9999) p.set("posted_within_days", String(opts.jobage))
  if (opts.workMode) p.set("work_mode", opts.workMode)
  if (opts.company) p.set("company_slug", opts.company)

  const facets: Array<[string, string[]]> = [
    ["regions", opts.regions],
    ["countries", opts.countries],
    ["cities", opts.cities],
    ["seniority", opts.seniority],
    ["category", opts.category],
    ["skills", opts.skills],
    ...Object.entries(opts.facets),
  ]
  for (const [param, values] of facets) {
    for (const value of values) p.append(param, value)
  }
  return p
}
```

| Param | Meaning | Repeatable? |
|---|---|---|
| `q` | free-text keyword query (title/skill/role) | no |
| `limit` | results per page | no |
| `offset` | `(page - 1) * limit` | no |
| `semantic_ratio` | `0` for pure keyword search (the reference always sends `0`) | no |
| `include_description` | whether to hydrate each hit's full body server-side | no |
| `description_format` | `markdown` \| `text` \| `html`, only sent when hydrating | no |
| `posted_within_days` | recency filter, `1`–`9998` | no |
| `work_mode` | `remote` \| `hybrid` \| `onsite` | no |
| `company_slug` | filter to one company | no |
| `regions`, `countries`, `cities`, `seniority`, `category`, `skills` | controlled-vocabulary facets | **yes** — appended once per value |
| any other key | the generic `--facet key=value` escape hatch | yes |

**Request headers**, quoted from `helpers.ts`:

```ts
const UA = "freehire-search-skill/1.0 (+https://freehire.me)"
...
response = await fetch(url, {
  headers: { "User-Agent": UA, Accept: "application/json" },
  redirect: "follow",
  signal: AbortSignal.timeout(15000),
})
```

Your adapter's `parse()` never calls `fetch` itself — the Scout does, exactly the
way `scout-ats/index.ts` builds the request for Greenhouse/Lever/Ashby today (see
§7.3). But `buildRequestUrl` is the one place you own that shapes what gets
requested, so bake `limit`, `include_description=true`, and `description_format`
into the URL yourself (see the worked skeleton in §8) rather than assuming the
caller will add them.

### Detail endpoint

```
GET /api/v1/jobs/{slug}
```

Looks up one posting by its `public_slug`. Not used by a poll-based adapter (our
`AtsAdapter.parse()` handles a **bulk** payload, not a single lookup) — documented
here for completeness and because §5 depends on knowing that `detail`'s `description`
field is *always* HTML (no `description_format` parameter exists on this endpoint;
`toDetail`'s `cleanHtml()` call is unconditional), which is not true of the search
endpoint's hydrated field.

### Facets endpoint (discovery only, not polled)

```
GET /api/v1/jobs/facets
```

Returns the live controlled-vocabulary values (with counts) for `region`, `country`,
`seniority`, `category`, etc. SKILL.md: *"Discover the live values for a market at
`/api/v1/jobs/facets` ... never invent facet values."* Not called by your adapter;
noted so you do not invent a facet value that does not exist.

### The response envelope and the `FreehireJob` shape

Every endpoint answers inside the same envelope:

```ts
/** The shared API response envelope: {data, meta, error}. */
export interface Envelope<T> {
  data: T
  meta?: { total?: number; limit?: number; offset?: number }
  error?: string
}
```

For the search endpoint, `T` is `FreehireJob[]`. The full job shape, quoted in full
(this is the wire type your `parse()` must defensively read from, field by field —
see §4 for the destination-side field readers to reuse rather than reinvent):

```ts
/**
 * A freehire job — the fields this skill reads (the wire shape carries more).
 */
export interface FreehireJob {
  public_slug: string
  source: string
  external_id: string
  url: string
  title: string
  company: string
  company_slug: string
  location: string
  description: string
  skills: string[]
  work_mode?: string
  regions: string[]
  countries: string[]
  cities: string[]
  posted_at: string | null
  created_at: string | null
  // Always present in the wire shape (an unenriched job serializes it as `{}`);
  // the individual fields are what may be absent.
  enrichment: {
    seniority?: string
    category?: string
    employment_type?: string
    salary_min?: number
    salary_max?: number
    salary_currency?: string
  }
}
```

Note `source: string` and `external_id: string` — a live example from
`parsing.test.ts`'s fixture shows `source: "greenhouse"` and
`external_id: "acme:1"`, alongside `url: "https://boards.greenhouse.io/acme/jobs/1"`.
**freehire tells you which real ATS actually hosts each posting, and gives you that
board's own URL** — this is not a freehire.me page, it is the underlying board's job
page. That fact matters for §6 and §7.4 below: freehire is structurally a **discovery
proxy in front of other ATS's**, not a board of its own, and the destination's
`AtsAdapter` interface (one fixed submit-provider per adapter) was built for the
opposite shape. Keep `source`/`external_id` in `rawPayload` — they are not wasted;
they are exactly the data a future submit-routing improvement would need, and
`ParsedPosting.rawPayload` exists precisely so history is not lost while nothing
downstream reads it yet.

**The envelope's array key is `data`, not `jobs`.** This is freehire's own
field-name trap, parallel to Greenhouse's `jobs` and Lever's bare top-level array —
a fourth shape a universal scraper would have to special-case. Your adapter's
`isRecord(payload)` / `Array.isArray(payload["data"])` checks must read `data`, and
your test file should pin this the same way `adapters.test.ts` pins Lever's
bare-array shape (`"lever accepts a top-level array and rejects an object
envelope"`) — write an equivalent test asserting freehire rejects a payload shaped
like `{ jobs: [...] }`.

---

## 3. A known quirk to document: `include_description=false` is not honoured

The reference client documents, and works around, a real server-side bug. Quoted
verbatim from `search.ts`:

```ts
let rows = (env.data ?? []).map(toResult)
// The API currently returns description bodies regardless of
// include_description=false (verified live 2026-08-19), and the cost this
// flag exists to avoid is the ~73% of CLI output the bodies occupy in
// agent context - so the lean mode strips them client-side either way.
if (opts.includeDescription === false) {
  rows = rows.map((r) => ({ ...r, description: null }))
}
```

**What this means for you:** the request parameter `include_description` is
advisory only from the client's point of view — the server sends full bodies
regardless of what you pass. This does not matter for our adapter (we always want
the full body, so we will always pass `include_description=true` anyway — see §8),
but it is worth a one-line comment at the call site saying you know this, so a
future reader does not "fix" a missing `include_description=false` fast-path assuming
it would save bandwidth. It would not. If bandwidth ever becomes a concern, the
correct lever is `description_format=text` (smaller than `markdown`/`html`) or a
smaller `limit`, not `include_description`.

---

## 4. Field-by-field mapping: `FreehireJob` → `ParsedPosting`

The destination's adapter contract, quoted from `types.ts`, is what every field
below must satisfy:

```ts
export interface ParsedPosting {
  readonly atsJobId: string | null;
  readonly title: Untrusted;
  readonly locationRaw: Untrusted | null;
  readonly descriptionRaw: Untrusted | null;
  readonly applyUrl: Untrusted;
  readonly employmentType: EmploymentType;
  readonly workArrangement: WorkArrangement;
  readonly postedAtInput: PostedAtInput;
  readonly rawPayload: unknown;
}
```

**Every field marked `Untrusted` carries job-posting text that originated outside
this codebase — freehire's own copy, or copy freehire itself pulled from a third ATS
it aggregates.** `Untrusted` is `string` to the TypeScript compiler and enforces
nothing at the type level; it exists, per `contracts/shared-types.ts`'s own
re-export comment, *"so the danger is visible at every use site instead of living in
a document nobody rereads."* The project-wide rule (stated in `types.ts`'s
`descriptionRaw` comment, and true of every external source, freehire included) is:
**store it inert, escape it on display, and fence it before it ever reaches Gemini.**
Do not strip, "clean", or half-sanitize an `Untrusted` field beyond what the shared
`stripHtml` helper already does for structure (see the row below) — a stripped
field is not a safe field, it is a field that *looks* safer while the actual defence
(the untrusted fence at the prompt boundary) lives elsewhere.

| freehire field | → `ParsedPosting` field | Notes |
|---|---|---|
| `public_slug` | `atsJobId` | Read defensively with `readId`/`readString` even though the upstream type claims `string` — every other adapter validates rather than trusting a wire type, and freehire's is "public but only semi-documented" per Ashby's own header comment about the same class of API. |
| `title` | `title` (`Untrusted`, required) | Skip the posting (push to `skipped`) if empty, exactly like the other three adapters — a posting with no title cannot be fingerprinted or screened. |
| `location` | `locationRaw` (`Untrusted \| null`) | A bare string, like Ashby's — no nested object to unwrap, unlike Greenhouse. |
| `description` | `descriptionRaw` (`Untrusted \| null`), via the shared `stripHtml` | See the format recommendation below. |
| `url` | `applyUrl` (`Untrusted`, required) | **This is the underlying board's own job URL** (confirmed by the test fixture: a freehire job sourced from Greenhouse carries `url: "https://boards.greenhouse.io/..."`), not a `freehire.me` page. Skip the posting if empty, matching the other adapters' "not actionable without one" rule. |
| `enrichment.employment_type` (falls back to `title`) | `employmentType` | Reuse the shared `classifyEmploymentType(...)`, exactly as Ashby does (`classifyEmploymentType(readString(entry, "employmentType") ?? title)`). freehire's own vocabulary for this field is undocumented in the reference material, which is precisely the case `classifyEmploymentType`'s substring matching is built to tolerate. |
| `work_mode` (facet-derived, `remote \| hybrid \| onsite`, optional) + `location` | `workArrangement` | See the dedicated note below — this is genuinely structured data and deserves a small local reader, the way `readGreenhouseLocation` and `readCategory` are small per-adapter helpers in the existing code. |
| `posted_at` (and, separately, `created_at`) | `postedAtInput` | The whole of §5. |
| the raw `FreehireJob` object | `rawPayload` | Keep the entry verbatim, unmodified — same rule as all three existing adapters, and the reason `source`/`external_id`/`skills`/`regions`/`countries`/`cities`/`enrichment.*` survive even though none of them has a destination column (next row). |
| `skills`, `regions`, `countries`, `cities`, `enrichment.seniority`, `enrichment.category`, `enrichment.salary_*` | **not mapped** | No destination column exists for any of these. `registry.ts`'s own comment on `locations: []` explains why this is deliberate, not an oversight: *"Splitting ... into allowlist-matchable tokens is the Normalizer's job, not the Scout's — it needs the user's allowlist to know which distinctions matter, and duplicating that logic per adapter is exactly the drift this module exists to prevent."* The same reasoning applies to every facet freehire supplies that our schema does not yet have a column for: it survives in `rawPayload` so nothing is lost, and is available to a future migration without re-polling. |

### The `descriptionRaw` format decision — follow the Lever/Ashby precedent, not Greenhouse's

Both Lever and Ashby prefer a **pre-rendered plain-text field over raw HTML** when
the board offers one, specifically because it avoids our own tag-stripper guessing
at structure the source has already resolved. Lever:

```ts
// Lever ships BOTH `descriptionPlain` and `description` (HTML). Preferring the
// plain form is not merely convenient — it is the board's own de-marked text,
// so it avoids our tag stripper guessing at structure Lever already resolved.
// `stripHtml` still runs on the fallback path.
descriptionRaw: stripHtml(readString(entry, "descriptionPlain", "description")),
```

freehire's `description_format` request parameter is the equivalent lever: request
`description_format=text` in `buildRequestUrl` so the API itself renders plain text
(freehire's own de-marked rendering, the same category of "board already resolved
this" as Lever's `descriptionPlain`), and still run the result through the shared
`stripHtml` from `./types.ts` — not the reference client's own `cleanHtml` from
`helpers.ts`, which decodes a slightly different entity set and is not the function
every other adapter in this codebase uses. Passing already-plain text through
`stripHtml` is a safe no-op on the entity-decoding front and free insurance against
any stray tag freehire's "text" rendering leaves in (Lever's own code runs
`stripHtml` unconditionally for the same reason, even on its already-plain field).

Do **not** request `description_format=markdown` (the reference CLI's own default) —
markdown's `**bold**`/`- ` bullet syntax would pass through `stripHtml` unchanged
(it is not HTML) and land in `description_raw` looking like broken prose, which is
worse than either plain text or HTML-then-stripped.

### The `work_mode` → `workArrangement` mapping

The shared classifier is boolean-shaped for the "remote" case only:

```ts
export function classifyWorkArrangement(locationText: string | null, explicitRemote?: boolean | undefined): WorkArrangement
```

freehire's `work_mode` is a genuine three-value controlled vocabulary
(`remote | hybrid | onsite`) — strictly better evidence than the boolean flag every
existing adapter is limited to. Rather than force a three-way fact through a
boolean parameter (losing the `hybrid`/`onsite` distinction whenever `locationRaw`
does not happen to contain that word), write a small local resolver in the same
spirit as `readGreenhouseLocation`/`readCategory` — a one-adapter-only helper, which
is the established pattern for a board-specific shape:

```ts
// freehire's work_mode facet is a genuine three-value vocabulary (remote/hybrid/
// onsite), unlike the other three boards' boolean-or-nothing remote flags — so it
// gets checked directly instead of being squeezed through classifyWorkArrangement's
// boolean parameter, which would silently lose the hybrid/onsite distinction
// whenever the location string does not happen to repeat the word.
function resolveFreehireWorkArrangement(locationRaw: string | null, workMode: string | undefined): WorkArrangement {
  if (workMode === "remote") return "remote";
  if (workMode === "hybrid") return "hybrid";
  if (workMode === "onsite") return "onsite";
  // No structured signal: fall back to the shared prose classifier, same as every
  // other adapter when the board gives nothing better.
  return classifyWorkArrangement(locationRaw, undefined);
}
```

---

## 5. The date question — this is the load-bearing design decision in this parcel

### What freehire actually supplies

`FreehireJob` carries **two** date fields:

```ts
posted_at: string | null
created_at: string | null
```

SKILL.md's only documentation of either is one line: *"`date` is the posting date
(`posted_at`); it may be `null` for undated postings."* `created_at` is undocumented
in every file you were asked to read — it is not mentioned in SKILL.md, and neither
`toResult` nor `toDetail` ever reads it. The reference client's own maintainer does
not treat it as more trustworthy than `posted_at`; it simply is not used for
anything downstream.

### Is `posted_at` a true publication date, or a mutable one?

**Nothing in the reference material verifies this, and there is a concrete reason
to doubt it in general.** freehire aggregates ~50 ATS platforms into one schema.
Our own `greenhouse.ts` documents, in detail, that Greenhouse's own API exposes only
`updated_at` — a field that "looks exactly like a posting timestamp and is not one,"
because a recruiter fixing a typo resets it (`posted-at.ts`'s Greenhouse branch
enforces this by construction: it can never return `"exact"`, no matter how
well-formed the input). If freehire's crawler for a Greenhouse-hosted posting derives
its own `posted_at` from that same mutable `updated_at` — which is the only date
Greenhouse's public API gives anyone — then a freehire `posted_at` for that posting
inherits exactly the same mutability, one layer removed and with no way for us to
tell, from the wire shape alone, which upstream board a given record came from
without inspecting `source` per record (which the current interface has no path to
use — see §7.4).

**Conclusion: treat freehire's `posted_at` as genuine evidence — worth parsing and
preferring over silence — but never entitled to `"exact"` confidence.** This mirrors
the Greenhouse branch's own reasoning exactly (a real timestamp, wrong or unverifiable
meaning, still real evidence, never dressed up as more certain than it is), and for
a materially similar reason: mixed, unverifiable provenance across ~50 source boards
rather than one specifically-known mutable field. `created_at` does not resolve the
question either — it is undocumented, and even if it turned out to mean "when
freehire's own crawler first stored the row," that is functionally the same kind of
evidence our own `firstSeenAt` already is (our own system's first sighting), just
computed by someone else's crawler on their own schedule — not a stronger claim
about when the job was actually posted.

### How the existing adapters handle the same question — the pattern to follow

`posted-at.ts`'s discriminated union forces every adapter to declare, at compile
time, which kind of date evidence it has:

```ts
export type PostedAtInput =
  | { readonly source: "greenhouse"; readonly updatedAt: string | null }
  | { readonly source: "lever"; readonly createdAt: number | null }
  | { readonly source: "ashby"; readonly publishedDate: string | null }
  | { readonly source: "adzuna"; readonly created: string | null }
  | { readonly source: "aggregator"; readonly relativeText: string | null };
```

And the extractor's per-branch confidence:

```ts
case "greenhouse": {
  const date = parseTimestamp(input.updatedAt);
  if (date === null) return null;
  // Never `exact`, no matter how well-formed — that downgrade is the point.
  return { date, confidence: "derived" };
}
```

freehire's honest mapping is a **new branch that behaves like the Greenhouse
branch**: parse `posted_at` when present, cap the confidence at `"derived"`, and
return `null` (letting the caller fall back to `firstSeenAt` and the cold-start
guard) when the field is absent or unparseable. It is not the `"aggregator"` branch
— that branch exists for **relative prose** ("3 days ago") with no digit-based
timestamp at all, and its parser (`parseRelativeDays`) would not recognise an ISO
string in the first place (it matches `/(\d+)\s*\+?\s*(hour|day|week|month)s?\s+ago/`
or the literal words "today"/"yesterday" — an ISO date matches none of that and
`readSourceDate` would silently return `null`, discarding freehire's real timestamp
entirely and falling back to `firstSeenAt` every time). That would be **strictly
worse** than a dedicated branch: it throws away real (if imperfectly trusted)
evidence for no reason.

### The scope conflict, and the two ways to resolve it

**The honest fix requires a new case in `PostedAtInput` and in
`extractPostedAt`'s switch — both live in `posted-at.ts`, which is not in your
four-file list** (§1). This is not a hypothetical: `noFallthroughCasesInSwitch` is
set in `supabase/functions/deno.json` (see `brief-1-http-retry.md` §1 for the exact
flag list), so a `PostedAtInput` union member you invent locally in `freehire.ts`
without a matching `case` in `posted-at.ts`'s `switch (input.source)` **fails to
typecheck** the moment `readSourceDate` is asked to handle it — TypeScript will not
let the switch silently fall through.

Two ways forward; pick based on whether you can get the one-line exception:

1. **Recommended — request the exception.** Ask whoever is coordinating this parcel
   for a narrow, explicitly-labelled addition to `posted-at.ts`:
   ```ts
   // freehire aggregates ~50 boards of mixed, per-record-unverifiable date
   // provenance — some of which (e.g. Greenhouse) only expose a mutable
   // "updated" timestamp to begin with. Treated like Greenhouse: real evidence,
   // never `exact`.
   | { readonly source: "freehire"; readonly postedAt: string | null }
   ```
   and a matching switch arm identical in shape to the Greenhouse one, substituting
   `input.postedAt` for `input.updatedAt`. This is a 6-line, additive, low-risk
   change with an obvious precedent already in the file (it does not touch any
   existing branch), but it is still a file outside your stated four, so name the
   request explicitly rather than editing it unannounced.
2. **Fallback if the exception is refused — degrade honestly rather than silently.**
   Do not force freehire's ISO date through the `"aggregator"` branch (see above —
   it silently discards the date). Instead, build `postedAtInput` as
   `{ source: "aggregator", relativeText: null }` unconditionally, which is
   equivalent to declaring "freehire gives us no usable date signal" — every
   freehire posting then falls back to `firstSeenAt` with the existing cold-start
   guard applied. This is honest (it never claims more confidence than the code can
   support) and requires zero changes outside your four files, at the cost of
   discarding a real, if unverifiable, signal freehire does provide. Document this
   trade-off in a comment at the call site so a future reader does not mistake it
   for an oversight.

Do not invent a third option that quietly maps `posted_at` into one of the other
four existing branches (e.g. pretending it is an `"adzuna"`-shaped `created` date) —
every one of those branches is calibrated to a *specific*, verified source and
claims `"exact"` for at least one of them; borrowing one to smuggle a `"exact"` verdict
for freehire would defeat the entire point of the union (per the extractor's own
header comment: *"the compiler prevents the refactor"* that lets a parse failure or
an unverified source quietly earn a confidence it has not earned).

---

## 6. Two limitations upstream states about itself, and the design consequence

Quoted from SKILL.md:

> **⚠️ Scope: tech-focused** — freehire's corpus already includes some non-tech
> postings (it crawls whole company career pages), **but its faceted filtering —
> skills, categories, and seniority dictionaries — is tuned tech-first today**, so
> this skill scopes its triggers to software / data / engineering / tech roles...
>
> **ℹ️ Hosted-service dependency (best-effort, no SLA)** — This skill depends on a
> third-party hosted service, freehire.me... **freehire.me is a personal project but
> actively maintained; it runs on a best-effort basis (no formal SLA).**

The harvest plan already draws the correct conclusion from this (P6's own caveat):
*"A supply supplement, never a sole source."* Concretely for this adapter:

- **It must be one source among the growing set (Greenhouse, Lever, Ashby, and
  whatever P2's robots-gated direct-crawl expansion adds later), never the only
  one.** The tech-first tuning means freehire is a good *supplement* for boards our
  three direct adapters cannot reach (a company on Workable, say, which has no
  adapter yet), not a replacement for direct polling of companies already on the
  watchlist.
- **An outage must degrade the job search, not fail it.** This is already how
  `AtsParseResult`/the Scout's per-board try/catch are shaped for the other three
  adapters (`registry.ts`'s header comment: *"a board returning something unexpected
  is an ORDINARY operational event ... it must be recorded ... rather than crashing
  the whole poll and taking the other boards down with it"*) — freehire adds no new
  requirement here, it just must not be given a *better* failure story (retries,
  silent swallowing) than the other three get, or a worse one (an unhandled throw
  that takes the whole Scout run down).

**The reference client deliberately does not retry on a connection error, for
exactly this reason.** Quoted from `helpers.ts`:

```ts
try {
  response = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  })
} catch (e) {
  // Connection refused / DNS failure / timeout: the API is unreachable.
  throw new Error(
    `could not reach the freehire API at ${baseUrl()} (${e instanceof Error ? e.message : String(e)})`,
  )
}
```

This is the same "fail fast on an unreachable host" contract `brief-1-http-retry.md`
§4.3 already documents in detail (that file is the shared-HTTP-transport parcel —
worth knowing it exists, because once it lands, `freehire.ts`'s eventual fetch call
site, wherever the Scout ends up making it, should reuse it rather than
hand-rolling a fourth copy of this exact behaviour). For **this** parcel,
`freehire.ts` itself never calls `fetch` — `parse()` is pure and synchronous, exactly
like the other three adapters — so there is nothing to retry inside your file at
all. The relevant discipline here is narrower: `parse()` must return
`{ ok: false, reason: ... }` for a malformed payload rather than throwing, exactly
like the other three, so one bad freehire response cannot take an entire poll run
down.

---

## 7. Design boundaries — why this is not "port the CLI"

The reference implementation is a command-line tool: it parses `argv`, prints
`json`/`table`/`plain` output, and owns retry/backoff itself (`apiGet`). None of
that belongs in `freehire.ts`. The registry's own header comment states the design
split your adapter must respect:

```ts
// WHY `toJobInsert` LIVES HERE AND NOT IN EACH ADAPTER — this is the load-bearing
// decision of the whole `ats/` directory. Constraint #12 wants three independent
// adapters, and independence is genuinely right for FIELD EXTRACTION: Greenhouse
// renaming a key must not break Lever. But independence is exactly wrong for
// FINGERPRINTING and FRESHNESS. If each adapter built its own fingerprint, three
// adapters would drift into three dedupe behaviours, and the same job found on
// Greenhouse and Lever would become two rows — which is the precise failure
// `UNIQUE(user_id, fingerprint)` exists to prevent.
```

Concretely, `freehire.ts` must **not**:
- Retry, back off, or set a timeout — that is the Scout's / a future shared
  transport's job (see §6), not `parse()`'s, which is pure and synchronous by
  contract (`AtsAdapter.parse(payload: unknown): AtsParseResult`).
- Print anything, accept CLI flags, or format `table`/`plain` output — there is no
  CLI here, only a function called by an Edge Function.
- Build a fingerprint, decide freshness confidence beyond choosing the right
  `PostedAtInput` variant, or decide the row's `company_name`/`company_slug` — all
  three are `registry.ts`'s job, applied uniformly across every adapter, for the
  reason quoted above.
- Reimplement HTML cleaning (`cleanHtml` in the reference `helpers.ts`) — reuse the
  shared `stripHtml` from `./types.ts` (§4).

### 7.1 — Flag: any registry entry breaks a pinned, off-limits test

`ADAPTERS` in `registry.ts` is a fixed-size map today:

```ts
const ADAPTERS: ReadonlyMap<AtsProvider, AtsAdapter> = new Map([
  ["greenhouse" as AtsProvider, greenhouseAdapter],
  ["lever" as AtsProvider, leverAdapter],
  ["ashby" as AtsProvider, ashbyAdapter],
]);
```

and `adapters.test.ts` — which is **not** in your four-file list — pins its exact
size and contents:

```ts
test("supportedProviders reports exactly the three shipped adapters", () => {
  assert.deepEqual([...supportedProviders()].sort(), ["ashby", "greenhouse", "lever"]);
});
```

**Adding freehireAdapter to this map, under any key, makes `supportedProviders()`
return four entries and fails this exact assertion.** This is not avoidable by
choosing a clever key — it is a property of the array's length, not its contents.
There is a second, independent trap in the same file if you reach for the obvious
key: `getAdapter("unknown")` is separately pinned to `null`:

```ts
test("an unsupported provider returns null rather than throwing", () => {
  assert.equal(getAdapter("workable"), null);
  assert.equal(getAdapter("unknown"), null);
  ...
});
```

so registering `freehireAdapter` under `"unknown" as AtsProvider` — the value that
otherwise correctly describes freehire's *output* row semantics ("we have an apply
URL but no adapter recognises it" is exactly true of a freehire-discovered
Workable posting) — breaks this test too, and would also silently change behaviour
for every *other*, unrelated watchlist row already tagged `ats_provider = 'unknown'`
for reasons that have nothing to do with freehire.

**Resolution — same shape as §5's conflict, name it rather than pick silently:**
1. **Recommended:** request a one-line, explicitly-labelled update to
   `adapters.test.ts`'s pinned array (`["ashby", "freehire", "greenhouse", "lever"]`)
   as part of landing this parcel — it is a direct, mechanical consequence of the
   registry change you were asked to make, not scope creep, and the request should
   say so explicitly.
2. **If that exception is refused:** do not add `freehireAdapter` to the `ADAPTERS`
   map this parcel. Export it from `freehire.ts` as a plain named export
   (`export const freehireAdapter: AtsAdapter = { ... }`) and stop there — "one
   added entry in registry.ts" can then mean a one-line **import + comment** noting
   it is available but not yet wired into `getAdapter`/`supportedProviders`,
   explicitly deferring the wiring (and the key-collision decision) to whoever
   builds the invocation path in §7.4. This keeps the parcel honest about what it
   actually integrated, rather than overclaiming.

Either way: **if you do register it in the map, use `"other" as AtsProvider` as the
map key, not `"unknown"`** — `"other"` is not asserted anywhere in the existing
test file, and keeping `freehireAdapter.provider = "unknown"` (for the row-level
`jobs.ats_provider` column, via `adapter.provider` in `toJobInsert`) while using a
**different** value as the map's lookup key is legal: nothing in `registry.ts`
requires a map key to equal the adapter's own `.provider` field — the three existing
entries only happen to coincide by convention. State this divergence in a comment
at the map entry, because it is exactly the kind of thing a future reader would
otherwise "fix" back into an accidental collision.

### 7.2 — Flag: the migration needs a companion edit outside your four files

`SCHEMA_CONTRACT.md` §9 states the rule your migration must satisfy, and names an
automated enforcement mechanism:

```
An enum lives in **two** places. Change one and you must change the other:

- `supabase/migrations/…_enums.sql`
- `packages/shared-types/src/enums.ts`

**A TEST is the enforcement, not this checklist.** As of 2026-09-10, run:

    pnpm --filter @applyy/shared-types test    # test/enum-parity.test.ts

... What it covers:
- every Postgres enum has a TS mirror with the same values **in the same order**
- no TS enum mirror lacks a Postgres declaration (a value added here and forgotten in
  the migration would otherwise typecheck everywhere and fail as a runtime
  `22P02 invalid_text_representation` on the first insert — in production, from an
  agent, at the worst time)
```

Your migration (§9 below) adds `'freehire'` to the `discovery_source` Postgres enum.
The TypeScript mirror is the `DISCOVERY_SOURCES` const tuple in
`packages/shared-types/src/enums.ts`, currently:

```ts
export const DISCOVERY_SOURCES = [
  'greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters', 'adzuna', 'jooble',
  'linkedin', 'naukri', 'company_career_page', 'manual', 'other',
  /** Public founder or recruiter hiring post on LinkedIn (Tier 2 discovery). */
  'linkedin_post',
] as const;
```

**This file is not in your four-item list, and `enum-parity.test.ts` will fail
without the matching append.** Request the one-line addition
(`'freehire',` appended at the end, matching `linkedin_post`'s own precedent of
being appended rather than inserted mid-list — order is part of the contract) as
part of this parcel, explicitly, the same way as §7.1's request. Do not silently
edit this file yourself (it is outside your partition) and do not skip it (the test
will fail and your Definition of Done in §9 requires tests to pass).

### 7.3 — What "the Scout" means here, and why it is not yours to change

`scout-ats/index.ts` (which you may not touch) selects `company_watchlist` rows by
`ats_provider`, then for each row does:

```ts
const adapter = getAdapter(board.ats_provider);
...
const requestUrl = adapter.buildRequestUrl(board.board_token);
...
const response = await fetch(requestUrl, { headers: {...} });
...
const payload = await response.json();
const parseResult = adapter.parse(payload);
```

This loop is built around **one board token per company**, one fetch, one parse —
exactly what Greenhouse/Lever/Ashby need, since each of those really is "give me
this one company's postings." Your `freehire.ts` must still expose
`buildRequestUrl(boardToken: string): string` to satisfy the `AtsAdapter` interface,
but see §7.4 for why *invoking* it through this exact loop, with `board_token`
standing in for a search query or a `company_slug` filter, is a design decision this
parcel does not have to make (and should not make unilaterally) — it only has to
leave the adapter **ready** for whichever invocation path gets built.

### 7.4 — The invocation question, deliberately out of scope for this parcel

freehire is not a per-company board — it is a keyword/facet **search across many
companies at once**. This is a structurally different shape from Greenhouse/Lever/
Ashby, and the codebase already anticipates the distinction: `agent_name` (in
`enums.sql`) has **both** `'scout_ats'` and `'scout_aggregator'` as separate agent
identities, and `PostedAtInput` already has an `"aggregator"` branch distinct from
the three per-company boards. Nothing in the files you were told to read specifies
how `scout_aggregator` (or an extended `scout_ats`) would actually call
`freehireAdapter.buildRequestUrl(boardToken)` — whether `board_token` should be
repurposed as a raw keyword query, a `company_slug` facet filter against existing
watchlist companies, or something else. **That decision belongs to whoever builds
the invocation path, not to this parcel**, which is scoped to "the adapter exists,
conforms to `AtsAdapter`, and is tested" — exactly the four files in §1, and no
more. Do not modify `scout-ats/index.ts` to wire this up; if you find yourself
wanting to, that is a sign you are about to touch a file another session owns, and
the correct move is to note the gap in your final report instead (§10).

For what it is worth as a design sketch a future session can pick up: a reasonable
shape is `company_slug`-filtered polling of existing watchlist companies (catching
postings on boards our three adapters do not cover) rather than an open-ended
keyword search with no company context, since the latter has no natural place to
attach a `company_watchlist` row's `company_name`/`company_slug` context that
`toJobInsert` requires. This is a recommendation, not a decision — flag it, do not
build it.

---

## 8. Code-style requirement — non-negotiable, stated prominently

**Every statement, declaration and block in `freehire.ts` and its test file carries
a comment saying WHY it exists, not what it does.** Structural lines (`}`, blank
lines) are the only exception. Hand-written backend files in this repo run **at
least one comment line per code line** — this is not a style preference, it is a
calibrated density, and `registry.ts` is the example to match, for both density and
voice. Re-read its two block comments quoted in §7 above: note the shape — *"Returns
null rather than throwing for a provider we have no adapter for. That is a real
state, not a bug"* — that is a *why*. A comment reading `// look up the adapter`
would be a rule violation. `greenhouse.ts`, `lever.ts`, and `ashby.ts` are the
worked examples for how this looks inside an actual adapter file specifically —
match their per-field comment density in `freehire.ts`, not just the header block.

A minimal skeleton showing the expected shape (fill in per §4–§5, do not copy this
verbatim — it omits several required behaviours to keep the excerpt short):

```ts
// freehire.me job aggregator adapter.
//
// Ported in spirit (not in code — this is a fresh Deno/Edge-Function adapter, not
// a port of a Node CLI) from MadsLorentzen/ai-job-search @ 968fb1bd
// (MIT, © 2026 Mads Lorentzen), .agents/skills/freehire-search/cli/src/{helpers,
// commands/search}.ts. TAKEN: the endpoint, the query-param shapes, the envelope
// key names. NOT TAKEN: retry/backoff (parse() is pure and synchronous here, per
// this codebase's AtsAdapter contract — see registry.ts's header), the CLI's
// argument parsing and table/plain output, and process.env (Deno has no such
// global; the base host is a file-scope constant, matching GREENHOUSE_API_ORIGIN).
//
// ENDPOINT: https://freehire.me/api/v1/agent/jobs/search
// Public, unauthenticated. Envelope key is `data`, not `jobs` — freehire's own
// field-name trap, parallel to Lever's bare array and Greenhouse's nested location.
//
// THE DATE CAVEAT THIS ADAPTER EXISTS TO CARRY (brief-2 §5): freehire aggregates
// ~50 boards of mixed, per-record-unverifiable date provenance. Its posted_at is
// real evidence but is never treated as `exact` — see the PostedAtInput branch.

import {
  classifyEmploymentType,
  classifyWorkArrangement,
  isRecord,
  readId,
  readString,
  stripHtml,
  type AtsAdapter,
  type AtsParseResult,
  type ParsedPosting,
} from "./types.ts";

// Where the public aggregator API lives. A constant, like GREENHOUSE_API_ORIGIN,
// so the host appears exactly once in the codebase.
const FREEHIRE_API_ORIGIN = "https://freehire.me";

// ... small per-adapter readers (work-arrangement resolver from §4, etc.) ...

export const freehireAdapter: AtsAdapter = {
  // See brief-2 §7.1: NOT "freehire" — no such AtsProvider value exists, and this
  // is the row's SUBMIT-path claim, which freehire itself never is. "unknown" is
  // the column's own documented meaning for "apply URL, no adapter recognises it."
  provider: "unknown",
  // Distinct from `provider` above — this is DISCOVERY_SOURCE, added by this
  // parcel's migration (brief-2 §9), and it IS "freehire": where the sighting
  // came from, independent of who would submit it.
  discoverySource: "freehire",

  buildRequestUrl(boardToken: string): string {
    // ... build /api/v1/agent/jobs/search?... per §2 and §8's decisions ...
  },

  parse(payload: unknown): AtsParseResult {
    // ... per §2's envelope shape and §4's field mapping ...
  },
};
```

---

## 9. Definition of done

- [ ] `freehire.ts` satisfies `AtsAdapter` and typechecks under Deno
      (`deno check supabase/functions/_shared/ats/freehire.ts`).
- [ ] Every field mapping in §4 is implemented; every `Untrusted` field is passed
      through unmodified except for `stripHtml` on the description, matching the
      other three adapters' treatment of untrusted text.
- [ ] The `postedAtInput` mapping matches the decision made in §5 — either the
      requested `freehire` branch in `posted-at.ts` (if the exception was granted)
      or the documented `{ source: "aggregator", relativeText: null }` fallback (if
      not), with a comment explaining which and why.
- [ ] The registry change matches §7.1's resolution — either a map entry keyed
      `"other"` with the divergence from `adapter.provider` explicitly commented, or
      a standalone export with a comment noting it is not yet wired in, per whichever
      exception request was granted or refused.
- [ ] The migration (§7.2, §9 below) copies the `linkedin_post` precedent exactly:
      one `alter type ... add value if not exists ...` statement, nothing else, and
      **only adds** an enum value — never renames or removes one.
- [ ] Tests in your new test file mirror `adapters.test.ts`'s conventions (see §10)
      and cover **both** a well-formed `FreehireJob[]` response and a malformed one
      (wrong envelope key, non-object payload, missing title/url) — matching the
      "recorded as data, not thrown" contract every other adapter's tests pin.
- [ ] `node --test "supabase/functions/**/*.test.ts"` passes, **including**
      `adapters.test.ts` — which means either your registry change did not touch the
      `ADAPTERS` map (§7.1 option 2), or the exception in §7.1 option 1 was actually
      granted and applied.
- [ ] `pnpm --filter @applyy/shared-types test` passes — which means either you did
      not need the `discovery_source` migration this run, or the §7.2 exception was
      actually granted and applied.
- [ ] `git status --short` shows changes **only** in the four files listed in §1,
      plus whichever of the two named exceptions (§7.1, §7.2) were explicitly
      granted — nothing else.

---

## 10. Final verification checklist — run this before you say "done"

Do not declare completion from intent; each step below produces evidence, and your
report should include the real output, not a paraphrase.

1. **Run your new tests and paste the real output:**
   ```bash
   node --test "supabase/functions/_shared/ats/freehire.test.ts"
   ```
2. **Run the full function suite**, to see whether `adapters.test.ts` broke (§7.1)
   and to prove you did not disturb the other three adapters:
   ```bash
   node --test "supabase/functions/**/*.test.ts"
   ```
3. **Run the shared-types parity test**, to see whether the migration needs its
   companion edit (§7.2):
   ```bash
   pnpm --filter @applyy/shared-types test
   ```
4. **Type-check under Deno:**
   ```bash
   deno check supabase/functions/_shared/ats/freehire.ts
   ```
5. **Confirm the write partition held:**
   ```bash
   git status --short
   ```
   Only `freehire.ts`, your new test file, the `registry.ts` diff, the new migration
   file, and — **only if explicitly granted** — the two named exception files
   (`adapters.test.ts`, `packages/shared-types/src/enums.ts`) may appear as yours.
   You will also see pre-existing modifications from other sessions
   (`.gitignore`, `apps/web/src/features/...`, `supabase/functions/scout-ats/index.ts`,
   `worker/src/cli/scout.ts`, `supabase/functions/scout-ats/index.ts`,
   `docs/harvest/`) — **those are not yours; leave them alone.**
6. **Stage by explicit path only, never `-A` or `.`:**
   ```bash
   git add supabase/functions/_shared/ats/freehire.ts \
           supabase/functions/_shared/ats/freehire.test.ts \
           supabase/functions/_shared/ats/registry.ts \
           supabase/migrations/<your-timestamp>_add_freehire_discovery_source.sql
   git diff --cached --name-status
   ```
   Read that output before committing. If either exception was granted, add those
   exact two paths explicitly as well — never a bare `git add -A`. Then commit with
   the explicit pathspec repeated, per this repo's git-commit-authority rule (never
   `git add -A`/`git add .`/`git commit -a`, never `git stash`, never
   `git checkout -- <file>` outside your partition).
7. **Report honestly.** If either exception (§7.1, §7.2) was requested but not yet
   granted, say so explicitly and describe the fallback you shipped instead (§5's
   fallback, §7.1's standalone-export option). A "done" that quietly assumes an
   exception was granted, when it was not yet confirmed, is the exact "past tense
   for future work" failure mode this repo's own conventions warn against.

---

## Sources

`MadsLorentzen/ai-job-search`, commit `968fb1bd` (2026-09-16), MIT licence,
© 2026 Mads Lorentzen. Files read in full for this brief:
`.agents/skills/freehire-search/SKILL.md`,
`.agents/skills/freehire-search/cli/src/helpers.ts`,
`.agents/skills/freehire-search/cli/src/commands/search.ts`,
`.agents/skills/freehire-search/cli/src/commands/detail.ts`,
`.agents/skills/freehire-search/cli/tests/parsing.test.ts`.

Destination files read in full: `supabase/functions/_shared/ats/{types,registry,
greenhouse,lever,ashby,adapters.test}.ts`, `supabase/functions/_shared/normalize/
{posted-at,fingerprint}.ts`, `supabase/functions/_shared/contracts/shared-types.ts`,
`supabase/functions/scout-ats/index.ts`, `supabase/migrations/20260909234500_enums.sql`,
`supabase/migrations/20260911235500_add_linkedin_post_discovery_source.sql`,
`packages/shared-types/src/enums.ts`, `packages/shared-types/SCHEMA_CONTRACT.md`,
`docs/harvest/2026-09-16-ai-job-search-harvest-plan.md`,
`docs/harvest/briefs/brief-1-http-retry.md` (for house style and the shared-transport
context referenced in §6).
