# Brief 4 — Programmatic robots.txt Gate (`@applyy/master-robots`)

> **Status 2026-11-08:** Shipped (4ca08ef) as `packages/master-robots/` (`checkRobots` in `src/gate.ts`). It gates discovery (`scout-ats/poll-fetch.ts`, `scout-ats/page-fetch.ts`, `scout-web/fetch-board.ts`) and, since a3b4115, the apply page (`worker/src/apply-one.ts`). The 2026-11-01 ruling turned SmartRecruiters OFF, treats an Ashby robots 401 as no rules for board reads, and lets a pasted link skip robots. Current truth: [docs/robots/](../../robots/) and the code. The body below is the original record, unedited.

**Audience:** a peer Claude session starting with an EMPTY context window.
Everything you need is in this file. You cannot ask questions. Do not go
looking for the orchestrator.

**Repo:** `C:\Users\tejam\OneDrive\myproj\applyyy` (three y's in the FOLDER
name; the npm scope is `@applyy`, TWO y's — see "Package skeleton" below).

---

## 0. Read this section before you touch anything

### 0.1 Your write partition — the ONLY files you may create or modify

```
packages/master-robots/**
```

That is the whole partition. Everything you write lives under it.

### 0.2 Files that are FORBIDDEN to you (owned by other concurrent sessions)

```
worker/scripts/capture-fixture.ts
worker/src/cli/scout.ts
supabase/functions/scout-ats/index.ts
apps/web/**
pnpm-workspace.yaml
.gitignore
PROJECT_PLAN.md
pnpm-lock.yaml          <- SINGLE-OWNER, see 0.3
```

Five sessions share ONE working tree, ONE index and ONE `.git`. Writing
outside your partition destroys a peer's in-flight work. This has already
cost this project 392 lines of a project plan once.

Note especially: you are porting a gate that `capture-fixture.ts` will
eventually consume, but you **do not wire it in**. That integration belongs
to the session that owns `worker/`. Your job ends at "the package exists,
is tested, and typechecks."

### 0.3 The dependency rule — ZERO runtime dependencies

`pnpm-lock.yaml` is single-owner. You do not own it. Therefore:

> **`@applyy/master-robots` must declare ZERO runtime dependencies.**
> Node stdlib and WHATWG globals only: `fetch`, `URL`, `URLSearchParams`,
> `decodeURIComponent`, `AbortSignal.timeout`, `RegExp`.
> `devDependencies` may contain only `@types/node` and `typescript`, both
> of which are already in the lockfile at the versions shown in §7.

Adding a runtime dep rewrites a file you do not own, and the install will
diverge for four other sessions.

**The pattern you must follow, and cite, is the STRUCTURAL TYPE SEAM.**
`packages/master-pdf` needed `pdfjs-dist` and refused to declare it. Read
`packages/master-pdf/src/load-pdf.ts` — its header is the canonical
statement of the technique in this repo:

```
/* The one impure function in this package: PDF bytes in, plain snapshot out.
 *
 * WHY THIS PACKAGE DECLARES NO DEPENDENCY ON pdfjs-dist, which looks like an
 * omission and is a decision. Three reasons, in descending order of how much
 * they would have cost:
 *
 *   1. `pnpm-lock.yaml` is a SINGLE-OWNER file in this repo, with five sessions
 *      sharing one working tree. Adding a dependency here rewrites it from a
 *      session that does not own it. ...
 *   2. The parse runs browser-side, and a browser, a Deno Edge Function and the
 *      Node test runner each load and configure pdfjs differently ... Those are
 *      all the CALLER's environment, not this package's business.
 *   3. Everything except this file stays testable without a PDF at all.
 *
 * The structural type below is the mechanism: TypeScript checks the shape of
 * whatever module is passed in, so we get type safety against pdfjs's real API
 * without importing pdfjs's types. If pdfjs changes that shape, this stops
 * compiling at the call site - which is the same protection a real import would
 * have given, minus the lockfile write.
 */
```

and the seam itself:

```ts
export interface PdfjsLike {
  getDocument(parameters: { data: Uint8Array }): {
    readonly promise: Promise<PdfDocumentLike>;
  };
}
```

**Your equivalent:** the one impure function in your package is the network
read of `/robots.txt`. Define a structural `RobotsFetcher` type, accept an
injected fetcher in `options`, and default it to global `fetch`. That gives
you: (a) zero deps, (b) point 3 above — *everything except the fetch is
testable with no network at all*, which matters enormously because this
repo's CI policy is **no live portal requests, ever**. Every upstream test
is offline and yours must be too.

```ts
/* The slice of fetch's surface this package actually uses. Deliberately
   minimal ... */
export interface RobotsFetcher {
  (url: string, init: { signal: AbortSignal; headers: Record<string, string> }):
    Promise<{ readonly status: number; text(): Promise<string> }>;
}
```

Tests inject a fake. Production passes nothing and gets global `fetch`.

### 0.4 THE COMMENT RULE — NON-NEGOTIABLE, READ IT TWICE

> **Every statement, every declaration and every block carries a comment
> saying WHY it is there — not what it does.** Structural lines (`}`, blank
> lines, closing tags) are the only exception. Calibration target: **at
> least one comment line per code line.**

This is not a style preference and it is not negotiable down. Teja learns
from worked examples in his own code; a bare line teaches nothing when he
reads it back six weeks later. Retro-commenting is a second pass nobody
budgets for, so you write the comments **as you write the code**.

"What" comments are worse than none. `// loop over the rules` is noise.
`// Longest match wins, so we cannot early-exit: a later, shorter Allow must
// not beat an earlier, longer Disallow.` is the bar.

**Read `packages/master-pdf/src/layout.ts` before you write a line** — that
is the voice and the density. Two excerpts for calibration:

```ts
/* Two items belong to one line when their baselines sit within this many points.
 *
 * NOT ZERO, AND THE REASON IS MEASURED. A bullet glyph is set in a different
 * face from the text it introduces and its baseline lands about 0.2pt off -
 * already recorded in master-ingest's README as the reason a naive
 * exact-equality y-grouping followed by an x-sort INVERTS the bullet and its own
 * text. Exact comparison on floating-point coordinates emitted by a typesetter
 * is the plausible wrong design: it works on most lines, fails only on lines
 * with mixed faces, and the failure reads like a parser bug rather than a
 * tolerance bug.
 */
export const LINE_BAND_TOLERANCE_PT = 3;
```

```ts
  /* Distance from the TOP of the page, which is the only vertical measure a
     human can act on - nobody thinks in upward-growing coordinates. Reported,
     never compared. */
  readonly fromTop: number;
```

Note the shape: a block comment naming the *decision* and the *plausible
wrong alternative*, then the code. Do that throughout, including in the
tests and in `package.json` (this repo comments JSON via `"// key"` sibling
entries — see §7).

### 0.5 Language lock

**Node + TypeScript everywhere. Python is FORBIDDEN in this repo.** The
source material below is Python. You are reading it as a *specification*,
not as code to copy. Do not create a `.py` file anywhere, do not shell out
to `python3`, do not leave Python in a fixture.

---

## 1. Why this parcel exists

Project `applyyy` is an autonomous job-application system. It has seventeen
hard constraints. **Constraint #5:**

> "DON'T bypass CAPTCHAs, MFA, authentication controls, robots restrictions,
> or anti-bot mechanisms."

**Today, robots.txt compliance in this repo is a HAND-MAINTAINED ALLOWLIST.**
From `worker/scripts/capture-fixture.ts:26-34` (a file you MUST NOT edit —
quoted here so you understand the current state you are replacing):

```ts
// Hosts whose robots.txt has been read and permits fetching job pages. Adding a
// host here is a deliberate act that requires re-reading its robots.txt first.
const ALLOWED_HOSTS = new Set([
  // robots.txt disallows only /embed/; job pages are permitted. Checked 2026-09-09.
  'boards.greenhouse.io',
  // robots.txt has every rule commented out, so nothing is disallowed. Checked 2026-09-09.
  'job-boards.greenhouse.io',
]);
```

and the enforcement point at `:98-101`:

```ts
  // The allowlist is the robots.txt enforcement point. A host nobody has
  // checked cannot be fetched by accident.
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`host not in ALLOWED_HOSTS (robots.txt unreviewed): ${parsed.hostname}`);
  }
```

That design is **honest and correct** — it fails closed, and the dated
comments are real evidence. It simply does not scale. `PROJECT_PLAN.md §13`
says sustaining application volume needs **200–400 job boards**. A human
reading 400 robots.txt files, and re-reading them as they change, is not a
plan.

**The parcel:** a programmatic robots.txt gate as a new workspace package,
`packages/master-robots`. Same fail-closed posture as the allowlist, but
derived from the live policy file instead of from a human's memory.

**Design note you should internalise:** this package does not *relax* the
allowlist, it *mechanises* it. Every place the hand allowlist would have
said "I have not checked this host", the gate must say `allowed: false`. If
you ever find yourself writing a branch that ends in "…so we'll assume it's
fine", you have written a bug.

---

## 2. Source material — the full upstream Python, quoted

**Provenance:** `MadsLorentzen/ai-job-search`, pinned at commit
`968fb1bd`. Licence **MIT, © 2026 Mads Lorentzen**. Vendored in this repo at
`reference/ai-job-search-upstream/tools/robots_check.py` (142 lines) with
tests at `reference/ai-job-search-upstream/tests/test_robots_check.py`.

### 2.1 `tools/robots_check.py` in full

```python
#!/usr/bin/env python3
"""Decide whether the browser-header curl retry in 09-web-research.md may run.

The retry exists to get past bot-filtering firewalls on sites whose robots.txt
permits access. It is never used to override a site that has said no.

WebFetch identifies itself as Claude-User and honors robots.txt, so a 403 has
two very different causes: a WAF default on a site whose published policy
allows access, or a site that has actually declined. This tells them apart.

Rules implemented (RFC 9309), deliberately on the cautious side:
  * longest-match wins; on equal specificity Disallow wins
  * a Disallow for either "*" or "Claude-User" blocks the retry
  * blank lines inside a record do not end it (Python's robotparser drops
    rules in that case, which fails open - see tests)
  * 404 means no published policy, which is permission
  * any other failure to read robots.txt leaves permission unconfirmed,
    and the retry does not happen

Usage:  python3 tools/robots_check.py <url>
Exit 0 = the retry may proceed. Exit 1 = do not retry; go to escalation step 3.
"""

import re, subprocess, sys
from urllib.parse import urlsplit, unquote

BROWSER = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
           '(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36')

def _fetch(url, ua):
    """curl, not urllib: some hosts (jobup.ch) hang urllib indefinitely while
    answering curl in under a second, and --max-time is a hard ceiling."""
    # "--" terminates option parsing, so a URL beginning with a dash can never
    # be read by curl as a flag. gate() rebuilds the target as
    # scheme://host/robots.txt before calling here, so this is hardening for
    # direct callers rather than a hole in the gate path itself.
    r = subprocess.run(
        ['curl', '-sS', '-L', '--max-redirs', '5', '--max-time', '12', '-A', ua,
         '-H', 'Accept: text/plain,*/*', '-w', '\n%{http_code}', '--', url],
        capture_output=True, text=True, timeout=20)
    if r.returncode != 0:
        raise RuntimeError('curl exit %d' % r.returncode)
    body, _, code = r.stdout.rpartition('\n')
    return body, int(code or 0)


def is_robots_body(text):
    """Does this actually look like a robots.txt?

    A misconfigured host can answer /robots.txt with 200 and an HTML error page.
    That body parses to zero rules, and zero rules read as "allowed" - so a
    soft-200 granted permission that was never given. An empty or whitespace-only
    body IS a valid allow-all under RFC 9309 and stays allowed; a non-empty body
    with no recognised directive is treated as unreadable.
    """
    if not text.strip():
        return True
    for raw in text.splitlines():
        line = raw.split('#', 1)[0].strip().lower()
        if ':' in line and line.split(':', 1)[0].strip() in (
            'user-agent', 'allow', 'disallow', 'sitemap', 'crawl-delay', 'host',
        ):
            return True
    return False

def _groups(text):
    """user-agent -> [(is_allow, pattern)], tolerating blank lines inside a record."""
    out, agents, expect = {}, [], True
    for raw in text.splitlines():
        line = raw.split('#', 1)[0].strip()
        if not line or ':' not in line:
            continue
        field, _, value = line.partition(':')
        field, value = field.strip().lower(), value.strip()
        if field == 'user-agent':
            if not expect:
                agents, expect = [], True
            agents.append(value.lower())
            out.setdefault(value.lower(), [])
        elif field in ('allow', 'disallow') and agents:
            expect = False
            for a in agents:
                out[a].append((field == 'allow', value))
    return out

def _match(pattern, path):
    """RFC 9309 wildcard match; returns match length or -1.

    The pattern is percent-decoded to match the already-decoded path. Without
    this, "Disallow: /foo%20bar" never matched "/foo bar" and the rule was
    silently skipped - a fail-open on any site that encodes its own rules.
    """
    if pattern == '':
        return -1
    pattern = unquote(pattern)
    rx = '^' + ''.join('.*' if c == '*' else ('$' if c == '$' else re.escape(c)) for c in pattern)
    return len(pattern) if re.match(rx, path) else -1

def allowed(text, agent, path):
    g = _groups(text)
    rules = g.get(agent.lower()) or g.get('*') or []
    best_len, best_allow = -1, True
    for is_allow, pat in rules:
        n = _match(pat, path)
        if n > best_len or (n == best_len and n >= 0 and not is_allow):
            best_len, best_allow = n, is_allow      # ties -> Disallow wins (cautious)
    return True if best_len < 0 else best_allow

def gate(url):
    parts = urlsplit(url)
    path = unquote(parts.path) or '/'
    if parts.query:
        path += '?' + parts.query
    robots = f'{parts.scheme}://{parts.netloc}/robots.txt'
    body, last = None, 'no attempt'
    for ua in ('Claude-User', BROWSER):
        try:
            text, code = _fetch(robots, ua)
        except Exception as e:
            last = type(e).__name__; continue
        if code == 404:
            return 0, 'ALLOWED - no robots.txt published'
        if code == 200:
            if not is_robots_body(text):
                last = 'HTTP 200 but the body is not a robots.txt'
                continue
            body = text; break
        last = 'HTTP %d' % code
    if body is None:
        return 1, 'UNCONFIRMED (%s) - do not retry, go to step 3' % last
    for a in ('Claude-User', '*'):
        if not allowed(body, a, path):
            return 1, f'DISALLOWED for {a} - do not retry, go to step 3'
    return 0, 'ALLOWED - robots.txt permits this path'

if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('usage: python3 tools/robots_check.py <url>', file=sys.stderr)
        sys.exit(2)
    rc, msg = gate(sys.argv[1])
    print(msg)
    sys.exit(rc)
```

### 2.2 Section-by-section: the LOGIC to port

You are writing TypeScript. Port the *behaviour*, not the shape. Suggested
module split under `packages/master-robots/src/`:

| Upstream | Your TS | Purity |
|---|---|---|
| `is_robots_body` | `isRobotsBody(text): boolean` in `parse.ts` | pure |
| `_groups` | `parseGroups(text): RobotsGroups` in `parse.ts` | pure |
| `_match` | `matchLength(pattern, path): number` in `match.ts` | pure |
| `allowed` | `isPathAllowed(text, agent, path): boolean` in `match.ts` | pure |
| *(new)* | `parseCrawlDelayMs(text, agent): number \| null` in `parse.ts` | pure |
| `_fetch` | `fetchRobots(...)` in `fetch-robots.ts` — **the one impure file** | impure |
| `gate` | `checkRobots(url, userAgent, options)` in `check-robots.ts` | impure |
| *(new)* | TTL cache in `cache.ts` | impure (holds a clock) |
| — | `index.ts` re-exporting the public surface | — |

Keep the pure/impure split exactly as `master-pdf` does: one impure file,
everything else testable with literal strings and no network. That split is
what makes the offline-CI rule achievable rather than aspirational.

**`is_robots_body` — the soft-200 sentinel.** Strip everything after the
first `#`, trim, lowercase, and ask whether any line's field name (text
before the first `:`) is one of the six recognised tokens: `user-agent`,
`allow`, `disallow`, `sitemap`, `crawl-delay`, `host`. **A blank or
whitespace-only body returns `true`** — see Defence 2. A non-empty body with
no recognised directive returns `false`.

**`_groups` — the parser.** One pass over lines. Comment-strip, trim, skip
blank lines and lines with no `:`. Split on the FIRST colon only
(`partition` in Python; use `indexOf(':')` and two `slice`s in TS —
`String.prototype.split(':')` with no limit will destroy a `Sitemap:
https://…` line, and even with a limit it discards the rest, so do not use
it). Field name lowercased, value trimmed.

The state machine is the subtle part and it is the whole reason this
implementation exists rather than a stdlib one:

- `expect` starts `true`, meaning "we are in a run of `User-agent:` lines and
  the next agent line joins the same group."
- On `user-agent`: if `expect` is `false` (we have already seen rules for
  the current group), **start a fresh group** — reset the agent list and set
  `expect = true`. Then append this agent (lowercased) and ensure it has an
  entry in the map.
- On `allow` / `disallow`, only when at least one agent is active: set
  `expect = false` and append `(isAllow, rawValue)` to **every** currently
  active agent's rule list. Note: the pattern is stored **raw, not
  lowercased** — case matters in paths and only the field name was folded.

> **Why this state machine rather than a library.** Upstream's docstring:
> "blank lines inside a record do not end it (Python's robotparser drops
> rules in that case, which fails open - see tests)". The real body served by
> `privatebank.barclays.com` puts blank lines between `User-agent: *` and its
> rules; a record-separator-based parser drops every rule and `/cs/` reads as
> allowed. Node has no robots parser in stdlib anyway, but if you are tempted
> to reach for one: the fail-open mode above is exactly why upstream did not.
> That case is pinned in the upstream tests as `BARCLAYS` and **you must port
> that test**.

**`_match` — pattern to match length.** Empty pattern returns `-1` (no
match — `Disallow:` with no value means "disallow nothing"). Percent-decode
the pattern (Defence 3). Build a regex anchored at `^`: each character maps
to `.*` if `*`, to `$` if `$`, else to its escaped literal. Return
`pattern.length` on a match (the length of the DECODED pattern, since that
is the variable at that point in upstream), else `-1`.

TypeScript specifics:
- There is no `re.escape`. Write your own:
  `character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` applied per character,
  or a small escape helper. Comment *why* you are escaping per character
  rather than escaping the whole pattern — because `*` and `$` must survive
  as metacharacters while every other special character must not.
- `re.match` is anchored at the start only (Python's `match`, not
  `fullmatch`). `RegExp.prototype.test` is **unanchored**, so your `^` prefix
  is load-bearing — say so in a comment. Do not add a trailing `$`.
- `unquote` → `decodeURIComponent`, but it **throws** on a malformed escape
  (`%zz`) where Python's `unquote` passes it through. Wrap in try/catch and
  fall back to the raw pattern. A throw here must never become a crash that a
  caller catches into "allowed".

**`allowed` — rule selection and tie-break.** Look up the agent's group
(lowercased); if absent, fall back to the `*` group; if that is absent too,
an empty rule list. Then scan every rule keeping the best:

```python
        if n > best_len or (n == best_len and n >= 0 and not is_allow):
            best_len, best_allow = n, is_allow      # ties -> Disallow wins (cautious)
```

If nothing matched (`best_len < 0`), allow. Otherwise return the winner's
verdict. Note the `n >= 0` guard in the tie clause — without it two non-
matching rules at `-1` would "tie" and a Disallow would win against a path
it does not match. Port the guard and comment it.

**`gate` — the orchestrator.** Percent-decode the path, default `/` when
empty, append `?query` when present (robots patterns can match query
strings). Rebuild the robots URL from **scheme + host only** — never from the
caller's raw URL. Then fetch, classify the status, and finally check the
path against **both** the specific agent group and `*`.

> Upstream pins the URL-rebuild in a test named
> `test_gate_never_passes_the_caller_url_through_to_curl`, asserting the
> fetched URL for input `https://x.example/-o/evil?q=1` is exactly
> `https://x.example/robots.txt`. Port that test. It is cheap and it pins a
> property that is easy to break during a refactor.

### 2.3 The upstream test file — port these cases

`reference/ai-job-search-upstream/tests/test_robots_check.py` is offline by
policy:

> "No network: every case exercises the parser against literal robots.txt
> bodies, matching the repo's CI policy of making no live portal requests.
>
> The cases marked FAIL-OPEN REGRESSION are the ones Python's own
> urllib.robotparser gets wrong. They are pinned here because getting them
> wrong means the browser-header retry runs against a site that said no,
> which is the exact boundary this tool exists to hold."

Two fixture bodies to reuse verbatim:

```python
# Real body served by privatebank.barclays.com: blank lines sit between the
# User-agent line and its rules. Python's robotparser treats those as record
# separators and drops every rule, so /cs/ reads as allowed.
BARCLAYS = "User-agent: *\n\n\nAllow: /\n\nDisallow: /cs/\n\nSitemap: https://x/sitemap.xml\n"

# jobup.ch: the case a community fork was asked to ship opt-in.
JOBUP = "User-agent: *\nDisallow: /api/\n"
```

Cases to carry across (each one is a real behaviour, not a formality):

- blank lines inside a record do not end it → `/cs/` disallowed on `BARCLAYS`
- a sibling path on the same site is still allowed → `/careers/`
- longest match beats file order: `Allow: /` then `Disallow: /cs/` →
  `/cs/deep/page` disallowed
- longest match can UNBLOCK: `Disallow: /` then `Allow: /jobs/` → `/jobs/x`
  allowed, `/other` disallowed
- tie → Disallow, **in both orderings**. Upstream's own note on why the
  second ordering exists:
  > "The only ordering that exercises the tie-break clause: with Allow
  > first, deleting the clause makes the first rule at a given length win
  > and Allow would leak through. The Disallow-first sibling above cannot
  > detect that mutation (review finding F21, 2026-08-19)."
  That is mutation-testing reasoning. Port **both** or you have a test that
  passes with the defence deleted.
- wildcard and end-anchor: `Disallow: /*.pdf$` blocks `/files/cv.pdf`, allows
  `/files/cv.pdf.html`
- `Disallow:` with an empty value allows everything
- empty body and comment-only body allow everything
- inline comments are stripped: `Disallow: /x  # nope` still blocks `/x`
- agent selection: a named `Claude-User` opt-out is honoured while `*` still
  allows; agent matching is case-insensitive; absent agent falls back to `*`;
  consecutive `User-agent:` lines share one ruleset
- soft-200: HTML error page and JSON error body are both *not* a robots file;
  a soft-200 is UNCONFIRMED, not allowed
- a genuinely empty robots IS allow-all (`""` and `"\n\n   \n"`)
- a sitemap-only file counts as a real robots file
- percent-decoded patterns: `Disallow: /foo%20bar` blocks `/foo bar` and does
  **not** over-match `/foobar`
- the robots URL is rebuilt from scheme+host, never passed through

**Do NOT port:** `test_gate_reads_policy_as_browser_when_honest_request_is_refused`
and `test_gate_obeys_a_browser_fetched_policy_strictly` — those test the
browser-UA fallback, which we are deliberately dropping (§5). Replace them
with a test asserting the opposite: a WAF-blocked robots.txt (403) returns
`allowed: false` with an UNCONFIRMED reason and **makes no second request**.
Assert the call count on your injected fetcher. That is the test that stops
someone "fixing" the missing fallback later.

Also skip the CLI/argv tests (`TestCli`, `TestArgumentHardening`'s curl
argv assertions) — we have no CLI and no curl. Their *intent* survives as
URL validation; see §6.

---

## 3. The four defences that MUST survive the port

If you drop one of these, the package is worse than the hand allowlist it
replaces, because it will be trusted at 400× the volume.

### Defence 1 — FAIL-CLOSED on everything except 404

**Upstream reasoning, quoted from the module docstring:**

> ```
>   * 404 means no published policy, which is permission
>   * any other failure to read robots.txt leaves permission unconfirmed,
>     and the retry does not happen
> ```

The classification, exhaustively:

| Outcome | Verdict | Why |
|---|---|---|
| HTTP 404 | evaluate as allow-all | RFC 9309: no published policy = permission |
| HTTP 200 + recognised body | parse and apply | the normal path |
| HTTP 200 + unrecognised body | **UNCONFIRMED → refuse** | Defence 2 |
| HTTP 403 / 401 / 429 / 5xx / anything else | **UNCONFIRMED → refuse** | policy unread |
| Timeout | **UNCONFIRMED → refuse** | policy unread |
| Network / DNS / TLS error | **UNCONFIRMED → refuse** | policy unread |
| `fetch` threw anything at all | **UNCONFIRMED → refuse** | policy unread |

> **Name the pattern for your own comments: fail-closed / default-deny.** The
> tell for getting it wrong is a `try { … } catch { }` whose catch path falls
> through to the success return. Every catch in this package must lead to a
> refusal with a reason string naming the error class — upstream stores
> `type(e).__name__` for exactly that. In TS: capture
> `error instanceof Error ? error.name : 'UnknownError'`.

One nuance worth a comment: 404 is treated as allow-all, but it still runs
through the *same* evaluation path as a parsed body (an empty rule set),
rather than short-circuiting to `allowed: true`. Two code paths that both
mean "allow" is one code path too many — and it means your 404 result still
carries a `crawlDelayMs: null` and a real reason string like the others.

### Defence 2 — the SOFT-200 defence (`robots_check.py:47-64`)

**Upstream reasoning, quoted in full from `is_robots_body`:**

> ```
>     A misconfigured host can answer /robots.txt with 200 and an HTML error page.
>     That body parses to zero rules, and zero rules read as "allowed" - so a
>     soft-200 granted permission that was never given. An empty or whitespace-only
>     body IS a valid allow-all under RFC 9309 and stays allowed; a non-empty body
>     with no recognised directive is treated as unreadable.
> ```

and from the test class:

> "Found by adversarial review, not inspection. A misconfigured host answering
> /robots.txt with an HTML error page at status 200 parses to zero rules, and
> zero rules read as 'allowed' - so the browser retry ran on permission that
> was never given. FAIL-OPEN REGRESSION."

The mechanism of the bug: `<html><body>404 Not Found</body></html>` contains
no line whose field is a robots directive, so the parser produces an empty
rule set, and an empty rule set means "nothing is disallowed". The gate
returns ALLOWED on a host that published nothing of the kind. **Validate the
body contains a recognised directive token before you trust the parse.**

**The trap on the other side, and it is a real one:** RFC 9309 says a
genuinely EMPTY file **is** allow-all. Over-correcting — treating every body
with zero directives as unreadable — would refuse every site that ships an
empty `robots.txt`, which is a lot of them. So:

- `""` and `"\n\n   \n"` → **valid**, allow-all
- `"# just a comment\n"` → **valid** (comment-only is still not "not a
  robots file"; upstream's `allowed()` handles it as zero rules, and
  `is_robots_body` returns true on it via... actually note carefully:
  `"# just a comment\n"` strips to an empty line, so no directive is found
  and `is_robots_body` returns **false**, while `allowed()` returns true. Port
  upstream's behaviour exactly as written and pin whichever answer you
  produce in a test with a comment explaining the reasoning — the safe
  reading is that a comment-only file is indistinguishable from a body we
  cannot recognise, and refusing is the fail-closed choice.)
- `"<html>…"`, `'{"error":"not found"}'` → **invalid** → UNCONFIRMED
- `"Sitemap: https://x.example/sitemap.xml\n"` → **valid** (a sitemap-only
  file is a real robots file with zero rules)

Distinguish **empty** from **not-robots**. That distinction is the whole
defence.

### Defence 3 — PERCENT-DECODE the pattern before matching (`:88-91`)

**Upstream reasoning, quoted from `_match`:**

> ```
>     The pattern is percent-decoded to match the already-decoded path. Without
>     this, "Disallow: /foo%20bar" never matched "/foo bar" and the rule was
>     silently skipped - a fail-open on any site that encodes its own rules.
> ```

Both sides must be in the same encoding space. `gate()` already decodes the
path (`path = unquote(parts.path) or '/'`), so the pattern must be decoded
too. Skip this and every rule a site writes in encoded form is silently
ignored — and "silently" is the operative word: nothing errors, nothing
logs, the gate just says yes.

Two tests pin both directions: `/foo%20bar` must block `/foo bar` **and**
must not block `/foobar`. Port both — the second one is what catches a
"fix" that strips `%20` instead of decoding it.

TS note, repeated because it will bite: `decodeURIComponent` throws
`URIError` on malformed input. Catch it and fall back to the undecoded
pattern; do not let it propagate into the caller's catch block where it
would be indistinguishable from a network failure.

### Defence 4 — TIES GO TO DISALLOW (`:99-107`), and BOTH groups are checked

**Upstream reasoning, from the docstring and the inline comment:**

> ```
>   * longest-match wins; on equal specificity Disallow wins
>   * a Disallow for either "*" or "Claude-User" blocks the retry
> ```
> ```python
>             best_len, best_allow = n, is_allow      # ties -> Disallow wins (cautious)
> ```

and from the test:

> "Cautious tie-break: Google resolves ties to Allow, we do not."

This is **deliberately stricter than RFC 9309**, which gives ties to Allow.
Write that in a comment in your source, with the word "deliberately", so the
next reader does not file it as a spec-compliance bug. We are a job
applicant, not a search engine; being more conservative than the standard
costs us a page and protects constraint #5.

The second half is separate and equally important — `gate` checks **both**
groups:

```python
    for a in ('Claude-User', '*'):
        if not allowed(body, a, path):
            return 1, f'DISALLOWED for {a} - do not retry, go to step 3'
```

Note this is *not* what plain RFC group-selection does. RFC 9309 says the
most specific matching group applies and `*` is ignored when a named group
exists. Upstream deliberately denies if **either** group denies. Keep that,
comment it as a deliberate widening, and make your `reason` say *which*
group denied — the caller needs that to tell "this site blocks everyone"
from "this site blocks us specifically", which are very different signals
when you are choosing which of 400 boards to keep.

Generalise the agent list: your `checkRobots` takes a `userAgent` parameter,
so the loop is `[userAgent, '*']` — and de-duplicate when the caller passes
`'*'` itself.

---

## 4. Two gaps upstream has that WE MUST FILL

Upstream is a one-shot CLI: one URL, one process, exit code. We are a
long-running worker hitting many URLs per host. Two things it never needed:

### Gap A — NO CACHING. It re-fetches robots.txt on every call.

`gate()` fetches `/robots.txt` unconditionally, every invocation. Fine for a
CLI a human runs once. For us it means one extra request per candidate URL —
and we will check dozens to hundreds of URLs on the same host. That is both
wasteful and, ironically, *itself* a load pattern a site operator would
object to.

**Build a per-host TTL cache.**

- Key on **scheme + host + port** (the robots URL's origin), not on the full
  URL. Two paths on one host share one policy. `new URL(url).origin` gives
  you exactly this string — say in a comment why origin and not hostname:
  `http://x` and `https://x` are separate origins and may serve different
  files, and a port-bearing host must not collide with the default-port one.
- Cache the **fetch outcome** — the parsed body plus its status
  classification — not the per-path verdict. Per-path verdicts would balloon
  and would not share across paths, which is the entire point.
- **Cache failures too, with a SHORTER TTL.** If a host is timing out, do not
  re-hammer it once per URL. But do not cache a failure for the full TTL
  either, or one transient blip locks you out of a legitimate board for an
  hour. Suggested defaults, both overridable in `options`: success TTL
  ~1 hour, failure TTL ~5 minutes. Whatever you choose, comment the reasoning
  and make it a named exported constant like `master-pdf` does with
  `LINE_BAND_TOLERANCE_PT`.
- **Inject the clock.** Take `now?: () => number` in options, defaulting to
  `Date.now`. Same seam technique as the fetcher, same reason: a cache test
  that needs a real hour to run is a test nobody runs. This keeps expiry
  testable without `setTimeout` and without flakiness.
- **Decide and document whether the cache is module-global or an instance.**
  Recommendation: export a `createRobotsGate(options)` factory owning a
  `Map`, *and* a module-level convenience `checkRobots` using a default
  instance. Module-global mutable state is a shared-mutable-state hazard —
  tests leak into each other, and a caller cannot get a clean slate. The
  factory is the honest primitive; the convenience wraps it. Comment the
  trade-off rather than just picking.
- Bound the map or document why you are not. A worker touching 400 hosts
  holds 400 small strings — fine. Say that explicitly so nobody adds an LRU
  that is not needed, and so the day someone points this at 400,000 hosts
  the note is there.

### Gap B — `crawl-delay` is RECOGNISED but NEVER parsed or enforced.

Look closely at upstream: `crawl-delay` appears in exactly ONE place —

```python
        if ':' in line and line.split(':', 1)[0].strip() in (
            'user-agent', 'allow', 'disallow', 'sitemap', 'crawl-delay', 'host',
        ):
```

— the soft-200 sentinel's token list. It is used only as evidence that a
body *is* a robots file. `_groups` handles only `user-agent`, `allow` and
`disallow`; nothing ever reads a delay and nothing ever waits.

That is a genuine hole for us. `Crawl-delay` is a site telling us our
request rate. Ignoring it while loudly obeying `Disallow` is obeying the
letter and missing the point of constraint #5 — and it is exactly the
behaviour that gets an IP blocked, which costs us the board anyway.

**What to build:**

1. **Parse it.** Extend the group parser to collect `crawl-delay` per agent.
   Take the value from the *same group-selection logic* as the rules
   (specific agent, else `*`). The value is in **seconds** and may be
   fractional (`Crawl-delay: 0.5` and `Crawl-delay: 10` are both real).
   Return **milliseconds** in the API — `crawlDelayMs` — because every Node
   timing API takes ms and a unit mismatch here is a silent 1000× error.
   Comment that conversion and its reason.
2. **Validate it.** `Number.parseFloat` on junk yields `NaN`; a negative or
   non-finite value is meaningless. Anything that is not a finite number
   `>= 0` → `null` (unknown), not `0` (no delay). Those are different claims
   and conflating them is a fail-open. Consider clamping an absurd value
   (some sites publish `Crawl-delay: 86400`) — but **clamping must not be
   silent**: if you cap it, the reason string must say so, because a caller
   that respects a capped delay is not respecting the published one.
   Recommendation: do NOT clamp inside this package. Return the true value
   and let the caller decide a host asking for a day is a host to drop. Name
   that decision in a comment; it is a policy call and it belongs at the
   policy layer.
3. **Design where the delay is APPLIED — and say so in the package's
   README/header.** This is your design call; make it and justify it. The
   two candidates:
   - *(recommended)* **Return it, do not sleep.** `checkRobots` is a pure-ish
     decision function; a package that blocks for 10 seconds inside what
     looks like a validation call is a latent production hang, and it cannot
     be composed (a caller wanting to interleave hosts cannot). Return
     `crawlDelayMs` and expose a **separate, optional** scheduling helper —
     e.g. `nextAllowedFetchAt(origin)` / `recordFetch(origin)` backed by the
     same per-host map — so the caller can enforce it without this package
     owning a timer.
   - *(reject, but say why)* sleeping inside `checkRobots`. Hides latency,
     unstoppable, untestable without fake timers, and serialises unrelated
     hosts.

   Whichever you pick, the header comment must state **who is responsible for
   honouring the delay**, because a returned-but-ignored delay is worse than
   no delay: it looks compliant in code review and is not. If you ship the
   recommended split, say plainly in the README that the worker integration
   (a different session's partition) is what closes the loop, so the gap is
   visible rather than assumed-done.

---

## 5. EXPLICIT DO-NOT-PORT: the browser User-Agent fallback

**This is a ruled decision. It is not an oversight. Do not "fix" it.**

Upstream retries reading robots.txt with a Chrome User-Agent when its honest
UA is refused by a WAF (`robots_check.py:116-128`):

```python
    for ua in ('Claude-User', BROWSER):
        try:
            text, code = _fetch(robots, ua)
        except Exception as e:
            last = type(e).__name__; continue
        if code == 404:
            return 0, 'ALLOWED - no robots.txt published'
        if code == 200:
            if not is_robots_body(text):
                last = 'HTTP 200 but the body is not a robots.txt'
                continue
            body = text; break
        last = 'HTTP %d' % code
```

with

```python
BROWSER = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
           '(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36')
```

**Upstream's case for it is genuinely good**, and you should understand it
before rejecting it — from the module docstring:

> "The retry exists to get past bot-filtering firewalls on sites whose
> robots.txt permits access. It is never used to override a site that has
> said no. ... a 403 has two very different causes: a WAF default on a site
> whose published policy allows access, or a site that has actually declined.
> This tells them apart."

and from the test that pins it:

> "09-web-research.md's Barclays-class recovery: the policy file itself
> returns 403 to Claude-User and 200 to a browser, and the checker must then
> read it as a browser and obey it strictly."

It only ever uses the browser UA to read the **policy file**, and then obeys
that policy strictly — there is even a test that a browser-fetched policy
still disallows what it disallows.

**We are not porting it anyway.** Presenting a browser User-Agent
specifically to get past a bot filter is arguably the exact thing constraint
#5 prohibits: *"DON'T bypass ... anti-bot mechanisms."* The narrowness of the
use ("only to read robots.txt") is a distinction we are choosing not to rely
on. A WAF refusing our honest UA **is** a site declining to talk to us, and
the conservative reading of our own constraint is that we take that answer.

**Therefore:** on a WAF-blocked robots.txt (403, or any non-200/404), return
**UNCONFIRMED** and refuse. One request, one honest User-Agent, no retry with
a different identity.

**Record it in the code so it survives.** Put a block comment at the WAF
branch in `check-robots.ts` saying, in substance:

> Upstream retries this read with a Chrome User-Agent when the honest UA is
> refused (`robots_check.py:116-128`), and its reasoning is sound — it reads
> only the policy file that way and then obeys it strictly. We DELIBERATELY
> do not port it: presenting a browser identity to get past a bot filter is
> what constraint #5 forbids, and a WAF refusing our honest UA is a site
> declining to talk to us. This is a ruled decision, not a missing feature.
> Do not add the fallback.

And pin it with a test that asserts the injected fetcher is called **exactly
once** on a 403. A comment alone gets deleted; a failing test gets read.

> **The technique here has a name: an *anti-feature test*.** You are testing
> that something does NOT happen, because the thing not happening is a
> deliberate decision that looks like an omission. Worth adding to your
> vocabulary — it is the cheapest defence against a well-meaning future
> "improvement".

---

## 6. Replace `curl` with `fetch`

Upstream shells out to curl:

```python
def _fetch(url, ua):
    """curl, not urllib: some hosts (jobup.ch) hang urllib indefinitely while
    answering curl in under a second, and --max-time is a hard ceiling."""
```

The reason is a Python-specific defect (`urllib` hanging) plus the fact that
`--max-time` is a hard ceiling. **Neither applies to us**, and subprocessing
curl from a Node worker would add a binary dependency, a shell-injection
surface and a Windows portability problem. Use `fetch`.

Requirements, mapping curl flag → TS:

| curl | TypeScript |
|---|---|
| `--max-time 12` | `signal: AbortSignal.timeout(12_000)` — a hard ceiling, same as curl's, and it aborts the socket rather than just rejecting the promise |
| `-A ua` | `headers: { 'user-agent': userAgent }` |
| `-H 'Accept: text/plain,*/*'` | `headers: { accept: 'text/plain,*/*' }` |
| `-L --max-redirs 5` | `fetch` follows redirects by default (`redirect: 'follow'`); it has no max-redirect knob — note in a comment that the platform caps it (20 in undici) and that a redirect loop therefore still terminates. Do NOT set `redirect: 'manual'` and hand-roll a follower; that is more code and more ways to fail open |
| `timeout=20` (outer) | the `AbortSignal.timeout` IS the ceiling; no second timer |

Make the timeout an option with a documented default (12s, matching
upstream's measured ceiling). Comment why it is short: we are checking
hundreds of hosts and a slow policy file is a host we skip, not a host we
wait for.

Catch **everything** around the fetch — `AbortError` from the timeout,
`TypeError` from a DNS/TLS failure, anything else — and map each to an
UNCONFIRMED refusal whose reason names the error. Read the status *before*
reading the body; a 404 needs no body read at all.

**On upstream's `--` argv terminator.** That guard exists so a URL beginning
with a dash can never be read by curl as a flag:

```python
    # "--" terminates option parsing, so a URL beginning with a dash can never
    # be read by curl as a flag. gate() rebuilds the target as
    # scheme://host/robots.txt before calling here, so this is hardening for
    # direct callers rather than a hole in the gate path itself.
```

We have no argv, so there is no literal equivalent — **but the underlying
concern transfers**: a caller-supplied string must be validated as a URL
before it reaches the network layer, and the fetched target must be
constructed by us rather than passed through.

**What you must do instead:**

1. Parse with `new URL(url)` inside a try/catch. A string that does not parse
   is **not** a soft failure — refuse with a reason. (`URL.canParse` also
   exists on Node 24; either is fine, comment the choice.)
2. **Assert the protocol is `http:` or `https:`.** Without this,
   `file:///etc/passwd`, `data:`, and `javascript:` all "parse". A
   `file:` URL reaching `fetch` is an SSRF-shaped bug in a package whose
   entire job is to be the safety gate.
3. Build the robots target as `${parsed.protocol}//${parsed.host}/robots.txt`
   — from the parsed pieces, never by string-concatenating caller input.
   `parsed.host` (not `hostname`) preserves a non-default port. Pin this with
   the ported `test_gate_never_passes_the_caller_url_through_to_curl`.

That is the same *class* of defence upstream was applying — never let
attacker-shaped input choose the target — expressed in the idiom of the
platform we actually run on. Say that in the comment; it explains why the
`--` guard has no direct descendant in your file.

---

## 7. The API shape to expose

```ts
export interface RobotsDecision {
  /* The only field a caller may branch on. */
  readonly allowed: boolean;
  /* Human-readable WHY, for the log line. Never parsed by callers. */
  readonly reason: string;
  /* Published Crawl-delay in MILLISECONDS, or null when the site published
     none (or published something unparseable). null is "unknown", not "zero". */
  readonly crawlDelayMs: number | null;
}

export function checkRobots(
  url: string,
  userAgent: string,
  options?: RobotsOptions,
): Promise<RobotsDecision>;
```

**Never a bare boolean.** The justification, which belongs in the code as a
comment:

A bare `false` is unactionable at 400 hosts. The three refusals below are
operationally *completely different* and a boolean erases the difference:

- `DISALLOWED for * — /jobs is blocked by policy` → the site said no. Drop
  the board permanently. Correct behaviour, nothing to fix.
- `UNCONFIRMED (HTTP 403) — policy unreadable` → a WAF. Not a policy
  decision. Maybe revisit, maybe drop; a human should see the pattern across
  hosts.
- `UNCONFIRMED (TimeoutError) — policy unreadable` → transient. Retry later.

All three are `allowed: false`. If the gate returns only a boolean, the
worker logs "skipped" 400 times and nobody can tell a permanent no from a
flaky network — and the first thing anyone will do to find out is to start
bypassing the gate to investigate. **A gate that cannot explain itself gets
disabled.** That is the real argument for the reason string.

Same logic applies to the ALLOW side: `'ALLOWED — no robots.txt published'`
(404) and `'ALLOWED — robots.txt permits this path'` are different facts and
both are worth having in a log.

Secondary reason: **reasons are how this package is debugged from
production.** This code runs unattended; the reason string is the only
artefact that escapes.

`RobotsOptions` should carry (all optional, all defaulted, each field
commented with why it is injectable):

```ts
export interface RobotsOptions {
  readonly fetcher?: RobotsFetcher;     // structural seam; zero deps; offline tests
  readonly now?: () => number;          // clock seam; TTL expiry testable in ms
  readonly timeoutMs?: number;          // default 12_000, matching upstream's ceiling
  readonly successTtlMs?: number;       // default ~1h
  readonly failureTtlMs?: number;       // default ~5m, shorter so a blip is not sticky
}
```

Keep the surface small. `index.ts` exports `checkRobots`,
`createRobotsGate`, the types, the named TTL/timeout constants, and the pure
helpers the tests drive directly (`isRobotsBody`, `parseGroups`,
`matchLength`, `isPathAllowed`, `parseCrawlDelayMs`). Exporting the pure
helpers is deliberate — it is what makes the defences testable without a
fetcher at all, exactly as upstream tests `allowed` and `is_robots_body`
directly.

---

## 8. Attribution header — required, verbatim substance

Put this at the top of `src/index.ts` (and reference it from the README if
you write one). Expand it in the house voice; the facts below are mandatory.

```
Ported from MadsLorentzen/ai-job-search @ 968fb1bd (MIT, © 2026 Mads Lorentzen).

Source: tools/robots_check.py, vendored at
reference/ai-job-search-upstream/tools/robots_check.py.

WHAT CHANGED IN THE PORT:
  - Python -> TypeScript. This repo is Node + TS only; Python is forbidden.
  - curl subprocess -> fetch + AbortSignal.timeout. Upstream shelled out
    because Python's urllib hangs on some hosts; that defect is not ours, and
    a subprocess would add a binary dependency and a shell surface.
  - ADDED a per-host TTL cache, keyed on origin. Upstream is a one-shot CLI
    and re-fetches every call; we check many URLs per host.
  - ADDED crawl-delay parsing and a place to enforce it. Upstream recognises
    the token only as evidence a body is a robots file (robots_check.py:60-62)
    and never reads the value.
  - DROPPED the browser User-Agent fallback (robots_check.py:116-128),
    DELIBERATELY. Upstream uses it only to read the policy file and then obeys
    that policy strictly, but presenting a browser identity to get past a bot
    filter is what project constraint #5 forbids. A WAF-blocked robots.txt is
    UNCONFIRMED and we refuse. This is a ruled decision, not a gap.

WHAT WAS PRESERVED EXACTLY, because these are the defences:
  - fail-closed on everything except 404
  - the soft-200 body sentinel
  - percent-decoding of patterns before matching
  - ties resolve to Disallow (stricter than RFC 9309, on purpose), and BOTH
    the named agent group and "*" are consulted
```

MIT requires the copyright notice and permission notice be retained. Keep
the attribution line intact; do not paraphrase away the name, the commit, or
the licence.

---

## 9. Package skeleton — model on `packages/master-pdf`

**`packages/master-robots/package.json`** — copy the *form* of
`packages/master-pdf/package.json` exactly, including its `"// key"` comment
convention (JSON has no comments; this repo uses sibling keys prefixed `//`).
The real file, for reference:

```json
{
  "// name": "Scoped @applyy (TWO y's) per the naming standard; only the repo folder is applyyy. ...",
  "name": "@applyy/master-pdf",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "types": "./src/index.ts",
  "files": ["src"],
  "// scripts.test": "The glob is REQUIRED. `node --test test` (a bare directory) fails on Node 24 with MODULE_NOT_FOUND, and that error reads exactly like missing fixtures, which has already cost a previous session time in master-ingest.",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --test \"test/**/*.test.ts\""
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.8.0"
  }
}
```

Your version must have:

- `"name": "@applyy/master-robots"` — **TWO y's in the scope.** Only the
  repo folder is `applyyy`. Getting this wrong breaks workspace resolution
  for everyone.
- `"version": "0.0.0"`, `"private": true` (workspace-internal, never
  published), `"type": "module"`.
- `"exports": { ".": "./src/index.ts" }` and `"types": "./src/index.ts"` —
  **source-only, no build step.** A compiled copy would be a second place the
  policy rules live, which is how two implementations of "the same rule"
  drift apart.
- `"files": ["src"]`.
- `"scripts": { "typecheck": "tsc --noEmit", "test": "node --test \"test/**/*.test.ts\"" }`
  — **the glob is REQUIRED.** `node --test test` (a bare directory) fails on
  Node 24 with `MODULE_NOT_FOUND`, and that error reads exactly like missing
  fixtures. It has already cost a previous session real time in
  `master-ingest`. Carry the explanatory `"// scripts.test"` comment across.
- **NO `dependencies` block at all** (or an explicit `"// dependencies"`
  comment stating the zero-dep rule and why — preferred, since the absence is
  a decision, and `master-pdf` documents its own absent dep the same way).
- `devDependencies`: `@types/node` `^24.0.0` and `typescript` `^5.8.0`, both
  already resolved in the lockfile. The workspace pins TypeScript to `5.9.3`
  via a root `overrides` block regardless, so the caret is safe.

**`packages/master-robots/tsconfig.json`** — model on
`packages/master-pdf/tsconfig.json`:

```json
{
  // All compiler settings live in the root base config, so this package cannot
  // drift from the values the cross-runtime spike proved.
  // NOTE: real `//` comments, not "// key" entries — TypeScript validates the
  // keys inside compilerOptions and rejects an unknown one with TS5025.
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

(Note the difference: `tsconfig.json` takes **real** `//` comments; only
`package.json` needs the `"// key"` trick. Do not mix them up — TS rejects an
unknown key inside `compilerOptions` with TS5025.)

**Settings inherited from `tsconfig.base.json` that WILL affect your code** —
these are not suggestions, they are compile errors:

- `"erasableSyntaxOnly": true` — **no `enum`, no `namespace`, no constructor
  parameter properties.** Use `const` objects plus union types. An `enum` in
  a shared module *runs* under Deno and *throws at parse* under Node 24, so
  this flag exists to make it a compile error instead of a CI-only runtime
  failure. You will want an enum for the outcome classification; use a union
  of string literals.
- `"allowImportingTsExtensions": true` and the house rule that follows from
  it: **relative imports carry an explicit `.ts` extension** —
  `import { x } from './parse.ts'`. Required by Deno and by Node's type
  stripper; it is not a style choice.
- `"verbatimModuleSyntax": true` — use `import type` for type-only imports.
- `"strict"`, `"noUncheckedIndexedAccess"` — an index into an array or a
  `Map.get()` types as possibly-`undefined`. Your group map lookups will need
  real handling, not `!`.
- `"exactOptionalPropertyTypes"` — an optional property must be genuinely
  absent, not explicitly `undefined`. Matters when you build `RobotsOptions`
  defaults.
- `"noUnusedLocals"`, `"noUnusedParameters"` — unused symbols are **errors**.
- `"noFallthroughCasesInSwitch"` — relevant if you switch on status class.
- `"lib": ["es2023"]`, no DOM. `fetch`, `AbortSignal` and `URL` come from
  `@types/node`, which is why `"types": ["node"]` is in the tsconfig.
  Historically that line says "tests only" in `master-pdf`; **for you it is
  src too**, since your fetch path is Node-facing. Update the comment to say
  so rather than copying `master-pdf`'s claim verbatim — copying a comment
  that is false in its new home is exactly the kind of drift this repo's
  review process catches.

**`packages/master-robots/deno.json`** — `master-pdf` ships one mapping its
workspace imports for Deno:

```json
{
  "imports": {
    "@applyy/shared-types": "../shared-types/src/index.ts",
    "@applyy/master-ingest": "../master-ingest/src/index.ts"
  }
}
```

You have **no workspace imports**, so you need no import map. Either omit the
file, or ship `{ "imports": {} }` with a comment saying the map is empty
because this package depends on nothing — the second is friendlier to the
next reader. Your call; state the reasoning either way.

**Do NOT edit `pnpm-workspace.yaml`.** It already globs `packages/*`, so
your new directory is picked up automatically. That is precisely why the
partition can exclude it.

**Suggested layout:**

```
packages/master-robots/
  package.json
  tsconfig.json
  deno.json            (optional, see above)
  src/
    index.ts           attribution header + public surface
    parse.ts           isRobotsBody, parseGroups, parseCrawlDelayMs   (pure)
    match.ts           matchLength, isPathAllowed                      (pure)
    fetch-robots.ts    the ONE impure file; RobotsFetcher seam
    check-robots.ts    checkRobots / createRobotsGate; classification
    cache.ts           per-origin TTL cache; clock seam
    types.ts           RobotsDecision, RobotsOptions, RobotsFetcher
  test/
    parse.test.ts
    match.test.ts
    check-robots.test.ts
    fixtures/bodies.ts BARCLAYS, JOBUP, soft-200 bodies
```

**Test style** — `node:test` + `node:assert`, `describe`/`it`, as in
`packages/master-pdf/test/links.test.ts`:

```ts
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { linksOnLine, resolveLinks } from '../src/index.ts';
```

Note the test file headers in `master-pdf` carry the same WHY-density as
src. Yours should too — a test named
`test_equal_specificity_tie_goes_to_disallow_when_allow_listed_first` is
worthless without the paragraph explaining that it is the only ordering that
detects deletion of the tie-break clause. Carry that paragraph over.

---

## 10. Definition of done

Tick every line. "Mostly done" on a safety gate is not done.

1. `packages/master-robots/` exists with `package.json`, `tsconfig.json`,
   `src/`, `test/`.
2. `package.json` declares **ZERO runtime dependencies**; devDependencies are
   only `@types/node` and `typescript`. **`pnpm-lock.yaml` is unmodified.**
3. `package.json` matches the `master-pdf` form: `@applyy/master-robots`
   (two y's), `"private": true`, `"type": "module"`, source-only `exports`
   pointing at `.ts`, and `"test": "node --test \"test/**/*.test.ts\""` with
   the glob.
4. Public API is `checkRobots(url, userAgent, options) =>
   Promise<{ allowed, reason, crawlDelayMs }>`. No bare-boolean return
   anywhere on the public surface.
5. All four defences implemented **and individually commented as deliberate**:
   fail-closed except 404; soft-200 body sentinel; percent-decoded patterns;
   ties-to-Disallow plus both-groups checking.
6. The browser-UA fallback is **absent**, with the "ruled decision" comment
   at the WAF branch and a test asserting exactly one fetch on a 403.
7. Tests exist and pass, covering at minimum:
   - **allow** — a permitted path on a real policy
   - **deny** — a disallowed path
   - **404** — no policy published → allowed
   - **soft-200** — HTML / JSON body at 200 → refused, UNCONFIRMED
   - **timeout** — injected fetcher rejects with an AbortError → refused
   - **non-200/404 status** — 403 → refused, and only one fetch attempt
   - **tie-breaking** — BOTH orderings (Disallow-first and Allow-first)
   - **percent-decoded pattern** — `/foo%20bar` blocks `/foo bar` and does
     not block `/foobar`
   - **crawl-delay parsed** — integer and fractional seconds → correct ms;
     junk / negative → `null`
   - **blank lines inside a record** — the `BARCLAYS` fail-open regression
   - **longest-match** — both directions (blocks, and unblocks)
   - **agent selection** — named opt-out honoured, case-insensitive, `*`
     fallback, shared ruleset across consecutive `User-agent:` lines
   - **cache** — second call for the same origin makes no second fetch;
     after TTL expiry (advance the injected clock) it refetches; a failure is
     cached on the shorter TTL
   - **URL validation** — unparseable string refused; `file:` / `data:`
     refused; robots target rebuilt as `scheme://host/robots.txt` from
     `https://x.example/-o/evil?q=1`
8. **No test makes a real network request.** Every case uses a literal body
   through the injected fetcher. This is the repo's CI policy, not a
   preference.
9. `pnpm --filter @applyy/master-robots typecheck` passes clean under the
   repo's strict base config.
10. **Every statement, declaration and block carries a WHY comment.** Spot-
    check your own diff: ≥1 comment line per code line, `master-pdf`'s
    `layout.ts` as the calibration.
11. Attribution header present in `src/index.ts` with the commit hash, the
    licence, and the changed/preserved lists.
12. **Nothing outside `packages/master-robots/**` is modified.**

---

## 11. Loop-engineering exit checklist

Run these and **paste the real output** in your final report. Not a summary
of it, not "tests pass" — the actual terminal text. A claim of success
without the output it came from is the single most expensive habit in this
workflow, because it is indistinguishable from a claim that was never
checked.

```powershell
# 1. Install (picks up the new workspace package; must NOT alter the lockfile)
pnpm install --frozen-lockfile

# 2. Tests — paste this output verbatim
pnpm --filter @applyy/master-robots test

# 3. Typecheck — paste this output verbatim
pnpm --filter @applyy/master-robots typecheck

# 4. PROVE the partition held. Every line must start with packages/master-robots/
git status --short

# 5. PROVE the lockfile is untouched. Must print nothing.
git diff --name-only -- pnpm-lock.yaml
```

If step 1 wants to write `pnpm-lock.yaml`, **stop and report it** — do not
let it. A zero-dependency package should not move the lockfile at all; if it
does, something in your `package.json` is wrong (usually a stray
`dependencies` entry or a devDependency at a version not already resolved).

**Git rules — these are hard:**

- **NEVER `git add -A`, `git add .`, or `git commit -a`.** Five sessions share
  one index. A blanket stage sweeps a peer's in-flight work into your commit.
  This has already destroyed 392 lines of work in this repo.
- Stage by explicit path: `git add packages/master-robots`
- Verify before committing: `git diff --cached --name-status` — confirm only
  your files are staged.
- Commit **with the pathspec**, which is the actual safety mechanism:
  `git commit -m "…" -- packages/master-robots`
  The `-- <paths>` makes the commit take only the named files and disregard
  the rest of the index, so a peer's `git add` landing while you compose a
  message cannot be swept in. **Staging by explicit path alone does NOT
  protect against this.**
- **NEVER `git stash`** — it yanks other sessions' in-flight work.
- **NEVER `git checkout -- <file>`** outside your own partition.
- Never `--force`, never `--no-verify`, never rewrite pushed commits.

**Report back with:** the file list you created, the pasted test output, the
pasted typecheck output, the pasted `git status --short`, your decision on
where the crawl-delay is applied (with the reasoning), and anything in this
brief you found to be wrong. That last one is not a formality — this brief
was written from the upstream source and the repo's existing packages, not
from having built the thing.
