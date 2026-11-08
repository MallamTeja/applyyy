# Dark-mode rules keyed on `[data-theme='dark']` are dead: theme via `light-dark()`

_Last verified against code: 2026-11-08 (2a9ac31)._

**Status:** enforced convention. The tree is clean as of 2026-11-08 (run the check in
[How to check](#how-to-check) to re-confirm). Any new `[data-theme='dark']` colour rule is a regression.
**Audience:** anyone writing CSS under `apps/web/src`.

---

## The rule

> Never write a colour under a `[data-theme='dark']` selector.
> Write it once as `light-dark(<light>, <dark>)`, or use a token from
> `apps/web/src/styles/tokens.css` that already does.

A `[data-theme='dark']` colour rule **does not apply in the state most operators
are actually in**. It is not a weaker version of the right answer. It is dead code
that silently ships the wrong palette.

## Why: the mechanism

The app has three theme states, not two: `system`, `light`, `dark`
(`ThemePreference`, `apps/web/src/app/theme.ts:25`). `system` is the default
(`DEFAULT_THEME`, `theme.ts:42`), and it is applied by **removing** the attribute,
not by setting it:

```ts
// apps/web/src/app/theme.ts:106, applyTheme()
export function applyTheme(root: Element, preference: ThemePreference): void {
  if (preference === DEFAULT_THEME) {
    root.removeAttribute(THEME_ATTRIBUTE);   // <- 'system' means NO attribute
  } else {
    root.setAttribute(THEME_ATTRIBUTE, preference);
  }
}
```

This is deliberate, and a test asserts it:
`apps/web/test/theme.test.ts:148`, *"choosing system REMOVES the attribute rather
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

`tokens.css` handles this correctly and explains itself in its header comment:

- `:root { color-scheme: light dark }` (`tokens.css:56`) lets the browser resolve every
  `light-dark()` call live from `prefers-color-scheme`.
- The two override rules, `:root[data-theme='light']` (`tokens.css:228`) and
  `:root[data-theme='dark']` (`tokens.css:235`), flip `color-scheme`. They restate no colour.

`tokens.css` is imported before `base.css` in `apps/web/src/main.tsx:11-12`, because the
primitives in `base.css` read the tokens.

## What to write instead

**Preferred: use a semantic token.** It is already themed, and the meaning travels
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
retunes every component that uses it.

The semantic families in `tokens.css` (each has a base, a `-strong` and a `-wash` variant):

| Token | Meaning | Where |
|---|---|---|
| `--traced` | verified, traces to the master | `tokens.css:140-142` |
| `--fabricated` | alarm | `tokens.css:145-147` |
| `--signal` | needs a human | `tokens.css:150-152` |
| `--accent` | interactive; carries **no** status meaning (`-strong`, `-subtle`) | `tokens.css:133-135` |

Text and surface tokens (`--text-primary`, `--text-secondary`, `--text-muted`, `--ground`,
`--panel`, `--sheet`, `--rule`) are also `light-dark()` pairs. Read the full list with
`git grep -n "^  --" -- apps/web/src/styles/tokens.css`.

**When no token fits: `light-dark()`, one declaration:**

```css
.thing { color: light-dark(#15803d, #4ade80); }
```

Both halves sit on the same line and cannot drift apart. This is the whole argument
for `light-dark()` over a `:root` + `@media (prefers-color-scheme: dark)` pair: the
media-query form needs the dark value stated a second time, and the day someone
tunes one copy, the toggle and the OS setting quietly disagree.

**The one legitimate exception: `--lift`.** `light-dark()` resolves `<color>` only. A
token that is not a colour (currently just `--lift`, a `box-shadow`) needs the long
form. It needs both of these:

1. a `@media (prefers-color-scheme: dark)` block guarded with
   `:root:not([data-theme='light'])` (`tokens.css:248-252`), and
2. a `:root[data-theme='dark']` rule (`tokens.css:254-256`).

Either alone leaves a state uncovered.

**Not an exception, just a fixed colour.** A few tokens are not `light-dark()` pairs
because the colour must not change with the theme (for example `--alarm-raised` and
`--ink-inverse`, `tokens.css:74` and `:110`, which sit on the dark alarm surface in both
themes). That is fine. The rule is only about *which half wins*, and these have one half.

## How to check

Run from the repo root (Git Bash or PowerShell):

```bash
git grep -nE "\[data-theme='[a-z]+'\][^*]*[{]" -- 'apps/web/src/*.css'
```

Expected output, as of 2026-11-08: four hits, all in `apps/web/src/styles/tokens.css`
(lines 228, 235, 249, 254), and each one only sets `color-scheme` or `--lift`.
**Any hit in another file is the bug.**

Notes on the check itself:

- The pattern matches selectors only. Several stylesheets *describe* the dead pattern in
  comments (for example `apps/web/src/app/SourceBadge.css:4`), and a bare
  `grep "data-theme="` fires on those explanations. A check that forbids naming the bug
  fires on its own documentation.
- The earlier version of this check used `[^]]` in the pattern. In this repo's Git Bash
  `grep` that form either errors ("Invalid regular expression") or matches nothing, so it
  passed vacuously. It printed no hits even for `tokens.css`. The command above was
  re-tested on 2026-11-08 and finds the four expected lines. If it ever prints nothing,
  the check is broken. It does not mean the tree is clean, because `tokens.css` must always match.
- `git grep` reads tracked files only. Add `--untracked` to include a new file you have
  not staged yet.

## What this cost, and what was fixed

Three instances existed. All three were in components the operator looks at most,
and all three were visibly broken on a default-settings dark machine:

| File | Symptom |
|---|---|
| `apps/web/src/app/SourceBadge.css` | Source pills rendered mid-green / mid-blue text, tuned for white paper, on a near-black card |
| `apps/web/src/features/discovery/DiscoveredJobsPage.css` (cooldown + salary pills) | Dark-orange and mid-green chips, barely legible |
| `apps/web/src/features/discovery/DiscoveredJobsPage.css` (`.job-card__drop-banner`) | `#b91c1c` on `#151924` |

All three cleared in `286ea2e` (2026-09-17). Their replacement comments are still in the
files (`SourceBadge.css:4`, `DiscoveredJobsPage.css:151` and `:403`), so the reason survives.
Newer stylesheets cite this file in their headers instead of adding a dark rule
(`apps/web/src/features/applied/Applied.css:2`, `apps/web/src/features/manual-apply/ManualApply.css:2`).

**The diagnostic worth reusing.** These were the *only* three files in the tree using
the pattern, and they were the *only* three components that looked broken. That
correlation is what identified the mechanism. Before that it looked like three
unrelated bad colour choices. Call this class of bug a **dead selector**: a rule
keyed on state the default code path never produces. It survives code review because
the CSS *looks* complete. Only the state table above shows the hole.

## Related

- `apps/web/src/styles/tokens.css`: the token system and its own rationale
- `apps/web/src/app/theme.ts`: the three states and why `system` is a real third state
- `apps/web/test/theme.test.ts`: the assertions that pin this behaviour
- [`README.md`](./README.md): the `docs/ui/` index
