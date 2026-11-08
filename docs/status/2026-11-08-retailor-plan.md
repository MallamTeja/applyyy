# Re-tailor the approval queue on the new rules: run plan

Prepared 2026-11-08 ~16:40 IST by peer 3. **Not run.** Every live write below is run by the orchestrator, in the window where Teja approved it (repo CLAUDE.md §2).
Live data was read with SELECT only (`env -u SUPABASE_ACCESS_TOKEN supabase db query --linked`), at 2026-11-08 ~16:38 IST.

**Why:** Teja, 16:11 IST: "after all this re tailor all the resumes we have in our approval queue".
**Run order:** master v27 written → peer 1's content rules and peer 3's layout deployed (tailor edge function + web) → this plan.

## 0. Preconditions (check each, in order, before any move)

1. **Master.** `select max(version) from master_profiles` must return the new version (it was **26** at prep time; v27 is planned). Replace every `__NEW_MV__` below with that number.
2. **Deploys.** The tailor function and the web must both be on the new template commit. The tailor bundles `packages/resume-template` by relative path, so its `fitsOnePage` uses the new two-column page-fit model only after a redeploy.
3. **Nothing in flight.** At prep time, `applying` = 0 and `blocked_needs_human` = 0, and no `approved` row had `claimed_by` set. Re-check:
   `select id, status, claimed_by, claim_expires_at from applications where status in ('applying','blocked_needs_human') or claimed_by is not null;` must return 0 rows. If a row is `applying`, do not move it: there is no edge, and the move raises 23514.
4. **Teja stays off the Approval and Pipeline pages** until §4 passes. Tell him this first (on 11-07 a re-tailor mid-approval swallowed his approve clicks). His touch is also caught by the stamp below (PT409), but the cleaner path is that he doesn't touch anything.
5. **The scheduled applier is not live** (`APPLYY_CRON_LIVE` is unset or false), so no `approved` row is submitted between the read and the move. The applier wrote `note` events on all 5 approved rows today, 09:19 to 10:37 UTC.

## 1. Live queue at prep time

Status counts: approved 5 · awaiting_approval 16 · passed_filters 14 · scored 59 · failed 91 · applied 8 · rejected 1 · dropped_filter 35751 · applying 0 · blocked_needs_human 0.
Latest master: **v26** (user `0f4b24da`, written 2026-11-08 10:27:55 UTC).

| group | rows | action |
|---|---|---|
| awaiting_approval, all on master v24 | 16 | move to passed_filters (§2) |
| approved, on master v19/20/24/25/26 | 5 | move to passed_filters (§2). This **withdraws Teja's approval**; he re-approves after the re-tailor |
| failed, retry: Tether `04d5c6e4`, L&T `7890ff1b` | 2 | move to passed_filters (§2). Allowed because previous_status = `scored` (guard_failed_rerun) |
| failed, **skip**: DocCheck `b7ccb314` | 1 | none (Teja's ruling) |
| passed_filters, already queued, Teja's picks: `b0e93ede` `3a4df0f9` `d45c3ba6` `3c787bb6` (all `manual`) and `2b7db9a2` | 5 | no move needed; included in the run (§3) |
| passed_filters, scout-inserted, not Teja's: `4333ab9f` MEYA, `5999b66c` Adapty, ElevenLabs ×7 (`2a5704a9` `b64d0652` `0eaeefc7` `c4298a31` `10e737c4` `3666b0aa` `56a1b250`) | 9 | **not** part of this re-tailor. The per-row path (§3, option A) leaves them alone |

**Total to re-tailor: 23 moved + 5 already queued = 28 rows.**

The match score each row will be re-judged against (floor 30; rows tagged `manual` bypass it):

| id | status | current score | manual? | company |
|---|---|---|---|---|
| 8794f52f | awaiting | **32** | no | FIS (SRE Cloud Platform) |
| d0bf75bb | awaiting | **33** | no | LSEG (SRE) |
| f21fbd88, 8f20a220 | awaiting | 49 | no | Netomi, Supabase |
| 58868e0a | awaiting | 50 | no | LSEG |
| 8e9d58ce, a06fd6b8, 37027b2d, e5107026, 9c26dfc6, 04d5c6e4 | mixed | 52 | no | Canonical ×2, Barclays, Netomi, LSEG, Tether |
| cb16aa3d, afc4e657, b7eb1ef1, f1fa8258 | mixed | 53–58 | no | GE HealthCare, Broadridge, Zendesk, LSEG |
| 61693261, 4bd46605, d0a7d313, 1849aaa1, ce965450, a323b808 | mixed | 64–79 | no | BMS, BlackRock, TrueFoundry, Fractal, Cursor, Novartis |
| 7890ff1b, 3f87ad01 | failed / approved | 82, 91 | **yes** | L&T, Electronic Arts |

## 2. The moves: one statement per row, one CLI call per statement

**Mechanism.** `advance_application_status(p_application_id, p_to_status, p_agent, p_detail, p_expected_updated_at)` is called as the CLI's `postgres` role with `p_agent = 'human'`. That is legal: the agent-key check runs only for non-human agents. The edges `awaiting_approval → passed_filters`, `approved → passed_filters` and `failed → passed_filters` are all `{human}` (migration `20261101173000`, commit 87fff82).

**Stale check.** `p_expected_updated_at` is each row's `updated_at` as text, with full microseconds, read at prep time. If the row changed since (Teja approved or edited it, or the applier released a claim), the function raises **SQLSTATE PT409** `application <id> changed since it was read …`, rolls back, and moves nothing. **On PT409: skip the row and report it. Never re-read and retry without a fresh human decision.** Passing NULL disables the check, so never omit the stamp.

**Why one call per row.** Several statements in one file share one transaction, so a single PT409 would roll back the rows before it and leave the batch half-known. Run each statement as its own file:

```bash
# per statement: write it to a file, then run it; exit code ≠ 0 = refused (read the SQLSTATE)
env -u SUPABASE_ACCESS_TOKEN supabase db query --linked -o json -f move-<id8>.sql
```

**Success** prints one row: `status = passed_filters`, `previous_status` = the old status.
**Other refusals:** 23514 means no such edge (the row is now `applying`, `scored` or `audit_flagged`); 42501 is guard_failed_rerun.

If the master moves again before the run, the stamps stay valid: a master write doesn't touch `applications`. Only a change to the row itself trips PT409.

```sql
-- Barclays | Full Stack Developer | awaiting_approval | mv 24
select r.id, r.status, r.previous_status, r.updated_at from public.advance_application_status(p_application_id := '37027b2d-094b-4623-9e38-747669a5b73e'::uuid, p_to_status := 'passed_filters'::public.application_status, p_agent := 'human'::public.agent_name, p_detail := jsonb_build_object('reason','master_rerun','from_master',24,'to_master',__NEW_MV__), p_expected_updated_at := '2026-11-07 17:00:12.918339+00'::timestamptz) r;

-- Bristol Myers Squibb | Analytics Engineer I , Commercialization | awaiting_approval | mv 24
select r.id, r.status, r.previous_status, r.updated_at from public.advance_application_status(p_application_id := '61693261-85c2-4792-8020-cbd5e9157044'::uuid, p_to_status := 'passed_filters'::public.application_status, p_agent := 'human'::public.agent_name, p_detail := jsonb_build_object('reason','master_rerun','from_master',24,'to_master',__NEW_MV__), p_expected_updated_at := '2026-11-07 17:03:48.161831+00'::timestamptz) r;

-- Canonical | Software Engineer - Solutions Engineering | awaiting_approval | mv 24
select r.id, r.status, r.previous_status, r.updated_at from public.advance_application_status(p_application_id := 'a06fd6b8-e6b4-463d-ae72-f9d3918601e0'::uuid, p_to_status := 'passed_filters'::public.application_status, p_agent := 'human'::public.agent_name, p_detail := jsonb_build_object('reason','master_rerun','from_master',24,'to_master',__NEW_MV__), p_expected_updated_at := '2026-11-07 17:06:24.236941+00'::timestamptz) r;

-- Zendesk | Software Engineer I | awaiting_approval | mv 24
select r.id, r.status, r.previous_status, r.updated_at from public.advance_application_status(p_application_id := 'b7eb1ef1-ccb8-4ab1-8aa5-c73325690689'::uuid, p_to_status := 'passed_filters'::public.application_status, p_agent := 'human'::public.agent_name, p_detail := jsonb_build_object('reason','master_rerun','from_master',24,'to_master',__NEW_MV__), p_expected_updated_at := '2026-11-07 17:07:15.750237+00'::timestamptz) r;

-- Cursor | Forward Deployed Engineer - India | awaiting_approval | mv 24
select r.id, r.status, r.previous_status, r.updated_at from public.advance_application_status(p_application_id := 'ce965450-bb44-449d-b1f3-dc854a98d783'::uuid, p_to_status := 'passed_filters'::public.application_status, p_agent := 'human'::public.agent_name, p_detail := jsonb_build_object('reason','master_rerun','from_master',24,'to_master',__NEW_MV__), p_expected_updated_at := '2026-11-07 17:09:48.602742+00'::timestamptz) r;

-- TrueFoundry | Backend Interns | awaiting_approval | mv 24
select r.id, r.status, r.previous_status, r.updated_at from public.advance_application_status(p_application_id := 'd0a7d313-90e0-4e63-9b03-b02d84686812'::uuid, p_to_status := 'passed_filters'::public.application_status, p_agent := 'human'::public.agent_name, p_detail := jsonb_build_object('reason','master_rerun','from_master',24,'to_master',__NEW_MV__), p_expected_updated_at := '2026-11-07 17:10:45.201946+00'::timestamptz) r;

-- LSEG | Software Engineer (Java, Spring Boot & Python) | awaiting_approval | mv 24
select r.id, r.status, r.previous_status, r.updated_at from public.advance_application_status(p_application_id := 'f1fa8258-86bd-40de-a768-b02a7e5250b8'::uuid, p_to_status := 'passed_filters'::public.application_status, p_agent := 'human'::public.agent_name, p_detail := jsonb_build_object('reason','master_rerun','from_master',24,'to_master',__NEW_MV__), p_expected_updated_at := '2026-11-07 17:12:08.18943+00'::timestamptz) r;

-- Netomi | Devops Engineer - I | awaiting_approval | mv 24
select r.id, r.status, r.previous_status, r.updated_at from public.advance_application_status(p_application_id := 'f21fbd88-df39-4339-a38b-f61c72621b25'::uuid, p_to_status := 'passed_filters'::public.application_status, p_agent := 'human'::public.agent_name, p_detail := jsonb_build_object('reason','master_rerun','from_master',24,'to_master',__NEW_MV__), p_expected_updated_at := '2026-11-07 17:12:49.570662+00'::timestamptz) r;

-- Canonical | Web Frontend Engineer - JS, CSS, React, Flutter | awaiting_approval | mv 24
select r.id, r.status, r.previous_status, r.updated_at from public.advance_application_status(p_application_id := '8e9d58ce-7db8-481d-b9d8-a44198b1e526'::uuid, p_to_status := 'passed_filters'::public.application_status, p_agent := 'human'::public.agent_name, p_detail := jsonb_build_object('reason','master_rerun','from_master',24,'to_master',__NEW_MV__), p_expected_updated_at := '2026-11-07 18:22:16.083865+00'::timestamptz) r;

-- LSEG | Site Reliability Engineer / DevOps Engineer | awaiting_approval | mv 24
select r.id, r.status, r.previous_status, r.updated_at from public.advance_application_status(p_application_id := '58868e0a-0b53-4d17-910e-20a7a057d213'::uuid, p_to_status := 'passed_filters'::public.application_status, p_agent := 'human'::public.agent_name, p_detail := jsonb_build_object('reason','master_rerun','from_master',24,'to_master',__NEW_MV__), p_expected_updated_at := '2026-11-07 18:23:19.045095+00'::timestamptz) r;

-- Fractal Analytics | Gen AI Engineer | awaiting_approval | mv 24
select r.id, r.status, r.previous_status, r.updated_at from public.advance_application_status(p_application_id := '1849aaa1-1fbd-418d-8d8c-f973666a55ed'::uuid, p_to_status := 'passed_filters'::public.application_status, p_agent := 'human'::public.agent_name, p_detail := jsonb_build_object('reason','master_rerun','from_master',24,'to_master',__NEW_MV__), p_expected_updated_at := '2026-11-07 18:24:10.139511+00'::timestamptz) r;

-- Supabase | SDK Engineer - Python | awaiting_approval | mv 24
select r.id, r.status, r.previous_status, r.updated_at from public.advance_application_status(p_application_id := '8f20a220-5682-45a5-8cda-f3bcce0dc579'::uuid, p_to_status := 'passed_filters'::public.application_status, p_agent := 'human'::public.agent_name, p_detail := jsonb_build_object('reason','master_rerun','from_master',24,'to_master',__NEW_MV__), p_expected_updated_at := '2026-11-07 19:13:50.156102+00'::timestamptz) r;

-- Novartis | Specialist AI Engineer | awaiting_approval | mv 24
select r.id, r.status, r.previous_status, r.updated_at from public.advance_application_status(p_application_id := 'a323b808-96e0-440d-910e-8bdf274af8ae'::uuid, p_to_status := 'passed_filters'::public.application_status, p_agent := 'human'::public.agent_name, p_detail := jsonb_build_object('reason','master_rerun','from_master',24,'to_master',__NEW_MV__), p_expected_updated_at := '2026-11-07 19:14:15.24249+00'::timestamptz) r;

-- Netomi | Data Engineer I | awaiting_approval | mv 24
select r.id, r.status, r.previous_status, r.updated_at from public.advance_application_status(p_application_id := 'e5107026-2457-4e81-b915-70e54066938a'::uuid, p_to_status := 'passed_filters'::public.application_status, p_agent := 'human'::public.agent_name, p_detail := jsonb_build_object('reason','master_rerun','from_master',24,'to_master',__NEW_MV__), p_expected_updated_at := '2026-11-07 19:15:19.65176+00'::timestamptz) r;

-- FIS | Site Reliability Engineer (SRE) – Cloud Platform | awaiting_approval | mv 24
select r.id, r.status, r.previous_status, r.updated_at from public.advance_application_status(p_application_id := '8794f52f-94c7-44a3-b737-758359bf45e9'::uuid, p_to_status := 'passed_filters'::public.application_status, p_agent := 'human'::public.agent_name, p_detail := jsonb_build_object('reason','master_rerun','from_master',24,'to_master',__NEW_MV__), p_expected_updated_at := '2026-11-07 19:16:28.165914+00'::timestamptz) r;

-- LSEG | Site Reliability Engineer | awaiting_approval | mv 24
select r.id, r.status, r.previous_status, r.updated_at from public.advance_application_status(p_application_id := 'd0bf75bb-c464-4531-9093-ce456b1208e7'::uuid, p_to_status := 'passed_filters'::public.application_status, p_agent := 'human'::public.agent_name, p_detail := jsonb_build_object('reason','master_rerun','from_master',24,'to_master',__NEW_MV__), p_expected_updated_at := '2026-11-07 19:16:53.064741+00'::timestamptz) r;

-- Electronic Arts | Data Science Intern | approved | mv 20
select r.id, r.status, r.previous_status, r.updated_at from public.advance_application_status(p_application_id := '3f87ad01-1c3c-459c-99a7-6089c264e8d8'::uuid, p_to_status := 'passed_filters'::public.application_status, p_agent := 'human'::public.agent_name, p_detail := jsonb_build_object('reason','master_rerun','from_master',20,'to_master',__NEW_MV__), p_expected_updated_at := '2026-11-08 09:18:38.566171+00'::timestamptz) r;

-- Broadridge | Python full stack + AWS (ETL) | approved | mv 19
select r.id, r.status, r.previous_status, r.updated_at from public.advance_application_status(p_application_id := 'afc4e657-51b6-4cda-a336-f93db61f6a91'::uuid, p_to_status := 'passed_filters'::public.application_status, p_agent := 'human'::public.agent_name, p_detail := jsonb_build_object('reason','master_rerun','from_master',19,'to_master',__NEW_MV__), p_expected_updated_at := '2026-11-08 09:18:38.797305+00'::timestamptz) r;

-- GE HealthCare | Research Intern - AI | approved | mv 24
select r.id, r.status, r.previous_status, r.updated_at from public.advance_application_status(p_application_id := 'cb16aa3d-693a-4956-a21d-2135a0348347'::uuid, p_to_status := 'passed_filters'::public.application_status, p_agent := 'human'::public.agent_name, p_detail := jsonb_build_object('reason','master_rerun','from_master',24,'to_master',__NEW_MV__), p_expected_updated_at := '2026-11-08 10:07:43.764714+00'::timestamptz) r;

-- LSEG | Software Engineer | approved | mv 25
select r.id, r.status, r.previous_status, r.updated_at from public.advance_application_status(p_application_id := '9c26dfc6-ed33-4f0f-9c80-f510df3b824d'::uuid, p_to_status := 'passed_filters'::public.application_status, p_agent := 'human'::public.agent_name, p_detail := jsonb_build_object('reason','master_rerun','from_master',25,'to_master',__NEW_MV__), p_expected_updated_at := '2026-11-08 10:27:13.661888+00'::timestamptz) r;

-- BlackRock | Models Infrastructure Platform Enablement (Python + React),  | approved | mv 26
select r.id, r.status, r.previous_status, r.updated_at from public.advance_application_status(p_application_id := '4bd46605-b12c-4bc4-b2ec-b2602461491b'::uuid, p_to_status := 'passed_filters'::public.application_status, p_agent := 'human'::public.agent_name, p_detail := jsonb_build_object('reason','master_rerun','from_master',26,'to_master',__NEW_MV__), p_expected_updated_at := '2026-11-08 10:36:53.958985+00'::timestamptz) r;

-- L&T Precision Engineering & Systems IC | GenAI Trainee | failed | mv 14
select r.id, r.status, r.previous_status, r.updated_at from public.advance_application_status(p_application_id := '7890ff1b-ebde-4212-82c0-43cf078c0b3e'::uuid, p_to_status := 'passed_filters'::public.application_status, p_agent := 'human'::public.agent_name, p_detail := jsonb_build_object('reason','master_rerun','from_master',14,'to_master',__NEW_MV__), p_expected_updated_at := '2026-11-07 18:24:55.674853+00'::timestamptz) r;

-- Tether Operations Limited | Research Engineer Intern (Multimodal LLM) | failed | mv 11
select r.id, r.status, r.previous_status, r.updated_at from public.advance_application_status(p_application_id := '04d5c6e4-e9fc-4d06-9e24-a8dc621cd00a'::uuid, p_to_status := 'passed_filters'::public.application_status, p_agent := 'human'::public.agent_name, p_detail := jsonb_build_object('reason','master_rerun','from_master',11,'to_master',__NEW_MV__), p_expected_updated_at := '2026-11-07 18:25:47.900558+00'::timestamptz) r;
```

## 3. The re-tailor run

**Option A, recommended: `run-one.yml` per row, serially.** It takes `application_id` (uuid) and pushes that one row through matcher → tailor → auditor. The 5 most recent runs (11-07 18:21–18:25 UTC) all succeeded in **41–55 s** each. Its concurrency group is per row (`run-one-<id>`), so dispatches for different rows **run in parallel**. Space them **≥ 60 s** apart to stay under Gemini's ~15 RPM window (the 429s on 11-01 were the RPM window, not the daily quota).

```bash
# the 23 moved rows + the 5 already at passed_filters; one dispatch per row, 60 s apart
for id in \
  37027b2d-094b-4623-9e38-747669a5b73e 61693261-85c2-4792-8020-cbd5e9157044 a06fd6b8-e6b4-463d-ae72-f9d3918601e0 \
  b7eb1ef1-ccb8-4ab1-8aa5-c73325690689 ce965450-bb44-449d-b1f3-dc854a98d783 d0a7d313-90e0-4e63-9b03-b02d84686812 \
  f1fa8258-86bd-40de-a768-b02a7e5250b8 f21fbd88-df39-4339-a38b-f61c72621b25 8e9d58ce-7db8-481d-b9d8-a44198b1e526 \
  58868e0a-0b53-4d17-910e-20a7a057d213 1849aaa1-1fbd-418d-8d8c-f973666a55ed 8f20a220-5682-45a5-8cda-f3bcce0dc579 \
  a323b808-96e0-440d-910e-8bdf274af8ae e5107026-2457-4e81-b915-70e54066938a 8794f52f-94c7-44a3-b737-758359bf45e9 \
  d0bf75bb-c464-4531-9093-ce456b1208e7 3f87ad01-1c3c-459c-99a7-6089c264e8d8 afc4e657-51b6-4cda-a336-f93db61f6a91 \
  cb16aa3d-693a-4956-a21d-2135a0348347 9c26dfc6-ed33-4f0f-9c80-f510df3b824d 4bd46605-b12c-4bc4-b2ec-b2602461491b \
  7890ff1b-ebde-4212-82c0-43cf078c0b3e 04d5c6e4-e9fc-4d06-9e24-a8dc621cd00a \
  b0e93ede-6b0d-4abe-bdf1-e28c18ee4b56 3a4df0f9-3a5f-4bb5-b795-63cb68705b0d d45c3ba6-6e53-43c9-8146-5a2402708c3f \
  3c787bb6-e21f-4570-9432-5ce8af2d0602 2b7db9a2-dab1-4e98-8f8e-718716afce0c; do
  gh workflow run run-one.yml --ref main -f application_id="$id"   # dispatch this row only
  sleep 60                                                          # Gemini RPM spacing
done
```

**Expected duration:** 28 dispatches × 60 s ≈ **28 min** to dispatch, plus ~1 min for the last run, so about **30 min**. Check with `gh run list --workflow=run-one.yml --limit 30 --json conclusion,createdAt,updatedAt`.

**Option B, not recommended: one `postscreen-drain.yml` dispatch.** It has no row or id input. The matcher takes **every** `passed_filters` row (10 per page, cap 40 pages) and the tailor takes **every** `scored` row (3 per page, cap 90), each ordered by `created_at` ascending, with 45 s between pages (`postscreen-drain.yml:109-129`). Today that is 28 + 9 scout rows at passed_filters plus **59 old `scored` rows**, about 96 tailors: ~4 matcher pages + ~32 tailor pages + ~20 auditor pages ≈ 56 pages ≈ **60–70 min**. It also re-tailors 68 rows Teja didn't ask for. The last clean drain (run 41456608718, 11-02) ran 49 pages in 50 min. Command, if chosen anyway:
`gh workflow run postscreen-drain.yml --ref main -f from_stage=matcher -f dry_count_only=false`

## 4. Verify (SELECT only), after the last run finishes

```sql
-- every re-tailored row should be back for review, on the new master, with at most 2 projects
select a.id, a.status, a.master_version, jsonb_array_length(a.tailored_profile->'projects') as projects, j.company_name
from public.applications a join public.jobs j on j.id = a.job_id
where a.id in (
  '37027b2d-094b-4623-9e38-747669a5b73e','61693261-85c2-4792-8020-cbd5e9157044','a06fd6b8-e6b4-463d-ae72-f9d3918601e0',
  'b7eb1ef1-ccb8-4ab1-8aa5-c73325690689','ce965450-bb44-449d-b1f3-dc854a98d783','d0a7d313-90e0-4e63-9b03-b02d84686812',
  'f1fa8258-86bd-40de-a768-b02a7e5250b8','f21fbd88-df39-4339-a38b-f61c72621b25','8e9d58ce-7db8-481d-b9d8-a44198b1e526',
  '58868e0a-0b53-4d17-910e-20a7a057d213','1849aaa1-1fbd-418d-8d8c-f973666a55ed','8f20a220-5682-45a5-8cda-f3bcce0dc579',
  'a323b808-96e0-440d-910e-8bdf274af8ae','e5107026-2457-4e81-b915-70e54066938a','8794f52f-94c7-44a3-b737-758359bf45e9',
  'd0bf75bb-c464-4531-9093-ce456b1208e7','3f87ad01-1c3c-459c-99a7-6089c264e8d8','afc4e657-51b6-4cda-a336-f93db61f6a91',
  'cb16aa3d-693a-4956-a21d-2135a0348347','9c26dfc6-ed33-4f0f-9c80-f510df3b824d','4bd46605-b12c-4bc4-b2ec-b2602461491b',
  '7890ff1b-ebde-4212-82c0-43cf078c0b3e','04d5c6e4-e9fc-4d06-9e24-a8dc621cd00a',
  'b0e93ede-6b0d-4abe-bdf1-e28c18ee4b56','3a4df0f9-3a5f-4bb5-b795-63cb68705b0d','d45c3ba6-6e53-43c9-8146-5a2402708c3f',
  '3c787bb6-e21f-4570-9432-5ce8af2d0602','2b7db9a2-dab1-4e98-8f8e-718716afce0c')
order by a.status, j.company_name;
```

**Pass:** 28 rows. Every one has `status in ('awaiting_approval','audit_flagged','failed')`. Every non-failed row has `master_version = __NEW_MV__` and `projects <= 2`.
**Any other status is a finding, not a pass:**
- `passed_filters` or `scored`: a run didn't reach it, so re-dispatch that id.
- `dropped_filter`: the matcher floor dropped it; see risk 1.
- `failed`: read `failure_reason` and the latest `tailor` event.

Count check: `select status, count(*) from applications where id in (<same 28>) group by 1` must sum to 28. The page-fit (one page) is enforced by the tailor's `fitsOnePage` on the new model.

## 5. Risks

1. **Matcher floor (one-way).** A moved row that isn't tagged `manual` is re-scored, and a score below 30 sends it to `dropped_filter`, permanently (the drop is an event). 21 of the 23 moved rows are not `manual`. Closest to the floor: **FIS `8794f52f` (32) and LSEG `d0bf75bb` (33)**. The score was computed against an older master; v26/v27 may shift it either way. Teja can rule to accept this or to skip those two.
2. **Approval withdrawn.** The 5 `approved` rows (EA, Broadridge, GE HealthCare, LSEG, BlackRock) lose their approval and come back as `awaiting_approval`. Teja must re-approve them after reviewing the new resume. BlackRock is already on v26.
3. **Stamp mismatch is expected for any row touched before the run** (PT409, a safe refusal). If preconditions take long, re-read the stamps (§2) right before moving, under the same human decision.
4. **Tailor refusals.** Tether and L&T failed `tailor_validation_failed` on 11-07 at masters v11 and v14. They may fail again on the new rules. If so, check `application_events where agent='tailor'`.
5. **Parallel runs.** `run-one.yml` concurrency is per row, so dispatching faster than 60 s apart risks Gemini 429s. A 429'd row stays at its input status and needs a re-dispatch.
6. **Stale resume visible during the run.** The old `tailored_profile` stays on a moved row (frozen at passed_filters) until the tailor overwrites it at `scored`. That is the other reason Teja stays off the Approval page.
7. **Shared scratchpad collision (found during prep).** Two recon agents both wrote `q1.sql`–`q3.sql` into the same scratchpad, and one read the other's results. Use a unique subfolder per session for the move files.

## 6. v27 offline replay (no Gemini), 2026-11-08 ~16:55 IST

**What was replayed.** Each row's stored `applications.tailor_refs`, run through the real tailor-side code by relative path (the content rules from e445e06, plus the split page-fit model in the working tree): `pickCitedVariant → enforceContentRules → headline_title = cleanRoleTitle(job title) → validateTailoredProfile → fitTailoredToOnePage → checkContentRules`. Masters: live **v26**, and the **v27 DRAFT** `docs/status/2026-11-08-master-v26.json`. The script is peer 1's replay.mjs, extended. It and its outputs are in the peer 3 scratch folder `p3_v27/`.

**One adjustment, and why.** Replayed with the stored bullet TEXT, v27 refuses all 23 rows with `unverifiable_token` (e.g. `bullet_aczen_db_indexing` 28×). Those texts were rewritten by the old tailor from v24 bullets, and v27 reworded the bullets and their numbers. A real re-tailor rewrites from v27, so that refusal is an artifact, not a prediction. The numbers below therefore swap every cited bullet's text for the master's verbatim text (`MASTER_TEXT=1`): the stored picks plus the new wording, as the closest offline stand-in.

**It is a lower bound on problems.** The LLM re-picks bullets and projects and rewrites text, so real results can differ, and only in the direction of new failures this replay can't see.

### Totals (28 rows)

| verdict | v26 live | v27 draft | rows |
|---|---|---|---|
| FITS one page | 19 | 19 | every fitting row is on rung 4 or 5 (the two densest), 0 trims, achievements and certifications side by side |
| OVERFLOW (page_overflow) | 2 | 2 | Tether `04d5c6e4`, L&T `7890ff1b` |
| REFUSED | 2 | 2 | EA `3f87ad01`, Broadridge `afc4e657`: `unresolved_ref:skill_db5a2722-e1ac-4252-a2f0-43b1991e4fd6` (a skill the master dropped in v26) |
| NO_REFS (never tailored, can't predict) | 5 | 5 | `2b7db9a2` `3a4df0f9` `3c787bb6` `b0e93ede` `d45c3ba6` |
| **sum** | 28 | 28 | |

**Real PDF cross-check.** The worker's `renderResumePdf` (real Chromium, throws on ≠ 1 page) on the 3 tightest v27 rows, all on rung 5: Fractal `1849aaa1`, Canonical `a06fd6b8`, Netomi `e5107026` → **all ONE PAGE**, about 123 KB each.

### The three questions

1. **Do the longer v27 bullets cause page_overflow?** No new overflow: 19 fit under both masters. Rungs moved in 2 rows: Zendesk `b7eb1ef1` went 5→4 and Netomi `e5107026` went 4→5. Headroom is thin, though. No row fits above rung 4, so any further growth (a longer summary, another skill group) lands on trims.
2. **Does F1 (now 4 bullets) change which 2 projects are picked? Yes, in 12 of 19 rows.** In v26, F1 had 3 bullets and failed the 4-bullet project floor, so `enforceContentRules` forced `one_on_one + applyy`. In v27 all three projects are eligible, and the ranking (`content-rules.ts:119-124`: eligible → the model's picks → JD keyword score → master order) falls to the stored model picks. Those often include F1. Rows that **lose applyy** to F1: Barclays `37027b2d`, BlackRock `4bd46605`, LSEG `58868e0a` `9c26dfc6` `f1fa8258`, BMS `61693261`, Supabase `8f20a220` (keeps applyy, loses one_on_one), Canonical `a06fd6b8`, Novartis `a323b808` (keeps applyy), Zendesk `b7eb1ef1`, GE HC `cb16aa3d`, Netomi `e5107026` `f21fbd88`. Consequence: **the new applyy GitHub link is absent from about 10 resumes.** A real re-tailor re-picks, so the exact rows will differ.
3. **Do the summary + split section + floors still fit?** Yes for 19 of 23 replayable rows, with 0 trims, all on rung 4–5. The 2 overflows are the floors themselves: `blockedBy` = `skills/summary/education: never removed`, `exp_aczen: keeps >= 4 bullets`, `exp_student_tribe: keeps >= 1`, and the project floors. Nothing left can be trimmed, so the tailor will fail `page_overflow` on Tether and L&T again.

### Rows needing Teja

- **Project choice (12 rows).** Should `applyy` (the multi-agent project, now with its GitHub link) always be one of the 2 projects? Today's rule lets F1 displace it. If yes, that is a content-rules change: pin `proj_applyy` in the ranking. It belongs to peer 1, before the re-tailor.
- **Tether `04d5c6e4`, L&T `7890ff1b`: predicted page_overflow** at the current floors. Either skip them in the run, or relax a floor for them (e.g. the 4-bullet Aczen floor). Spending 2 Gemini runs to re-fail them isn't useful.
- **EA `3f87ad01`, Broadridge `afc4e657`: refused on a stale skill ref** (`skill_db5a2722…`, removed from the master). A fresh tailor re-picks skills, so this one likely clears in the real run (LLM re-pick). The replay can't confirm it.
