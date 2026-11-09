# Re-tailor QA, master v27 (2026-11-09)

Peer 2. Read-only: SELECTs plus local renders. No writes to live data.
State measured 2026-11-09 ~16:45 IST: 23 `awaiting_approval` (all `master_version` 27), 1 `approved`, 2 `dropped_filter`, 2 `failed` (Tether `04d5c6e4`, L&T `7890ff1b`, both still on old masters and outside this batch).

## Verdict

**All 23 `awaiting_approval` rows pass all 11 checks. The queue is ready to approve.**
That is the 18 rows asked for, plus a re-run of peer 3's 5 rows from 2026-11-08 as a control.
The one row that fails is the **approved** Supabase row `8f20a220` (see §3b). It is not in the queue.

## 1. How it was checked

Harness: peer 3's `qa.mjs` (bridge `C:\Users\tejam\applyyy-handoff-keep\2026-11-08-1745-peer3.md`), extended to `qa2.mjs` in peer 2's scratchpad.
Each row's stored `tailored_profile` goes through the production `renderResumePdf` (real Chromium, throws on more than 1 page). pdf.js then reads the page count, link annotations and text.

| # | Rule | How |
|---|---|---|
| 1 | One page | real render + pdf.js `numPages` |
| 2 | Exactly 2 projects, one is applyy | `projects[].ref` |
| 3 | Summary present and printed | data ≥ 40 chars, and its first 30 chars appear in the PDF text |
| 4 | Achievements left, certifications right | HTML order, then link x-position against page mid-line |
| 5 | Links clickable | PDF annotations include the applyyy repo, every cert URL and `mailto:` |
| 6 | Floors | Aczen ≥ 4, certs ≥ 3, achievements ≥ 2, education = 2 |
| 7 | Headline = role title | equals `cleanRoleTitle(job.title)` |
| 8 | Each project ≥ 4 bullets | strict (peer 3's floor was min(4, master max)) |
| 9 | Only email `tejamallam00@gmail.com` | identity email, every email in the PDF text, every `mailto:` |
| 10 | 1on1 link is the keeper | no URL contains `1on1_sb`; a row with the 1on1 project links `github.com/mallamteja/1on1` |
| 11 | Links blue | computed color of every `<a href>` in the rendered DOM is `rgb(17, 85, 204)` (#1155cc) |

**The gate was proved to fire.** A copy of `d45c3ba6` was injected with a wrong email, a `1on1_sb` link and a 3-bullet project. `3a4df0f9` was injected with tripled bullets. All five violations were caught, including `ResumeNotOnePageError: renders to 2 pages`. Check 11 was not red-tested.

## 2. Results (23 `awaiting_approval`)

Counts are Aczen bullets · project bullets · certs · achievements · education.

| id | company | role (headline) | pages | projects | counts | links blue | verdict |
|---|---|---|---|---|---|---|---|
| ce965450 | Cursor | Forward Deployed Engineer | 1 | applyy + one_on_one | 4 · 4/4 · 3 · 2 · 2 | 12/12 | PASS |
| d45c3ba6 | FIS | Java Developer with Angular | 1 | one_on_one + applyy | 4 · 4/4 · 3 · 2 · 2 | 12/12 | PASS |
| 3a4df0f9 | LSEG | Observability Platform Engineer | 1 | one_on_one + applyy | 4 · 4/4 · 3 · 2 · 2 | 12/12 | PASS |
| 2b7db9a2 | LSEG | Cyber Security Automation Developer | 1 | applyy + one_on_one | 4 · 4/4 · 3 · 2 · 2 | 12/12 | PASS |
| d0bf75bb | LSEG | Site Reliability Engineer | 1 | one_on_one + applyy | 5 · 5/4 · 3 · 2 · 2 | 11/11 | PASS |
| 8794f52f | FIS | Site Reliability Engineer | 1 | one_on_one + applyy | 5 · 4/4 · 3 · 2 · 2 | 12/12 | PASS |
| 4bd46605 | BlackRock | Models Infrastructure Platform Enablement | 1 | one_on_one + applyy | 5 · 6/4 · 3 · 2 · 2 | 12/12 | PASS |
| 9c26dfc6 | LSEG | Software Engineer | 1 | one_on_one + applyy | 4 · 4/4 · 3 · 2 · 2 | 12/12 | PASS |
| cb16aa3d | GE HealthCare | Research Intern | 1 | f1_predictor + applyy | 5 · 4/4 · 3 · 2 · 2 | 12/12 | PASS |
| afc4e657 | Broadridge | Python full stack + AWS | 1 | one_on_one + applyy | 5 · 5/4 · 3 · 2 · 2 | 12/12 | PASS |
| 3f87ad01 | Electronic Arts | Data Science Intern | 1 | f1_predictor + applyy | 4 · 4/4 · 3 · 2 · 2 | 12/12 | PASS |
| e5107026 | Netomi | Data Engineer I | 1 | one_on_one + applyy | 4 · 4/4 · 3 · 2 · 2 | 12/12 | PASS |
| a323b808 | Novartis | Specialist AI Engineer | 1 | f1_predictor + applyy | 5 · 4/4 · 3 · 2 · 2 | 12/12 | PASS |
| 1849aaa1 | Fractal Analytics | Gen AI Engineer | 1 | applyy + one_on_one | 4 · 4/4 · 3 · 2 · 2 | 12/12 | PASS |
| 58868e0a | LSEG | Site Reliability Engineer / DevOps Engineer | 1 | one_on_one + applyy | 5 · 5/4 · 3 · 2 · 2 | 12/12 | PASS |
| 8e9d58ce | Canonical | Web Frontend Engineer | 1 | one_on_one + applyy | 5 · 5/4 · 3 · 2 · 2 | 12/12 | PASS |
| f21fbd88 | Netomi | Devops Engineer | 1 | one_on_one + applyy | 5 · 6/4 · 3 · 2 · 2 | 12/12 | PASS |
| f1fa8258 | LSEG | Software Engineer | 1 | one_on_one + applyy | 5 · 4/4 · 3 · 2 · 2 | 12/12 | PASS |
| b7eb1ef1 | Zendesk | Software Engineer I | 1 | one_on_one + applyy | 4 · 4/4 · 3 · 2 · 2 | 12/12 | PASS (control) |
| a06fd6b8 | Canonical | Software Engineer | 1 | applyy + one_on_one | 5 · 4/4 · 3 · 2 · 2 | 12/12 | PASS (control) |
| 61693261 | Bristol Myers Squibb | Analytics Engineer I | 1 | one_on_one + applyy | 4 · 4/4 · 3 · 2 · 2 | 12/12 | PASS (control) |
| 37027b2d | Barclays | Full Stack Developer | 1 | one_on_one + applyy | 4 · 4/4 · 3 · 2 · 2 | 12/12 | PASS (control) |
| d0a7d313 | TrueFoundry | Backend Interns | 1 | one_on_one + applyy | 5 · 5/4 · 3 · 2 · 2 | 12/12 | PASS (control) |

Every row: only `tejamallam00@gmail.com`. Every one_on_one row links `github.com/mallamteja/1on1` and `open1on1.vercel.app`. No row links `1on1_sb`.

**Cosmetic, Teja's call. These are not rule failures.** Each headline equals `cleanRoleTitle`, but three read oddly:
- `d0a7d313`: "Backend Interns" is plural, copied from the posting.
- `d45c3ba6`: "Java Developer with Angular". The cleaner cuts the title at the comma in "…Angular , Spring Hibernate".
- `4bd46605`: "Models Infrastructure Platform Enablement" is the first segment of a long BlackRock title, not a role name.

## 3. The three odd rows

### 3a. Barclays `3c787bb6` and `b0e93ede` → `dropped_filter`

The **matcher** dropped them with `drop_reason: match_below_threshold`. This is the score floor of 30 working as designed.

| id | role | when (UTC) | score | band |
|---|---|---|---|---|
| 3c787bb6 | Mainframe Software Developer | 2026-11-08 12:23:06 | 15 | poor |
| b0e93ede | Software Engineer - Mainframe | 2026-11-08 12:24:14 | 22 | poor |

Matcher reasoning, quoted: *"zero experience with mainframe technologies such as COBOL, JCL, DB2, CICS, and IMS DB/DC, which are core requirements"*.
They were dropped because the master v27 re-run sent them back through scoring (`passed_filters → matcher`). Before that they had skipped scoring.

**Recommendation: leave them dropped.** The drop is correct and needs no action.

### 3b. Supabase `8f20a220` (approved): the resume fails the floors and the kit's "closed" is wrong

Timeline, from `application_events` (UTC):
1. 2026-11-08 12:09:56: re-tailored on v27, audit clean, `awaiting_approval`.
2. 12:11:32–12:14:59: **33 `resume_attest_skill` / `resume_add_bullet` edits** (`source: ai_chat_auto`, agent `human`). Four of them fired `page_fit_trimmed`. The trims removed `cert_ibm_ml`, `bullet_f1_data` and `bullet_applyy_grounding`. Teja's two re-adds of those bullets were trimmed again in the same edit.
3. 12:15:12: `awaiting_approval → approved` (human, `bucket_b_review`, 4 edited lines).
4. 12:16:00: applier `apply_kit_skipped`, `posting_closed`. Its reason: *"jobicy.com/jobs/159374-sdk-engineer-python shows no email field (2 field(s): Job title, company or skill, Dark mode)"*.
5. **2026-11-09 10:01:35 (the daily applier run): nothing was submitted.** A `release` event reads *"dry_run: DRY_RUN="true" is not the exact string "false"; refusing to submit"*. A second `release` 1 s later reads *"already processed earlier in this run"*: the same run picked the row twice. That is harmless here and worth a look later. The row is still `approved`.

**Finding 1. The approved resume breaks the rules.** It renders to 1 page, but the counts are certs **2** (needs 3) and projects **3/3** bullets (needs 4 each). The cause is that the AI-chat skill edits grew the skills block, and page-fit then trimmed certs and project bullets to make room. The failure was confirmed twice: the first run, then a fresh SELECT and re-render.

**Finding 2. The `posting_closed` kit verdict is a false positive.** The jobicy page returns 200 with title "Remote SDK Engineer – Python at Supabase". Its JSON-LD has `datePosted 2026-11-06` and `validThrough 2026-12-06`. It has an "Apply for this job" button and no expired badge. The kit took "no email field on an aggregator page" to mean "closed". This is the CLAUDE.md §6 pattern: missing data became an answer. The real application form sits behind jobicy, on Supabase's own careers site. This was not probed further.

**Recommendation for Teja:** withdraw the approval, then re-tailor. When editing the card, keep the skill additions small enough that page-fit does not trim certs or bullets. Then apply by hand from Supabase's careers site, because the jobicy URL has no form the bot can use. The withdraw is a human edge (`approved → passed_filters`: "Human withdraws the approval to re-score and re-tailor"). The orchestrator runs it, not a peer:

```sql
select public.advance_application_status(
  '8f20a220-5682-45a5-8cda-f3bcce0dc579'::uuid,
  'passed_filters'::application_status,
  'human'::agent_name,
  '{"reason":"qa_floor_fail_withdraw","qa_doc":"docs/status/2026-11-09-retailor-qa.md"}'::jsonb,
  '2026-11-09 10:01:36.806707+00'::timestamptz
);
```

Before running it, note three things:
- The last argument is an optimistic-concurrency guard: the row's `updated_at` as of the 16:45 IST SELECT. Re-read it right before running.
- Nothing re-scores `passed_filters` on a cron. Re-tailoring needs `postscreen-drain.yml` afterwards.
- A separate bug follows from Finding 2: the kit's "closed" heuristic should not run on aggregator hosts. Not fixed here.

## 4. Re-run

The scratch files are in peer 2's scratchpad `…\5e9823eb-c384-4392-af2e-87c137a8d137\scratchpad\qa\`: `rows.sql`, `master.sql`, `qa2.mjs` (queue rows) and `qa3.mjs` (also `approved`).
```bash
env -u SUPABASE_ACCESS_TOKEN supabase db query --linked -o json -f "$D/rows.sql" > "$D/rows.json"   # from the repo root
cd worker && node "$D/qa2.mjs" "$D/rows.json" "$D/master.json" [id8,id8,...]
```
