# `docs/ui/` — the applyy console's interface docs

Two kinds of file live here:

- **Conventions** — rules that bind future work. Read before writing UI code.
- **Audits** — dated snapshots of findings. Nothing in them is implemented until you pick it.

| File | What it is |
|---|---|
| [`theming-convention.md`](./theming-convention.md) | **Convention.** Why `[data-theme='dark']` colour rules are dead in this app, and what to write instead. The tree is currently clean; any new instance is a regression. |
| [`audit-color-and-theming.md`](./audit-color-and-theming.md) | Audit · 20 findings (`K*`) — contrast, token drift, hue-meaning collisions. |
| [`audit-accessibility.md`](./audit-accessibility.md) | Audit · 20 findings (`A*`) — focus, keyboard, ARIA, live regions, hit targets. |
| [`audit-layout-and-typography.md`](./audit-layout-and-typography.md) | Audit · 32 findings (`L*`) — undefined tokens, states that lie, PAPER/MACHINE, type scale, card density. |
| [`audit-copy-and-ux.md`](./audit-copy-and-ux.md) | Audit · 32 findings (`C*`) — vocabulary leaks, error messages, empty states, destructive actions. |

All four audits are dated **2026-09-17** and were taken at commit `286ea2e`.

---

## How to pick

Every finding has a stable ID (`K1`, `A3`, `L19`, `C7`). Name the IDs you want and they
become a work parcel. Findings are already sorted into tiers within each file; Tier 1 is
always "pick these first."

Cross-references are marked inline — e.g. `A1` and `K13` are the same two lines of CSS seen
from two angles, so picking one should pick both.

---

## If you only pick five

Ranked by *consequence per line changed*, across all four audits:

1. **[L5](./audit-layout-and-typography.md)** — on a database read failure the Approval Queue renders a **green "you're finished"** empty state. The one screen that gates irreversible submissions cannot tell "nothing to do" from "I couldn't ask."
2. **[K1](./audit-color-and-theming.md)** — `--text-muted` fails WCAG AA in dark on every surface (3.63:1). **One token edit fixes ~88 call sites**, and `tokens.css` currently claims this block is "AA certified", which is false.
3. **[L1](./audit-layout-and-typography.md) / [K4](./audit-color-and-theming.md)** — seven CSS variables are used but never defined, so the declarations silently drop. Every job card and email card has square corners and no background fill. **~25 lines.**
4. **[C1](./audit-copy-and-ux.md)** — database status enums (`awaiting_approval`, `audit_clean`) are the label on four screens. One lookup map.
5. **[A3](./audit-accessibility.md)** — the job description is expandable only by mouse click on a bare `<div>`. Keyboard and screen-reader users **cannot read job descriptions at all**.

Honourable mention: **[C2](./audit-copy-and-ux.md) + [C3](./audit-copy-and-ux.md)** — approving gives no confirmation and rejecting needs none. Both sit on the irreversible path.

---

## The one theme that runs through all four

The design system is good. `tokens.css`, `base.css`, `DiffView.css`, `pipeline.css` and
`health.css` argue for their choices in comments and the choices are consistent and
unusual — the PAPER/MACHINE material split, `light-dark()` with one definition site per
colour, elevation as a lighter surface rather than a heavier shadow, no status signalled by
hue alone.

**Almost every finding in these four documents is a component that did not use it.** The
newer feature CSS restates colours as literals, invents its own radii, references variables
that do not exist, and writes dark-mode rules keyed on an attribute the default state
removes. Once a literal exists, nothing ties it to a meaning — so hues drift into second
jobs, second channels get dropped, and the rule the token file wrote down stops being true.

The repair job is to bring six stylesheets up to the other six. It is not a redesign, and
the audits deliberately propose no new visual direction.

---

## Method, and what that means for trust

Findings were produced by four read-only recon agents working in parallel over disjoint
concerns, then checked before being written down:

- Contrast ratios were **re-derived independently** from the WCAG relative-luminance formula. The two methods agreed to within 0.25 (e.g. `--text-muted` on `--sheet`: 3.63:1 re-derived vs 3.65:1 reported). Where they differ, the re-derived number is the one recorded.
- Five copy findings and four layout findings were re-read against the tree by hand.
- **Two claims were wrong and are corrected in place**, with the correction left visible rather than quietly dropped — see the note at the top of [`audit-layout-and-typography.md`](./audit-layout-and-typography.md). One was stale (it described a bug fixed in `286ea2e`, after the agent read the tree); one was a wrong inference about dead code.

Treat unverified findings as *strong leads with exact line numbers*, not as facts. Every
one names a file and a line, so checking a finding takes about as long as reading it.
