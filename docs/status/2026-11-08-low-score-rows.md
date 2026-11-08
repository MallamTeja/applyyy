# Low-score and failed rows Teja wants to apply to — 2026-11-08

Read-only investigation by peer 2, 15:25–15:45 IST. Every fact below came from a live SELECT
(Supabase project `xynqxekcqizwhtskzqrq`, run 2026-11-08 ~15:30 IST) or from code at `2a9ac31`.
Nothing here has been executed. The prepared writes in §4 and §5 are for the orchestrator to run
after Teja agrees.

Times are IST unless marked UTC. The dense-typography tailor (`dc8ac5c`) went live ~00:47 IST
2026-11-08. **Every failure below happened before it.**

## 1. The six rows (T1)

| # | Company · title | id | Status now | Score | Why, from the event data | Proposed move |
|---|---|---|---|---|---|---|
| 1 | LSEG · Cyber Security Automation Developer | `2b7db9a2-dab1-4e98-8f8e-718716afce0c` | `failed` (from `scored`) | 58 moderate | Tailor cited a summary variant it did not pick (§2.1) | `failed → passed_filters` (human), then run-one |
| 2 | LSEG · Observability Platform Engineer | `3a4df0f9-3a5f-4bb5-b795-63cb68705b0d` | `dropped_filter` (`match_below_threshold`) | 27 poor | Core tools are absent from master v24 | Human pick: tag `manual` + `dropped_filter → passed_filters` |
| 3 | FIS · Java Developer with Angular, Spring Hibernate | `d45c3ba6-6e53-43c9-8146-5a2402708c3f` | `dropped_filter` (`match_below_threshold`) | 22 poor | Java, Spring, Hibernate and Angular are absent from master v24 | Same as #2 |
| 4 | Barclays · Mainframe Software Developer | `3c787bb6-e21f-4570-9432-5ce8af2d0602` | `dropped_filter` (`match_below_threshold`) | 13 poor | COBOL, JCL, DB2, CICS and IMS are absent from master v24 | Same as #2 |
| 5 | Barclays · Software Engineer - Mainframe | `b0e93ede-6b0d-4abe-bdf1-e28c18ee4b56` | `dropped_filter` (`match_below_threshold`) | 19 poor | Same as #4 | Same as #2 |
| 6 | DocCheck AG · Software Engineer – AI-Assisted Development (m/w/d) | `b7ccb314-08c3-4530-957b-d29b4e28c7b8` | `failed` (from `scored`) | 49 moderate | Tailor invented two bullet ids (§2.2). The job also asks for German and DACH residency | Ask Teja first (German, DACH). Then same as #1 |

Lookup used (13 rows matched; the six above are the only exact title matches, so the ids are not ambiguous):
`applications a join jobs j on j.id = a.job_id where j.company_name ilike any('%LSEG%','FIS%','%Barclays%','%DocCheck%') and j.title ilike <each title>`.

### 2.1 LSEG Cyber Security (`2b7db9a2`): tailor rejected a summary ref

Tailor note, 2026-11-07 19:15:51 UTC (00:45 IST 11-08):

```json
{"reason": "tailor_validation_failed", "violations": [{"ref": "summary-ai-llm", "kind": "unresolved_ref", "where": "summary refs"}]}
```

`summary-ai-llm` **does exist** in master v24. It is the paragraph inside
`summary_variants[id=variant-ai-llm]`. Since 2026-11-07, the validator accepts a variant's
paragraph as a citation only when the tailoring also **picked** that variant:
`supabase/functions/_shared/tailor/validator.ts:799`, `citesMasterSummary = … || (variant !== undefined && variant.summary.id === ref)`.
Here the model cited the paragraph without setting `summary_variant`.

This is a seam in the prompt/validator contract, not a lie. The prompt lists every variant's
`ref=` as citable. A rerun may repeat the same mistake. T3 (`docs/status/2026-11-08-live-events-watch.md`)
counts how often this happens. The fix is a code decision for the orchestrator: either the
prompt says "cite a variant's ref only if you pick it", or the validator auto-picks the variant
whose summary was cited.

Matcher reasoning (score 58), quoted: *"…the posting heavily requires TypeScript, enterprise
vulnerability management, patch deployment pipelines… the role specifies a Senior Associate level position…"*

### 2.2 DocCheck (`b7ccb314`): tailor invented bullet ids

Tailor note, 2026-11-07 19:13:25 UTC (00:43 IST 11-08):

```json
{"violations": [{"ref": "bullet_one_on_one_backend", "kind": "unresolved_ref", "where": "bullet under proj_one_on_one"}, {"ref": "bullet_one_on_one_docs", "kind": "unresolved_ref", "where": "bullet under proj_one_on_one"}]}
```

Neither id appears anywhere in master v24 (`profile::text like '%bullet_one_on_one_backend%'` is false).
The validator worked as intended. A rerun is a fresh roll of the dice.

The matcher also flagged blockers that matter more than the tailor failure. Quoted: *"the
posting strictly requires clear communication in German ('kommunizierst klar auf Deutsch')…
residency or remote work eligibility within Switzerland/DACH region"*. The job is from
`arbeitnow.ch`, Basel, remote. **Ask Teja whether he can meet the German and DACH requirements
before rerunning this row.**

### 2.3 The four `poor` rows: master v24 lacks the stack

The matcher's reasoning for all four names missing **skills**, not missing experience. A
substring check of master v24 confirms it:

| Term | In master v24? |
|---|---|
| Spring, Hibernate, Angular | no |
| COBOL, JCL, mainframe | no |
| Terraform, OpenTelemetry, ClickHouse, Cribl | no |
| Kafka, Kubernetes | no |
| Java | yes, **but this is probably the substring of "JavaScript"**. The matcher says "zero background in… Java" |
| TypeScript | yes |

Quoted reasoning:
- FIS 22: *"zero background in the primary required technologies: Java, Spring Boot, Hibernate, Angular, Apache Camel, Kafka, Kubernetes, or Oracle DB."*
- LSEG Observability 27: *"zero hands-on experience with Cribl, ClickHouse, or OpenTelemetry… lack the required infrastructure-as-code (Terraform) experience."*
- Barclays 13: *"There is zero overlap with mainframe technologies."*
- Barclays 19: *"zero experience in mainframe technologies (COBOL, JCL, IMS, CICS, DB2, z/OS, etc.)"*

**This conflicts with Teja's "fits on JD skills".** If he has these skills (for example Java and
Spring from `1on1_sb`, which is Java 23 + Spring Boot 3.4), they are not in master v24.
The tailor cannot claim a skill the master lacks, because the validator rejects fabrication. So a
forced pass gives a resume that still shows the gap. **Recommended order:** add the real skills to
the master first, then rerun. The score then rises on its own, and the floor does not need a bypass.

## 3. Systemic question: does the rubric under-weight skills?

**It cannot be measured from stored data, and these four rows do not suggest it.**
- The weights are `technical 30 · experience 25 · behavioral 15 · career 30` (`supabase/functions/_shared/match/rubric.ts:38-49`). Skills already tie for the largest weight.
- Only the total, the band and the reasoning are persisted. The matcher note `detail` has the keys `band, score, reasoning`. There are **no per-dimension scores**, so "skill-fit rows score < 30" cannot be tested.
- In the four `poor` rows, the reasoning blames absent skills (§2.3), not domain words. These rows were scored correctly against the master as it is.
- Band distribution of the last 3 days of matcher notes: poor 65 (avg 21) · weak 25 (avg 36) · moderate 63 (avg 51) · good 27 (avg 68) · strong 25 (avg 82). n = 205.

To measure this properly, the matcher would have to write the four dimension scores into the note
`detail`. That is a small code change. It is the orchestrator's call, and it is not proposed as a rubric change.

## 4. Prepared statements: the six rows (do not run until Teja agrees)

RPC signature (live): `advance_application_status(p_application_id uuid, p_to_status application_status, p_agent agent_name, p_detail jsonb, p_expected_updated_at timestamptz)`.
Run it as the human, through the same route that made the 2026-11-07 18:21 UTC `approved → passed_filters` human moves.

### 4a. Failed rows #1 and #6: `failed → passed_filters` (human)

Edge `failed → passed_filters` allows `{human}`. `guard_failed_rerun` permits it because
`previous_status = 'scored'` for both rows, which is before approval.

```sql
select public.advance_application_status('2b7db9a2-dab1-4e98-8f8e-718716afce0c'::uuid, 'passed_filters', 'human',
  '{"reason":"human_pick_rerun","note":"Teja 2026-11-08: tailor unresolved_ref summary-ai-llm before dc8ac5c"}'::jsonb, null);
-- #6: only after Teja confirms German + DACH eligibility
select public.advance_application_status('b7ccb314-08c3-4530-957b-d29b4e28c7b8'::uuid, 'passed_filters', 'human',
  '{"reason":"human_pick_rerun","note":"Teja 2026-11-08: tailor unresolved_ref bullet ids"}'::jsonb, null);
```

Both scored ≥ 30 before (58 and 49), so the matcher advances them without a bypass.

### 4b. Poor rows #2–#5: human pick

The human-pick bypass is `isHumanPicked(jobs.discovered_via)`, which checks for an array that
contains `'manual'` (`_shared/match/score-threshold.ts`). The matcher (`matcher/index.ts:613`, `:726`)
and the auditor pre-gate (`auditor/pregate.ts:46`) both read it. **A status move alone is not
enough:** all four jobs have `discovered_via = {company_career_page}`, so run-one would re-score and
drop them again.

**Option A (recommended): Teja pastes each link into Add a job.** `job-link-intake` adds the
`manual` tag, asks him to confirm the revive of a dropped row (`revive_dropped`), records
`overrode_drop_reason`, and starts matcher → tailor → auditor itself. This leaves the most honest
audit trail and needs no hand-written SQL.

| # | Link to paste |
|---|---|
| 2 | https://lseg.wd3.myworkdayjobs.com/Careers/job/IND-BLR-Divyasree-Technopolis/Observability-Platform-Engineer_R0121185-1 |
| 3 | https://fis.wd5.myworkdayjobs.com/SearchJobs/job/IND-PUNE-FL7/Java-Developer-with-Angular---Spring-Hibernate_JR0309419 |
| 4 | https://barclays.wd3.myworkdayjobs.com/External_Career_Site_Barclays/job/Pune-Gera-Commerzone-SEZ/Mainframe-Software-Developer_JR-0000108583 |
| 5 | https://barclays.wd3.myworkdayjobs.com/External_Career_Site_Barclays/job/Pune-Gera-Commerzone-SEZ/Software-Engineer---Mainframe_JR-0000125396 |

**Option B: the orchestrator does the same thing by hand.** The order matters: tag first, so the
matcher reads the tag.

```sql
-- 1) tag as human-picked (jobs has only the "own jobs" RLS policy, no status guard)
update public.jobs set discovered_via = array_append(discovered_via, 'manual')
where id in ('64e70ece-f257-4c5c-b607-60fb7e1a4ffc',  -- #2 LSEG Observability
             'de176926-20f9-4058-b419-ed5d0de5ad28',  -- #3 FIS Java
             '0933b2f5-a19e-4d9e-aec6-82a272936a60',  -- #4 Barclays Mainframe SW Dev
             'e8ebe165-90ce-4b9c-b52d-b09698bbec28')  -- #5 Barclays SE Mainframe
  and not ('manual' = any(discovered_via));            -- expect 4 rows
-- 2) human revive, edge dropped_filter -> passed_filters {human}
select public.advance_application_status(id, 'passed_filters', 'human',
  jsonb_build_object('reason','human_pick','overrode_drop_reason','match_below_threshold','note','Teja 2026-11-08 00:48 IST'), null)
from (values ('3a4df0f9-3a5f-4bb5-b795-63cb68705b0d'::uuid),('d45c3ba6-6e53-43c9-8146-5a2402708c3f'::uuid),
             ('3c787bb6-e21f-4570-9432-5ce8af2d0602'::uuid),('b0e93ede-6b0d-4abe-bdf1-e28c18ee4b56'::uuid)) v(id);
```

Naming caveat: `'manual'` was defined as "pasted by Teja" (`auditor/pregate.ts`). Option B writes
it for a dashboard pick. That is the same intent, but it does not match the label exactly.

### 4c. Run each row (after 4a or 4b, and not needed for Option A)

```bash
gh workflow run run-one.yml --ref main -f application_id=2b7db9a2-dab1-4e98-8f8e-718716afce0c
gh workflow run run-one.yml --ref main -f application_id=b7ccb314-08c3-4530-957b-d29b4e28c7b8   # only if #6 cleared
gh workflow run run-one.yml --ref main -f application_id=3a4df0f9-3a5f-4bb5-b795-63cb68705b0d
gh workflow run run-one.yml --ref main -f application_id=d45c3ba6-6e53-43c9-8146-5a2402708c3f
gh workflow run run-one.yml --ref main -f application_id=3c787bb6-e21f-4570-9432-5ce8af2d0602
gh workflow run run-one.yml --ref main -f application_id=b0e93ede-6b0d-4abe-bdf1-e28c18ee4b56
```

Verify each row with `select id, status, match_score, failure_reason from applications where id = '<uuid>'`.
The expected result is `awaiting_approval`, or `audit_flagged`. If it is `failed`, read the newest
tailor note.

## 5. P0 #3: Tether and L&T page-overflow reruns (T2)

| Company · title | id | Score | Failed at | Violation | previous_status |
|---|---|---|---|---|---|
| Tether Operations Limited · Research Engineer Intern (Multimodal LLM) | `04d5c6e4-e9fc-4d06-9e24-a8dc621cd00a` | 52 | 2026-11-07 18:25:47 UTC (23:55 IST) | `page_overflow`, blocked by floors (skills, summary, education never removed; `exp_aczen` ≥ 4 bullets; three projects ≥ 3 each; certifications ≥ 2; …) | `scored` |
| L&T Precision Engineering & Systems IC · GenAI Trainee | `7890ff1b-ebde-4212-82c0-43cf078c0b3e` | 82 | 2026-11-07 18:24:55 UTC (23:54 IST) | `page_overflow`, same floor list minus `proj_one_on_one` and two achievements | `scored` |

History (status_change events): both were `approved` on 11-04, then sent `approved → passed_filters`
by a human at 2026-11-07 18:21:09 UTC for the master re-run, then re-scored, then the tailor failed.
They never entered `applying`, so a rerun carries no double-submit risk. `guard_failed_rerun`
reads only `OLD.previous_status`, which is `scored`, so it **allows** the move.

Both failed about 50 minutes before the dense-rung tailor went live. This is the case `dc8ac5c` was built for.

```sql
select public.advance_application_status('04d5c6e4-e9fc-4d06-9e24-a8dc621cd00a'::uuid, 'passed_filters', 'human',
  '{"reason":"rerun_after_dense_rungs","note":"page_overflow before dc8ac5c (~00:47 IST 11-08)"}'::jsonb, null);
select public.advance_application_status('7890ff1b-ebde-4212-82c0-43cf078c0b3e'::uuid, 'passed_filters', 'human',
  '{"reason":"rerun_after_dense_rungs","note":"page_overflow before dc8ac5c (~00:47 IST 11-08)"}'::jsonb, null);
```

```bash
gh workflow run run-one.yml --ref main -f application_id=04d5c6e4-e9fc-4d06-9e24-a8dc621cd00a
gh workflow run run-one.yml --ref main -f application_id=7890ff1b-ebde-4212-82c0-43cf078c0b3e
```

The matcher re-scores both. Tether (52, `discovered_via {other}`) and L&T (82, `{manual}`) both
clear the floor. Both rows return to `awaiting_approval`, so **Teja must approve them again**. Per
the bulk-move rule, tell him to stay off the Approval page until the two runs finish.

If either fails again with `page_overflow`, the dense rungs are not enough for that content. Read
the new `blockedBy` list before trying anything else.
