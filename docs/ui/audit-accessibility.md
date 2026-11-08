# UI audit — accessibility and interaction

> **Status 2026-11-08:** Partly superseded. Checked at `2a9ac31`: still open are A1 and A2 (focus ring overridden by a faint glow, `apps/web/src/features/settings/settings.css:2174`, `apps/web/src/features/discovery/DiscoveredJobsPage.css:40`), A3 (click-only `<div>` at `DiscoveredJobsPage.tsx:1010`), A4 (`apps/web/src/features/pipeline/DiscoveryModal.tsx` has no `role="dialog"`), A5 (dialog role still on the scrim, `DiscoveredJobsPage.tsx:1144`), A7 on the Answer Bank (`AnswerBankPage.tsx`, `AddQuestionModal.tsx` have no `aria-pressed`; `EligibilityAnswers.tsx:363` does) and A14 (no skip link). A6 no longer applies: the DiffView view toggle it described is gone, and the new controls use `aria-pressed` (`apps/web/src/features/approval/DiffView.tsx:385`). A9 is partly addressed: many pages now carry `aria-live` or `role="status"` regions (`git grep -c "aria-live" -- apps/web/src`). Other findings were not re-checked; line numbers below are from 2026-09-17. Current index: [README.md](./README.md). The body below is the original record, unedited.

**Date:** 2026-09-17 · **Scope:** every `.tsx` and `.css` under `apps/web/src`
**Status:** findings only. Nothing here is implemented. Pick by ID.

Two categories came back **clean** and are recorded here so nobody re-checks them:

- **Reduced motion** — `styles/base.css:106-114` has a global `@media (prefers-reduced-motion: reduce)` block zeroing `animation-duration`, `animation-iteration-count` and `transition-duration` with `!important` on `*, *::before, *::after`. Every keyframe in the app is covered. *(Caveat: this is also why [K9](./audit-color-and-theming.md) matters — it removes a status's only second channel for exactly the users who need it.)*
- **Table semantics** — `<th scope="col">`/`<th scope="row">` used consistently and correctly in WatchlistPage, AnswerBankPage, BlocklistPage and all six HealthPage tables. No sortable headers, so no `aria-sort` gap. Lists are real `<ul>/<li>`.

---

## The pattern behind most of this

**One CSS specificity mistake, repeated in three files.** The global focus ring lives at
`styles/base.css:97-100` inside `:where(a, button, input, …):focus-visible`.
**`:where()` contributes zero specificity**, so that rule scores `(0,1,0)`. Any
component rule like `.answer-bank__input:focus` scores `(0,2,0)` and **wins** — silently
replacing the app's focus indicator with whatever that component happened to write.

This is worth naming because it is not a mistake anyone makes on purpose: `:where()` is
used deliberately in `base.css` so components *can* override it. The cost is that a
component which writes `outline: none` plus a weak `box-shadow` has no idea it just
deleted the accessibility baseline.

---

## Tier 1 — pick these first

### A1 · Focus ring destroyed on every Answer Bank input
`features/settings/settings.css:1899-1906` and `:1916-1925`

```css
.answer-bank__input { … outline: none; }                        /* :1900 */
.answer-bank__input:focus { border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(79, 70, 229, 0.15); }              /* :1903-1906 */
```

The base rule sets `outline: none` itself and makes the `box-shadow` the *entire*
indicator. This override replaces it with a **2px indigo glow at 15% alpha** — roughly
**1.1:1** against `--ground`. A keyboard user editing the answer bank has no idea where
they are.

Affects every control in `AddQuestionModal` (`:177, 194, 209, 228, 265, 274, 283, 298`)
and every inline editor in `AnswerBankPage` (`:335, 420, 432, 442, 455, 487, 498`).

**Fix:** delete both `:focus` `box-shadow` declarations and let the base rule apply — or
restate it verbatim: `box-shadow: 0 0 0 1px var(--accent), 0 0 0 3px var(--accent-subtle)`.
Change the selector to `:focus-visible` so a mouse click does not ring the field.
Same edit also resolves [K13](./audit-color-and-theming.md).

### A2 · Same override, Discovered Jobs search
`features/discovery/DiscoveredJobsPage.css:33, 37-40` — `outline: none` then
`box-shadow: 0 0 0 2px var(--accent-subtle)`. `--accent-subtle` is a **wash** designed
to sit *behind* the 1px solid `--accent` ring (`tokens.css:110`), not to be the ring.
Used alone it is the whole indicator, and the border-colour change is the only real
signal — which is colour-only.

**Fix:** `box-shadow: 0 0 0 1px var(--accent), 0 0 0 3px var(--accent-subtle)` on `:focus-visible`.

> This file is in my write partition. Flagging rather than fixing, because it belongs
> with A1 and A16 as one change — the same mistake in three files should land in one commit.

### A3 · Click-only job-description expander — a genuine keyboard dead end
`features/discovery/DiscoveredJobsPage.tsx:534-540`

```tsx
<div className="job-card__description" onClick={() => setActiveJdModal(job)}
     title="Click to view full job description">
```

No `role`, no `tabIndex`, no `onKeyDown` — paired with `DiscoveredJobsPage.css:179-188`
setting `cursor: pointer`, so it **looks** interactive to a mouse user and is completely
unreachable by keyboard or screen reader.

This is the **only** way to read a full job description from the card grid — the "Apply
Link ↗" anchor goes off-site. So keyboard-only and screen-reader users cannot read job
descriptions at all.

**Fix:** make it a real `<button type="button">` with `text-align: left` (`-webkit-line-clamp`
works fine on a button), or add `role="button" tabIndex={0}` plus an Enter/Space handler —
the pattern already used correctly at `PipelinePage.tsx:115-127`. Smallest diff in this
document for the largest removal of a hard block.

### A4 · `DiscoveryModal` is not a dialog at all
`features/pipeline/DiscoveryModal.tsx:59-60` — no `role="dialog"`, no `aria-modal`, no
`aria-labelledby` (the `<h2>` at `:67` is right there), **no Escape handler**, no focus
move on open, no focus restore on close. The backdrop is a bare `<div onClick>`.

Worse: the ✕ button at `:78-86` is **conditionally removed while `running`**, so during
a scan there is *no* keyboard exit from the modal at all.

Opened from three places: `PipelinePage.tsx:224`, `DiscoveredJobsPage.tsx:623`,
`WatchlistPage.tsx:492`.

### A5 · Job-description modal: dialog role on the scrim
`features/discovery/DiscoveredJobsPage.tsx:573-579` — `role="dialog" aria-modal="true"`
is on the **backdrop**, so the scrim is announced as the dialog and the actual panel is
just a div. No accessible name, no Escape, no focus trap, no focus restore.

### A6 · `role="radiogroup"` containing plain buttons — invalid ARIA
`features/approval/DiffView.tsx:521-536` — a `radiogroup` whose children are `<button>`
(implicit role `button`, not `radio`) with **no `aria-checked`**. Screen readers announce
a radio group containing zero radios. Which view is active is conveyed only by a CSS class
(`DiffView.css:505-510`). No arrow-key roving. This is on the most consequential screen
in the product.

**Fix:** simplest robust option — drop `role="radiogroup"` and use
`aria-pressed={viewMode === 'split'}` on two toggle buttons.

### A7 · Yes/No answer buttons signal by colour alone
`AnswerBankPage.tsx:399-412` and `AddQuestionModal.tsx:249-262`

Both buttons always render `✓ Yes (True)` / `✕ No (False)` **regardless of state**. The
only difference between chosen and not-chosen is a green or red tint
(`settings.css:1969-1979`). No `aria-pressed`.

**A colour-blind operator cannot tell which answer is stored** — for questions like work
authorisation and notice period. Compounded by [K5](./audit-color-and-theming.md): those
same tints measure 3.5:1 in dark.

**Fix:** `aria-pressed` on each, plus a non-colour marker (filled vs hollow indicator, or
drop the glyph from the unselected one).

---

## Tier 2 — overlays, state, and announcements

### A8 · No focus trap, no initial focus, no focus restore on any overlay

| Overlay | role/aria-modal | Escape | Trap | Initial focus | Restore |
|---|---|---|---|---|---|
| `CommandPalette.tsx:146-155` | ✓ *(on backdrop)* | ✓ `:109-114` | ✗ | ✓ `:107` | ✗ |
| `PipelineDrawer.tsx:86-94` | ✓ *(on backdrop)* | ✓ `:75-83` | ✗ | ✗ | ✗ |
| `CompanySuggestionsModal.tsx:183-189` | ✓ | ✓ `:79-88` | ✗ | ✗ | ✗ |
| `AddQuestionModal.tsx:137-144` | ✓ | ✗ | ✗ | ✓ `:185` | ✗ |
| `DiscoveryModal.tsx:59-60` | ✗ | ✗ | ✗ | ✗ | ✗ |

`aria-modal="true"` tells assistive tech the background is inert but **does nothing for
Tab**. In all five, a keyboard user tabs straight out of the overlay into the 15-link nav
rail behind it with no visual indication of where they went. On close, focus lands on
`<body>` and the next Tab restarts from the top of the document.

The `role`/`aria-modal`-on-the-backdrop bug repeats in `CommandPalette.tsx:151-153` and
`PipelineDrawer.tsx:91-93`.

**Fix:** one shared `useModalDialog(ref, onClose)` hook — store `document.activeElement`
on mount, focus the panel (`tabIndex={-1}`), trap Tab/Shift-Tab, bind Escape, restore on
unmount. **A4 and A5 then fall out of it almost for free.** This is the highest-leverage
item in Tier 2.

### A9 · Async status and error messages are not announced
Only four live regions exist in the entire app (`Toast.tsx:47`, `AppShell.tsx:50`,
`LoginPage.tsx:141, 149`). Everything else changes silently:

- `DiscoveryModal.tsx:91-94` — the scan progress text is the **only** feedback during a long network operation. Needs `role="status"`.
- `EmailMonitoringPage.tsx:277-281` / `:284-288` — `role="status"` / `role="alert"`.
- `FiltersPage.tsx:296-303` — save banner.
- `WatchlistPage.tsx:316-319`, `BlocklistPage.tsx:144-145`.
- `CompanySuggestionsModal.tsx:387-391` — purely visual, auto-clears in 2.5s.
- `DiscoveredJobsPage.tsx:431-445` — "Showing N of M" updates live as you type; no `aria-live`.
- `DiffView.tsx:603-608` — the gate note ("N claims need a decision") shrinks as you decide and the Approve button flips from disabled to enabled. **Neither is announced, so a screen-reader user cannot tell they have unblocked the gate.**

Also: `Toast.tsx:47` uses `role="status"` + `aria-live="polite"` for **all three** kinds
including `error`. Errors belong in an assertive region. *(See [C6](./audit-copy-and-ux.md) —
error toasts also vanish in 3.2s.)*

### A10 · Emoji leak into accessible names, app-wide
**The codebase already knows the right pattern** — `DiscoveredJobsPage.tsx:469`,
`CommandPalette.tsx:157`, `AnswerBankPage.tsx:234`, `Toast.tsx:51`, `LoginPage.tsx:142, 150`
and `StatusBadge.tsx:28` all hide their glyphs correctly with `aria-hidden`. Everywhere
else does not, so buttons announce as *"globe showing Europe-Africa Find Remote Jobs
(Global)"*:

`PipelinePage.tsx:204, 210, 218` · `DiscoveredJobsPage.tsx:288, 297, 307, 318, 327, 336,
346, 356` (every tab and toggle) and `:503, 509, 526` (the pill prefixes) ·
`DiscoveryModal.tsx:63-65, 123` · `PipelineDrawer.tsx:141` ·
`CompanySuggestionsModal.tsx:47-50, 172, 221, 260, 342, 427` · `AnswerBankPage.tsx:199,
202, 206, 226, 273, 311, 514, 530, 545, 578` · `FiltersPage.tsx:246, 261, 292, 405` ·
`AddQuestionModal.tsx:148` · `WatchlistPage.tsx:396` · `EmailMonitoringPage.tsx:218` ·
`DiffView.tsx:394`.

**One case is genuinely meaningful, not decorative:** `DiffView.tsx:129-141` — the
`✓ {kw}` / `⚠ {kw}` / `✕ {kw}` chips carry matched-vs-flagged-vs-missing in the glyph, the
colour and a `title`. A screen reader gets *"check mark Kubernetes"* with no word for the
state. **Fix:** a `visually-hidden` word — the helper already exists at `base.css:290-299`
and the same file uses it correctly at `DiffView.tsx:270, 278`.

### A11 · Icon-only delete button whose accessible name is an emoji
`AnswerBankPage.tsx:581-588` — accessible-name computation takes text content **before**
`title`, so this announces as *"wastebasket, button"* and the `title` never fires. It is
the only destructive per-row control on the page and sits beside a "📋 Copy" button.
Pairs with [C5](./audit-copy-and-ux.md).

**Fix:** `aria-label` on the button, `aria-hidden` on a span wrapping the emoji.

### A12 · Four hit targets under 24×24 CSS px
- `Toast.css:91-102` — `.toast__close`, ~16×16, on a control that auto-disappears in 3.2s and sits over page content.
- `settings.css:1200-1211` — `.suggestions-search-clear`, ~21px, absolutely positioned over the input.
- `settings.css:1934-1943` — `.answer-bank__quick-pill`, ~22px, **twenty of them** on the page.
- `DiffView.css:598-607` — `.line__edit-trigger`, ~23px.

**Fix:** `min-height: 24px; min-width: 24px; display: inline-flex; align-items: center; justify-content: center`.

### A13 · Selected state of button groups exists only in CSS
Beyond A7: `CompanySuggestionsModal.tsx:267-301` (five category tabs) ·
`AnswerBankPage.tsx:256-275` (category chips) · `DiscoveredJobsPage.tsx:312-328` (the two
toggle pills — fine on colour, since the label text itself changes, but no `aria-pressed`).

`DiscoveredJobsPage.tsx:280-309` sets `role="tablist"` + `role="tab"` + `aria-selected`
but there is **no `role="tabpanel"`** for the tabs to control and no roving `tabIndex`.
Either complete the pattern or downgrade to `aria-pressed` toggle buttons.

### A14 · No skip link, and no focus or announcement on route change
`AppShell.tsx:156-162`. The comment at `:158-159` says `<main>` lets screen readers skip
the rail — true for SR users, but a **keyboard-only sighted user** still tabs through the
search button, ~15 nav links, the 3-segment theme control and sign-out **on every single
navigation**.

Compounding it: `App.tsx:30-62` swaps the `<Outlet>` with no focus management. Focus stays
on the link, the document title never changes, nothing is announced — an SR user has no
signal the page changed.

**Fix:** a `<a href="#main">Skip to content</a>` as the first child of `.shell` (visually
hidden until `:focus` — the helper exists at `base.css:290-299`), `id="main" tabIndex={-1}`
on `<main>`, and a route-change effect focusing `<main>` or the `<h1>`. `PageHeader.tsx:32`
already renders exactly one `<h1>` per screen, so it is a clean target.

---

## Tier 3

### A15 · Interactive pipeline headers have no hover or pointer affordance
`PipelinePage.tsx:115-127` correctly adds `role="button" tabIndex={0}` and an Enter/Space
handler — the keyboard side is right. But `.column__head--interactive` **has no CSS rule
anywhere**; `pipeline.css:82-90` only styles `.column__head`. So there is no
`cursor: pointer` and no hover change: nothing but a `title` tooltip says these 15 headers
open a drawer.

### A16 · `.login-form__input` focus ring is a bare 1px
`features/auth/LoginPage.css:148, 152-155` — same specificity override as A1/A2, but at
least a solid `--accent` ring, so it is visible. Still thinner than the app standard and
drops the halo; WCAG 2.2 SC 2.4.13 wants ≥2px. Change to `:focus-visible` and use the base
two-stop shadow. **Fix with A1 and A2 as one commit.**

### A17 · Explanatory `title` on `disabled` buttons is unreachable
`HealthPage.tsx:651, 698, 741, 781` — disabled elements are out of the tab order and do
not fire tooltips on keyboard focus, so the one sentence explaining *why* the control is
dead is mouse-hover-only. `PipelinePage.tsx:160` has the same disabled button with **no**
title at all.

**Fix:** `aria-disabled="true"` + a no-op handler (keeps it focusable), or render the
reason as visible text. Pairs with [C11](./audit-copy-and-ux.md), which rewrites that
sentence out of design-review jargon.

### A18 · Unlabelled inputs
- `AnswerBankPage.tsx:235-241` and `CompanySuggestionsModal.tsx:230-236` — search inputs with only a `placeholder`, which is not an accessible name in several SR/browser combinations and vanishes on input. (`EmailMonitoringPage.tsx:228-235` gets this right.)
- `AnswerBankPage.tsx:335, 420, 432, 442, 455, 487, 498` — inline editors inside a `<td>`. The row header carries the question text, which helps in table-navigation mode but gives the control no name in forms mode. Add `aria-label={question.asks}`.

### A19 · Command palette: no `aria-activedescendant`, input unlabelled
`CommandPalette.tsx:158-165, 170-189` — the `<ul role="listbox">`/`<li role="option">`
pattern is there, but the `<li>`s are never focused and nothing points the input at the
active option. Arrow-key navigation at `:126-131` produces **zero** screen-reader output;
the user hears nothing until Enter changes the route.

**Fix:** `role="combobox" aria-expanded="true" aria-controls="palette-list"
aria-activedescendant={…} aria-label="Search screens and actions"` on the input,
`id="palette-list"` on the `<ul>`, `id={item.id}` on each `<li>`.

### A20 · Smaller items
- **No `<caption>` on any table** — `WatchlistPage.tsx:408`, `AnswerBankPage.tsx:281`, `BlocklistPage.tsx:216`, `HealthPage.tsx:141, 482, 637, 678, 723, 767, 818`. Each is preceded by a heading, so low value — except on HealthPage, where six tables sit on one screen.
- **`CompanySuggestionsModal` has no header close button** — `:190-201`, the comment literally reads `{/* Modal Header without ✕ button */}`. Exit is Escape, backdrop click, or a "Done" button below a scrolling body, so on a short viewport there is no visible exit without scrolling.
- **Undefined tokens break a hover state** — `DiscoveryModal.css:95-98` uses `var(--panel-hover)`, which resolves to transparent, leaving the close button's hover as a colour-only text shift. See [K4](./audit-color-and-theming.md).

---

## Suggested order of attack

1. **A1 + A2 + A16** together — the same one-line specificity mistake in three files.
2. **A3** — smallest diff, removes an outright keyboard dead end.
3. **A8** as a shared hook — **A4 and A5 then fall out for free.**
4. **A6 + A7 + A13** — all "state exists in CSS only"; one `aria-pressed` pass.
5. **A9** — mostly adding `role="status"`/`role="alert"` to elements that already exist.
6. **A10 + A11** — mechanical `aria-hidden` sweep; the correct pattern is already in the codebase in seven places.

---

## Related

- [`README.md`](./README.md) — the `docs/ui/` index and how to pick
- [`audit-color-and-theming.md`](./audit-color-and-theming.md) — A1/A7/A20 pair with K13/K5/K4
- [`audit-copy-and-ux.md`](./audit-copy-and-ux.md) — A9/A11/A17 pair with C6/C5/C11
