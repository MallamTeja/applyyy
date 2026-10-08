> **Historical record as of 2026-10-06.** Current state: [SYSTEM_ARCHITECTURE.md](../SYSTEM_ARCHITECTURE.md) · [PROGRESS.md](../PROGRESS.md).

# Handoff — 2026-10-06 evening (orchestrator applyyy-bc)

Written at ~21:20 IST because Teja hit the usage limit and closed every session.
It supersedes `2026-10-06-first-live-application-handoff.md` (c2a8ef0) on every point it covers.
**Every fact below is a measurement taken at a time. Measure it again before you trust it.**

## 1. The goal and where it stands

**The goal** is one real application, end to end. It goes through every stage in order: discover → match → tailor → audit → human approve → assisted fill → Teja clicks Submit → email tracking.

| Item | State (measured 19:15 IST) |
|---|---|
| Application row | `ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154`, GitLab "Intermediate Backend Engineer, India", Greenhouse job 8775507002 |
| Status | **`awaiting_approval`**, reached 12:07 IST, audit **clean**, unclaimed, only row in the queue |
| Tailored resume | Stored. It has 11 top-level keys and was made by `gemini-3.5-flash-lite`. |
| JD keywords | 23 were backfilled by hand at 12:54 IST. The honest score is about 6/23. |
| Next human steps | (optionally edit, once the editor ships) → approve at /approvals → `node worker\src\cli\assist.ts --id ba1e5d1d-…` → answer the 6 required questions in headed Chromium → Teja clicks Submit |

The 6 questions Teja answers by hand are:
1. Located in India?
2. Employment agreements
3. Visa sponsorship
4. Previously at GitLab
5. Open-source links
6. Primary language

Seven fields fill automatically: first and last name (from answer_bank), email, phone, LinkedIn, country and the resume. When the fill runs, watch the phone field for a duplicated +91.

## 2. Live production state (verified first-hand at 19:15 IST)

- **main = `3724d35`**. Everything up to it is pushed and CI is green.
- **Edge functions:**
  - `tailor` is v14 and `email-tracker-intake` is v15. Both were deployed by Teja at 19:13 IST from a clean worktree at 3724d35. A subagent verified the bundles by sentinel.
  - **Every other function** (matcher, scout-web, cover-letter and the rest) **is still the 2026-10-05 build.** They lack the model tag and the fallback.
- **Migration `20261006190000` is applied.** It freezes `tailored_profile` outside scored, audit_flagged and awaiting_approval. All three verification checks passed: the trigger is installed; an edit after approval is refused with 42501; an edit at awaiting_approval is allowed. The test writes were rolled back, and I re-checked the row afterwards.
- **Web (Vercel)** is live through `1d45b7d`:
  - Bucket A rows have Review and Preview resume.
  - The tailored and master resumes show side by side, each with Download PDF (print) and Download HTML.
  - The pipeline drawer has "View resume".
  - The ATS score says "not measured" when a row has no keywords.
  - Keyword matching uses word boundaries, through the shared `keywordAppearsIn`.
- **Gemini:**
  - `GEMINI_MODEL=gemini-3.5-flash-lite`.
  - Keys 1–11 are enabled and keys 12–20 are disabled.
  - `GEMINI_FALLBACK_MODEL` is **not set**. That is Teja's call.
  - A 503 "high demand" is per **model**, not per key. That was proven by probe; see the memory note.

## 3. Unfinished work — saved on a WIP branch, NOT on main

**Branch `wip/2026-10-06-resume-editor`** (pushed) holds a snapshot of the working tree at ~21:20 IST.

**TASK 8, the resume editor in the approval comparison view** (author: applyyy-83). It is built, and **applyyy-d6's review did NOT approve it yet.**

The rules it was built to follow:
- **R0:** an edit writes the line `text` only, never `master_text`. master_text is the ground truth for the auditor and for the diff's traced verdict.
- **R1:** an edited line is labelled "edited by you" and is never shown as traced.
- **R2:** an edited row leaves Bucket A and batch approval.
- **Save:** a conditional `.eq('status','awaiting_approval')` update, plus an `application_events` note.
- **Reset:** the original is rebuilt from `tailor_refs` and the pinned master.
- **Remove:** deletes the whole bullet. This also fixes a live bug where Remove was cosmetic only.
- **Editable lines:** bullets and summary only. Skills are not editable.

**Required before it commits, from d6's review:**
1. A save that throws after the UPDATE landed must catch the error and re-read the row.
2. Two-tab batch approval must not forge `edited_lines:0`. Use updated_at optimistic concurrency, plus a fresh select before the batch.
3. Add `edited_refs` to the approval `p_detail`.
4. One unreadable pinned master must refuse only its own row, not blank the whole queue (Page ~:297-306).
5. Enforce R0 at the save boundary.

Which of these were finished on disk at snapshot time is recorded at the bottom of this file, if applyyy-83 replied in time. Otherwise, assume every one is partial and re-verify each.

**To resume:**
1. Check out the branch in a separate worktree, or cherry-pick the paths.
2. Re-run `tsc` and the web suite.
3. Finish 1–5, each with a test, and red-on-revert for 2 and 4.
4. Get a review.
5. Land it as ONE commit on main with an explicit pathspec, then prove it live with a bundle sentinel.

**Also on the branch, with no known owner:** the `CLAUDE.md` edits. This is the same unclaimed diff the morning handoff flagged. **Ask Teja before landing it.**

**Not on the branch, deliberately:** `supabase/functions/deno.lock` (a deno-check side effect) and a stray root `deno.lock`, both of which can be deleted.

## 4. Open decisions for Teja

- Set `GEMINI_FALLBACK_MODEL`? The suggestion is gemini-3.6-flash or 3.8-flash, whichever a live probe shows answering.
- Re-audit for edited rows needs a migration adding an `awaiting_approval→tailored` human edge. Not built; for now edits are labelled, not audited.
- Email tracker:
  - capture real ATS sender hosts (workablemail.com and others);
  - decide whether display-name-only matching is trusted;
  - precision over recall on rejections: missed rejections wait for a human; false ones kill an application.
- A cover letter generated before an edit stays stale (`cover-letter/run.ts:108`). Not built.
- **Follow-up bugs:**
  - The approval diff and the auditor compare against the LATEST master, not the pinned one (`ApprovalQueuePage ~:162`, `auditor/index.ts:182-184`).
  - DiffView's sticky Approve bar may overlap the diff. It was seen only in automated screenshots.
- Delete Gemini key secrets 12–20, the bad `SUPABASE_ACCESS_TOKEN` user env var, and `$env:TEMP\applyyy-clean-bc`.
- **Security:** Teja's app password was pasted into a chat transcript, and it equals his email address. Rotate it after the first application, and update BOTH the GitHub secret and the Supabase secret `APPLYY_APP_USER_PASSWORD`. They drifted once today and broke the tailor's sign-in.

## 5. CLAUDE.md claims found stale today (not yet fixed, because CLAUDE.md has an unowned diff)

- §8 says "The Auditor does not exist as code". **False:** it exists in `supabase/functions/auditor/` and `_shared/audit/`, and it audited this row clean.
- §8's statements that `_shared/match/` and `_shared/tailor/` have "zero non-test importers" are stale too. Re-grep before quoting them.

## 6. Lessons from today worth keeping (most are in memory already)

- **A brief that specifies the implementation invites it.** "Same key on 503" would have bypassed the kill switch and the budget, because `claim_gemini_key` enforces both. Specify the goal and let the worker push back.
- **A deploy is not a push.** Commit and push authority does not include production deploys, and the auto-mode classifier blocks them. Teja runs deploys himself, from a clean worktree pinned to a SHA. A clean worktree needs `supabase/.temp/{project-ref,pooler-url,linked-project.json,postgres-version}` copied in before `--linked` works.
- **Read your own grep's blind spots.** A `[run-one]` line filter hid a multi-line JSON body, and a TZ-less `date` mislabelled UTC as IST. Both produced confident wrong reports.

## 7. Snapshot status of TASK 8, as reported by applyyy-83 at ~21:18 IST (not re-verified by the orchestrator)

- d6's fixes **(1)–(5) are all DONE on disk; none is partial.**
- The tree passes: `tsc` EXIT=0, web 364/364, vite build 0.
- Render checks: default 93/93, missing-pin 95/95, stale-batch S1 / fresh-batch S0 control pass, KW=measured 77/77.
- Red-on-revert is red on named cases: R0, R2, the save status guard, kept-claim, F2b ("a row changed elsewhere is never batch-approved"), and F4 ("queue hidden").
- **The only remaining gate is d6's re-review of the delta.** After that comes ONE commit on main, then the live sentinel proof.
- Re-run the gates first: this is a peer's report, not a measurement by the next reader.
