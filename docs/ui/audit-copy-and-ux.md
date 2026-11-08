# UI audit — the written interface

> **Status 2026-11-08:** Partly superseded. Checked at `2a9ac31`: C4 is still open (Watchlist "Remove" has no confirm, `apps/web/src/features/settings/WatchlistPage.tsx:486`). C5 changed: Answer Bank delete now uses the in-page `InlineConfirm` (`apps/web/src/features/settings/AnswerBankPage.tsx:38-39`); native dialogs are banned app-wide (repo `CLAUDE.md` §8). C6 is still open (every toast, errors included, closes after 3.2 s, `apps/web/src/app/Toast.tsx:35`). C7 is gone ("Saved successfully" no longer appears in `apps/web/src`). The Approval queue was redesigned on 2026-11-07 (`7211fd7`), so C2, C3 and C25 need a fresh check against the new page before anyone picks them. Other findings were not re-checked. Current index: [README.md](./README.md). The body below is the original record, unedited.

**Date:** 2026-09-17 · **Scope:** all 51 `.tsx`/`.ts` files under `apps/web/src`
**Status:** findings only. Nothing here is implemented. Pick by ID.

Five claims (C1, C2, C3, C6, C15) were re-verified against the tree by hand before this
file was written; all five held. Line numbers are as of commit `286ea2e`.

---

## The two patterns behind most of this

**1. The console renders its own database vocabulary.** Status enums, table columns, agent
role names and internal design words (`cascade`, `affordance`, `bucket`, `constraint #5`)
reach the screen unmapped. The operator is a job seeker, not a maintainer of this schema.

**2. Every failure path pipes the exception straight to the screen.** Ten screens render
`error.message` or `String(err)` as the whole message. The operator gets Postgres's words,
not the console's, and never a way to recover.

---

## Tier 1 — pick these first

These change what the operator can safely do, not just how it reads.

### C1 · Status enum values are the label on every screen
`apps/web/src/app/StatusBadge.tsx:23` — `label ?? status.replace(/_/g, ' ')`, with
`title={`Status: ${status}`}` at `:27` showing the raw snake_case.

Renders **"awaiting approval", "audit clean", "oa pending", "blocked needs human",
"dropped filter", "deduped"** on Pipeline, Approval queue, Diff view and the Pipeline
drawer. The single largest vocabulary leak in the product, and one small map fixes every
screen at once.

**Fix:** a `STATUS_LABEL: Record<ApplicationStatus, string>`; `label` falls back to it,
never to the enum. `awaiting_approval` → "Waiting for your approval"; `audit_clean` →
"Every line traced"; `audit_flagged` → "Unverified claims"; `blocked_needs_human` →
"Needs you to finish it"; `oa_pending` → "Online assessment".

### C2 · Approving produces no confirmation at all
`features/approval/ApprovalQueuePage.tsx:260-266` (`settle()`), called from `:318` and
`:366`. The button reads *"Approve all {n} and queue for submission"* — the one
irreversible action in the product — and the only feedback is the row disappearing. The
file's own comment at `:57-61` admits the toast was removed.

**Fix:** `toast.success('Queued 7 applications for submission.')`. Keep the verb:
Approve → "Approved and queued".

### C3 · Reject discards an application on one click
`features/approval/DiffView.tsx:594-600` — no confirmation, and the reason is a hardcoded
internal string (`'rejected at approval gate'`) the operator never sees or chooses. It
sits directly beside a disabled Approve button.

**Fix:** confirm with the consequence named — *"Reject this application? The tailored
resume for Backend Engineer at Stripe is discarded and the job will not be re-queued."*
Offer the reason as a short choice ("Not interested", "Wrong seniority", "Bad company").

### C4 · Watchlist "Remove" deletes a board with no confirmation
`features/settings/WatchlistPage.tsx:473-480` → `handleDelete` at `:259`. Hard-deletes the
row and its polling history, immediately, with Pause sitting right beside it.

**Fix:** *"Stop watching Stripe? The console will no longer check their Greenhouse board.
Pause it instead if you only want a break."*

### C5 · Deleting a stored answer has a no-information confirm
`features/settings/AnswerBankPage.tsx:155` — *"Are you sure you want to delete …"* does not
say what breaks. Per the page's own header comment (`:1-17`), deleting an answer makes the
Applier **stop and park every future application** that hits that question. The control is
a bare `🗑️` (`:588`) whose accessible name is the emoji — see
[A11](./audit-accessibility.md).

**Fix:** *"Delete 'Notice period (days)'? Applications that hit this question will stop and
wait for you instead of answering it."*

### C6 · Error toasts auto-dismiss after 3.2 seconds
`apps/web/src/app/Toast.tsx:33-35` — every toast, `toast.error` included, is removed on a
3200 ms timer. **The message carrying the only recovery instruction vanishes before it can
be acted on.** Pairs with [A9](./audit-accessibility.md) — errors also land in a polite
live region rather than an assertive one.

**Fix:** keep success/info on the timer; make `error` sticky until dismissed.

### C7 · "Saved successfully" for three fields that are not saved
`features/settings/SearchPreferencesPage.tsx:294` reports success, but the payload at
`:253-267` **omits** `killSwitchActive` (`:111`), `backoffSeconds` (`:112`) and `dailyCap`
(`:113`) — all three rendered as live controls at `:646-689` under "Pipeline Dispatch &
Rate Limits".

**Fix:** persist them, or disable the inputs and label the section *"Not yet configurable
— shown for reference."* A success message covering unsaved fields is not confusing, it is
false — and one of the three fields is the emergency kill switch.

### C8 · Command palette actions do not do what they say
`apps/web/src/app/CommandPalette.tsx:50-58` — *"Trigger Email Sync"* navigates and then
toasts *"Navigated to Email Monitoring to trigger sync."* Same at `:62` (*"Block a
Company"*) and `:72` (*"Browse Watchlist Suggestions"*).

**Fix:** wire the action, or rename to *"Go to email monitoring"* and drop the apologetic
toast.

---

## Tier 2 — vocabulary and states

### C9 · Ten screens render the raw exception
`WatchlistPage.tsx:119, 124, 173, 226` · `FiltersPage.tsx:230, 232` ·
`AnswerBankPage.tsx:65, 136, 170` · `EmailMonitoringPage.tsx:90` · `BlocklistPage.tsx:97` ·
`SearchPreferencesPage.tsx:128, 291` · `DiscoveredJobsPage.tsx:260`.

*"Insert failed: …"* names a SQL verb; `String(err)` can render `[object Object]`; none
says what to do next.

**Fix pattern:** *"Could not save this board. The console is connected but the write was
refused — check you are still signed in, then try again."* Raw text behind a "Details"
disclosure, never as the whole message.

### C10 · "Filter Cascade" is the page's own name for itself
`FiltersPage.tsx:280, 292, 405, 224, 282` · leaks to `DiscoveredJobsPage.tsx:327, 452, 458`
(*"⚡ Cascade Active"*) and `SearchPreferencesPage.tsx:627`.

"Cascade" is the implementation's word for an ordered short-circuit evaluation. **The nav
rail already calls this page "Filters"** (`app/routes.ts:84`).

**Fix:** heading → "Screening rules"; button → "Save rules" → toast "Rules saved";
discovery pill → "Rules on" / "Rules off"; the note → *"Each rule is checked in turn; the
first one a job fails is the reason it was dropped."*

### C11 · Internal design notes rendered as UI on System health
`features/health/HealthPage.tsx` — `:642, 691, 728, 779` column header *"Operator Recovery
Control (Affordance)"* · `:720` *"Constraint #5 strictly prohibits automated bypass"* ·
`:501-546` row labels *"no screen claims it"*, *"claimed by a screen that does not exist"* ·
`:811-835` a whole panel titled *"Status graph cycle observability"* warning about
`oa_pending ↔ interview`. Plus `FiltersPage.tsx:338` *"This rule was added to the schema
after this page was written."*

**Fix:** header → "What you can do". `:720` → *"The console never bypasses a captcha.
Finish this one in your browser, then record what happened."* Move the cycle panel and the
coverage partition behind a "Console diagnostics" disclosure, or out entirely.

### C12 · Three different names for the same two actions
Remote discovery: `PipelinePage.tsx:204` "🌍 Find Remote Jobs (Global)" ·
`DiscoveredJobsPage.tsx:357` "🌐 Scout Remote Feeds" · `SearchPreferencesPage.tsx:719`
"🌐 Save & Find Remote Jobs Now" · `DiscoveryModal.tsx:68` "Global Remote & Web Discovery"
· `:137` "Start Global Remote Scan". Watchlist scan: five more variants across the same
files.

**Fix:** one verb per action, carried trigger → modal title → modal button → result.
"Find remote jobs" → "Finding…" → "Found 41 jobs, 12 new".

### C13 · ATS vocabulary and lowercase enum values throughout the watchlist
`WatchlistPage.tsx:337` label *"ATS Provider"* · `:344-348` options render **`greenhouse`,
`lever`, `ashby`** lowercase · `:353` *"ATS Identifier (Board Slug)"* · `:414-417` columns
*"ATS Provider / Board Token / Last Poll / Poll Count"* · `:170, 222` error *"Board token
'x' is already registered under greenhouse"*. Also `CompanySuggestionsModal.tsx:438, 461`,
`BlocklistPage.tsx:220` (a "Slug" column), `DiscoveredJobsPage.tsx:381`.

**Fix:** "Job board", capitalised options. *"ATS Identifier (Board Slug)"* → **"Their board
name"**, help *"The last part of their careers URL — `boards.greenhouse.io/`**stripe**"*.
Duplicate error → *"Stripe's Greenhouse board is already on your watchlist."* Drop
Blocklist's Slug column.

### C14 · Answer types shown as snake_case in a table column
`AnswerBankPage.tsx:321` renders `single_select`, `long_text`, `boolean`. `:307` renders
the row key `notice_period_days`. `:404, 411` label yes/no buttons *"✓ Yes (True)" / "✕ No
(False)"*, exposing the storage type in a yes/no control.

**Fix:** map to "Text / Number / Yes or no / Choice / Date / Paragraph"; buttons → plain
"Yes" / "No". *(Those same buttons also fail on colour — see
[A7](./audit-accessibility.md) and [K5](./audit-color-and-theming.md).)*

### C15 · Raw ISO timestamps on System health
`HealthPage.tsx:135` — `new Date(read.measuredAt).toISOString()` renders
`2026-09-17T11:42:08.917Z`. Same at `:234-237`. **Every other age on that page is
humanised by `formatAge`; these two are not.**

**Fix:** `toLocaleString()`, keeping the ISO string as the `title` for the paste-into-SQL
case the file's own comment describes.

### C16 · Loading text names Supabase, the browser, and internal phases
`ApprovalQueuePage.tsx:273` · `WatchlistPage.tsx:401` · `DiscoveredJobsPage.tsx:452`
(*"…against Tech constraints and Filter Cascade…"*) · `MasterProfilePage.tsx:166` /
`MasterUploadReview.tsx:399` (*"Extracting resume PDF browser-side…"*) · `AppShell.tsx:53`
(*"Verifying operator session…"*) · `EmailMonitoringPage.tsx:218` (*"📦 Supabase Cached"*).

**Fix:** *"Loading the applications waiting for you…"* · *"Reading your resume — it never
leaves this browser."* · *"Signing you in…"* · "Live" / "Last saved results".

### C17 · Seven empty states that are a dead end
`ApprovalQueuePage.tsx:285` · `PipelineDrawer.tsx:142` · `BlocklistPage.tsx:211` ·
`MasterProfilePage.tsx:321, 375, 440, 488` · `AnswerBankPage.tsx:598` ·
`EmailMonitoringPage.tsx:293` · `DiscoveredJobsPage.tsx:459`. All state a fact; none offers
the next action.

**Fix:** Blocklist → *"You haven't blocked anyone yet. Add a staffing firm or a company
that ghosted you and it will be skipped from now on."* Discovered jobs → *"Nothing
discovered yet. Run 'Find remote jobs' above, or add companies to your watchlist."* (with
the link live). *(Three of these empty states are also what a **failed read** renders — see
[L5](./audit-layout-and-typography.md), which is the more serious version of this.)*

### C18 · Login errors are raw auth strings; the sign-up notice hedges
`LoginPage.tsx:89, 95` → *"Invalid login credentials"* with no next step. `:99` *"Account
created. If email verification is enabled, please verify your email or sign in."* tells the
user to go find out which of two worlds they are in.

**Fix:** *"That email and password don't match. Check the password, or create an account
below."* Branch the sign-up message on the actual response.

### C19 · The discovery modal writes errors into the progress line
`DiscoveryModal.tsx:47-49` — the catch sets `step`, the same element (`:93`) that shows
progress, in the same style. **A finished scan and a crashed one look identical.**

**Fix:** a separate, error-styled state: *"The scan stopped. The job feeds didn't respond —
try again in a minute."*

### C20 · Env var names and repo paths in operator-facing copy
`data/readState.ts:156` · `HealthPage.tsx:322-324` · `MasterUploadReview.tsx:342` ·
`EmailMonitoringPage.tsx:75, 111`. Defensible on System health (it is a diagnostic); not on
the pipeline board, the email screen or the resume review.

**Fix:** off System health, one sentence — *"This console isn't connected to its database
yet. See System health for what's missing."*

---

## Tier 3 — consistency and polish

### C21 · Sentence case / Title Case / ALL CAPS mixed within single screens
`routes.ts:38` and the shell are deliberately sentence case. Everything else diverges —
`HealthPage.tsx` uses **both** conventions on one page (`:119, 301, 381` sentence vs
`:428, 630, 671, 717, 760` Title). All Settings headings are Title Case. ALL CAPS in
controls at `FiltersPage.tsx:270` and `CommandPalette.tsx:166, 199`.
`MasterUploadReview.tsx:455` renders *"{n} item(s)"*.

**Fix:** sentence case everywhere, matching `routes.ts`. *"Tech Only (ON)"* → *"Tech roles
only"* — a toggle label should not change when it flips.

### C22 · Raw identifiers rendered as content
`PipelineDrawer.tsx:133` (a UUID fragment on every card) · `EmailMonitoringPage.tsx:338,
342` · `MasterProfilePage.tsx:316, 360, 506` (a UUID under every skill chip) ·
`DiffView.tsx:334, 404, 560` · `MasterUploadReview.tsx:137` (*"Similarity 0.873"*).

**Fix:** hide ids behind a "copy id" affordance. *"Matched to Job: 3f2a…"* → *"Matched to
your Stripe application"*. Similarity → *"87% similar to what you had"*.

### C23 · Save/toast verb mismatches
`FiltersPage.tsx:262` *"Apply SDE / Fresher Preset"* → toast *"Applied Early-Career SDE &
Tech Preset!"* (a different name) · `:292/:223/:224` one action with three nouns, firing
both a banner **and** a toast · `AnswerBankPage.tsx:227` → modal *"Add Standing Question"*
→ submit *"Save to Answer Bank"* → toast *"Added…"* · `LoginPage.tsx:224` *"Create
Account"* vs `:205` *"Create Operator Account"* · `WatchlistPage.tsx:443` state
*"● Polling"* vs button `:471` **"Enable"**.

**Fix:** one name per action, end to end. Watchlist → Pause / Resume, states Checking /
Paused.

### C24 · Pipeline offers moves named by enum, disabled, unexplained
`PipelinePage.tsx:160-163` → *"Move to needs_verification"*. Five different verbs for the
same disabled control class across `PipelinePage` and `HealthPage` (Move to / Advance to /
Mark as / Resolve as / Send to). **Fix:** one verb, the C1 label, and a **visible** *"Not
available yet."* — see [A17](./audit-accessibility.md), the tooltip explaining it is
keyboard-unreachable.

### C25 · "Bucket A", "master v3", `audit_clean` on the approval queue
`ApprovalQueuePage.tsx:332` *"(Bucket A)"* · `:354`
`<StatusBadge status="audit_clean" label="audit_clean" />` — the label is **explicitly
forced** to the enum · `:356` *"master v{n}"* · `DiffView.tsx:463-467` the same three ·
`:562` renders the raw `line.kind`.

**Fix:** drop "(Bucket A)"; `:354` → `label="Every line traced"`; *"master v3"* → *"from
resume version 3"*.

### C26 · Tooltips carrying information that should be on the page
`DiscoveredJobsPage.tsx:520` — the **entire** cooldown explanation (interview, screening,
notes) is a `title` on a pill showing only the interview value · `:305, 316, 325` — the
only explanation of the three filter toggles · `WatchlistPage.tsx:457-459` — *"(3 fail)"*
unreadable without hover · `PipelinePage.tsx:136` — the cell shows *"read failed"*, the
reason is hidden.

**Fix:** promote to visible text. *"(3 fail)"* → *"failed 3 times in a row"*.

### C27 · Truncation with no way to see the whole thing
`DiscoveredJobsPage.tsx:503` (location) · `:539` (description, behind an **unlabelled click
on a div** — see [A3](./audit-accessibility.md), which is a keyboard dead end) ·
`DiffView.tsx:492` (*"+3"* locations) · `answerBankStore.ts:220-222` (answers over 80
chars — and the cover-letter default at `:145` is ~200 chars, so it is **always**
truncated; reading it requires entering edit mode).

**Fix:** a visible *"Read full description"* link; a "Show full answer" toggle. See also
[L20](./audit-layout-and-typography.md) — the description is truncated **twice**, by two
mechanisms.

### C28 · Agent role names in operator copy
`AnswerBankPage.tsx:193, 201, 207, 311` · `BlocklistPage.tsx:205` (*"…before reaching
Tailor or Applier."*) · `SearchPreferencesPage.tsx:567, 588, 650` ·
`CompanySuggestionsModal.tsx:396`. The operator has one system, not a cast.

**Fix:** *"before anything is written or sent"* · *"the console searches"* · *"{n} Answers
Injected"* → *"used {n} times"*.

### C29 · HTTP status codes and rate-limit mechanics in settings
`SearchPreferencesPage.tsx:663` *"Cooldown window when HTTP 429 rate limit is
encountered."* · `:648` *"Emergency Kill Switch"* with *"Active"* / *"Paused"* over
underlying values `active`/`disabled` — a third word for the same state.

**Fix:** *"Wait before retrying — how long to pause when a job board asks us to slow
down."* Kill switch → "Automation": Running / Paused.

### C30 · Filter drop reasons speak in rule language
`filtersStore.ts:289, 315, 330, 344` — *"Title contains blocked term 'Senior'"* ·
*"Location 'X' not in allowlist"* · *"Employment type 'full_time' not allowed"* (raw enum).
`DiscoveredJobsPage.tsx:471` prefixes *"Filtered:"*.

**Fix:** *"Title says 'Senior' — you're filtering those out."* · *"Full-time isn't in the
job types you picked."*

### C31 · Salary shown with a currency code, not a symbol
`DiscoveredJobsPage.tsx:509-512` and `DiffView.tsx:484-487` → *"INR 300,000 – 600,000"*;
the `'+'` suffix for open-ended ranges is unexplained. **Fix:** `Intl.NumberFormat` with
`style: 'currency'` → *"₹3,00,000 – ₹6,00,000"*; open-ended → *"₹3,00,000 and up"*.

### C32 · Smaller items
- **`"Unknown / Not specified"` as a selectable card** — `SearchPreferencesPage.tsx:46-49, 70-73`. → *"Not stated in the posting"*, and expand "JD" to "job description".
- **Two independent toast systems** — `CompanySuggestionsModal.tsx:69-76, 387-391` rolls its own (2500 ms, different markup) alongside `app/Toast.tsx` (3200 ms). → use `useToast()`.
- **Three resume-upload prompts for one task** — `MasterUploadReview.tsx:381-401` nests a second uploader inside the review of the first, and it auto-stores **without** the acknowledgement gate the file's own header calls mandatory.
- **`"Done"` used for three different outcomes** — `DiscoveredJobsPage.tsx:617`, `DiscoveryModal.tsx:169`, `CompanySuggestionsModal.tsx:398`. Only the middle is an outcome; the others are "Close".
- **Gemini key pool panel renders a heading and no data** — `HealthPage.tsx:425-434`, on the page whose thesis is that silence must be loud.

---

## Not copy, but it makes copy lie

`ApprovalQueuePage.tsx:318` discards the per-claim `ReadonlyMap<string, ClaimDecision>`
that `DiffView` hands back — the file admits this at `:42-48`. So the Diff view's button
can read *"Approve without 2 claims"* (`DiffView.tsx:445`) while the page records a plain
approval. **The string promises something the handler does not do.** Same handler as
[C2](#c2--approving-produces-no-confirmation-at-all); worth taking together.

---

## Related

- [`README.md`](./README.md) — the `docs/ui/` index and how to pick
- [`audit-accessibility.md`](./audit-accessibility.md) — C5/C6/C24/C27 pair with A11/A9/A17/A3
- [`audit-layout-and-typography.md`](./audit-layout-and-typography.md) — C17 pairs with L5, the serious version
