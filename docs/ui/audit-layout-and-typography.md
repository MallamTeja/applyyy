> **Historical record as of 2026-09-17.** Current state: [README.md](./README.md).

# UI audit — layout, information architecture and typography

**Date:** 2026-09-17 · **Scope:** all CSS and page components under `apps/web/src`
**Status:** findings only. Nothing here is implemented. Pick by ID.

> **Two corrections to the source report, made after checking the tree.** They are recorded
> rather than quietly dropped, because the same mistakes are easy to repeat:
>
> 1. The report claimed `.job-pill--salary` / `.job-pill--cooldown` still carry the dead
>    `[data-theme='dark']` rules. **They do not** — that was fixed in commit `286ea2e`,
>    which landed after the agent read the tree. The finding was true at `c0a7de2` and is
>    now history; see [`theming-convention.md`](./theming-convention.md).
> 2. The report called `health.css:272-289` "orphaned override" on the grounds that
>    `HealthPage.tsx` never renders `.move__button`. **It renders it four times.** The
>    duplicate-selector problem below is real; the proposed "just delete it" fix is not.

---

## The finding behind every other finding

`tokens.css`, `base.css`, `DiffView.css`, `pipeline.css`, `health.css` and `SourceBadge.css`
are a genuinely opinionated design system — they argue for their choices in comments and
the choices are consistent.

`DiscoveredJobsPage.css`, `EmailMonitoringPage.css` and the back half of `settings.css`
(roughly line 1000 onward) **were written as if that system did not exist.**

Almost every finding below is that seam. The repair job is to bring six stylesheets up to
the other six — not to redesign anything.

---

## Tier 1 — things that are visibly broken right now

### L1 · Seven custom properties are used but never defined
Same root cause as [K4](./audit-color-and-theming.md), listed here for the *layout*
consequences. An undefined `var()` is invalid-at-computed-value-time, so the declaration
is dropped silently — radius falls to `0`, `background` falls to `transparent`.

| Undefined | Sites | Should be |
|---|---|---|
| `--radius-md` | `DiscoveredJobsPage.css:16, 76, 297, 311`; `EmailMonitoringPage.css:35, 98, 234, 261` | `--radius-sheet` |
| `--radius-lg` | `DiscoveredJobsPage.css:256` | `--radius-sheet` |
| `--surface` | `DiscoveredJobsPage.css:29, 52, 137, 309`; `DiffView.css:633`; `health.css:282` | `--panel` / `--sheet` |
| `--text` | `DiscoveredJobsPage.css:32, 55, 112, 278` | `--text-primary` |
| `--gap-8` | `DiscoveredJobsPage.css:291` | `--gap-7` |
| `--panel-hover` | `DiscoveryModal.css:97` | `--surface-hover` |
| `--font-mono` | `EmailMonitoringPage.css:276` | `--font-id` |

**What you can see on screen right now:** every job card, both discovery filter bars, the
JD modal and every email card render with **square corners** while every other surface in
the app is 6px. The search input, the filter selects and `.job-pill` render with **no
background fill at all** — which is exactly why the Discovered jobs page looks flat next
to Pipeline or Settings. Card titles inherit `body` colour rather than `--text-primary`.

**~25 lines. Repairs more of the visual system than anything else in this document.**

### L2 · `.move__button` is defined twice, in two features, as a global selector
`pipeline.css:139, 156` and `health.css:273, 286`. Component-imported CSS is still global,
so whichever module-graph edge loads last wins. `health.css`'s copy sets
`text-align: center` and `background: var(--surface)` (undefined → transparent),
overriding pipeline's deliberate `text-align: left; width: 100%` — and
`pipeline.css:141-143` explicitly comments that left alignment is the point, *"so the
target status names line up down the column and can be read as a list."*

**Both pages render this class** (HealthPage four times, PipelinePage once), so neither
block can simply be deleted. **Fix:** rename them apart — `.pipeline-move-button` and
`.health-move-button` — or scope each under its page's root class. A shared name for two
different intentions is the bug.

### L3 · Four `.button--*` modifiers are used but never defined
Verified: **defined in no CSS file**, used in six places.

| Class | Used at |
|---|---|
| `button--primary` | `DiscoveredJobsPage.tsx:613`, `WatchlistPage.tsx:391` |
| `button--secondary` | `DiscoveredJobsPage.tsx:607`, `SearchPreferencesPage.tsx:709` |
| `button--ghost` | `DiscoveredJobsPage.tsx:587` |
| `button--small` | `BlocklistPage.tsx:247` |

So in the JD modal footer, "Open Career Page ↗" (secondary) and "Done" (primary) render
**byte-identically**. `base.css` ships only `.button`, `.button--approve`,
`.button--reject` — a *semantic* pair, not a *hierarchy* pair. **The app has no primary
action anywhere.**

**Fix:** add the four modifiers to `base.css`, or delete the class names so the gap is
visible instead of silent.

### L4 · The email page is the only page not wrapped in `.page`
`EmailMonitoringPage.tsx:191` — `<div className="email-monitor">`. Every other page root
is `.page`. `EmailMonitoringPage.css:11-16` sets only `width: 100%` and `padding-bottom`.

**Result:** the page title, the KPI cards and every email card sit **flush against the
rail's border and the right edge of the viewport**, with zero top padding, where every
other screen has a `--gap-6` gutter. **One line:** `className="page email-monitor"`,
and drop the `width: 100%`.

---

## Tier 2 — states that lie

These are correctness bugs wearing a layout costume. They are the highest-stakes items in
this document.

### L5 · On a database read failure, the Approval Queue says the work is done
`ApprovalQueuePage.tsx:131-133` — `if (error || !data || !live) { return; }`. The error is
swallowed, `queue` stays `[]`, and `:280` renders *"Queue is empty. Applications requiring
review will appear here once tailored."*

`ApprovalQueuePage.css:89-98` gives that box a **`border-left: 3px solid var(--traced)`** —
the verified-green all-clear — with the comment *"it is a statement that the work is done."*

**So a Supabase outage renders as a green "you're finished" on the one screen that gates
irreversible submissions.** This is precisely the failure `base.css:301-316` was written to
prevent — *"an empty cell reads as zero, and zero and unknown are opposite claims."* The
approval queue is the one page that did not get the treatment.

**Fix:** hold the error in state and render a third branch with `--fabricated` framing.
`data/readState.ts` already has the vocabulary; the Pipeline page already uses it.

### L6 · The Pipeline drawer contradicts itself on a failed read
`PipelineDrawer.tsx:48-51` sets `items` to `[]` on error, but the header at `:99` still
prints the board's count. The drawer renders **"12 Applications"** above **"No applications
currently in this status stage."**

### L7 · Discovered jobs has no error state, and its loading state *is* its empty state
`DiscoveredJobsPage.tsx:121-125` — the catch only `console.error`s. On failure the page
shows *"No discovered jobs match your current criteria."* Separately, `:450-453` renders
the **loading** message inside the same dashed box as the **empty** message at `:455`.
One visual container, three meanings.

### L8 · Email monitoring shows "No interview invitations found" while still loading
`EmailMonitoringPage.tsx:291` branches only on `filteredEvents.length === 0`. `loading` is
tracked (`:43`) and drives the button label (`:244`) but never the list, so the empty state
paints on every mount before the query returns.

### Per-page state coverage

| Page | Loading | Empty | Error |
|---|---|---|---|
| **Approval queue** | text in the green all-clear box | green all-clear box | **none** — silently reads as empty |
| **Discovered jobs** | text in the dashed empty box | dashed empty box | **none** — silently reads as empty |
| **Pipeline board** | `…` in the count chip only | **none** (18 columns of `0`) | tiny italic "read failed" |
| **Pipeline drawer** | text in the empty box | ✅ distinct | **none** — contradicts header count |
| Email monitoring | **none** | ✅ | ✅ |
| Settings (all six) | ✅ | ✅ | ✅ |
| Answer bank | ✅ | ✅ | toast only |
| System health | ✅ | ✅ | ✅ |

**The three daily-use Operations screens are the three with the worst coverage.** Settings
and System health — the pages you visit least — are the ones that handle failure properly.

---

## Tier 3 — the PAPER / MACHINE split

This is the one genuinely distinctive idea in the design system (`tokens.css:3-9`): resume
content is set in a serif (PAPER), console chrome in a sans (MACHINE), so the two
materials stay tellable apart. **It is currently applied in nine CSS declarations
app-wide.**

### L9 · The Master Profile page — the canonical PAPER document — is entirely machine sans
`MasterProfilePage.tsx` renders the operator's actual resume: identity, summary, skills,
experience bullets, projects, education. **Not one rule in `settings.css:692-880` sets
`--font-paper`.**

This is the ground-truth document the whole verification desk exists to check against, and
it looks like a settings form. Meanwhile `DiffView.css:404` sets the *tailored copy of
those same bullets* in serif — so the operator sees **the same sentence in two different
typefaces on two screens**, and the split stops meaning "document vs chrome".

**Fix:** `--font-paper` on `.profile-card__name:699`, `.profile-entry-card__role:816`,
`.profile-bullet-item:855` and the summary paragraph.

### L10 · Job title + company are paper on one screen and machine on three others
`ApprovalQueuePage.css:80` sets `.queue__clean-job` in `--font-paper` *with an explicit
rationale* — "this is the job the resume was written for, so it belongs to the document
side." But `DiscoveredJobsPage.css:109`, `PipelineDrawer.css:122` and
`EmailMonitoringPage.css:133` set the same class of content in machine sans.

Same for the full job description (`DiscoveredJobsPage.css:265-272`, `:171`) — a JD is
source material read against the resume.

### L11 · The product wordmark is serif on two screens and sans in the rail
`AppShell.css:301` and `LoginPage.css:39` set "applyy" in `--font-paper`;
`AppShell.css:41` sets the identical string in `--font-machine`. **The wordmark is chrome,
not paper — this is the split running backwards**, and the first two screens an operator
ever sees are the two that get it wrong.

### L12 · Node identifiers set in the machine face at 10px inside a `<code>`
`settings.css:785-789` and `:868`. `base.css:272-284` is explicit: identifiers are "strings
the operator may copy into a SQL query… Monospace here is functional, not stylistic."
10px is also below `--size-2xs` (11px), the floor of the scale. **`.identifier` already
exists and does exactly this job.**

---

## Tier 4 — the type scale

### L13 · Nineteen off-scale font sizes, twelve on the discovery page alone
`DiscoveredJobsPage.css` uses `0.95rem`, `0.85rem` (×4 different roles), `1.15rem`,
`0.82rem`, `0.9rem`. Also `DiffView.css:602, 650, 661` · `DiscoveryModal.css:65, 87, 185` ·
`PipelineDrawer.css:158` · `settings.css:786, 869` (10px, below the floor) ·
`settings.css:1266, 1590, 1870` (`0.7rem`) · `settings.css:1531, 1939, 2023` (`0.72rem`).

`AppShell.css:64` and `pipeline.css:188` both write `0.6875rem` literally — which *is*
`--size-2xs`, so it renders correctly but defeats the point of having a scale.

### L14 · The discovery grid shows nine distinct type sizes in one viewport
1.5 · 1.15 · 0.95 · 0.9 · 0.85 · 0.82 · 0.8125 · 0.75 · 0.6875 rem. **The scale has eight
steps total; this one screen uses nine sizes, six of which are not on it.**

**Fix:** collapse to four — `--size-lg` page title, `--size-md` card title, `--size-base`
body, `--size-sm` meta and chips.

### L15 · Long-form body copy with no line-height and no measure
- `EmailMonitoringPage.css:173` `.email-card__snippet` — **no `max-width`**. Combined with L4 (no `.page` wrapper) a snippet runs the full content width: **≈230 characters per line** at a 1920 viewport.
- `settings.css:855` `.profile-bullet-item` — no cap; **≈150 characters**. Every *other* explanatory string in that file is capped (56ch, 70ch, 66ch); the resume bullets, the most-read text on the page, are not.
- `DiscoveredJobsPage.css:265` `.jd-modal__body` — ≈91 characters.

Contrast `DiffView.css:265` — `max-width: 46ch`, commented *"under 80 characters so the
sentence that stops the operator is actually readable."* **The rule exists; it is just not
applied where the reading happens.**

### L16 · Twelve different measure caps for the same class of prose
46ch, 48ch, 52ch, 56ch, 60ch, 64ch, 65ch, 66ch, 68ch, 70ch, 72ch across eleven files.
**Fix:** add `--measure-tight: 46ch`, `--measure-body: 58ch`, `--measure-wide: 68ch` to
`tokens.css` and map all of them on.

### L17 · Seven font-weight values for overlapping roles
450, 500, 550, 600, 650, 700, plus `font-weight: normal` inline at `AnswerBankPage.tsx:315`.
The same "big stat number" role is 700 in `EmailMonitoringPage.css:53`, 600 in
`settings.css:898`, and 700 in `DiscoveryModal.css:186`.

`tokens.css` defines `--font-weight-page-title: 650`, `--font-weight-section-header: 600`
and `--font-weight-card-header: 600` — **none of the three is ever referenced**; every
heading restates the number. See also [K17](./audit-color-and-theming.md).

---

## Tier 5 — the job-card grid

### L18 · Up to seven competing chips per card
`DiscoveredJobsPage.tsx:465-530` — one card can carry a drop banner, a source badge, an
employment-type pill, a work-arrangement pill, a location pill, a salary pill and a
cooldown pill. Every one of them is coloured; **nothing is quiet, so nothing signals.**

*(The report's claim that the salary and cooldown pills still carry the dead
`[data-theme]` rules is stale — fixed in `286ea2e`. The density problem stands.)*

### L19 · Nothing on the card is scannable, and the company name is the quietest thing on it
`DiscoveredJobsPage.css:101-107` — `.job-card__company` is
`text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted)`.

So the **company** — the single most scannable token on the card, and the field that
actually varies — is rendered as a muted tracked-out eyebrow, while the generic role title
("Software Engineer", repeated across dozens of cards) is the 1.15rem/600 focal point.
Uppercasing also destroys proper-noun casing: eBay → EBAY, iRobot → IROBOT.

**Result: a grid of 300 cards where every card looks the same and the one varying field is
the faintest.** This is the finding most likely to change how the page actually feels.

**Fix:** swap the hierarchy — company at `--size-md`/600 in `--text-primary`, role beneath
it at `--size-base`, sentence case throughout. A `fit_score` badge would give the grid
something to sort and scan by; the data already exists (`PipelineDrawer.tsx:59` reads it).

### L20 · The description is truncated twice, by two mechanisms, with two different ellipses
`DiscoveredJobsPage.tsx:539` does `.slice(0, 220)` **plus a literal `'...'`**, while
`DiscoveredJobsPage.css:171-180` *also* applies `-webkit-line-clamp: 3`. Whichever fires
first wins, so the card either shows a hard `...` mid-sentence or a clamped fade with an
invisible `...` below the fold — **and you cannot predict which**. Line 503 truncates
location with `.slice(0, 26)` plus a proper `…` (U+2026). Two strategies, two ellipsis
characters, one component.

**Fix:** delete the JS `.slice()` calls. Character-count truncation cuts mid-word and
ignores the rendered width.

### L21 · The accent fill is spent on every card, on every page
`settings.css:280-287` states the ingest button is *"the one place in the console that gets
[the accent fill] — the single restrained accent is spent on the primary action of the
whole ingest flow and nowhere else."*

It is in fact on `.job-card__tailor-btn` (**once per card — 300× on a full grid**),
`.btn-dispatch--remote`, `.btn-primary`, `.button--search`, `.button--suggest:hover`,
`.suggestions-tab--active`, `.login-form__submit-btn` and `.line__edit-trigger:hover`.
The scarcity argument is no longer true anywhere.

---

## Tier 6 — the same job done several ways

### L22 · Discovery has two stacked filter bars with different shapes
`.discovery__cascade-header` (horizontal, `--surface`-backed, tabs at 3px **plus**
`.chip-btn` pills at **9999px**) sits directly above `.discovery__controls` (vertical,
`--panel`-backed, controls at 3px). Two bars, two surfaces, two orientations, three radii,
both filtering the same list. `EmailMonitoringPage.css:57` is a third shape for the same
job; `settings.css:157` a fourth.

### L23 · `.chip-btn` is a 9999px pill, which tokens.css names as the thing not to do
`settings.css:192-196`. `tokens.css:178` — *"Refined, modern radii: no oversized tacky
pills."* Used on the discovery bar directly beside a 3px tab and a 4px toggle: **three
radii in one 40px-tall row.** Also `settings.css:1333` (20px) and `:1533` (10px).

### L24 · Five modal shells, four radii, four elevations, five z-index magic numbers
| Modal | Radius | Max width | z-index |
|---|---|---|---|
| `.palette-modal` | `--radius-sheet` | 36rem | 10000 |
| `.discovery-modal` | `--radius-sheet` | 38rem | 9500 |
| `.drawer` | none | 32rem | 9000 |
| `.jd-modal` | `--radius-lg` → **0** | **720px** | 1000 |
| `.suggestions-modal` | **12px** | **980px** | 1000 |

Backdrops disagree too: 0.55+blur(2px), 0.55+blur(4px), 0.45+blur(3px), 0.65+blur(4px).
**Fix:** one `.modal`/`.modal-backdrop` primitive in `base.css` plus a `--z-*` set in
`tokens.css`.

### L25 · Card shapes: four variants of "a record in a list"
`.job-card` (`--panel`, radius 0, `--gap-4`, shadow hover) · `.email-card` (`--sheet`,
radius 0, `--gap-3`, border hover) · `.company-card` (`--sheet`, `--radius-sheet`,
`--gap-3/4`, `--lift` hover) · `.drawer__app-card` (`--ground`, `--radius-sheet`,
`--gap-4`, `--lift` hover). Four backgrounds, three paddings, three hover elevations.

### L26 · Two near-duplicate table definitions, and the longest table is the one missing sticky headers
`health.css:79-117` and `settings.css:119-152` are the same rules with **one** difference:
settings makes `th` sticky and health does not. Health's freshness table is the longest in
the app and is the one that loses its headers on scroll. **Fix:** one `.table` in
`base.css` with sticky `thead th`.

### L27 · Breakpoints: three values, no scale, two in px
`AppShell.css:318` 52rem · `DiffView.css:575` 62rem · `settings.css:411` 40rem ·
`settings.css:934` **768px** · `settings.css:1459` **640px**. The px ones ignore the user's
browser font size.

**And the diff view's breakpoint measures the wrong thing.** `DiffView.css:575` stacks the
panes at 62rem viewport, but the shell reserves `--rail-width: 14.5rem` and the rail only
collapses at 52rem. At a 63rem viewport the panes are two columns inside ≈44.5rem →
**≈21rem per pane of serif resume prose ≈ 34 characters.** The breakpoint is off by the
width of the rail. **Fix:** `container-type: inline-size` on `.shell__main` with
`@container (max-width: 47rem)`, or raise the media query to 76.5rem.

---

## Tier 7 — template chrome

### L28 · `--lift` is bypassed twenty times
`tokens.css:11-13` — *"elevation is expressed as a LIGHTER surface in both directions,
never as a heavier shadow"* — and `--lift` is themed the long way specifically so shadows
invert on dark. Twenty declarations write their own black shadow, so on the dark theme
those surfaces get a **black smear** where `--lift` would have given a top highlight.
Notably `base.css:224` — the shared `.button` — hardcodes one **two lines after `--lift`
was defined for exactly this**. See also [K12](./audit-color-and-theming.md).

### L29 · Thirteen ALL-CAPS tracked-out eyebrow labels
Three earn it and say why in comments. The other ten are decoration. **`AppShell.tsx:86-87`
carries the comment "Sentence case, not a tracked-out capitals eyebrow" directly above
`.rail__heading`, which is `text-transform: uppercase; letter-spacing: 0.06em`** — the
comment and the CSS disagree.

### L30 · Thirty OS emoji used as iconography
`SourceBadge.css:117-120` now states the reasoning for removing them: full-colour OS emoji
*"fought this low-chroma palette and rendered differently on every machine."* The rest of
the app ships about thirty — the loudest, most saturated objects on every screen, in a
console whose stated rule is that colour is never decorative. Pairs with
[A10](./audit-accessibility.md), which is the accessibility half of the same sweep.

### L31 · `↗` appended to link text
`DiscoveredJobsPage.tsx:552, 609` · `EmailMonitoringPage.tsx:316`. Decoration rather than a
standard external-link affordance — `target="_blank"` is already announced.
*(`HealthPage.tsx` uses `→` as a state-transition operator, which is load-bearing and fine.)*

### L32 · `settings.css:730` — `.profile-link-badge { }` is an empty block
The class is rendered at `MasterProfilePage.tsx:266`, so those links get no styling at all.

---

## What is genuinely good — leave it alone

`styles/tokens.css` (the `light-dark()` argument at `:24-50` is correct and rare),
`styles/base.css`, `DiffView.css:1-595`, `pipeline.css:1-192`, `health.css:1-270`,
`SourceBadge.css`, and `AppShell.css:312-379` (the narrow-viewport rail, with its reasoning
for a strip over a hamburger).

---

## Suggested order of work

1. **L1, L2, L3, L4** — mechanical, roughly an hour, fixes the most visible breakage.
2. **L5, L6, L7, L8** — correctness, not polish. L5 is the one that can cost you a submission.
3. **L9–L12** — the PAPER/MACHINE split, currently applied in nine declarations.
4. **L19 + L20**, then **L13–L15** on the same page.
5. **L22–L28** — consolidate the duplicated primitives into `base.css`.

---

## Related

- [`README.md`](./README.md) — the `docs/ui/` index and how to pick
- [`theming-convention.md`](./theming-convention.md) — why the stale finding is stale
- [`audit-color-and-theming.md`](./audit-color-and-theming.md) — L1/L28 are K4/K12
- [`audit-accessibility.md`](./audit-accessibility.md) — L30 is the visual half of A10
