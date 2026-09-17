# The robots.txt compliance gate — design, deviations and evidence

**Package:** `packages/master-robots` (`@applyy/master-robots`)
**Written:** 2026-09-17 by `applyyy-85`, under orchestration by `applyyy-e3`.
**Ported from:** `github.com/MadsLorentzen/ai-job-search` @ `968fb1bd`, MIT, © 2026
Mads Lorentzen. Cloned at `reference/ai-job-search-upstream`, gitignored, **never
vendored**. Ideas ported; no code copied.
**Briefing packet:** [`docs/harvest/briefs/brief-4-robots-gate.md`](../harvest/briefs/brief-4-robots-gate.md).
Two of its specifications were overridden — see [Defects in brief-4](#defects-in-brief-4).

---

## 1. Why this package exists

PROJECT_PLAN.md constraint #5: *"DON'T bypass CAPTCHAs, MFA, authentication controls,
robots restrictions, or anti-bot mechanisms."*

Until now that constraint was enforced by a hand-maintained allowlist in
`worker/scripts/capture-fixture.ts`, where a human read each host's robots.txt and
recorded the finding in a comment beside the hostname. That is honest and it works,
but it is **one call site carrying a rule the whole system needs**. A comment is not
a control. This package is the control: one function every fetch path can cross.

The intended first consumer is `capture-fixture.ts` itself, which should call the gate
rather than carry its own copy of the rule. That is a follow-up parcel for whoever
owns `worker/`; the public API was shaped to make that call trivial.

---

## 2. The governing design rule

> **Make the wrong answer unrepresentable, not merely detected.**

The failure class this package exists to prevent is *missing or malformed data
becoming an answer*. Sharper: **the permissiveness of the reader is the fail-open.** A
guard written as "did the parser fail?" inherits the parser's eagerness to succeed —
a lenient parser that finds nothing has not failed, so the guard passes.

Four places that principle is applied structurally rather than by checking:

| Hazard | Structural closure |
|---|---|
| Soft-200 HTML error page parses to zero rules → "allow all" | A body failing the shape check **never becomes a `Ruleset`**, empty or otherwise. There is no constructor for it. |
| "No policy published" merged with "we couldn't tell" | `definitively-absent` and `indeterminate` are **separate union arms**, so the two cannot be collapsed into one `NOT_FETCHED` and silently flip 404's verdict. |
| A new source state defaulting to allow | `verdictFor()` is **total over the union** with a `never` exhaustiveness check. A new arm fails to *compile* until someone rules on its verdict. |
| A caller omitting the user-agent and getting a permissive answer | `productToken` is **required with no default** — omission is a compile error, not a runtime verdict. |

A default user-agent would have been a fail-open with extra steps: the omitting caller
still gets an answer, the answer is the permissive one, and nothing raises.

---

## 3. The decision table

| What the host said | `RobotsSource` | Verdict | Why |
|---|---|---|---|
| 200 + valid robots.txt | `policy` | per rules | Normal path. |
| 200 + empty / whitespace / all-comments body | `policy` (zero rules) | **allow** | RFC 9309: an empty ruleset permits everything. |
| 200 + HTML/JSON/markup body | `not-robots-txt` | **refuse** | The soft-200. Never parsed, never a ruleset. |
| 404, 410 | `definitively-absent` | **allow** | A successful answer meaning "I publish no policy". |
| 401, 403 | `refused-by-host` | **refuse** | **Deviation from RFC 9309** — see §4. |
| 429, `Retry-After` ≤ 5s | `rate-limited` | **wait** | Short enough to honour. |
| 429, `Retry-After` > 5s, absent, or unreadable | `indeterminate` | **refuse** | Unknown when to return; we do not invent a delay. |
| 5xx | `indeterminate` | **refuse** | RFC 9309 assigns *meaning* to a 5xx on robots.txt ("unavailable"), not transience. Not retried. |
| 3xx not followed | `indeterminate` | **refuse** | Following across origins would apply another host's policy. |
| Timeout, DNS failure, thrown fetch | `indeterminate` | **refuse** | Never learned the policy. |
| Unparseable target URL | — | **refuse** | Malformed input must not be the permissive path. |

### The 404/403 pair, which looks inconsistent and is not

Both are 4xx. They get opposite verdicts:

- **404 → allow.** The host *successfully answered*, and its answer was "I publish no
  policy." Absence of a restriction is permission.
- **403 → refuse.** The host answered "I am refusing you." That is the opposite fact.

RFC 9309 says *"4xx means allow all"* and so would grant us access on a 403 — **at
precisely the moment we have been actively blocked**, which is when a WAF returns one.
A refusal would become a permission.

The principle that makes these **one rule rather than two exceptions**:

> **Read what the host actually *said*, not what class its number falls in.**

That same principle is why 404 does **not** fail closed. Refusing on 404 would refuse
the majority of the web, since most sites publish no robots.txt. *Safety that halts the
system is not a stricter setting — it is a different product.*

**Ruling history:** the orchestrator's initial briefing said "unknown or unfetchable
means refuse", which would have caught 404. Flagged as over-broad, and the ruling was
revised to allow on 2026-09-17 on the definitive-vs-indeterminate distinction above.

---

## 4. The six deliberate deviations

| # | Deviation | From | Reason |
|---|---|---|---|
| 1 | **403 → refuse** | RFC 9309 ("4xx = allow all") | A WAF 403 read through the RFC grants permission exactly when we were blocked. See §3. |
| 2 | **Equal-length tie → Disallow** | RFC 9309 (tie → least restrictive) | When a site writes two equally specific contradicting rules its intent is genuinely ambiguous; resolving an ambiguity in our own favour is the wrong way to be wrong. Kept from upstream. |
| 3 | **Shape-based soft-200 check, not rule-count** | upstream `is_robots_body()` | Upstream's rule refuses a valid all-comments policy. See §5 — this is the most consequential deviation in the package. |
| 4 | **No browser-User-Agent fallback on refusal** | upstream `gate()` | Upstream re-fetches robots.txt as a browser when the honest request is refused. That defeats the site's refusal and is exactly what constraint #5 names. **Must never be added.** |
| 5 | **5xx not retried** | our own shared transport's defaults | RFC 9309 assigns meaning to a 5xx on robots.txt rather than treating it as transient. `transport.ts:27–34` anticipated this package by name and made its retry policy injectable for it. |
| 6 | **Per-host TTL cache + crawl-delay** | not in upstream at all | The gate runs before *every* outbound fetch; an uncached gate doubles our request count against every host, which is itself impolite. |

**Two independent derivations of deviation #4.** `worker/scripts/capture-fixture.ts:63`
already records, at its own fetch site and written by a different session, that
"Spoofing a UA to look like a human is an anti-bot circumvention and breaks constraint
#5." Two sessions reaching the same rule from the same constraint independently is
stronger support for it than any single ruling.

---

## 5. The finding: upstream's soft-200 defence would refuse a host we have verified

Upstream defends the soft-200 with `is_robots_body()`, which asks *"does any line look
like a directive?"* Executed on 2026-09-17 against five bodies:

```
empty                                          is_robots_body=True   allowed(/x)=True
whitespace only                                is_robots_body=True   allowed(/x)=True
comments only (job-boards.greenhouse.io shape) is_robots_body=False  allowed(/x)=True
html error page                                is_robots_body=False  allowed(/x)=True
real policy                                    is_robots_body=True   allowed(/x)=True
```

**Read row 3 against row 4.** A robots.txt whose rules are all commented out scores
*identically* to an HTML error page. Upstream refuses both.

That matters because `worker/scripts/capture-fixture.ts:31` records, as a
human-verified fact checked 2026-09-09:

```
// robots.txt has every rule commented out, so nothing is disallowed. Checked 2026-09-09.
'job-boards.greenhouse.io',
```

A verbatim port turns a host we confirmed permits us into a refusal. That is not
caution; it is a false negative against a published, permissive policy.

**Upstream also contradicts itself here**, and we should not inherit the bug: its own
`allowed()` treats a comments-only body as allow-all (row 3, right column), while
`is_robots_body()` rejects that body before `allowed()` is ever consulted — so
`gate()` only ever sees the strict half.

### The fix: discriminate on syntax, not rule count

The fail-open is **not** "zero rules". It is **"the body is not robots.txt syntax at
all"**. Those were conflated because both produce zero rules.

```
valid robots.txt ::= every non-blank, non-comment line is a `field: value` directive
not robots.txt   ::= any non-blank, non-comment line that is not  →  REFUSE
```

An all-comments file has no such lines and passes **vacuously** — the one vacuous pass
in this package, and it is correct because RFC 9309 genuinely says an empty ruleset
permits everything. An HTML page fails on its first line.

Three layers, since the first is host-controlled:

1. `Content-Type` of html/xhtml/xml on `/robots.txt` → refuse.
2. Body whose first non-whitespace character (after BOM stripping) is `<` → refuse.
3. Every non-blank, non-comment line must be `field: value`, with the field a real
   token. The token requirement is what rejects `{"error":"not found"}` — that line
   *has* a colon, so a naive "contains a colon" check would admit a JSON error page.

Unknown *fields* are tolerated (RFC 9309 says to ignore them), so a future directive
cannot be mistaken for an error page.

**This is pinned by a named regression test**, verified red-green: reverting the shape
check to upstream's rule-count guard fails exactly two tests, both naming the host.

---

## 6. Defects in brief-4

Both overridden with the orchestrator's approval. Recorded so the next reader of the
brief sees why the shipped API differs.

**A — the proposed return type reintroduces the fail-open** (brief-4 §7, lines 972–988):

```ts
export interface RobotsDecision {
  /* The only field a caller may branch on. */
  readonly allowed: boolean;
  /* Human-readable WHY, for the log line. Never parsed by callers. */
  readonly reason: string;
  readonly crawlDelayMs: number | null;
}
```

A boolean cannot distinguish *"allowed because the policy permits this path"* from
*"allowed because we could not tell"*. The brief mitigates by making unknown → `false`,
which is fail-closed **in value** but destroys the distinction **in type** — and since
`reason` is documented as never parsed, the boolean is the only machine-readable
output. A future contributor has nothing stopping them.

Shipped instead: a discriminated `RobotsVerdict` with a `kind`, and **deliberately no
convenience `allowed` boolean** — the moment one exists, every caller branches on it
and the union becomes decoration rather than a control.

**B — the proposed fetch seam cannot express a defence the design requires**
(brief-4 §0.3, lines 103–110):

```ts
export interface RobotsFetcher {
  (url: string, init: { signal: AbortSignal; headers: Record<string, string> }):
    Promise<{ readonly status: number; text(): Promise<string> }>;
}
```

The response exposes `status` and `text()` and nothing else — **no headers**. The
`Content-Type` check in §5 is unimplementable against it. Shipped seam widens the
response side with a minimal read-only `headers.get()`, not the whole `Response` (see
§8 for why not).

---

## 7. The user-agent: four tokens, and a ruling

Recon found **four distinct production user-agents**, not one:

| User-Agent | Sites |
|---|---|
| `applyy-scout/1.0 (+https://github.com/MallamTeja/applyyy)` | `_shared/http/transport.ts:50`, `scout-ats/index.ts:214`, `worker/src/cli/scout.ts:154` |
| `applyy-remote-scout/1.0` | `worker/src/cli/scout-remote.ts:65,94,122` |
| `applyy-browser/1.0` | `apps/web/src/data/discoveryService.ts:182–184` |
| `applyy-fixture-capture/0.1 (personal job-search tool; read-only)` | `worker/scripts/capture-fixture.ts:65` |

**This is why `productToken` is required with no default.** A default would have been
wrong at three of the four call sites — not merely risky. If a future contributor
removes the requirement "for convenience", that is the fail-open returning.

### Product token ≠ User-Agent header

RFC 9309 matches the **product token** (`applyy-scout`), not the header. Passing a full
header where a token is expected makes every named-group comparison fail, selection
falls through to `*`, and **nothing throws** — a silent fail-open no test catches unless
written deliberately. There is such a test. `tokenFromUserAgentHeader()` is the
supported conversion, and it returns `null` rather than guessing.

### Teja's ruling on `jobs.lever.co` — 2026-09-17

`PROJECT_PLAN.md` §19 records `jobs.lever.co/robots.txt` carrying
`User-agent: ClaudeBot` → `Disallow: /`, respected since 2026-09-09.

None of our four tokens is `ClaudeBot`, so strictly the rule is not addressed to the
token we present. That tension was put to Teja rather than resolved by any session,
since §19 states revisiting the exclusion is his call and nobody else's.

**Ruled 2026-09-17: honour the ClaudeBot Disallow regardless of which token we
present.** `jobs.lever.co` stays excluded; we lose it as a source and that is accepted.
The reasoning matched §19's own: a Claude-driven agent fetching Lever content is what
that line asks us not to do, and *choosing a token in order to escape a Disallow is the
same move as presenting a browser UA past a WAF* — which constraint #5 names.

Recorded as a **revisit that came out the same way**, not an assumption carried forward.

**This is a caller-side policy and is deliberately NOT hardcoded into the package.**
The gate implements RFC 9309 group matching; the ruling layers on top as a one-line
caller rule. Hardcoding it would bury a product decision inside a mechanism.

---

## 8. Dependencies — deliberately none

`packages/master-robots/src` takes **zero runtime dependencies on workspace packages**,
and this is load-bearing rather than tidiness:

> It is what lets `node --test` run this package **today**, with an empty root
> `node_modules` and no install.

The moment a workspace dependency is added, the tests stop running without a
lockfile-touching install, and the gate guarding every outbound fetch becomes the
hardest package in the repo to check. The fetch transport is an **injected structural
seam**, not an import, specifically so this stays true.

**One cross-tree import**, in `src/fetch.ts`:

```ts
import { parseRetryAfterMs } from '../../../supabase/functions/_shared/http/retry-after.ts';
```

*Reused rather than copied.* That function already defends the trap where
`Date.parse("-5")` is **not** `NaN` — it is the year −5, which floors to a 0 ms delay and
turns a garbage header into "retry immediately". It shape-checks for an ASCII letter
before reaching `Date.parse`, is pure, takes its clock as a parameter, and has 14 tests
behind it. A second implementation would be a second place that trap can regress, and
the copy is always the one nobody re-tests. This repo argues the identical point in
`packages/master-pdf/package.json` about `master-ingest`'s text folds.

**Precedent note:** no `packages/*` package has reached into `supabase/functions`
before. `worker/src/cli/scout.ts:9` and `scout-remote.ts:10` set the cross-tree idiom;
this is the first from a package, and it is deliberate, confined to one
dependency-free pure function, and a relative path rather than a package dependency —
so it adds nothing to install.

**Why only `retry-after.ts` and not `transport.ts`:** `transport.ts:133` declares
`readonly redirect?: RequestRedirect`, and `RequestRedirect` is not a global under this
package's `lib: ["es2023"]` + `types: ["node"]`. Importing it fails typecheck with
TS2304 unless `"DOM"` is added to `lib`, dragging the whole DOM global surface into a
package that never touches a document.

---

## 9. Verification — what was actually run, and what was not

**Everything below was executed on 2026-09-17. Nothing here is inferred.**

| Check | Command | Result |
|---|---|---|
| Package tests | `node --test "packages/master-robots/test/**/*.test.ts"` | **76 pass, 0 fail**, 17 suites |
| No regression elsewhere | `node --test "supabase/functions/**/*.test.ts"` | **430 pass, 0 fail** |
| Typecheck | `tsc --noEmit -p tsconfig.json --typeRoots ../master-pdf/node_modules/@types` | **exit 0, no output** |
| Typecheck non-vacuity | `--listFiles \| grep -c master-robots` | **11 files**, and a deliberately injected `TS2322` **was caught**, then reverted and re-verified clean |
| Regression red-green | Reverted the shape check to upstream's rule-count guard | **Exactly 2 tests failed**, both named `REGRESSION job-boards.greenhouse.io`; restored → 76/76 |

### What I could NOT verify, stated plainly

- **`pnpm install` was never run** — the lockfile is single-owner and four other
  sessions were active. So `packages/master-robots/node_modules` does not exist, and
  **`pnpm run typecheck` / `pnpm run test` inside the package have never executed.** The
  `package.json` scripts are written to match the house convention exactly but are
  **unproven**.
- **The typecheck borrowed `@types/node` from `packages/master-pdf`** via `--typeRoots`.
  That proves the *source* typechecks; it does **not** prove the package resolves its own
  types once installed.
- **The package is not linked into the workspace.** It will not appear in
  `pnpm -r run test` or `pnpm run typecheck` until an install is scheduled.
- **No live network request was ever made.** Every fixture is synthetic and labelled;
  the Lever body is hand-authored from §19, *not* captured — fetching it is the exact
  act §19 declined to perform, and a live fetch in CI would itself crawl a host that
  has told us not to.
- **The Lever test proves the mechanism handles the rule as documented.** It is not
  evidence about the rest of Lever's live file, which we have never read.

### Comment density, measured

Source files, comment:code, house floor ≥ 1.00 — **all pass**:
`index.ts` 3.14 · `shape.ts` 2.49 · `types.ts` 2.27 · `match.ts` 1.59 · `fetch.ts` 1.28 ·
`parse.ts` 1.10 · `gate.ts` 1.02

Test files, against the repo's observed 0.69–0.83 band — **below band, reported rather
than padded**: `rules.test.ts` 0.59 · `shape.test.ts` 0.50 · `gate.test.ts` 0.43
(fixtures 1.03). Further comments here would have restated test names rather than
explaining why a test exists, which is the "what, not why" the rule prohibits.

---

## 10. Follow-ups for other owners

1. **`worker/scripts/capture-fixture.ts` should call this gate** rather than carry its
   own `ALLOWED_HOSTS` copy of the rule. Outside this parcel's partition.
2. **`transport.test.ts` carries a `describe` block named "the retry policy is
   injectable — the seam `master-robots` needs"**, testing a 429-only policy against a
   `/robots.txt` URL. That caller is not arriving in that shape. The seam is still
   correct, but the *name* now asserts something false, and a test name that lies is
   worse than no test.
3. **`PROJECT_PLAN.md` §3 is six days stale on git authority** — it still reads "Peers
   NEVER `git commit`. Peers NEVER `git push`" and "absolute", superseded by
   `~/.claude/CLAUDE.md` (authority granted 2026-09-10 for `applyyy`, widened
   2026-09-11). Routed to the orchestrator; in nobody's partition.
4. **Schedule the install** that links `@applyy/master-robots` into the workspace, and
   re-run `pnpm run typecheck` and `pnpm run test` inside the package to close the
   verification gaps in §9.
