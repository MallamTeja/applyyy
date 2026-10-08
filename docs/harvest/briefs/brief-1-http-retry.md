> **Historical record as of 2026-09-16.** Current state: [SYSTEM_ARCHITECTURE.md](../../SYSTEM_ARCHITECTURE.md) · [PROGRESS.md](../../PROGRESS.md).

# Brief 1 — Shared HTTP transport (retry / backoff / timeout)

**Read this whole file before you touch anything.** You are starting with an empty
context window and you cannot ask the orchestrator questions. Everything you need —
the upstream source code, the contract, the local conventions, the exit checklist —
is quoted in full below. **You do not need to read the upstream reference clone.**

---

## 0. Situation

**Repo:** `applyyy` at `C:\Users\tejam\OneDrive\myproj\applyyy`
An autonomous job-application system: Supabase Postgres + Deno Edge Functions,
React/Vite dashboard, Playwright worker on GitHub Actions, Gemini LLM.
Locked stack: **Node + TypeScript everywhere. pnpm only.**

**Your parcel:** create a shared HTTP transport module with retry / backoff / timeout,
ported from an upstream MIT project, plus four capabilities upstream lacks.

### Write partition — you may write ONLY inside this

```
supabase/functions/_shared/http/**
```

That directory **currently exists and is empty**. Everything you create goes in it.

### Forbidden to touch — other concurrent sessions own these

| Path | Owner |
|---|---|
| `supabase/functions/scout-ats/index.ts` | another session |
| `worker/src/cli/scout.ts` | another session |
| `apps/web/**` | another session |
| `pnpm-lock.yaml` | **SINGLE-OWNER** — see below |
| `.gitignore` | another session |
| `PROJECT_PLAN.md` | another session |

`pnpm-lock.yaml` being single-owner has a hard consequence for you:

> **The module must add NO new dependency.** Not a retry library, not `p-limit`,
> not `node-html-parser`. Zero `package.json` edits, zero lockfile churn. If you
> think you need a package, you need to write ~15 lines instead.

This is **write-ownership partitioning** — the technique that makes N concurrent
sessions over one working tree safe. The partition is the contract; the exit
checklist in §9 is how you prove you honoured it.

---

## 1. The critical runtime constraint

The module must run in **both** Deno (Supabase Edge Functions) **and Node 24** (the
Playwright worker). Therefore:

**ALLOWED — WHATWG / cross-runtime only**
- `fetch`, `Request`, `Response`, `Headers`
- `AbortSignal.timeout(ms)`, `AbortSignal`, `AbortController`
- `URL`, `URLSearchParams`
- `setTimeout` / `clearTimeout` as **globals** (see the trap in §6)
- `Math`, `JSON`, `Date`, `Error` and subclassing it

**FORBIDDEN**
- any `node:` import — `node:timers`, `node:https`, `node:buffer`, `node:process`
- `process.*` — including `process.env` and `process.stderr.write`
  (upstream's `writeError` helper uses `process.stderr.write`; **do not port it**)
- any `Deno.*` global — `Deno.env`, `Deno.serve`
- `require`, `__dirname`, CommonJS anything
- npm packages (see the lockfile rule above)

**Import style — match the neighbours exactly.**
Files under `supabase/functions/_shared/**` use **explicit `.ts` extensions** (Deno
style), because the same files are type-checked by Deno *and* executed by `node --test`.
Verbatim from `supabase/functions/_shared/ats/registry.ts`:

```ts
// The three shipped adapters.
import { ashbyAdapter } from "./ashby.ts";
import { greenhouseAdapter } from "./greenhouse.ts";
import { leverAdapter } from "./lever.ts";
// The adapter contract.
import type { AtsAdapter, ParsedPosting } from "./types.ts";
// The shared dedupe primitive. Async because it hashes.
import { jobFingerprint } from "../normalize/fingerprint.ts";
```

And from `supabase/functions/_shared/filter/cascade.test.ts`, with the reason stated:

```ts
// Extension-suffixed specifier so this runs under Deno and `node --test` alike.
import { screenJob, type ScreenableJob, type ScreenContext } from "./cascade.ts";
```

So: `import { httpFetch } from "./transport.ts";` — **never** `from "./transport"`.

**TypeScript strictness in force.** `supabase/functions/deno.json` sets, on top of
`strict: true`:

```jsonc
"noUncheckedIndexedAccess": true,
"noImplicitOverride": true,
"noFallthroughCasesInSwitch": true,
"exactOptionalPropertyTypes": true
```

`exactOptionalPropertyTypes` will bite you on the options object. Under that flag
`{ timeoutMs?: number }` does **not** accept an explicit `undefined`. Resolve
defaults with `??` into a fully-required internal config type rather than spreading
possibly-undefined properties around:

```ts
// Resolve every option to a concrete value ONCE, because exactOptionalPropertyTypes
// makes "absent" and "present but undefined" two different types — normalising here
// means no downstream code has to handle both.
const cfg: ResolvedHttpConfig = {
  timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
  // ...
};
```

---

## 2. THE COMMENT RULE — NON-NEGOTIABLE

> **Every statement, declaration and block carries a comment saying WHY it exists,
> not what it does.** Structural lines (`}`, blank lines, closing tags) are the only
> exception. Hand-written backend files in this repo run **at least one comment line
> per code line**. This applies to the implementation files *and* the test files.

A bare line teaches nothing when it is read back later, and retro-commenting is a
second pass nobody budgets for — so write the comments as you write the code, not
after.

**Calibration.** This is real, currently-shipped code from
`supabase/functions/_shared/ats/registry.ts`. Match this density and this voice —
comments that explain the decision, name the failure they prevent, and say what was
deliberately *not* done:

```ts
// Every adapter this build knows about, keyed by the provider it submits to.
//
// PHASE 2 IS ONE LINE HERE. Adding Workable or SmartRecruiters means writing one file
// that satisfies `AtsAdapter` and adding one entry below — the Scout does not change,
// `toJobInsert` does not change, and no existing adapter is touched. That is the
// extensibility the interface was designed for, stated as a fact about this table
// rather than as an aspiration in a comment somewhere else.
const ADAPTERS: ReadonlyMap<AtsProvider, AtsAdapter> = new Map([
  // Greenhouse: `updated_at` only, so its dates can never be `exact`.
  ["greenhouse" as AtsProvider, greenhouseAdapter],
  // Lever: genuine `createdAt`, top-level array response.
  ["lever" as AtsProvider, leverAdapter],
  // Ashby: genuine publication date, and the only board exposing unlisted postings.
  ["ashby" as AtsProvider, ashbyAdapter],
]);

// Look up the adapter for a watchlist row's provider.
//
// Returns null rather than throwing for a provider we have no adapter for. That is a
// real state, not a bug: `company_watchlist.ats_provider` is an enum that already
// contains `workable` and `smartrecruiters` (Phase 2) and `unknown`, so a row can
// legitimately name a board this build cannot poll. The Scout records it and moves on
// rather than crashing the poll and taking the other boards down with it.
export function getAdapter(provider: AtsProvider): AtsAdapter | null {
  return ADAPTERS.get(provider) ?? null;
}
```

Note the shape of the good comments: **"returns null rather than throwing … because a
row can legitimately name a board this build cannot poll"**. That is a *why*. A
comment reading `// get the adapter from the map` would be a rule violation.

The test files follow the same rule. From `adapters.test.ts`:

```ts
// Tests for the three ATS adapters and the shared row builder.
//
// THE TEST THAT MATTERS MOST IN THIS FILE is "the same job on two boards produces the
// same fingerprint". Everything else here checks that one adapter reads one board
// correctly; that one checks the property the whole `ats/` split was designed to
// protect — that per-adapter field extraction did NOT leak into per-adapter dedupe.
// It is the test that would catch a future contributor helpfully adding the req id to
// the fingerprint "for uniqueness".
import { test } from "node:test";
// Strict, so `undefined` never quietly compares equal to `null`.
import assert from "node:assert/strict";
```

---

## 3. The contract, as testable invariants

These are the invariants the ported core must satisfy. Each one should be pinned by
an assertion, not by a comment.

| # | Invariant | Notes |
|---|---|---|
| **I1** | **7 attempts total** on a retryable status: 1 initial + 6 retries | `maxRetries = 6`, loop `for (attempt = 0; attempt <= maxRetries; attempt++)` |
| **I2** | Retry **only** on `429` and `status >= 500` | nothing else is retryable |
| **I3** | A plain 4xx (400, 401, 403, 404 when not specially handled) **throws immediately**, `calls === 1` | no retry, no backoff, no sleep |
| **I4** | Backoff starts at **500 ms** and **doubles**, capped at **8000 ms** | `delay = Math.min(delay * 2, 8000)` |
| **I5** | Jitter is **ADDED, not multiplied**: `delay + Math.floor(Math.random() * 500)` | multiplying would change the schedule's shape; the upstream form is additive and must stay additive |
| **I6** | `AbortSignal.timeout(15000)` is **per attempt**, not a total budget | a fresh signal is constructed inside the loop on every attempt — a signal hoisted out of the loop would abort attempt 3 onward for free |
| **I7** | The User-Agent is an **exported constant** so tests can assert it | e.g. `export const DEFAULT_USER_AGENT = "…"` |

> **Discrepancy found in upstream, resolved for you — do not "fix" it back.**
> The four upstream copies do **not** agree on the cap. `jobdanmark` and `jobbank`
> cap at `5000`; `linkedin` and `freehire` cap at `8000`. **Our contract is 8000**
> (I4). When you read the quoted jobdanmark source in §4 you will see `5000` — that
> is the upstream text quoted faithfully. Your port uses **8000**, and your
> attribution header's "what changed" line must say so.

---

## 4. The upstream source, quoted in full

**Provenance:** `MadsLorentzen/ai-job-search`, pinned at commit **`968fb1bd`**.
Licence **MIT, © 2026 Mads Lorentzen**.

### 4.1 The canonical retry loop — `jobdanmark-search/cli/src/helpers.ts`

This file carries **three copies of the same loop** (`apiFetch` L4, `apiPost` L35,
`htmlFetch` L75). That triplication is the reason this parcel exists: three copies
drift. Your port collapses them to one core with per-caller options.

```ts
export const BASE_URL = "https://jobdanmark.dk"
export const USER_AGENT = "Mozilla/5.0 (compatible; jobdanmark-cli/1.0)"

export async function apiFetch<T>(path: string, params?: Record<string, string>): Promise<T> {
  let url = `${BASE_URL}${path}`
  if (params && Object.keys(params).length > 0) {
    const qs = new URLSearchParams(params)
    url += `?${qs.toString()}`
  }

  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15000),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`API request failed: ${response.status} ${response.statusText}`)
      }
      const jitter = Math.floor(Math.random() * 500)
      await new Promise((resolve) => setTimeout(resolve, delay + jitter))
      delay = Math.min(delay * 2, 5000)
      continue
    }
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`)
    }
    return response.json() as Promise<T>
  }
  throw new Error("API request failed after max retries")
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const url = `${BASE_URL}${path}`

  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`API request failed: ${response.status} ${response.statusText}`)
      }
      const jitter = Math.floor(Math.random() * 500)
      await new Promise((resolve) => setTimeout(resolve, delay + jitter))
      delay = Math.min(delay * 2, 5000)
      continue
    }
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`)
    }
    return response.json() as Promise<T>
  }
  throw new Error("API request failed after max retries")
}

/**
 * Fetch a rendered jobdanmark.dk page as text, with the same 429/5xx backoff,
 * request timeout, and User-Agent as apiFetch/apiPost. `detail` reads HTML
 * rather than the JSON API; it used to call fetch() directly with none of the
 * three, so a rate-limited detail page failed on the first 429 while every
 * other portal's detail command retried. Returns null on 404 so the caller
 * keeps its own NOT_FOUND contract.
 */
export async function htmlFetch(url: string): Promise<string | null> {
  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(15000),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`API request failed: ${response.status} ${response.statusText}`)
      }
      const jitter = Math.floor(Math.random() * 500)
      await new Promise((resolve) => setTimeout(resolve, delay + jitter))
      delay = Math.min(delay * 2, 5000)
      continue
    }
    if (response.status === 404) {
      return null
    }
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`)
    }
    return response.text()
  }
  throw new Error("API request failed after max retries")
}
```

### 4.2 The 8s-cap variant, 404 → `""` — `linkedin-search/cli/src/helpers.ts`

```ts
const UA = "Mozilla/5.0 (compatible; linkedin-search-cli/1.0)"

/** Fetch HTML with exponential backoff on 429/5xx. Returns "" on a 404. */
export async function htmlFetch(url: string): Promise<string> {
  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "X-Requested-With": "XMLHttpRequest",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`Request failed: ${response.status} ${response.statusText}`)
      }
      const jitter = Math.floor(Math.random() * 500)
      await new Promise((r) => setTimeout(r, delay + jitter))
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 404) return ""
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`)
    }
    return response.text()
  }
  throw new Error("Request failed after max retries")
}
```

Note the per-caller extras this variant needs and jobdanmark's does not:
`redirect: "follow"`, extra `Accept-Language` / `X-Requested-With` headers. Your
options object must let a caller supply arbitrary headers and a `redirect` mode
without forking the loop.

### 4.3 Fail-fast on connection error — `freehire-search/cli/src/helpers.ts`

```ts
const UA = "freehire-search-skill/1.0 (+https://freehire.me)"

/**
 * GET a JSON envelope from the freehire API. Retries 429/5xx (transient server
 * states) with backoff; returns `null` on a 404. A connection failure fails fast
 * with a clear message — no retry, so an outage degrades this source quickly
 * rather than hanging the caller (the graceful-degradation contract).
 */
export async function apiGet<T>(path: string): Promise<Envelope<T> | null> {
  const url = `${baseUrl()}${path}`
  const maxRetries = 6
  let delay = 500

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response
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

    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`freehire API request failed: ${response.status} ${response.statusText}`)
      }
      await sleep(delay + Math.floor(Math.random() * 500))
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 404) return null

    // Read the body once, tolerantly: an error response's JSON gives us its
    // `error` message; a 2xx must parse (a malformed one is surfaced, not swallowed).
    const body = (await response.json().catch(() => null)) as Envelope<T> | null
    if (!response.ok) {
      throw new Error(body?.error || `freehire API request failed: ${response.status} ${response.statusText}`)
    }
    if (!body) throw new Error("freehire API returned an unparseable response body")
    return body
  }
  // Unreachable in practice; the loop returns or throws on the last attempt.
  throw new Error("freehire API request failed after retries")
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
```

**Carry this behaviour across**: a thrown `fetch` (DNS failure, connection refused,
or the AbortSignal firing) is wrapped in a clear error and **fails fast without
retrying**. It is a deliberate graceful-degradation choice: an unreachable host
should drop out of the run quickly rather than hold a 7-attempt budget open.

> Judgement call you should make explicitly and comment: an `AbortError` from
> `AbortSignal.timeout` arrives through the same `catch`. Upstream treats it as
> fail-fast. Keep that default (it matches "fail fast on an unreachable host"), but
> expose it as an option (`retryOnNetworkError?: boolean`, default `false`) and say
> in the comment why the default is the conservative one.

### 4.4 Cloudflare / WAF detection — `jobbank-search/cli/src/helpers.ts` L92-100

This is the pattern for addition (d) in §5. Upstream does it **outside** the retry
loop, at the call site:

```ts
export async function rssFetch(params: Record<string, string | string[]>): Promise<RssItem[]> {
  const searchParams = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const v of value) {
        searchParams.append(key, v)
      }
    } else {
      searchParams.append(key, value)
    }
  }
  const url = `${BASE_URL}/job/rss?${searchParams.toString()}`
  const response = await fetchWithUA(url)
  if (!response.ok) {
    const body = await response.clone().text()
    if (response.status === 403 && /just a moment|cloudflare|cf-chl/i.test(body)) {
      throw new Error(
        "Jobbank is blocking automated requests with Cloudflare bot protection. Skip this portal or use the WebSearch fallback."
      )
    }
    throw new Error(`Failed to fetch RSS feed: ${response.status} ${response.statusText}`)
  }
  const xml = await response.text()
  return parseRssItems(xml)
}
```

Two things to steal and one to improve:
- **Steal** the regex `/just a moment|cloudflare|cf-chl/i` and the `response.clone()`
  before reading the body (the original `Response` body is a one-shot stream; cloning
  keeps it readable by the caller).
- **Steal** the actionable error text shape — it tells the operator what to *do*
  ("skip this portal / use the fallback"), not merely that something failed.
- **Improve**: upstream only checks this on `403`. A WAF challenge also comes back as
  `429` and `503`, and *those* statuses are retryable — so upstream's jobbank never
  sees them here, and a WAF-driven 503 burns all 7 attempts. Your version must check
  **inside** the loop, before the retry decision. See §5(d).

Also in that file: `import { parse as parseHtml } from "node-html-parser"` — **do not
port that import.** It is a new dependency and the lockfile is single-owner.

---

## 5. Four additions upstream LACKS — these are the value you add

Upstream is four copy-pasted loops in four CLIs. Our module is one loop used by a
Scout that polls many boards. That difference generates four requirements upstream
never had.

### (a) Honour `Retry-After` on a 429 — it OVERRIDES the computed backoff

Upstream ignores the header entirely and always sleeps its own computed delay. That
is exactly wrong against a server that has just told you how long to wait: sleeping
500 ms when the server said 30 s gets you rate-limited harder and can escalate to a
ban.

Requirements:
- Parse `Retry-After` when the response is a 429 (and accept it on a 503 too — the
  RFC allows it there and real WAFs send it).
- **Two wire formats.** Delta-seconds (`Retry-After: 120`) *and* an HTTP-date
  (`Retry-After: Wed, 16 Sep 2026 07:28:00 GMT`). Handle both; a date is converted to
  a delta against `Date.now()` and floored at 0.
- When present and parseable, it **replaces** the computed backoff for that attempt —
  it does not add to it, and it is not subject to the 8000 ms cap (the point of the
  header is that the server knows better).
- **But it must be bounded**, or a hostile or buggy `Retry-After: 86400` parks the
  Scout for a day inside an Edge Function that has a wall-clock limit. Cap it at a
  configurable `maxRetryAfterMs` (suggest 60_000 default). If the header exceeds the
  cap, **stop retrying and throw** with the server's requested delay in the message —
  waiting less than asked is worse than giving up, because it guarantees another 429.
- Jitter: still add jitter on top of a server-supplied delay (it prevents your own
  parallel requests from re-colliding at the same instant), but do not add jitter to a
  header value you are about to reject as too large.
- Ignore an unparseable header and fall back to the computed backoff — never crash on
  a malformed one.

### (b) A concurrency cap

The Scout polls many boards. Unbounded `Promise.all` over a watchlist opens as many
sockets as there are rows, which gets you rate-limited by exactly the servers whose
429s the retry loop is there to survive — the two features fight each other unless the
cap exists.

- **No dependency.** Do not reach for `p-limit`. A counting semaphore over a queue of
  resolvers is about 15 lines.
- Suggested shape: a `createHttpClient({ maxConcurrent })` factory that returns bound
  `fetch`/`json`/`text` methods sharing one semaphore, so the cap is per-client rather
  than a module-level global. A module global would make two independent callers
  throttle each other invisibly and make the tests order-dependent.
- The semaphore must release in a `finally`, or one thrown request permanently leaks a
  slot and the client deadlocks after `maxConcurrent` failures. Comment that.
- A request **holds its slot across its own retries**. That is the correct reading of
  a concurrency cap (it bounds in-flight sockets), and it is also what keeps a
  rate-limited host from being hammered by fresh requests while an earlier one backs
  off. State this decision in a comment; it is the kind of thing a later reader will
  otherwise assume was an oversight.

### (c) Configurable timeout

Upstream hard-codes `15000` in all four files. One number cannot serve both callers:
an Edge Function has a wall-clock budget that a 15 s hang eats a large share of, and
a slow HTML detail page legitimately needs longer than a JSON list endpoint.

- `timeoutMs` option, **default 15000** so the ported default matches upstream.
- **Per attempt, not per budget (I6).** Construct `AbortSignal.timeout(cfg.timeoutMs)`
  *inside* the loop body. Hoisting it above the loop is a subtle, plausible-looking
  bug: the signal's clock starts once, so after the first backoff every later attempt
  inherits an almost-expired signal and aborts instantly. Write a comment at the
  construction site saying exactly this — it is the single most likely regression a
  future editor will introduce.
- If a caller supplies its own `signal`, the effective signal must be the **combination**
  of theirs and the per-attempt timeout, so caller cancellation still works. `AbortSignal.any([a, b])`
  exists in both Node 24 and Deno; use it, and guard it behind a feature check only if
  you can verify the runtime lacks it (it does not — do not add a polyfill).

### (d) Cloudflare / WAF detection that surfaces an actionable error INSTEAD of burning all 7 retries

A WAF challenge is **not** a transient server state. Retrying it seven times over
~30 s of backoff produces seven identical challenge pages, wastes the budget, and
reports a generic `503` at the end — which tells the operator nothing about what to do.

- Check **inside the loop, before the retry decision**, so a challenge served as
  `429` or `503` short-circuits instead of retrying. This is the improvement over
  upstream's jobbank, which only checks `403` after the loop has finished.
- Detect on status ∈ {403, 429, 503} **and** body matching the upstream regex
  `/just a moment|cloudflare|cf-chl/i`. Extend it with `attention required`,
  `/cdn-cgi/challenge-platform`, `access denied` — but keep the upstream three, they
  are the load-bearing ones.
- **`response.clone()` before reading the body**, exactly as upstream does. A `Response`
  body is a one-shot stream; reading it to sniff for a challenge would leave the real
  caller with a consumed body.
- Only sniff the body when a header hint makes it cheap and plausible — e.g.
  `server: cloudflare`, a `cf-ray` header, or a `content-type` of `text/html` on an
  endpoint that should have returned JSON. Sniffing every 503 body costs a full read
  on every retryable failure.
- Throw a **distinct error class** (`BotProtectionError extends HttpError`) so the
  Scout can branch on `instanceof` rather than regex-matching a message string. The
  message keeps upstream's actionable voice: name the host, say it is bot protection,
  and say what to do next.

---

## 6. The 404 design decision — make it CALLER-CHOSEN

Upstream deliberately varies 404 handling per adapter, and all four behaviours are
defensible:

| Upstream file | 404 behaviour | Why that caller wants it |
|---|---|---|
| `jobdanmark` `htmlFetch` | `return null` | "detail keeps its own NOT_FOUND contract" |
| `linkedin` `htmlFetch` | `return ""` | caller pipes straight into a regex parser; `""` parses to zero cards |
| `freehire` `apiGet` | `return null` | envelope type is already `Envelope<T> | null` |
| `jobbank` `fetchWithUA` | returns the raw `Response` | caller inspects status itself |
| `jobdanmark` `apiFetch`/`apiPost` | **throws** (falls through to `!response.ok`) | a missing API path is a bug, not a normal state |

**Do not bake one of these in.** Expose it as an option, e.g.:

```ts
// What a 404 MEANS is the caller's business, not the transport's, so it is an option
// rather than a hard-coded branch.
//   "throw"  — a missing path is a bug (the JSON API callers)
//   "null"   — a job that no longer exists is a normal, expected state (detail lookups)
//   "empty"  — the caller parses text and an empty document already means "nothing found"
notFound?: "throw" | "null" | "empty";
```

**Why caller-chosen, stated so you can put it in the comment:** whether a 404 is an
*error* or a *normal outcome* is a fact about the caller's domain, not about HTTP. A
deleted job posting returning 404 is the system working correctly; a 404 on the
board's list endpoint means we have the wrong URL and the Scout should shout. A shared
transport that picks one of those for everybody forces half its callers to write
`try/catch` around a non-error, or to treat a real misconfiguration as "no results
today" — and the second failure mode is silent, which is the expensive kind. Pushing
the choice to the call site is the same **dependency-seam** reasoning that keeps the
policy with the code that owns the policy.

Whatever the option, **a 404 is never retried** (invariant I3). Upstream's test pins
this explicitly — see §7.

---

## 7. The test technique, quoted — then translated to `node:test`

### 7.1 The upstream tests, verbatim

**`jobdanmark-search/cli/tests/retry-backoff.test.ts`**

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { apiFetch, apiPost, htmlFetch } from "../src/helpers";

// The portal contract requires backoff on 429/5xx. These tests pin the retry
// loop offline: a stubbed fetch counts attempts, and a stubbed setTimeout
// fires immediately so the exhaustion case does not sleep through the real
// 500ms -> 5s backoff schedule. apiFetch, apiPost, and htmlFetch carry separate
// copies of the loop, so all three are exercised to keep them from drifting
// apart. htmlFetch is the one `detail` uses: before it existed, detail called
// fetch() directly and a 429 failed on the first attempt (1 call, not 7).

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

function instantTimers() {
  globalThis.setTimeout = ((fn: () => void) =>
    originalSetTimeout(fn, 0)) as unknown as typeof setTimeout;
}

function stubFetch(responses: Array<() => Response>): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (async () => {
    const i = Math.min(state.calls, responses.length - 1);
    state.calls++;
    return responses[i]();
  }) as unknown as typeof fetch;
  return state;
}

const wrappers: Array<[string, () => Promise<{ ok: boolean }>]> = [
  ["apiFetch", () => apiFetch<{ ok: boolean }>("/x")],
  ["apiPost", () => apiPost<{ ok: boolean }>("/x", {})],
  ["htmlFetch", () => htmlFetch("https://jobdanmark.dk/job/x").then((html) => ({ ok: html !== null }))],
];

for (const [name, call] of wrappers) {
  describe(`${name} retry/backoff`, () => {
    test("retries a 429 and succeeds on the next attempt", async () => {
      instantTimers();
      const state = stubFetch([
        () => new Response("", { status: 429 }),
        () => new Response('{"ok":true}', { status: 200 }),
      ]);

      const data = await call();
      expect(data.ok).toBe(true);
      expect(state.calls).toBe(2);
    });

    test("does not retry a plain 4xx", async () => {
      const state = stubFetch([() => new Response("", { status: 400 })]);

      await expect(call()).rejects.toThrow(/400/);
      expect(state.calls).toBe(1);
    });

    test("gives up after the initial attempt plus six retries on persistent 5xx", async () => {
      instantTimers();
      const state = stubFetch([() => new Response("", { status: 500 })]);

      await expect(call()).rejects.toThrow(/500/);
      expect(state.calls).toBe(7);
    });
  });
}

describe("htmlFetch 404", () => {
  test("returns null without retrying so detail keeps its NOT_FOUND contract", async () => {
    const state = stubFetch([() => new Response("", { status: 404 })]);

    expect(await htmlFetch("https://jobdanmark.dk/job/missing")).toBeNull();
    expect(state.calls).toBe(1);
  });
});
```

**`jobdanmark-search/cli/tests/request-timeout.test.ts`**

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { apiFetch, apiPost, htmlFetch } from "../src/helpers";

// A stalled upstream connection (accepted socket, no response) would otherwise
// hang the CLI forever - fetch has no default timeout. Assert both request
// wrappers carry an AbortSignal timeout. Fails on the pre-fix code (no signal).
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("request timeout", () => {
  test("apiFetch passes an AbortSignal timeout to fetch", async () => {
    let init: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, i?: RequestInit) => {
      init = i;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await apiFetch("/search");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("htmlFetch passes an AbortSignal timeout to fetch", async () => {
    let init: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, i?: RequestInit) => {
      init = i;
      return new Response("<html></html>", { status: 200 });
    }) as unknown as typeof fetch;

    await htmlFetch("https://jobdanmark.dk/job/x");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("apiPost passes an AbortSignal timeout to fetch", async () => {
    let init: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, i?: RequestInit) => {
      init = i;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await apiPost("/search", { q: "x" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
```

**`jobdanmark-search/cli/tests/user-agent.test.ts`** — the `headerValue` helper at
L13-21 is the reusable part: `RequestInit["headers"]` is a union of three shapes, and
a test that only handles the object literal silently passes on code that used
`Headers`.

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { apiFetch, apiPost, htmlFetch, USER_AGENT } from "../src/helpers";

// Bun's fetch injects an anonymous default User-Agent (Bun/1.3.10) when code
// sets none. This CLI should say who is asking, in the honest style jobindex
// already uses on htmlFetch ("Mozilla/5.0 (compatible; jobindex-cli/1.0)").
// Assert the header is present on every request. Fails on the pre-change code.
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function headerValue(headers: RequestInit["headers"], name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const found = headers.find(([k]) => k === name);
    return found ? String(found[1]) : null;
  }
  const value = headers?.[name];
  return typeof value === "string" ? value : null;
}

describe("apiFetch user agent", () => {
  test("sends a User-Agent header", async () => {
    let init: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, i?: RequestInit) => {
      init = i;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await apiFetch("/api/search/autocomplete", { q: "it" });
    expect(headerValue(init?.headers, "User-Agent")).toBe(USER_AGENT);
  });
});

describe("apiPost user agent", () => {
  test("sends a User-Agent header alongside Content-Type", async () => {
    let init: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, i?: RequestInit) => {
      init = i;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await apiPost("/api/jobsearch/search/1", { q: "it" });
    expect(headerValue(init?.headers, "User-Agent")).toBe(USER_AGENT);
    expect(headerValue(init?.headers, "Content-Type")).toBe("application/json");
  });
});

describe("htmlFetch user agent", () => {
  test("sends the shared User-Agent and asks for HTML", async () => {
    let init: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, i?: RequestInit) => {
      init = i;
      return new Response("<html></html>", { status: 200 });
    }) as unknown as typeof fetch;

    await htmlFetch("https://jobdanmark.dk/job/x");
    expect(headerValue(init?.headers, "User-Agent")).toBe(USER_AGENT);
    expect(headerValue(init?.headers, "Accept")).toContain("text/html");
  });
});
```

### 7.2 The technique, named

Two monkeypatches, both restored in cleanup:

1. **Scripted `globalThis.fetch` + call counter.** An array of `() => Response`
   thunks; the stub serves index `min(calls, len-1)` so the *last* entry repeats
   forever — that is what lets a one-element `[() => 500]` script drive the exhaustion
   case. The counter is the assertion surface: `calls === 7`, `calls === 1`, `calls === 2`.
2. **`globalThis.setTimeout` replaced with a 0-ms version.** Without this the
   exhaustion test really sleeps through 500 + 1000 + 2000 + 4000 + 8000 + 8000 ms
   ≈ 24 s plus jitter. With it the same test is instant and still exercises the real
   loop. **This is why the assertion `calls === 7` is affordable at all.**

Both originals are captured at module load and restored in `afterEach` — a leaked
`globalThis.fetch` stub poisons every later test file in the same process, and
`node --test` runs files in the same process by default.

> **TRAP — this dictates how you write the sleep.** The `setTimeout` monkeypatch only
> works if your module resolves `setTimeout` from the global object **at call time**.
> Write `await new Promise((r) => setTimeout(r, ms))` inside the function. Do **not**
> write `const sleep = globalThis.setTimeout;` at module top level, and do not import
> from `node:timers` (forbidden anyway) — either captures the real timer before the
> test can patch it, and your exhaustion test then takes 24 real seconds or times out.

> **Same trap for `fetch`.** Call the bare global `fetch(...)`. Do not do
> `const f = globalThis.fetch` at module scope.

### 7.3 Translate to `node:test` — NOT `bun:test`, NOT vitest

**This repo's convention is `node:test` + `node:assert/strict`.** The upstream tests
are `bun:test`; the imports and matchers must be rewritten. `supabase/functions` is
not a pnpm workspace member and has no `package.json` — the root script runs it as
`node --test "supabase/functions/**/*.test.ts"`. Bun and vitest are not available to
it at all.

Translation table:

| bun:test | node:test + node:assert/strict |
|---|---|
| `import { describe, test, expect, afterEach } from "bun:test"` | `import { describe, test, afterEach } from "node:test";` + `import assert from "node:assert/strict";` |
| `expect(x).toBe(y)` | `assert.equal(x, y)` |
| `expect(x).toBeNull()` | `assert.equal(x, null)` |
| `expect(x).toBeInstanceOf(AbortSignal)` | `assert.ok(x instanceof AbortSignal)` |
| `expect(s).toContain("text/html")` | `assert.ok(s?.includes("text/html"))` |
| `await expect(p).rejects.toThrow(/500/)` | `await assert.rejects(p, /500/)` |
| `afterEach(fn)` | `afterEach(fn)` — same name, from `node:test` |

`assert.rejects` takes the **promise** (or a function returning one), so write
`await assert.rejects(call(), /500/)`. Note the ordering hazard: the upstream form
asserts `state.calls` *after* the rejection assertion — keep that order, because
asserting the counter before the promise settles reads a half-finished loop.

**File naming is load-bearing.** `supabase/functions/deno.json` excludes
`**/*.test.ts` from both `deno check` and `deno lint`, precisely because test files
import `node:test`, which Deno cannot resolve type-references for. Name your tests
`*.test.ts` (e.g. `transport.test.ts`). A different suffix would be type-checked by
Deno and fail; and the root `test:functions` glob would not find it.

### 7.4 A technique the upstream tests do not have, which you need

To assert the **backoff schedule** and the **`Retry-After` override** you need to see
the delays, not just the call count. Extend the `setTimeout` stub to record them:

```ts
// Record every requested delay instead of only firing instantly, because the
// Retry-After override and the 8000ms cap are assertions ABOUT THE SCHEDULE —
// a call counter alone cannot tell a 500ms sleep from a 30s one.
function instantTimers(): { delays: number[] } {
  const seen: { delays: number[] } = { delays: [] };
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    seen.delays.push(ms ?? 0);
    return originalSetTimeout(fn, 0);
  }) as unknown as typeof setTimeout;
  return seen;
}
```

Jitter makes exact equality useless, so assert **ranges**: attempt 1's delay is in
`[500, 1000)`, attempt 2's in `[1000, 1500)`, and the last two are in `[8000, 8500)`
— which simultaneously proves the doubling, the additive jitter (I5) and the 8000 cap
(I4). For `Retry-After: 2`, assert the delay is in `[2000, 2500)` — proving the
header won over the 500 ms computed value.

---

## 8. Attribution header

Put this at the very top of the ported implementation file, before the imports:

```ts
// Ported from MadsLorentzen/ai-job-search @ 968fb1bd (MIT, © 2026 Mads Lorentzen).
//
// TAKEN: the retry loop's shape and constants — 1 initial attempt plus 6 retries on
// 429/5xx only, 500ms delay doubling with additive `Math.floor(Math.random() * 500)`
// jitter, a per-attempt `AbortSignal.timeout`, an explicit User-Agent, fail-fast on a
// thrown fetch (freehire's graceful-degradation rule), and jobbank's Cloudflare
// challenge regex `/just a moment|cloudflare|cf-chl/i` with its `response.clone()`
// body read.
//
// CHANGED: upstream carries FOUR divergent copies of this loop across four CLIs
// (jobdanmark alone has three in one file) — collapsed here to one core with
// per-caller options, which is the entire reason this module exists. The backoff cap
// is 8000ms uniformly; upstream disagrees with itself (jobdanmark and jobbank cap at
// 5000, linkedin and freehire at 8000) and 8000 is the value our contract pins.
// ADDED, none of which upstream has: `Retry-After` is honoured on a 429 and overrides
// the computed backoff (bounded, so a hostile header cannot park an Edge Function);
// a concurrency cap, because we poll many boards where upstream polled one; a
// configurable timeout in place of a hard-coded 15000; and Cloudflare/WAF detection
// moved INSIDE the loop so a challenge served as 429 or 503 raises an actionable
// error immediately instead of burning all seven attempts on identical challenge
// pages. 404 handling is caller-chosen rather than baked in — upstream varies it per
// adapter (null / "" / throw / raw Response) and every one of those is right for its
// own caller. Node-only surfaces are dropped: `process.stderr.write` (writeError) and
// the `node-html-parser` import, neither of which can cross into Deno, and the latter
// of which would touch a single-owner lockfile.
```

Keep the first line **exactly** as written — it is the licence notice.

---

## 9. Definition of done

- [ ] The module exists under `supabase/functions/_shared/http/` and **exports a
      documented API** — every export has a comment saying why it exists and what
      decision it encodes. Suggested (not mandatory) layout, all inside the partition:
      `transport.ts` (the core loop), `errors.ts` (`HttpError`, `BotProtectionError`),
      `concurrency.ts` (the semaphore), `retry-after.ts` (header parsing),
      `index.ts` (the public surface), plus `*.test.ts` alongside.
- [ ] All imports use explicit `.ts` extensions. No `node:` imports and no `Deno.*` in
      any non-test file. (`node:test` / `node:assert/strict` in `*.test.ts` is correct
      and expected — those files are excluded from `deno check`.)
- [ ] Every statement, declaration and block carries a *why* comment; density matches
      `ats/registry.ts` (≥ 1 comment line per code line).
- [ ] Tests cover **at minimum** these four cases:
  - [ ] **7-attempt exhaustion** — persistent 500, `calls === 7`, rejects matching `/500/`
  - [ ] **4xx does not retry** — a 400, `calls === 1`, rejects matching `/400/`
  - [ ] **429 then 200** — `calls === 2`, resolves with the body
  - [ ] **timeout signal present** — `init.signal instanceof AbortSignal` on the fetch init
  - [ ] plus, for the four additions: `Retry-After` overrides the computed delay;
        the concurrency cap never exceeds `maxConcurrent` in flight; a Cloudflare
        challenge body throws `BotProtectionError` with `calls === 1`; the 404 option
        produces throw / null / empty as selected and never retries.
- [ ] **No new dependency.** `pnpm-lock.yaml` unchanged, no `package.json` created or
      edited anywhere.
- [ ] **No file outside `supabase/functions/_shared/http/**` modified** — including
      the six forbidden paths in §0.

### The typecheck command — a correction you need

The parcel brief says "`pnpm --filter ... typecheck` passes". **That command cannot
work for this directory, and you should not spend time trying to make it.**
`supabase/functions` is deliberately *not* a pnpm workspace member: it has no
`package.json`, it is not matched by `pnpm-workspace.yaml`, and the root
`package.json` documents this at length (it is a Deno project with its own
`deno.json` and `deno.lock`; adding a `package.json` would put two dependency
managers over one directory). Use these instead:

```bash
# Type-check the shipped module under Deno (test files are excluded by deno.json).
deno check supabase/functions/_shared/http/*.ts

# Run YOUR tests only, while iterating.
node --test "supabase/functions/_shared/http/*.test.ts"

# Run every function test, the way the root script does — confirm you broke nothing.
node --test "supabase/functions/**/*.test.ts"
```

`deno` is on PATH on this machine. If `deno check` is unavailable in your shell, say
so in your report rather than silently skipping it — do **not** add a tsconfig or a
package.json to work around it, both would be outside the partition.

---

## 10. Loop-engineering exit checklist — run this BEFORE you say "done"

Do not declare completion from intent. Each step produces evidence; paste the real
evidence into your report.

1. **Run the tests and paste the real output.** Not a summary, not "tests pass" — the
   actual terminal output including the pass/fail counts:
   ```bash
   node --test "supabase/functions/_shared/http/*.test.ts"
   ```
2. **Run the full function suite** to prove you did not break a neighbour:
   ```bash
   node --test "supabase/functions/**/*.test.ts"
   ```
3. **Type-check:**
   ```bash
   deno check supabase/functions/_shared/http/*.ts
   ```
4. **Prove the partition held.** Run and read it:
   ```bash
   git status --short
   ```
   The **only** new or modified paths attributable to you must be under
   `supabase/functions/_shared/http/`. You will also see pre-existing modifications
   from other sessions — `.gitignore`, `apps/web/src/features/...`,
   `supabase/functions/scout-ats/index.ts`, `worker/src/cli/scout.ts`, `docs/harvest/`.
   **Those are not yours. Leave them completely alone.** Do not stage them, do not
   revert them, do not "clean up" the tree. If anything of yours appears outside the
   partition, fix that before anything else.
5. **Confirm the lockfile is untouched:**
   ```bash
   git status --short pnpm-lock.yaml package.json
   ```
   Both must print nothing.
6. **Before any commit, confirm what is staged:**
   ```bash
   git add supabase/functions/_shared/http
   git diff --cached --name-status
   ```
   Read that output. Only your partition may appear. Then commit **with the explicit
   pathspec** — the pathspec is the safety mechanism, because several sessions share
   one index and a peer's `git add` landing while you compose a message would
   otherwise be swept into your commit:
   ```bash
   git commit -m "feat(http): shared transport with retry, backoff and timeout" -- supabase/functions/_shared/http
   ```
   **Never** `git add -A`, `git add .`, or `git commit -a`. **Never** `git stash` —
   it yanks other sessions' in-flight work. **Never** `git checkout -- <file>`
   outside your partition.
7. **Report honestly.** If a case is untested, say which. If `deno check` could not
   run, say so. A "done" that turns out to be partial costs the orchestrator more
   than a "done except X" — and past-tense claims about work still outstanding are
   the single most expensive failure mode in a multi-session run.

---

## 11. Notes the orchestrator flagged, worth your attention

- **Upstream's cap disagrees with itself** (5000 vs 8000 across the four files). Our
  contract is 8000. Already handled in §3 and in the attribution text — do not
  "correct" it back to 5000 when you see it in the quoted jobdanmark source.
- **Upstream's `writeError` uses `process.stderr.write`** — Node-only. Not portable,
  not ported. If the module needs to surface diagnostics, throw a typed error and let
  the caller decide how to report it; the Edge Function and the worker log differently.
- **jobbank imports `node-html-parser`** — a dependency, and the lockfile is
  single-owner. Not ported.
- **Upstream has no tests for the linkedin / freehire / jobbank variants at all** —
  only jobdanmark is tested. Every behaviour you take from the other three (fail-fast
  on connection error, the 8000 cap, Cloudflare detection) arrives **unpinned**. Your
  tests are the first ones those behaviours will ever have; write them deliberately
  rather than assuming upstream validated them.
