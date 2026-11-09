# Page overflow under the 5-cert rule — measurement and fix options (2026-11-09, ~23:40 IST)

Read-only measurement for the orchestrator and Teja. Nothing was changed: no code, no live writes, no tailor calls.
Method: the tailor's own one-page model (`packages/resume-template/src/page-fit.ts`, which `fitsOnePage` and
`fitToOnePage` use), measured at the minimum typography rung, plus real Chromium PDF page counts
(`renderResumeHtml` → `page.pdf({format:'A4'})` → `countPdfPages`, the worker's own path). Scripts and raw output live
outside the repo (peer 4 scratchpad `t4/measure.mts`, `probe.mts`, `trim.mts`).

**Units.** 1 line = one body line at the minimum rung = 10.93 pt. The model's page limit is 778.1 pt: A4 minus 7 mm
margins, times `SAFETY` 0.97. "Slack" = limit minus height; negative means the model says it overflows.

## TL;DR

- The 5-cert rule costs about **2.1 lines** on every resume. Certifications and achievements share one two-column row.
  With 5 certs the cert column becomes the taller one, and the row grows from about 2.3 to 5.1 lines.
- **Only one shape is refused:** a resume already at every bullet floor that also carries a second experience entry
  (Student Tribe). That was 38bb2f12. Its reconstruction overflows the model by **1.2 lines**. Rows with spare bullets
  don't fail; they lose 1-2 bullets to the trimmer instead.
- **Recommended fix:** print each cert's issuer on the same line as its name, "Machine Learning (IBM SkillsBuild)",
  instead of on a second line. That saves the full 2.1 lines, keeps every cert, every issuer and every credential
  link, and turns 38bb2f12 into a fit with no bullet lost.

## (1) 38bb2f12 — why it was refused

- Live event (17:26:17 UTC = 22:56 IST, the minute master v30 landed): `page_overflow`, with `blockedBy` listing
  **every** floor (`exp_aczen: keeps >= 4`, `exp_student_tribe: keeps >= 1`, both projects `>= 4`, all 3
  achievements `>= 1`, certs/achievements/skills/summary/education "never removed"). So the trimmer had nothing
  left to cut. The row stored no `tailored_profile` and `master_version` is null.
- Its distinguishing content: **two experience entries** (Aczen and Student Tribe). None of the 7 rows the same drain
  sent to the queue prints Student Tribe.
- **Reconstruction (an approximation; the tailor's actual output was never stored):** 22571d3c's v30 resume (same
  2 projects, 5 certs, 3 achievements), cut to the floors, plus Student Tribe with 1 bullet:

| Section | Lines it costs |
|---|---|
| projects (2 × 4 bullets) | 21.3 |
| experience (Aczen 4 + Student Tribe 1) | 15.1 (12.9 with Aczen alone at 5) |
| education | 5.8 |
| skills | 5.8 |
| summary | 5.7 |
| certifications + achievements row | 5.1 (certs column binding; achievements cost 0 while certs are taller) |
| **slack** | **−1.2 lines (model refuses)** |

- **Real Chromium:** the reconstruction prints on **1 page**. Adding one more one-line bullet spills it to **2 pages**.
  So the real page has under one line to spare. The model's 3% headroom (about 2.1 lines) is why it refuses. That
  headroom is doing its job and should not be loosened (see options).

## (2) The 7 queue rows from tonight's drain, with v30's 5 certs

The 5 v29 rows (3 certs) had v30's 5 resolved certs swapped in (taken from 22571d3c). The 2 v30 rows were measured
as stored.

| Row | As stored | With 5 certs: model slack | Real `fitToOnePage` with 5 certs | PDF pages |
|---|---|---|---|---|
| 060162ca (v29) | +1.1 | **−1.0** | fits after trimming **1** bullet (Aczen 5, project 6 bullets) | 1 |
| dabb8ae2 (v29) | +1.1 | **−1.1** | fits after trimming **2** bullets | 1 |
| 800e8d08 (v29) | +7.3 | +5.1 | fits, 0 trimmed | 1 |
| dc7cfdec (v29) | +5.3 | +3.1 | fits, 0 trimmed | 1 |
| f4e2f35f (v29) | +5.3 | +3.1 | fits, 0 trimmed | 1 |
| 22571d3c (v30) | +1.1 | (already 5) | fits, 0 trimmed | 1 |
| db9b46ef (v30) | +1.1 | (already 5) | fits, 0 trimmed | 1 |
| 38bb2f12 recon (v30) | — | **−1.2** | **REFUSED** (all floors bind) | 1 |

**Count:** of the 7 queue rows, **0 would be refused** and **2 would lose bullets** (1 and 2). Every refusal needs the
38bb2f12 shape: floors already binding plus a second experience entry. Per the standing ruling, the queue is NOT
re-tailored; this table only says what a re-tailor *would* do.

## (3) Layout fixes that keep every cert and achievement

Each was measured as a render-only transform on the cert entries, over all 13 cases above. The saving is identical
everywhere:

| Option | Lines saved | Keeps issuer | Keeps credential links | 38bb2f12 recon slack after |
|---|---|---|---|---|
| A. **Issuer inline**: `Machine Learning (IBM SkillsBuild)`, no separate detail line | **2.1** | yes | yes | **+1.0, fits, 0 trimmed** |
| B. Drop the cert link lines | 2.0 | yes | **no** | +0.8 |
| C. A + B | 2.1 | yes | no | +1.0 |
| D. All certs on one `·`-separated line, with issuers | 2.1 | yes | no | +1.0 |
| E. All certs on one line, names only | 2.1 | no | no | +1.0 |

**Why every option tops out at 2.1 lines:** the certs and achievements row is as tall as its taller column. Once the
cert column shrinks to the achievements column's height (about 2.3 lines), achievements set the height and any further
cert compaction saves nothing. Gaining more than 2.1 lines would mean touching the achievements column or another
section.

With option A, the real trimmer gives: 38bb2f12 recon **fits, 0 trimmed**; 060162ca and dabb8ae2 fit with **0**
bullets trimmed (they lost 1 and 2 under the current layout).

## Trade-off and recommendation

- **Option A (recommended).** It saves the maximum available (2.1 lines), drops nothing, and is the smallest visual
  change: one detail line folded into the title line. Costs:
  1. It is a **renderer change** (`packages/resume-template`, `renderUndatedEntry` for certifications only), so it
     changes the look of **every** resume, including the 86 already awaiting approval. Their certs would print one
     line per cert at submit instead of two. Content is identical; only the cert block is shorter, so it cannot push
     an approved resume onto page 2.
  2. It needs the renderer's calibration test and the ATS parse test (`worker/test/ats-parse-real-pdf.test.ts`)
     re-run, and the approval preview re-checked on a real PDF.
  3. There is no PDF cache to invalidate: `tailored_hash` appears only in docs and comments, not in live worker code
     (grep 2026-11-09).
- **Option B (drop cert links):** almost the same saving, but it removes the credential links Teja put on the master
  on purpose. Not recommended.
- **D/E (one line):** no extra saving over A, harder to read, and E loses the issuers. Not recommended.
- **Loosen `SAFETY` (0.97 → ~0.985):** would accept 38bb2f12 with no layout change, but the real page then has under
  one line to spare (measured above). Any difference between the CI runner's Chromium or fonts and the local render
  then ends at the worker's 2-page refusal at submit time, after Teja has already approved. Not recommended.
- **Do nothing:** the refusal stays limited to the 38bb2f12 shape (floors binding plus a second experience). Rows with
  spare bullets keep losing 1-2 bullets.

**Recommendation: option A.** It is a small renderer-only parcel: certifications get the issuer inline, achievements
are untouched. Gate it with the calibration test, the ATS parse test, and a real-PDF page count over the 86-row queue
before the deploy. Then re-run 38bb2f12 through the tailor.

## Caveats

- 38bb2f12's numbers come from a reconstruction: real v30 certs, achievements, projects and summary from 22571d3c, at
  the floors that its `blockedBy` names. The tailor's own wording for that job was never stored. It is evidence for
  the *shape* of the failure, not an exact replay.
- `fitToOnePage` was run with `jdKeywords = []`. That changes *which* bullets the trimmer picks, not how many.
- PDF pages were counted with local Chromium (worker's Playwright). The submit-time count runs on the CI runner.
