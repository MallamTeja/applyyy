# Dark-mode rules keyed on `[data-theme='dark']` are dead — theme via `light-dark()`

**Status:** enforced convention. The tree is clean as of 2026-09-17 (commit `286ea2e`).
Any new `[data-theme='dark']` colour rule is a regression.
**Audience:** anyone writing CSS under `apps/web/src`.

---

## The rule

> Never write a colour under a `[data-theme='dark']` selector.
> Write it once as `light-dark(<light>, <dark>)`, or use a token from
> `apps/web/src/styles/tokens.css` that already does.

A `[data-theme='dark']` colour rule **does not apply in the state most operators
are actually in**. It is not a weaker version of the right answer — it is dead code
that silently ships the wrong palette.

## Why — the mechanism

The app has three theme states, not two: `system`, `light`, `dark`
(`ThemePreference` in `apps/web/src/app/theme.ts`). `system` is the default, and it is applied by
**removing** the attribute, not by setting it:

```ts
// apps/web/src/app/theme.ts, applyTheme()
export function applyTheme(root: Element, preference: ThemePreference): void {
  if (preference === DEFAULT_THEME) {
    root.removeAttribute(THEME_ATTRIBUTE);   // <- 'system' means NO attribute
  } else {
    root.setAttribute(THEME_ATTRIBUTE, preference);
  }
}
```

This is deliberate and it is asserted by a test:
`apps/web/test/theme.test.ts` — *"choosing system REMOVES the attribute rather
than setting it"*. The reason is sound: stamping an explicit value for the OS's
current state would freeze it at page-load time, and the console would stop
following the machine at sunset.

The consequence for CSS is the part that is easy to miss:

| Operator's setting | OS | `data-theme` on `<html>` | Does `[data-theme='dark'] {…}` match? |
|---|---|---|---|
| **System** (the default) | **dark** | **absent** | **No** |
| System (the default) | light | absent | No |
| Light | either | `light` | No |
| Dark | either | `dark` | Yes |

So an attribute-keyed dark rule reaches **only** the operators who went into
Appearance and explicitly chose Dark. Everyone on the default setting with a dark
OS gets the **light** half of the stylesheet painted onto a `#151924` card.

`tokens.css` handles this correctly and explains itself in the header comment of `apps/web/src/styles/tokens.css`:
`:root { color-scheme: light dark }` lets the browser resolve every
`light-dark()` call live from `prefers-color-scheme`, and the two override rules
(`:root[data-theme='light']`, `:root[data-theme='dark']`) flip `color-scheme` rather than restating any colour.

## What to write instead

**Preferred — use a semantic token.** It is already themed, and the meaning travels
with the colour:

```css
.thing--warning {
  color: var(--signal);
  background: color-mix(in oklab, var(--signal) 13%, transparent);
  border-color: color-mix(in oklab, var(--signal) 36%, transparent);
}
```

`color-mix()` derives the wash and the edge from the same token as the text, so a
component cannot drift away from the meaning it carries, and retuning the token
retunes every component that uses it. The semantic tokens are `--traced` (verified),
`--fabricated` (alarm), `--signal` (needs a human), `--accent` (interactive, carries
no status meaning).

**When no token fits — `light-dark()`, one declaration:**

```css
.thing { color: light-dark(#15803d, #4ade80); }
```

Both halves sit on the same line and cannot drift apart. This is the whole argument
for `light-dark()` over a `:root` + `@media (prefers-color-scheme: dark)` pair: the
media-query form needs the dark value stated a second time, and the day someone
tunes one copy, the toggle and the OS setting quietly disagree.

**The one legitimate exception.** `light-dark()` resolves `<color>` only. A token
that is not a colour — currently just `--lift`, a `box-shadow` — needs the long
form: a `@media (prefers-color-scheme: dark)` block guarded with
`:root:not([data-theme='light'])`, **plus** a `:root[data-theme='dark']` rule. Both
are required; either alone leaves a state uncovered. See the `--lift` block in `tokens.css`.

## How to check

```bash
grep -rnE "\[data-theme=[^]]*\][^*]*\{" apps/web/src --include=*.css
```

Expected output: hits in `apps/web/src/styles/tokens.css` only, and only on
`color-scheme` / `--lift`. **Any hit in another file is the bug.** The pattern matches
selectors only: several stylesheets *describe* the dead pattern in comments, and a bare
`grep "data-theme="` fires on those explanations — a check that forbids naming the bug fires
on its own documentation.

## What this cost, and what was fixed

Three instances existed. All three were in components the operator looks at most,
and all three were visibly broken on a default-settings dark machine:

| File | Symptom |
|---|---|
| `apps/web/src/app/SourceBadge.css` | Source pills rendered mid-green / mid-blue text, tuned for white paper, on a near-black card |
| `apps/web/src/features/discovery/DiscoveredJobsPage.css` (cooldown + salary pills) | Dark-orange and mid-green chips, barely legible |
| `apps/web/src/features/discovery/DiscoveredJobsPage.css` (`.job-card__drop-banner`) | `#b91c1c` on `#151924` |

All three cleared in `286ea2e`.

**The diagnostic worth reusing.** These were the *only* three files in the tree using
the pattern, and they were the *only* three components that looked broken. That
correlation is what identified the mechanism — before that it looked like three
unrelated bad colour choices. Call this class of bug a **dead selector**: a rule
keyed on state the default code path never produces. It survives code review because
the CSS *looks* complete; only the state table above shows the hole.

## Related

- `apps/web/src/styles/tokens.css` — the token system and its own rationale
- `apps/web/src/app/theme.ts` — the three states and why `system` is a real third state
- `apps/web/test/theme.test.ts` — the assertions that pin this behaviour
- [`README.md`](./README.md) — the `docs/ui/` index
