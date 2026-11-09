# The 91 `failed` applications: cause, and what is recoverable on master v27 (2026-11-09)

**Status: audit only (SELECTs). No status moved.** Measured 17:15–17:45 IST against the live DB
(project `xynqxekcqizwhtskzqrq`), user `0f4b24da…` (the only owner of `failed` rows).
Tether `04d5c6e4` and L&T `7890ff1b` are excluded by Teja's ruling (they stay failed), leaving **89 rows**.

## Verdict

| Verdict | Rows |
| --- | --- |
| **Recoverable now** (re-run through `failed -> passed_filters`) | **9** |
| Needs Teja (passes today's gates, but location or language is doubtful) | 2 |
| Needs a description backfill first (Workday, job live, title passes the gates) | 24 |
| Leave | 54 |
| **Total** | **89** |

## How each row was classified

1. **Cause.** The failing `status_change` event carries only a snapshot of the row. The cause sits in the `note`
   event logged within ±2 min of it (`detail.reason`, plus `violations[]`, `skip_reason` or `stage`). Every one
   of the 91 rows has its failure event; 89 have a cause note. The two without one are `3c476629` and `0fcd296f`
   (both post-approval, both re-dropped by today's gates, see group E).
2. **Would today's gates keep it?** I replayed the auditor's last gate offline (`auditorPreGateDrop`,
   `supabase/functions/auditor/pregate.ts:45`) over every row's job, using the live config loaded through the real
   `loadPreGatePreferences` with a stub reader. Config: countries India/Nepal/Bhutan, remote policy
   `unlocked_or_authorized`, experience ceiling 1 year. Trap: `search_preferences` has **2 rows** (users `31e899ad`,
   0 titles, and `0f4b24da`, 54 titles). The CLI bypasses RLS, so the user must be named explicitly. A `limit 1`
   read can silently pick the wrong user.
3. **Would today's tailor succeed?** A re-run re-tailors from scratch: a new Gemini answer against master v27,
   not the stored refs. Most of these rows have no `tailored_profile` stored at all. So a stored-refs replay
   cannot predict the result, and I measured the live tailor instead:
   - **since v27 was created (2026-11-08 11:44 UTC): 23 tailored, 1 failed;**
   - over the last 48 h: 47 tailored, 5 failed (violations: `page_overflow` ×3, `unresolved_ref` ×3,
     `unverifiable_token` ×0).
   - The old failures in group A were `unverifiable_token` (the wording check, last seen 11-04) and
     `unresolved_ref` to `cert_ibm_sql`, `edu_mlrit` and `cert_prompt_eng`. **All three ids exist in v27**, so those
     refs now resolve. The ids that do not exist in v27 (`skill_openai`, `skill_node_js`, `bullet_one_on_one_*`)
     are absent from the prompt's master, so the model would have to invent them again.

## Groups

| Group | Cause (last failure) | Count | Rows (id prefix) | Replay / evidence | Verdict |
| --- | --- | --- | --- | --- | --- |
| A | tailor `tailor_validation_failed` (`unverifiable_token` / `unresolved_ref`), Oct 31–Nov 7 | 9 | `ef1e796a 22571d3c f241448f c492a347 75b24404 526e7895 f61398fd cb64a4bf 442cedce` | pre-gate PASS, `disappeared_at` null; the tailor on v27 is 23/24 | **recoverable now** |
| B | tailor `tailor_validation_failed` | 2 | `9cbf50d5` (Redgate, "Cambridge"), `b7ccb314` (DocCheck, "Homeoffice") | pre-gate PASS. But "Cambridge" is a UK city the work-auth gate does not know, and the matcher's note says the DocCheck JD requires German | **needs Teja** |
| C | tailor `tailor_validation_failed` | 10 | work_auth: `5421e823 93f74ee2 42b4346a 2f4fba37 11312698 d7a696fc 15dbe417 9d020523`; experience_ceiling: `e625b50f`; tech_gate_unclassified: `ee4eabf1` | today's pre-gate drops each one (US/Canada/Europe locations, etc.) | leave |
| D1 | matcher `missing_description` (+ `3dd93771` tailor `tailor_input_unusable:missing_description`) | 7 | `03c93f5f 7b5f718d 6b32fc94 f7af2a81 34d666f4 67c6b62b 3dd93771` | SmartRecruiters, `description_raw` null | leave (SR off by the 11-01 robots ruling) |
| D2 | matcher `missing_description` | 5 | `c04ee9b3 bba24b59 90c6cc2c 5aba68af 23737439` | Workday, `disappeared_at` set (11-05 to 11-08) | leave |
| D3 | matcher `missing_description` | 14 | experience_ceiling: `e9969973 dd1b24f4 b3cc3fea aeb2c0e9 96d0a68c 96bd2fa6 429aaaea 1cd3d847 137070c8`; tech_gate: `e4072083 2b080e34`; tech_gate_unclassified: `30abc94f`; title_non_software: `32775af3`; work_auth: `5e54e212` | the gates drop each one even without a body | leave |
| D4 | matcher `missing_description` (matcher run 11-01 to 11-04) | 24 | `f6daead2 f3a0c6bf e876c622 de4124f3 d1c21a92 cd9ac72b c922e507 c89a795d bad33707 a6a81ef8 a52740d6 68f84c22 6582f896 5c9db132 38d2b913 189ff8f1 211c11be 6a4480bf a4bf7238 605ebbdb 46bfcd31 8bf33f07 3587a388 a9a3c405` | Workday, job live, `description_raw` still null; a re-run fails again at the matcher | **needs a description backfill first** |
| E | post-approval: human `work_auth` ×5, `posting_stale` ×2, `posting_closed` ×1, no note ×2 | 10 | work_auth: `4d0680ee 0ebae14d 269f9e60 826a0de2 461f9f6b`; posting_stale: `a04238ae 07393b88`; posting_closed: `267dcfcd`; no note: `3c476629` (6 yrs required), `0fcd296f` (on-site Helsinki) | `guard_failed_rerun` refuses `failed -> passed_filters` for these (previous_status approved / needs_verification / blocked_needs_human). The two no-note rows are also dropped by today's gates | leave |
| F | human `posting_closed` (Teja, 11-06/11-07) ×7; auditor pre-gate `experience_ceiling` ×1 | 8 | posting_closed: `314f5b12 03e14152 2f30f118 fae990a8 cc44dc53 6b4a9e61 3424b639`; experience_ceiling: `c4ab09d0` (JD 5 yrs) | Teja's evidence: Greenhouse API 404, gone from the board, Workday 403. Not the aggregator `posting_closed` that peer 2 is investigating | leave |
| X | `page_overflow` | 2 | `04d5c6e4 7890ff1b` | Teja's ruling | excluded |

Total: 9 + 2 + 10 + 7 + 5 + 14 + 24 + 10 + 8 = 89, plus X = 91.

## Recovery SQL for group A (prepared, NOT run)

The edge is `failed -> passed_filters` (allowed agent `human`). It is allowed because these rows failed before
approval, so `previous_status` = `scored` passes `guard_failed_rerun`. `p_expected_updated_at` is the CAS value
read at 17:40 IST: a row touched since then is refused, not overwritten.
Cost: about 2 Gemini calls per row (matcher + tailor), so ~18 for the 9 rows.

Two facts to keep in mind:
- **Nothing scores `passed_filters` on a cron.** Dispatch `postscreen-drain.yml` afterwards.
- The re-run **skips the screener**. The auditor's pre-gate is what re-judges the job before Teja sees it.

```sql
-- Group A of docs/status/2026-11-09-failed-rows.md: pre-approval tailor failures whose jobs pass today's gates.
-- One statement per row, so a refused CAS shows which row moved since the audit.
select advance_application_status('ef1e796a-1bb7-4145-bc1b-a0b69fba24eb'::uuid, 'passed_filters', 'human', '{"reason":"failed_rerun","source":"failed_rows_audit_2026_11_09"}'::jsonb, '2026-11-07T04:21:46.673791+00:00'::timestamptz);
select advance_application_status('22571d3c-01c9-4249-b014-4958ae5f42ae'::uuid, 'passed_filters', 'human', '{"reason":"failed_rerun","source":"failed_rows_audit_2026_11_09"}'::jsonb, '2026-11-04T18:56:01.688038+00:00'::timestamptz);
select advance_application_status('f241448f-865f-498f-8c10-dd50dddf071e'::uuid, 'passed_filters', 'human', '{"reason":"failed_rerun","source":"failed_rows_audit_2026_11_09"}'::jsonb, '2026-11-04T18:55:49.850292+00:00'::timestamptz);
select advance_application_status('c492a347-9c09-438f-8b5f-b100f7681c29'::uuid, 'passed_filters', 'human', '{"reason":"failed_rerun","source":"failed_rows_audit_2026_11_09"}'::jsonb, '2026-11-02T14:19:38.839122+00:00'::timestamptz);
select advance_application_status('75b24404-d6ba-4e39-aee5-f31151ecd3ad'::uuid, 'passed_filters', 'human', '{"reason":"failed_rerun","source":"failed_rows_audit_2026_11_09"}'::jsonb, '2026-11-02T14:09:09.285097+00:00'::timestamptz);
select advance_application_status('526e7895-2575-488b-92ec-74e70e6bd45b'::uuid, 'passed_filters', 'human', '{"reason":"failed_rerun","source":"failed_rows_audit_2026_11_09"}'::jsonb, '2026-11-02T13:57:21.851419+00:00'::timestamptz);
select advance_application_status('f61398fd-9ad9-4b24-9ae9-62ba8b72a5ea'::uuid, 'passed_filters', 'human', '{"reason":"failed_rerun","source":"failed_rows_audit_2026_11_09"}'::jsonb, '2026-11-01T13:09:44.943278+00:00'::timestamptz);
select advance_application_status('cb64a4bf-64f0-4ea6-a8f9-936aacb3300c'::uuid, 'passed_filters', 'human', '{"reason":"failed_rerun","source":"failed_rows_audit_2026_11_09"}'::jsonb, '2026-11-01T09:47:02.215148+00:00'::timestamptz);
select advance_application_status('442cedce-08b1-475e-9bfa-1173677d5554'::uuid, 'passed_filters', 'human', '{"reason":"failed_rerun","source":"failed_rows_audit_2026_11_09"}'::jsonb, '2026-11-01T09:09:39.878515+00:00'::timestamptz);
```

Caveats inside group A, none of which blocks it:
- `442cedce` (Supabase Branching) has a 389-character JD, so the matcher has little to read.
- `c492a347` (Bromcom) and `f241448f` (ElevenLabs) are "Remote" postings from UK/US companies. The gate passes
  them under the `unlocked_or_authorized` policy.

## Open items this audit surfaced

- **D4 (24 Workday rows) needs a description backfill.** There is no backfill script in the repo: the 11-05
  `workday_backfill_2026_11_05` re-run was done by hand. Until the descriptions exist, re-running these rows only
  repeats `missing_description`.
- **Work-auth gate gap:** a city with no country ("Cambridge", Redgate `9cbf50d5`) passes as an unknown location.
  This is Teja's 11-05 ruling (unknown passes), but here the place is known, just not to the gate.
- **Failure cause is not on the row:** `applications.failure_reason` is null for 37 of the 91. The cause lives only
  in a note event. A reader of `failure_reason` alone sees "no reason".
