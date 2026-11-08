# `@applyy/web` — the operator console

_Last verified against code: 2026-11-08 (2a9ac31)._

The browser dashboard for applyyy. Teja uses it to review tailored resumes,
approve applications, apply by hand where the bot cannot, and configure the
pipeline. React 18 + Vite 6 + TypeScript + `react-router-dom` 7
(`apps/web/package.json`). It is a static bundle with no server of its own:
it talks to Supabase (Postgres with RLS, plus edge functions) from the browser.
Vercel deploys it on every push to `main` (`vercel.json`).

**Scope of this file.** Only what is true of `apps/web`. The pipeline and status
graph are in the repo `CLAUDE.md` §1. The schema contract is in
`packages/shared-types/SCHEMA_CONTRACT.md`. This file does not restate them,
because two homes for one fact drift apart.

---

## Commands

The package name is `@applyy/web`. `pnpm --filter web` matches nothing and
exits 0 having run nothing. Scripts are in `apps/web/package.json`:

| Script | Command | What it does |
|---|---|---|
| `pnpm --filter @applyy/web dev` | `vite` | Dev server on port 5173, `strictPort` (`vite.config.ts`) |
| `pnpm --filter @applyy/web typecheck` | `tsc --noEmit` | Type check only |
| `pnpm --filter @applyy/web build` | `tsc --noEmit && vite build` | Type check, then bundle to `apps/web/dist` |
| `pnpm --filter @applyy/web preview` | `vite preview` | Serve the built `dist/` |
| `pnpm --filter @applyy/web test` | `node --test "test/**/*.test.ts"` | Every test, unit and e2e |

Without pnpm, from `apps/web` (this is how CI runs it, `.github/workflows/ci.yml`):

```
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vite build              # the bundle Vercel ships
./node_modules/.bin/vite build --mode e2e   # the bundle the e2e tests serve
node --test "test/**/*.test.ts"
```

### Running the tests

- **Build the e2e bundle first.** Several tests (`test/*E2e.test.ts`,
  `test/e2eSuite.test.ts`) serve `dist/` and drive real Chromium with
  Playwright. Run `vite build --mode e2e` before `test`. Without it they fail
  with `E2E_DIST_MISSING` or `E2E_DIST_UNCONFIGURED`
  (`test/support/e2eDist.ts`).
- **`--mode e2e` loads `apps/web/.env.e2e`** above any `.env.local`. It holds the
  public project URL and an unsigned placeholder anon token. So every machine
  and CI test the same bundle. The e2e tests intercept every
  `https://*.supabase.co/**` request, so no test reaches a live system.
- **Read the summary, not only the exit code.** `tests 0` with `fail 0` means the
  glob matched nothing. Also read `cancelled`: a `before()` hook that cannot
  import cancels tests, which then count as neither passed nor failed. CI checks
  all three (`ci.yml`, step "web tests, and assert tests ran").
- **There is no DOM renderer in unit tests.** Hook-free components are called as
  functions and their element tree is inspected. Tests that import `.tsx` must
  import `./support/registerTsxHooks.ts` first. Effect and browser behaviour is
  proven in the Playwright e2e tests instead.

### Why `node --test` and not vitest

Zero test dependencies. Node runs the `.ts` sources directly by stripping the
types. That works **only** because `erasableSyntaxOnly` in `tsconfig.base.json`
guarantees every file is type-strippable.

> **Rule: value imports need the `.ts` extension.** `node --test` runs the
> sources directly, and Node's ESM resolver needs the extension where Vite's
> `Bundler` resolution does not. So `import { x } from './y'` type-checks and
> bundles, then fails only under the test runner. `import type` is exempt,
> because it is erased first. `allowImportingTsExtensions` is on for this
> (`apps/web/tsconfig.json`).

> **Trap.** `node --test test/` fails on Node 24: it resolves the bare directory
> as a module (`MODULE_NOT_FOUND`). Only the quoted glob form works.

### Why `tsconfig.json` restates `module`

`module` and `moduleResolution` are a coupled pair in tsc. Override one half and
tsc rejects the config (TS5095, TS5109). This once kept the package from
compiling at all. `apps/web/tsconfig.json` sets both `module: "ESNext"` and
`moduleResolution: "Bundler"`. `tsconfig.node.json` (for `vite.config.ts`)
overrides neither and keeps the base Node pair. *When a config inherits a coupled
pair, override both halves or neither.*

---

## Environment variables

Copy `apps/web/.env.example` to `apps/web/.env.local` (git-ignored). Never commit a
filled copy.

| Name | Needed | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | yes | The project URL. Public, not a secret. |
| `VITE_SUPABASE_ANON_KEY` | yes | The **anon** key only. Never the service-role key. |

That is the whole list read by `src/` (`src/data/supabase.ts:45`). Regenerate it with
`git grep -o "VITE_[A-Z0-9_]*" -- apps/web/src`. `VITE_EMAIL_SYNC_WEBHOOK_URL` is
retired: email sync now calls the `gmail-sync` edge function
(`src/features/emails/emailSync.ts`).

**With no env at all the console still builds and opens.** It is inert: every
page shows "not connected" instead of data. This is on purpose.

### Two guards stop a service-role key from shipping

Everything `VITE_`-prefixed is embedded in the browser bundle. A service-role key
bypasses RLS, and a key that has been served must be rotated.

1. **Build guard** (`vite.config.ts`, `assertNoServiceRoleKey`). The build fails
   if `VITE_SUPABASE_ANON_KEY` has a role other than `anon`. It also fails if
   **any** `VITE_` variable holds a token with a non-anon role. It reads the
   role claim, not the variable name, so a token parked under another name is
   still caught. A **missing** key does not fail the build.
2. **Runtime guard** (`src/data/supabase.ts`). At import time it decodes the key
   with `resolveSupabaseConfig` (`src/data/supabaseConfig.ts`) and throws if the
   role is not `anon`. The pure decision lives in `src/data/keyRole.ts`
   (`readRoleClaim`), so it can be tested without the throw.

*Why two layers:* the runtime guard stops the console from **running** with a bad
key. It does not stop the key from being **shipped**. Only the build guard does.
An unreadable token must fail closed: "malformed" is a family of inputs (wrong
segment count, bad base64, non-JSON, role missing or not a string), and the
tests in `test/` cover each one.

If an operation seems to need the service-role key, it belongs in an edge
function.

---

## Layout

```
apps/web/
  index.html, vite.config.ts, tsconfig*.json, .env.example, .env.e2e
  src/
    main.tsx, App.tsx      entry point and the route table
    app/                   shell and shared UI
    data/                  Supabase client, auth, read helpers, edge calls
    features/<area>/       one folder per screen or screen group
    styles/                tokens.css (colour tokens), base.css
  test/                    node --test files; support/ and fixtures/
```

### `src/app/` — the shell

| File | Role |
|---|---|
| `routes.ts` | The rail: `OPERATIONS_SECTION`, `CONFIGURATION_SECTION`, `DEFAULT_ROUTE` |
| `AppShell.tsx` | Layout route. Shows `LoginPage` until signed in, then the rail plus the page |
| `ErrorBoundary.tsx` | Each page is wrapped, so a page crash leaves the rail working (`App.tsx`) |
| `CommandPalette.tsx` | Ctrl+K / Cmd+K jump to any screen |
| `InlineConfirm.tsx` | The only confirm pattern allowed (see "No native dialogs") |
| `Toast.tsx` | App-wide toasts (`ToastProvider` in `App.tsx`) |
| `theme.ts`, `ThemeToggle.tsx` | Light / dark / system preference |
| `PageHeader.tsx`, `StatusBadge.tsx`, `SourceBadge.tsx`, `safeHref.ts` | Shared pieces |

### `src/data/` — data access

| File | Role |
|---|---|
| `supabase.ts`, `supabaseConfig.ts`, `keyRole.ts` | The client and its anon-key guard. `supabase` is `null` when unconfigured |
| `useAuth.ts` | Email + password sign-in (`signInWithPassword`) and sign-out |
| `edgeCall.ts` | `invokeEdge`: the one way the web calls an edge function |
| `contract.ts` | The only import surface for domain types (see invariants) |
| `readState.ts` | `classifyRead`, `describeEmptyState`: why a table is empty |
| `humanLanes.ts` | Which status edges a human may take |
| `useApplicationCounts.ts`, `statusCounts.ts` | Status counts |
| `useAgentRuns.ts`, `agentFreshness.ts`, `ruleWarnings.ts` | System health data |
| `pipelineRunner.ts`, `discoveryService.ts` | Run agents and scouts from the browser |

### Edge functions the web calls

Each call goes through `invokeEdge` (`src/data/edgeCall.ts`). Regenerate this list
with `git grep -n "invokeEdge(" -- apps/web/src`.

| Function | Called from |
|---|---|
| `resume-assist` | `features/approval/aiEdit.ts` (AI edits in the approval editor) |
| `dispatch-apply` | `features/approval/dispatchApply.ts` (start the apply worker) |
| `job-link-intake` | `features/discovery/AddJobLinkPanel.tsx` (add a job by link) |
| `scout-web` | `features/discovery/WebScoutPanel.tsx` |
| `scout-ats` | `data/discoveryService.ts` |
| `gmail-sync` | `features/emails/emailSync.ts` |
| any pipeline agent, by name | `data/pipelineRunner.ts`, `features/pipeline/rowPipelineDeps.ts` |

---

## Routes and feature folders

Routes are declared twice and must match: the rail entry in
`src/app/routes.ts` and the `<Route path>` in `src/App.tsx`. A path in one but
not the other gives "Unknown screen" or a rail item with no page. `/` redirects
to `DEFAULT_ROUTE` (`approvals`). Unknown paths show a not-found page.

**Operations**

| Path | Page | Folder |
|---|---|---|
| `/approvals` | Approval queue: review the tailored resume diff, edit, approve | `features/approval/` |
| `/pipeline` | Pipeline kanban and per-row drawer | `features/pipeline/` |
| `/applied` | Applied jobs: submitted rows, the resume sent, what happened since | `features/applied/` |
| `/discovered` | Discovered jobs, add a job by link, web scout | `features/discovery/` |
| `/manual-apply` | Jobs to apply to by hand, with a copy-ready answer kit | `features/manual-apply/` |
| `/health` | System health: agent freshness, recovery queue | `features/health/` |
| `/emails` | Email monitoring | `features/emails/` |
| `/referrals` | Referral outreach drafts | `features/referral/` |
| `/nudges` | Day-7 follow-up drafts | `features/followup/` |
| `/skill-gap` | Skill gap analytics | `features/analytics/` |

**Configuration** (all in `features/settings/`)

| Path | Page |
|---|---|
| `/search-preferences` | `SearchPreferencesPage.tsx` |
| `/master-profile` | `MasterProfilePage.tsx` (upload, review, edit the master resume) |
| `/answer-bank` | `AnswerBankPage.tsx` |
| `/filters` | `FiltersPage.tsx` |
| `/watchlist` | `WatchlistPage.tsx` |
| `/blocklist` | `BlocklistPage.tsx` |

Folders with no route of their own: `features/auth/` (the login page),
`features/resume-preview/` (resume render used by approval and manual apply) and
`features/profile/` (PDF text extraction).

---

## UI rules

### Theming

- Write colours with `light-dark()` or the semantic tokens in
  `src/styles/tokens.css`. Each colour is defined once there.
- **`[data-theme='dark']` colour rules are dead code.** The `system` preference
  removes the `data-theme` attribute instead of setting it (`applyTheme` in
  `src/app/theme.ts`), so such a rule never matches for a system-dark user.
  The one exception is `--lift`, a box-shadow, which `light-dark()` cannot hold.
- The preference is stored in `localStorage` under `applyy.theme`
  (`THEME_STORAGE_KEY`). Bad stored values fall back to `system`.
- Full reasoning: `docs/ui/theming-convention.md`.

### No native dialogs

No `alert`, `confirm` or `prompt`, and no `beforeunload` / `onbeforeunload`
listener anywhere in `src/` (Teja's rule, 2026-11-04). To ask before a write
that has no undo, use `src/app/InlineConfirm.tsx`: the first click only arms
the confirm, and Confirm runs the write once. `test/inlineConfirm.test.ts`
scans every file under `src/` with an AST and fails on any native dialog.

### JSX comments

Between JSX tags, a comment must be `{/* ... */}`. A `//` there renders as
visible text, and neither tsc nor a test catches it.

---

## Invariants — read why before you break one

### One import surface for domain types

`src/data/contract.ts` re-exports `@applyy/shared-types`. Do not declare a domain
type anywhere else in `apps/web`. The status graph, enums and table shapes have
one definition, and this package only reads them.

- **Kanban columns are derived, not listed.** Columns come from
  `APPLICATION_STATUSES`, card moves from `nextStatuses(status, 'human')`, lane
  grouping from `isTerminal` (`features/pipeline/PipelinePage.tsx`). A new status
  upstream lands in a column with no edit here. A hardcoded list would hide its
  rows.
- **Key page copy by a schema enum.** `PROVIDER_HINTS` in
  `features/settings/WatchlistPage.tsx` is `Partial<Record<AtsProvider, …>>`. An
  invented provider becomes a compile error, not a page that describes an ATS
  that does not exist.

### Untrusted text is never HTML

Job descriptions, company names and board data are `Untrusted`. No file under
`src/` uses `dangerouslySetInnerHTML`. Render as React text children. If HTML
escaping is ever needed, `packages/resume-template` exports `escapeHtml` and
`safeHref`.

### Nothing here approves on its own

`awaiting_approval → approved` is a human-only edge and the only door into the
submit path. No control fires it automatically. In the diff view, every flagged
claim needs an explicit decision ("Keep it, I can defend it", in
`features/approval/DiffView.tsx`) before Approve is enabled. A decision must be
read to be made; an acknowledgement checkbox can be clicked blind.

`--alarm-ground` (the dark alert surface) is used only by the flagged-claims
band. Its scarcity is the signal. Do not reuse it.

### Human lanes: the predicate is in the name

`src/data/humanLanes.ts` exports `HUMAN_ONLY_LANES` (`allowedAgents` is exactly
`['human']`) and `HUMAN_REACHABLE_LANES` (`allowedAgents` includes `human`) as
separate names. `MISSING_HUMAN_CONTROLS` filters the wide one. An earlier version
filtered the narrow one and reported full coverage while a safety-critical
control was missing. Coverage is checked per source status, so screens that build
buttons from `nextStatuses` cover new edges automatically.

### An empty table must say why

`src/data/readState.ts` separates four causes of "no rows": not configured, not
signed in, the query failed, and truly empty. Only the last means "you have no
applications". `classifyRead` returns a discriminated union, so a caller cannot
reach rows without handling the other cases. `describeEmptyState` never returns
the digit zero, and a test asserts that. The order of checks matters:
configuration, then session, then error, then rows. `rows ?? []` collapses all
four into "empty", which is the bug this module exists to prevent.

### System health reports age, not status

A job that stopped a month ago still has a successful last run. Freshness is the
signal (`src/data/agentFreshness.ts`). Silence must look as loud as failure, so an
unknown age renders as muted italic text, never a blank cell. A blank reads as
zero.

### Master profile ingest

`features/settings/masterIngest.ts` takes `unknown`, never throws, and returns
findings as a union on `ok`, so a caller cannot store a profile that had blocking
findings. Every node id must be unique **across the whole profile**, not per
section: the validator indexes bullets in one flat `Map`, and a duplicate id
silently replaces the first bullet. Findings are `blocking` or `advisory`, each
with a dotted path you can paste into a search box.

### Separate the pure decision from the side effect

`keyRole.ts`, `readState.ts` and `masterIngest.ts` follow one pattern: the pure
decision is its own module and is tested directly; the side effect (throwing at
boot, querying, storing) stays in the caller. The decision is the part that can
be subtly wrong. Mutation checks on these modules showed that only a few specific
tests catch the plausible wrong version, so keep the malformed-input and
ordering cases when you edit them.
