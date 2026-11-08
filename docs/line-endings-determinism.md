# Line endings are a correctness control, not a formatting preference

_Last verified against code: 2026-11-08 (2a9ac31)._

**Status:** fixed 2026-09-10 and still in force. Root `.gitattributes` was
committed as `088f938` and is unchanged since (`git log --oneline -- .gitattributes`);
`packages/resume-template/.gitattributes` came in `10b0336`. Every blob in the
index is LF: `git ls-files --eol | grep -v 'i/lf\|i/none\|i/-text'` prints nothing
(checked 2026-11-08). Some *working copies* are CRLF; see
[Working copies today](#working-copies-today).

## The three layers, and where each lives

| Layer | File | What it covers |
|---|---|---|
| Root rule | [`.gitattributes`](../.gitattributes) | Every path: LF in the repo and in every checkout |
| Package rule | [`packages/resume-template/.gitattributes`](../packages/resume-template/.gitattributes) | The renderer package, even if the root rule is loosened |
| Renderer normalisation | `packages/resume-template/src/print-styles.ts:277`, `packages/resume-template/src/render-resume-html.ts:544` | Runtime: `replace(/\r\n/g, '\n')` on the stylesheet and the whole rendered document |

The third layer is the one that protects the product guarantee at runtime,
whatever git did. The first two protect fresh clones, CI and the golden fixture
`packages/resume-template/test/fixtures/zomato-backend-intern.golden.html`.

## Why this is not a style question

Two product guarantees in `applyy` are **byte comparisons**. Anything that makes
bytes differ per platform breaks them silently rather than loudly.

1. **§7 / §10 — "what you approved is byte-for-byte what gets submitted."**
   The resume renderer builds HTML from multi-line template literals, so the
   **source file's line endings are copied verbatim into the rendered output.**
   A CRLF checkout therefore changes the *artifact*, not merely the file it was
   written in. The approval preview and the submitted PDF become different
   bytes, and the guarantee the entire approval gate rests on becomes false.
2. **Constraint #8 — `tailored_hash`.** That hash is a `sha256` over the
   rendered text and is used as a **cache key**. A per-platform hash means the
   cache never hits, and the same resume is billed to Gemini twice.
   As of 2026-11-08 the column exists (`supabase/migrations/20260909234700_core_tables.sql:355`,
   `packages/shared-types/src/tables.ts:559`), but no committed edge function
   writes it yet. Re-check with
   `git grep -n tailored_hash -- supabase/functions worker/src ':!*.test.ts'`.
   The exposure applies the day a writer lands.

Anything else that hashes rendered text has identical exposure: the job
fingerprint, and §19's byte-identical injection suite.

## Why nobody noticed

**Every machine is internally self-consistent, so every test passes everywhere
in isolation.** The divergence exists only *between* a Windows contributor and
the Ubuntu Actions runner — which is the one pair that no single test run ever
compares. A green suite on both machines is exactly what this bug looks like.

## The mechanism, precisely

`core.autocrlf=true` is set in this machine's **system** gitconfig
(`C:/Program Files/Git/etc/gitconfig`) — not the repo's, not the user's, so it
applies to every clone here and is easy to miss. Still true on 2026-11-08:
`git config --show-origin --get-all core.autocrlf`. The `eol=lf` attribute
overrides it inside this repo.

`autocrlf=true` converts **CRLF → LF on check-in** and **LF → CRLF on
check-out**. Two consequences that together explain why this hid so well:

- The **repository blobs are already pure LF.** Nothing is wrong in git history.
- The **working tree gets CRLF — but only on checkout.**

And that is the trap: the working tree on this machine was **LF, by accident**,
because these files were *authored here* by the peer sessions, never checked
out. `autocrlf` had never had an opportunity to convert them. So inspecting the
working tree showed no problem at all.

## Evidence

Measured, not assumed. A fresh `git clone` of the repo into a temp directory on
this same machine:

| File | CR bytes before | CR bytes after |
|---|---|---|
| `PROJECT_PLAN.md` | 525 | **0** |
| `supabase/functions/_shared/tailor/validator.ts` | 279 | **0** |
| `supabase/functions/_shared/normalize/posted-at.ts` | 209 | **0** |
| `apps/web/src/data/contract.ts` | 97 | **0** |
| `packages/resume-template/src/escape-html.ts` | 60 | **0** |
| **Entire clone, all files** | — | **0** |

The "after" column is a fresh clone of `088f938`. Both the bug and the fix are
demonstrated on one machine, which is the thing the CRLF problem otherwise
defeats: you cannot see it by testing in place.

## A finding worth keeping: a staged `.gitattributes` is inert

`packages/resume-template/.gitattributes` existed and was **staged but not
committed** — and during that window it did nothing. The fresh clone gave
`escape-html.ts` **60 CR bytes** despite the protective file being present on
disk.

**Git reads `.gitattributes` from the checked-out tree.** A clone checks out
`HEAD`, so a rule that is not in `HEAD` cannot influence the checkout that would
have needed it. Belt-and-braces protection only starts working once committed.

## The rule that was written, and why it is not the obvious one

Root [`.gitattributes`](../.gitattributes):

```gitattributes
* text=auto eol=lf
```

The obvious spelling is `* text eol=lf`. **That would be a latent corruption
bug.** Bare `text` asserts that *every* file is text, so git rewrites bytes
inside PNGs, PDFs and fonts. This project **renders resume PDFs and stores
browser screenshots**, so the blast radius would be precisely the artifacts sent
to employers.

`text=auto` detects which files are text and normalises only those. On top of
that:

- **Explicit `text eol=lf` pins** on `.ts .tsx .js .mjs .cjs .sql .yml .yaml
  .sh .json .jsonc .md .toml .css .html .env.example .gitignore .npmrc`, because
  `text=auto` uses a content heuristic and a file with an unlucky byte can be
  misdetected as binary and skip normalisation. These types are load-bearing, so
  they are named rather than left to a guess.
- **`*.golden.html -text`** — golden fixtures are compared byte for byte against
  a freshly rendered string, so conversion is switched off *outright* rather than
  merely pinned. `-text` survives even if the baseline rule is later loosened.
- **`*.bat` / `*.cmd` at `eol=crlf`** — the genuine exception. The Windows
  command interpreter needs CRLF; an LF-only `.cmd` executes only its first line.
- **Explicit `binary` for** `png jpg jpeg gif webp ico pdf woff woff2 ttf otf
  zip gz`. `text=auto` should already detect these, but naming them costs
  nothing and means a future contributor **cannot reintroduce corruption by
  loosening the base rule**, because the binary types are pinned independently
  of the heuristic.

## Deferred: the existing working tree is not renormalised

`.gitattributes` fixes **fresh clones and CI**, which is where the actual damage
was. It does **not** retroactively convert files already in a working tree; that
requires `git add --renormalize .`.

**That command has been deliberately deferred and must not be run ad hoc.** It
rewrites files across all four peer sessions' write-ownership territory, and
every one of them has unstaged work in flight — it would collide with concurrent
writers and produce exactly the tangled diff that write-ownership partitioning
exists to prevent. It is scheduled for when peers are idle and Teja is at the
keyboard.

Still deferred as of 2026-11-08; list the affected working copies with `git ls-files --eol | grep w/crlf`.

### Working copies today

On 2026-11-08 that command listed a few dozen files in `apps/web/`,
`supabase/functions/` and `worker/` (none in `packages/resume-template/`).
Every one of them shows `i/lf` and `attr/text eol=lf`. So:

- The **committed bytes are LF.** Git converts CRLF to LF when the file is
  staged, because the attribute says `text`.
- The CRLF is only in this machine's working copy. The root rule forces LF on
  checkout, so these files most likely got CRLF from a Windows editor or script
  that rewrote them after checkout. That cause is an inference, not a measurement.
- It matters for tooling, not for the product. Git Bash `grep` and edit scripts
  that match on `\n` can miss or corrupt CRLF lines. Measure EOL with `node`,
  and make edit scripts EOL-aware.

In the meantime the exposure is cosmetic: the repository blobs are LF, fresh
clones and CI get LF, and the renderer performs its own normalisation at its
choke point — which covers the runtime guarantee independently of git. That
in-renderer normalisation plus the package-level file plus the root rule are
three layers on purpose; note that this is exactly the situation
[`verification-traps.md`](verification-traps.md) warns about, so if you ever test
the renderer's normalisation, make sure the input can only be caught by *that*
layer.

## If you are adding something that hashes rendered text

Assume it has this exposure until you have checked. The question is not "does my
code handle line endings" but **"can the bytes I hash differ between a Windows
clone and the Ubuntu runner?"** The way to answer it is the table above: clone
into a temp directory and count CR bytes. Do not reason about it — measure it.
