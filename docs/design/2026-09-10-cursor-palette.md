# The Cursor-style palette — what changed, and the two catches worth keeping

**Date:** 2026-09-10 · **Built by:** `applyyy-20` · **Written up by:** `applyyy-da`
**State:** the 7 CSS files are **staged, not committed** at time of writing.
There is **no theme toggle yet** — see §7.

A low-chroma, theme-aware palette across all seven `.css` files in
`apps/web/src`. Build exits 0; verified in Chrome at 1440×900 in both themes and
at 400px; **22/22 WCAG contrast pairs pass.**

The hex values are in `tokens.css` and are not the interesting part. **Two
status-colour problems and one latent bug are**, and they are the reason this
document exists rather than a link to the stylesheet.

---

## 1. The idea worth leading with: paper and machine stay tellable apart

The app already distinguished **paper** (resume content, serif) from **machine**
(the console chrome, sans). That split survived the reskin as a **hue difference
at matched luminance** — paper surfaces carry a warm cast, machine chrome a cool
one.

**A generic dark theme paints every surface the same neutral grey.** This one
keeps the two materials distinguishable in the dark, which matters because the
whole approval screen is an argument about *which* text came from your master
profile and which was generated. The materials carrying different temperatures
is that argument, rendered.

**Elevation is a lighter surface in both directions, never a heavier shadow:**

| | ground | panel | sheet |
|---|---|---|---|
| **Dark** | `#0d0f11` | `#15181c` | `#1c1b19` |
| **Light** | `#f4f4f2` | `#eaeae7` | `#ffffff` |

Every token is defined on `:root`; the `@media (prefers-color-scheme: dark)`
block **redefines values only and introduces no new names**, so each token has
exactly one place you look up its meaning.

---

## 2. Catch one — a signal carried by scarcity, in a theme that destroys scarcity

`--alarm-ground` was documented as **"the ONLY dark surface in the
application"**, and its *rarity* was the fabrication warning. One dark band in a
light UI stops you dead.

**A dark theme destroys that, because now everything is dark.** The token still
existed, still rendered, still had a passing contrast ratio — and had silently
stopped meaning anything.

The rule was not dropped. **The channel carrying it was changed:** the alarm band
is now the only surface with **chroma** in a strictly neutral UI. Verified on
screen — it still stops you.

> **The generalisable move: when a theme change invalidates a signal, ask what
> property the guarantee actually rested on, then re-found it on a property that
> still holds.** The guarantee was never "dark". It was "unlike everything
> else". Scarcity was the mechanism, not the meaning — and a mechanism can be
> swapped once you can name which one you had.

This is the same shape as §17.2's resume-layout finding: the *stated* rule ("no
columns") was a proxy, and the real hazard was elsewhere. Here the stated rule
("the only dark surface") was also a proxy for "the only surface unlike the
others."

---

## 3. Catch two — a directional name that inverts

`--fabricated-deep` → **`--fabricated-strong`**, across 5 files.

**"Deep" is a directional name, and the direction inverts:** the emphatic tone is
*darker* in light mode and *lighter* in dark. So in half the application the old
name described the opposite of what it did.

This is the cleanest worked example in the repo of Teja's *"say what it is, not
what it was"* rule — with a sharpening: **a name that is actively wrong is worse
than a name that is merely vague.** "Deep" reads as precise, so nobody
double-checks it. `--strong` describes the *role* (more emphatic), which is
invariant under the theme flip.

---

## 4. The latent bug — and the mechanism is the transferable part

`.ingest__button` was `background: var(--ink)` with `color: var(--ink-inverse)`.

But **`--ink-inverse` means "text on the dark alarm band"**, not "the opposite of
ink". In dark mode **both resolve to warm off-white**: light text on a light
fill. **An invisible button.**

It shipped. **No build, no typecheck and no test would ever have caught it** — it
needed a human eye in a mode nobody had yet rendered.

> **A NAME BROAD ENOUGH TO BE BORROWED WILL BE BORROWED.**

`--ink-inverse` reads more general than its actual meaning, so a second caller
took it for a meaning it never had. The name did not lie about the value; it
lied about the *scope*. And the borrowing was invisible for as long as the two
meanings happened to coincide — which they did, in light mode, until a theme
flip pulled them apart.

Fixed by giving the real need an honestly-scoped token of its own —
**`--ink-on-fill`** ("text on a filled semantic colour"), which flips to
near-black in dark mode.

**Same family as the `humanOnlyLanes` / `humanReachableLanes` confusion already
logged here**, and as `content_hash` describing a mechanism that did not exist:
a name whose apparent scope exceeds its real one is a trap primed for whoever
reads it next. The tell is that the two meanings agree *today* — so nothing is
wrong until the day something changes, and then the failure appears far from the
name that caused it.

---

## 5. Four departures from the brief, all ratified

1. **No `--surface-raised` / `--text-muted` / `--border-subtle`.** Equivalents
   already existed as `--sheet` / `--ink-muted` / `--rule` — already semantic,
   just in the paper/desk/ink/rule vocabulary the existing ~1800 lines of CSS
   comments are written in. **Adding synonyms would have created exactly the
   duplicate-that-drifts problem the naming rule exists to prevent.** Only
   `--accent` is genuinely new.
2. **No new design-tokens file.** `tokens.css` already was one.
3. **"Cursor type" implies dark, but the requirement was light on `:root` with
   dark in a media block** — a real contradiction. Resolved by building *both*
   halves to the same discipline, so it is one system in either mode rather than
   a sage app that becomes a Cursor app at night.
4. **The accent is a muted slate-blue** (`#2f6bbf` light / `#6a9fe0` dark), and
   **the argument is structural, not aesthetic**: green, oxblood and bronze are
   each already spoken for as *verdicts*, so blue is the only hue left that can
   never be misread **as** a verdict.

   The consequence is the substantive part: the focus ring, the active rail item
   and the cascade checkbox all moved **off** `--traced` onto the accent.
   **Painting interaction in a status colour makes the UI assert something about
   a row that is merely focused.** A keyboard user tabbing down the approval
   queue was, in effect, being told each row was traced.

---

## 6. Accessibility evidence

**22/22 pairs pass.** Tightest: `--fabricated` on `--sheet` at **4.71:1**
(non-text mark, minimum 3.0) and light `--accent` on `--ground` at **4.80:1**
(minimum 3.0).

**Colour-blind second channels all verified intact after the reskin** — and this
is the check most likely to be skipped during a palette change, because contrast
ratios are the thing people remember to measure:

- the coverage bar is still **hatched**
- `.run--fabricated` still carries **weight + a 3px underline + a wash**, on top
  of hue
- `.table__never` still **names the finding in words**
- `.unknown` is still **italic**

**No status anywhere relies on hue alone.** A reskin is exactly when that
property quietly dies, because every change is "just a colour".

---

## 7. ⚠️ Not done — do not read these in the past tense

- **There is NO theme toggle.** The dark palette is reached only via
  `prefers-color-scheme`. **If Teja's OS is in light mode he will not see the
  dark look he asked for.** A toggle (localStorage, `prefers-color-scheme` as
  the default, explicit attribute on the root) was assigned to `applyyy-20`
  after this work and was **not built** at time of writing.
- **The 7 files are staged, not committed** as of 22:00. `applyyy-20` declined to
  commit on a *relayed* lift of Teja's standing no-commit rule and asked for his
  words directly — the right call, and the same reasoning that kept the
  `supabase db push` from being routed around.

---

## 8. Files

`apps/web/src/styles/tokens.css` (the palette), `styles/base.css`,
`app/AppShell.css`, `features/approval/DiffView.css`, `features/health/health.css`,
`features/pipeline/pipeline.css`, `features/settings/settings.css`.

Comment density is roughly 1:1 and written as the work went, so **the CSS is a
fair primary source for per-declaration reasoning.** This document covers only
what spans files — which is the half a stylesheet cannot hold.
