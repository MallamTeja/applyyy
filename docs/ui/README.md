# `docs/ui/`: the applyy console's interface docs

_Last verified against code: 2026-11-08 (2a9ac31)._

Two kinds of file live here:

- **Conventions**: rules that bind future work. Read them before writing UI code.
- **Records**: dated snapshots (audits, a past contract). They are history. Each one has a
  "Status 2026-11-08" banner under its title that says what still holds. Re-check any finding
  against the tree before you pick it.

| File | Kind | What it is |
|---|---|---|
| [`theming-convention.md`](./theming-convention.md) | **Convention** (living) | Why `[data-theme='dark']` colour rules are dead in this app, what to write instead, and the command that checks the tree. |
| [`audit-color-and-theming.md`](./audit-color-and-theming.md) | Record, 2026-09-17 | `K*` findings: contrast, token drift, hue-meaning collisions. |
| [`audit-accessibility.md`](./audit-accessibility.md) | Record, 2026-09-17 | `A*` findings: focus, keyboard, ARIA, live regions, hit targets. |
| [`audit-layout-and-typography.md`](./audit-layout-and-typography.md) | Record, 2026-09-17 | `L*` findings: undefined tokens, states that lie, PAPER/MACHINE, type scale, card density. |
| [`audit-copy-and-ux.md`](./audit-copy-and-ux.md) | Record, 2026-09-17 | `C*` findings: vocabulary leaks, error messages, empty states, destructive actions. |
| [`2026-11-01-review-structure-edits-contract.md`](./2026-11-01-review-structure-edits-contract.md) | Record, 2026-11-01 | The contract for structural resume edits on the Approval queue. Its data rules still run in code; its manual UI controls were removed on 2026-11-07. |

The four audits were taken at commit `286ea2e` (2026-09-17). Their line numbers are from
that commit and have moved since.

Other UI rules that bind all work live in the repo `CLAUDE.md` §8, not here:
no native browser dialogs (confirm inline with `apps/web/src/app/InlineConfirm.tsx`, enforced by
`apps/web/test/inlineConfirm.test.ts`), and JSX comments between tags must be `{/* */}`.

---

## How to pick

Every finding has a stable ID (`K1`, `A3`, `L19`, `C7`). Name the IDs you want and they
become a work parcel. Findings are sorted into tiers within each file. Tier 1 is
always "pick these first."

Cross-references are marked inline. For example `A1` and `K13` are the same lines of CSS seen
from two angles, so picking one should pick both.

---

## The five top findings, and where they stand (2026-11-08)

The audits ranked these five by *consequence per line changed*. Status was re-checked
against code at `2a9ac31`:

| ID | Finding (2026-09-17) | Status 2026-11-08 | Evidence |
|---|---|---|---|
| [L5](./audit-layout-and-typography.md) | On a DB read failure, the Approval queue showed a green "you're finished" empty state. | **Fixed** | `apps/web/src/features/approval/ApprovalQueuePage.tsx:764` says "Could not reach the application queue…". |
| [K1](./audit-color-and-theming.md) | `--text-muted` failed WCAG AA in dark (3.63:1 on `--sheet`). | **Fixed** | `apps/web/src/styles/tokens.css:98` is now `light-dark(#5b6675, #818b9b)`: 5.10:1 on `--sheet` in dark, 5.24:1 or better in light. The false "AA certified" label is gone (`tokens.css:77`). |
| [L1](./audit-layout-and-typography.md) / [K4](./audit-color-and-theming.md) | CSS variables used but never defined. | **Fixed** for the variables named. | `var(--surface)` now appears only in a comment (`apps/web/src/features/health/health.css:359`). |
| [C1](./audit-copy-and-ux.md) | Status enums (`awaiting_approval`, `audit_clean`) shown as labels. | Not re-checked | Check the screens before picking. |
| [A3](./audit-accessibility.md) | Job description opens only by mouse click on a bare `<div>`. | **Still open** | `apps/web/src/features/discovery/DiscoveredJobsPage.tsx:1010`: `<div className="job-card__description" onClick=…>`, no role, no `tabIndex`. |

Other findings checked on 2026-11-08 are listed in each audit's banner. The ones still open
at the time of checking include A1 and A2 (weak focus rings), A4 (`DiscoveryModal` is not a
dialog), A7 on the Answer Bank (Yes/No by colour only) and C6 (every toast, errors too,
dismisses after 3.2 s, `apps/web/src/app/Toast.tsx:35`).

---

## The one theme that runs through all four audits

The design system is good. `tokens.css`, `base.css`, `DiffView.css`, `pipeline.css` and
`health.css` argue for their choices in comments, and the choices are consistent and
unusual: the PAPER/MACHINE material split, `light-dark()` with one definition site per
colour, elevation as a lighter surface rather than a heavier shadow, and no status signalled
by hue alone.

**Almost every finding in the four audits was a component that did not use it.** In 2026-09,
the newer feature CSS restated colours as literals, invented its own radii, referenced
variables that did not exist, and wrote dark-mode rules keyed on an attribute the default
state removes. Once a literal exists, nothing ties it to a meaning. Hues drift into second
jobs, second channels get dropped, and the rule the token file wrote down stops being true.

Since then, feature stylesheets have moved to `light-dark()` and tokens. To see which files
use it today: `git grep -l "light-dark(" -- 'apps/web/src/*.css'`. Some literal pairs remain
inside `light-dark()` calls instead of tokens (for example
`apps/web/src/features/settings/settings.css:1013`), which is the K2 pattern in a milder form.

The audits deliberately propose no new visual direction. The repair job is to bring
component stylesheets up to the token file, not a redesign.

---

## Method, and what that means for trust

The audits were produced by four read-only recon agents working in parallel over disjoint
concerns, then checked before being written down:

- Contrast ratios were **re-derived independently** from the WCAG relative-luminance formula.
  The two methods agreed to within 0.25. Where they differed, the re-derived number is the one recorded.
- Five copy findings and four layout findings were re-read against the tree by hand.
- **Two claims were wrong and are corrected in place**, with the correction left visible. See the
  note at the top of [`audit-layout-and-typography.md`](./audit-layout-and-typography.md).

Treat unverified findings as *strong leads with exact line numbers*, not as facts. The line
numbers are from 2026-09-17, so search by selector or text, not by line.
