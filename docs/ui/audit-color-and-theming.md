# UI audit — colour and theming

> **Status 2026-11-08:** Partly superseded. Checked at `2a9ac31`: K1 is fixed (`--text-muted` is now `light-dark(#5b6675, #818b9b)`, `apps/web/src/styles/tokens.css:98`, 5.10:1 on `--sheet` in dark) and the false "AA certified" label is gone (`tokens.css:77`). K6 is fixed (dark `--accent` is `#787cf5`, `tokens.css:133`, 5.02:1 on `--sheet`). K4 is fixed for `--surface` (now only in a comment, `apps/web/src/features/health/health.css:359`). K2 is softened, not gone: status hexes still appear as literal `light-dark()` pairs outside the token file (e.g. `apps/web/src/styles/base.css:449`, `apps/web/src/features/settings/settings.css:1013`). K14 still holds (`--traced-ink` equals `--traced`, `tokens.css:106` and `:140`). Other findings were not re-checked. The current rule is in [theming-convention.md](./theming-convention.md). The body below is the original record, unedited.

**Date:** 2026-09-17 · **Scope:** all 16 `.css` files under `apps/web/src`, plus inline `style={{}}` in all 27 `.tsx`
**Status:** findings only. Nothing here is implemented. Pick by ID.

Contrast ratios were computed by the auditing agent and then **re-derived independently**
from the WCAG relative-luminance formula before this file was written. The two agreed to
within 0.25 — e.g. `--text-muted` on `--sheet` measured 3.63:1 here vs 3.65:1 reported.
Where they differ, the number below is the re-derived one. Every ratio quoted is a
verdict (pass/fail) that both methods agree on.

Grounds used: `--sheet` `#151924` · `--panel` `#0f121a` · `--ground` `#090b10` (dark);
`#ffffff` · `#f1f3f5` · `#f8f9fa` (light). Translucent washes composited over the ground first.

The [`light-dark()` convention](./theming-convention.md) is a separate, already-fixed
issue — it is not repeated here.

---

## The pattern behind most of this

`tokens.css` states two house rules in its own header:
**(a)** every hue carries exactly one meaning, and the interactive accent carries none of them;
**(b)** no status relies on hue alone — each pairs colour with a second channel.

Both are currently violated, and the mechanism is the same in every case: a component
**restates a colour as a literal** instead of referencing the token. Once the literal
exists, nothing ties it to the meaning, so the hue drifts into a second job and the
second channel gets dropped. There are currently **seven greens, three reds and two
purples** in a system that declares three semantic hues.

---

## Tier 1 — pick these first

### K1 · `--text-muted` fails AA in dark on every surface — ~88 call sites
`apps/web/src/styles/tokens.css:83` — `--text-muted: light-dark(#64748b, #6b7280)`

| | on `--sheet` | on `--panel` | on `--ground` |
|---|---|---|---|
| **dark** `#6b7280` | **3.63:1** ✗ | **3.87:1** ✗ | **4.07:1** ✗ |
| **light** `#64748b` | 4.76:1 ✓ | **4.28:1** ✗ | 4.51:1 ✓ |

Needs 4.5:1. `--text-muted` (30 uses) plus its alias `--ink-muted` (`tokens.css:88`,
58 uses) = **~88 call sites**, almost all at 12–13px: helper text, timestamps,
`.identifier`, empty states, `.field__help`, `::placeholder`.

The light half fails on `--panel`, which is the **nav rail background** — so
`.rail__role` (`AppShell.css:49`) and `.rail__heading` (`AppShell.css:63`) fail in
light theme too.

**`tokens.css:76` claims "WCAG AA certified" for this block. That claim is false.**

**Fix:** dark half → `#818b9b` (**5.10:1** on `--sheet`); light half → `#5b6675`
(**5.24:1** on `--panel`). Then correct or delete the "AA certified" comment. One
token edit fixes all 88 sites — the highest leverage change in this document.

### K2 · Four status tokens restated verbatim as literals in three files
`apps/web/src/styles/base.css:374-457` · `features/settings/settings.css:947-975` ·
`features/emails/EmailMonitoringPage.css:207-227`

Byte-for-byte duplicates of tokens that already exist:

| literal | the token it duplicates | restated at |
|---|---|---|
| `light-dark(rgba(22,163,74,.08), rgba(34,197,94,.12))` | `--traced-wash` (`tokens.css:117`) | base.css:374, settings.css:966, EmailMonitoringPage.css:207 |
| `light-dark(#15803d, #4ade80)` | `--traced` (`tokens.css:115`) | base.css:375, settings.css:967, EmailMonitoringPage.css:208 |
| `light-dark(rgba(217,119,6,.08), rgba(245,158,11,.12))` | `--signal-wash` (`tokens.css:127`) | base.css:392 |
| `light-dark(#b45309, #fbbf24)` | `--signal` (`tokens.css:125`) | base.css:393 |
| `light-dark(rgba(225,29,72,.08), rgba(244,63,94,.12))` | `--fabricated-wash` (`tokens.css:122`) | base.css:445, EmailMonitoringPage.css:213 |
| `light-dark(#be123c, #fb7185)` | `--fabricated` (`tokens.css:120`) | base.css:446, EmailMonitoringPage.css:214 |

**The drift has already started.** `base.css:376` uses alpha `0.22/0.25` where
`--traced-edge` (`tokens.css:92`) is `0.25/0.25`. And `base.css:383` introduces a
**sixth green** — `light-dark(#16a34a, #22c55e)` — matching neither `--traced` nor
`--traced-strong`.

**Fix:** replace every one with the `var()`. This is the finding that stops the
others recurring.

### K3 · Three hardcoded colours that are unreadable in one theme
| ID | file:line | measured | what happens |
|---|---|---|---|
| K3a | `features/emails/EmailMonitoringPage.css:286-287` — `.store-notice--info`, `color:#a5b4fc` | **1.99:1** on white | Invisible in light theme. Both values are the *dark* half of the accent, hardcoded with no `light-dark()`. |
| K3b | `features/emails/EmailMonitoringPage.tsx:201` — `style={{color:'#4ade80'}}` on a 28px/700 stat value | **1.74:1** on white | Fails even the 3:1 large-text bar. Its sibling at `:207` correctly uses `var(--accent)` — the inconsistency is *within one component*. |
| K3c | `features/emails/EmailMonitoringPage.tsx:305` — `borderLeft:'3px solid #4ade80'` | ~1.7:1 | Same literal, same file. |

**Fix:** K3a → `background: var(--accent-subtle); color: var(--accent-strong)`
(7.9:1 light / 5.9:1 dark). K3b and K3c → `var(--traced)`.

### K4 · Five tokens referenced but never declared — the property silently drops
`--surface`, `--panel-hover`, `--radius-md`, `--radius-lg`, `--font-mono`, `--text`,
`--gap-8` appear in `var()` and exist nowhere in `tokens.css`. An undefined `var()`
is invalid-at-computed-value-time, so the declaration falls back to `inherit`/`initial`
with **no error anywhere**:

- `features/health/health.css:282` — `.move__button { background: var(--surface) }` → **transparent**. The health page's recovery buttons have no fill.
- `features/approval/DiffView.css:633` — `.line__edit-textarea` → **transparent**. The inline resume editor has no background.
- `features/pipeline/DiscoveryModal.css:97` — `var(--panel-hover)` → **no hover feedback** on the modal close button.
- `features/emails/EmailMonitoringPage.css:35, 98, 234, 261` — `var(--radius-md)` → **`0`**. Every email card is square while every other card in the app is 6px.
- `features/emails/EmailMonitoringPage.css:276` — `var(--font-mono)` → the URL input silently loses monospace. The real token is `--font-id`.

**Fix:** `--surface`→`var(--sheet)`, `--panel-hover`→`var(--surface-hover)`,
`--radius-md`→`var(--radius-sheet)`, `--font-mono`→`var(--font-id)`.
**Worth adding a CI grep** for `var(--[a-z-]*)` names not declared in `tokens.css` —
this class of bug is completely silent.

### K5 · Hardcoded light-theme colours on Answer Bank controls
- `settings.css:1851-1857` — `color:#b45309` on an amber wash → **2.85:1 in dark**, at 12px.
- `settings.css:1873-1875` — `color:#d97706` → **4.22:1 in dark**, at 0.7rem/700.
- `settings.css:1969-1979` — the yes/no buttons: `#059669` → **3.54:1 dark**; `#dc2626` → **3.56:1 dark**. Also a *seventh* green and a *third* red.
- `settings.css:2068-2073` — same red pair on the delete button.

**Fix:** `--signal-wash`/`--signal` and `--traced`/`--fabricated` families throughout.
Pairs with [A7](./audit-accessibility.md) — the same yes/no buttons also signal by
hue alone, and they store answers to questions like work authorisation.

---

## Tier 2 — the house rules

### K6 · `var(--accent)` as *text* fails AA in dark — 3.93:1
`--accent` dark is `#6366f1`. As small text on `--sheet` that is **3.93:1**.
Sites: `AppShell.css:193` · `Toast.css:81` · `DiffView.css:87, 670` ·
`LoginPage.css:80, 199` · `EmailMonitoringPage.css:148` · `DiscoveryModal.css:226` ·
`settings.css:212, 678, 708, 825, 870, 1064, 1254, 1700, 2058`.

**Fix:** `var(--accent-strong)` for accent-coloured *text* — it already exists
(`tokens.css:109`) and measures **5.88:1**. Keep `--accent` for borders, fills and
focus rings, where 3.93:1 clears the 3:1 non-text bar.

### K7 · `white` on an accent fill — 4.47:1, and the app already knows better
`DiffView.css:615, 653` · `settings.css:654, 745` · `EmailMonitoringPage.css:169`.

White on `#6366f1` = **4.47:1**, fails. `var(--ink-on-fill)` gives 4.57:1 and is what
`settings.css:1072`, `settings.css:1990`, `pipeline.css:269` and `LoginPage.css:165`
**already use for exactly the same fill**. The app answers one question two ways, and
the hardcoded answer is the failing one.

**Fix:** `var(--ink-on-fill)` at all five. Better: add `--accent-fill: #4f46e5` for
both themes — white on `#4f46e5` is 6.29:1, and a filled button does not need the
lighter dark-theme accent.

### K8 · The accent is carrying three status meanings (breaks house rule a)
`tokens.css:17-18` says the accent "deliberately carries NONE of them."
- `Toast.css:55, 81` — `.toast--info` uses `--accent`, so indigo means "informational" beside green=success and red=error in one three-way control.
- `EmailMonitoringPage.css:288` — same meaning, second location.
- `DiffView.css:84-88` — `.tag-pill--type` paints a job-type *taxonomy value* in accent, in a row with a green salary pill.

**Fix:** give "info" a neutral treatment (`--rule-strong` + `--text-secondary`), the
way `.kw-chip--missing` (`DiffView.css:226-230`) already handles a neutral third state.
`.tag-pill--type` → the neutral base; the word already carries the type.

### K9 · The traced green is carrying five meanings (breaks house rule a)
`tokens.css:114` scopes green to "safe, verified node in master profile." It is also:
`AppShell.css:245-251` (session-active dot) · `pipeline.css:225-233` (dispatch-is-live
dot) · `DiffView.css:95-99` (salary is stated) · `settings.css:1625-1631` (already on
watchlist) · `settings.css:1550-1553` (a company-size category) ·
`DiscoveryModal.css:180, 192, 205` (headline number).

Two of these also break rule (b):
- `AppShell.css:245` — a bare 7px dot, **no label, no shape, no word**. Hue is its only channel.
- `pipeline.css:225` — its only second channel is the `pulse-dot` animation, which `base.css:106-113` **zeroes out under `prefers-reduced-motion`** — removing the redundancy from exactly the users who need it.

**Fix:** both dots → `--text-secondary` plus a word ("signed in", "live"). Salary pill
and company-added button → neutral.

### K10 · `paused` is filed under the fabrication red, contradicting its own token
`base.css:438-457` groups `.status-badge--paused` with `flagged / rejected / failed /
dropped_*` in the red family. But `tokens.css:124` defines `--signal` as *"needs human
intervention / **paused queue**"*. Red now means both "this failed" and "this is waiting".

**Fix:** move it to the `--signal` group at `base.css:388-401`, where the token says it belongs.

### K11 · Purple is an undeclared hue doing two unrelated jobs — already drifting
`EmailMonitoringPage.css:225-227` `.email-badge--unclassified` =
`light-dark(#7e22ce, #c084fc)` · `settings.css:1538-1541` `.badge-cat--gcc` =
`light-dark(#7e22ce, #d8b4fe)`. Same light value, **two different dark values**.
No token backs either, and violet sits next to the indigo accent in hue, so at badge
size it reads as a muted accent.

**Fix:** "unclassified" is an absence of knowledge → the neutral slate family, matching
`.unknown` (`base.css:309-316`). Company categories → neutral; they already uppercase
and track out (`settings.css:1528-1536`), which is second channel enough.

### K12 · Hardcoded black shadows that do not flip with the theme
`tokens.css:12-13` says elevation is "a LIGHTER surface in both directions, never a
heavier shadow", and `--lift` implements it — flipping to an inset top highlight in
dark, because a black shadow is invisible on near-black. Nine rules bypass it:
`AppShell.css:97` · `Toast.css:26` · `CommandPalette.css:31` · `DiffView.css:509, 556` ·
`DiscoveryModal.css:31` · `PipelineDrawer.css:29` · `settings.css:214, 1100, 1336`.

Practical effect: `.rail__link--active` and `.chip-btn--active` **lose their entire
elevation cue in dark**, leaving surface-on-surface as the only "you are here" signal.

**Fix:** `box-shadow: var(--lift)` for the four small-elevation cases. The four
modal/overlay shadows are a genuinely larger elevation — add **one** `--lift-overlay`
token themed the long way, rather than nine literals.

### K13 · Accent washes and focus rings restate one half of `--accent-subtle`
`settings.css:871` (dark half, both themes) · `settings.css:1905, 1924` (light half as
the input focus ring, both themes) · `settings.css:2064` · `settings.css:1067, 1073` ·
`EmailMonitoringPage.css:286`. `base.css:205` does it correctly with `var(--accent-subtle)`.

**Fix:** `var(--accent-subtle)`. Note `settings.css:1905, 1924` is the *same* rule that
[A1](./audit-accessibility.md) flags for destroying the focus ring — fix both together.

### K14 · `--traced-ink` is a byte-for-byte duplicate of `--traced`
`tokens.css:91` is character-identical to `tokens.css:115`. One consumer:
`settings.css:1029`. The asymmetry shows in the pair right there —
`.watchlist-feedback--success` uses `--traced-ink`/`--traced-edge` while its sibling
`--error` uses `--fabricated`/`--fabricated`. Same pattern, two vocabularies.

**Fix:** delete `--traced-ink`; point `settings.css:1029` at `var(--traced)`. Then
either drop `--traced-edge` or add `--fabricated-edge`/`--signal-edge` so the family
is symmetric.

### K15 · A danger control wearing the "waiting" hue, changing hue on hover
`settings.css:983-998` — `.button--danger-outline` is `--signal-strong` at rest and
`--fabricated` on hover. Bronze means "waiting for you"; a delete button is not
waiting. A control that changes *hue family* on hover reads as changing meaning.

**Fix:** `--fabricated` at rest and on hover; vary the wash, not the hue.

### K16 · Error has no second channel while its success sibling does
`settings.css:1782-1788` — success gets `font-weight: 600`; error, the one that
matters, gets hue alone. **Fix:** add the weight. The app's own pattern at
`DiffView.css:467-471` pairs the fabricated colour with weight *and* a border.

---

## Tier 3 — dead weight and missing tokens

### K17 · Eleven declared tokens with zero consumers — a second, unused type scale
`tokens.css:149-164` — **all ten** semantic typography tokens (`--font-size-page-title`,
`--font-weight-page-title`, `--line-height-page-title`, the section-header triple, the
card-header pair, `--font-size-helper`, `--line-height-helper`) have **0 uses**.
`--font-size-body` has 0; `--line-height-body` has 1. `--ink-secondary` (`tokens.css:87`)
has 0.

They are dead because `base.css:56-78` **restates the same numbers as literals**
(`h1` = 1.5rem/650/1.25 = the page-title triple exactly), and `health.css:32`,
`ApprovalQueuePage.css:13-18` and `settings.css` restate them again per component.

**Fix:** wire `base.css:56-78` to the tokens, or delete the eleven. A second unused
definition of the type scale is the same drift hazard as a duplicated colour.

### K18 · Two colour families used repeatedly that should be tokens
- **"In-flight / progressing" blue** — restated in **three** files (`base.css:409-418`, `settings.css:947-949`, `EmailMonitoringPage.css:219-221`). This is a fourth semantic status (`applying/applied/interview/tailored/scored`) with no token.
- **"Neutral / not-yet-classified" slate** — restated in `base.css:426-434` and `settings.css:972-974`.

**Fix:** add `--inflight`/`-wash`/`-edge` and `--neutral-badge`/`-wash`/`-edge` to
`tokens.css` alongside the existing three families, and document the blue's one meaning
in the same register. Contrast on both already passes.

### K19 · `.run--traced` relies on hue alone, and the hue is ~1.06:1
`DiffView.css:427-433` — background is `--traced-wash` and nothing else. Over `#ffffff`
the marked passage differs from unmarked prose by **≈1.06:1**. Its counterpart
`.run--fabricated` deliberately carries four channels.

The design argument (safe content must not compete) is sound, but the result is that
"traced" is **indistinguishable from "unmarked"** for a colour-blind or low-vision
operator — on the screen whose entire job is telling those two apart.

**Fix:** one quiet non-hue channel — e.g. a 1px dotted bottom rule in `--traced`.

### K20 · Smaller items
- `DiscoveredJobsPage.tsx:437` — `style={{color:'#dc2626'}}`, a third red, 3.5:1 dark → `var(--fabricated)`.
- `AnswerBankPage.tsx:271` — `style={{color:'#b45309', borderColor:'#f59e0b'}}`, light bronze in both themes, ~3.0:1 dark → `var(--signal)`.
- `DiscoveredJobsPage.tsx:342, 352` — `var(--accent, #6366f1)`: the fallback is the dark-theme literal and would be wrong in light if it ever fired. Drop it.
- `tokens.css:96` — `--alarm-ink-muted` states two near-identical alphas (0.65/0.62) for a ground that is dark in **both** themes. `--alarm-raised` correctly declines the split. Collapse to one value.

---

## Checked and clean

Worth recording so nobody re-audits them: `--ink-on-fill` on `--traced` (5.01:1 light /
11.1:1 dark) · `--text-secondary` (6.85:1 dark, 7.6:1 light) · `--fabricated-strong`,
`--signal-strong`, `--traced-strong` as text on their own washes (all ≥4.7:1 both
themes) · `StatusBadge` renders the word beside the dot, so badge families satisfy rule
(b) · `Toast.tsx:52` renders `✓`/`!`/`ℹ` glyphs, so toasts satisfy rule (b) — their
problem is K8, not the second channel · the focus ring at `--accent` clears the 3:1
non-text bar · `CommandPalette.css` and `PipelineDrawer.css` are otherwise fully
tokenised.

---

## Related

- [`README.md`](./README.md) — the `docs/ui/` index and how to pick
- [`theming-convention.md`](./theming-convention.md) — the `light-dark()` rule
- [`audit-accessibility.md`](./audit-accessibility.md) — K5, K9, K13, K19 all pair with findings there
