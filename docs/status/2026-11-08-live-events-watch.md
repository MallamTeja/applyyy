# Live events watch: one-page trim, summary variants, new auditor findings

- **Date:** 2026-11-08 (IST)
- **Scope:** read-only. SELECTs via `env -u SUPABASE_ACCESS_TOKEN supabase db query --linked -f <file>`, `supabase functions list`, and a local re-run of the current `detectAuditFindings` over fetched rows. No live writes.
- **Window:** `application_events.created_at > '2026-11-07 18:00+00'` (23:30 IST 11-07 onward). Last tailor/auditor event in the window: 19:16:53 UTC. Nothing has run since.
- **Deploy times (functions list, `updated_at`):** tailor 2026-11-07 19:16:38 UTC (00:46 IST, so `dc8ac5c` per the 00:45 handoff); auditor 18:28:48 UTC (23:58 IST, `11e858f`).

## Where each key lives (proven from code before querying)

| Key | Written by | Location |
|---|---|---|
| `page_fit_trimmed` | `_shared/tailor/persist.ts:168` (tailor success); `apps/web/src/features/approval/saveTailoredEdit.ts:299` (editor save) | `application_events.detail`, on the tailor `note` (reason `tailored_profile_written`) or a human `note`; array of `{step, ref, text}` |
| `summary_variant` | tailor response, validated at `_shared/tailor/validator.ts:761-765, 799, 835` | `applications.tailor_refs->>'summary_variant'` (not in events) |
| summary-ref `unresolved_ref` | `validator.ts:782, 808` | tailor failure `note` `detail.violations[]` as `{kind:'unresolved_ref', ref, where:'summary refs'}` |
| `unfaithful_rewording`, `summary_unsupported` | `_shared/audit/detector.ts:373-548, 620-734` | `applications.audit_findings[]` (overwritten per audit). Auditor events carry only `findings_count` |

Note: the guarded status move writes the detail onto a separate `note` event. The `status_change` rows carry only the column snapshot (`block_reason`, `claimed_by`, ...). A count over `status_change` alone finds nothing.

## 1. `page_fit_trimmed`

| Metric | Count | Query |
|---|---|---|
| Events with the key, window | 0 | `select event_type, agent, to_status, count(*) filter (where detail ? 'page_fit_trimmed') ... from application_events where created_at > '2026-11-07 18:00+00' group by 1,2,3` |
| Events with the key, all time | 0 | `select count(*) from application_events where detail ? 'page_fit_trimmed' or detail::text ilike '%page_fit_trimmed%'` |
| Tailor runs in window | 12 (8 written, 4 failed) | tailor `note` list by `created_at` |
| `page_overflow` refusals | 2 (04d5c6e4 Tether, 7890ff1b L&T) | `detail->'violations'` on tailor failure notes |
| Editor saves (human `note` with `kind/before/after`) in window | 0 | key census: human notes carry only `reason`, `screen`, `decided_by`, `from`, `source` |

**Floor check:** nothing to check. No trim was recorded anywhere, so no trim could have cut a floor item. Both `page_overflow` refusals stop at the floors, as designed. Their `blockedBy` lists every floor, e.g. 04d5c6e4: `"exp_aczen: keeps >= 4 bullets", "proj_one_on_one: keeps >= 3 bullets", ..., "certifications: keeps >= 2"`.

**Why zero:**
- The 3 re-tailors at 18:22-18:24 UTC (8e9d58ce, 58868e0a, 1849aaa1) fit through the typography ladder alone.
- 5 of the 6 later runs (19:13-19:16:24 UTC) ran before the 19:16:38 tailor deploy, and all fit without a trim.
- Only d0bf75bb (19:16:49) ran on `dc8ac5c`, and it fit without a trim too.
- The web editor path has never fired: no save event at all since `7a78d05` went live.

## 2. `summary_variant`

| Metric | Count | Query |
|---|---|---|
| Rows tailored in window, by picked variant | `variant-backend-fullstack` 4 (58868e0a, 8e9d58ce, 8f20a220, d0bf75bb); `variant-ai-llm` 2 (1849aaa1, a323b808); `variant-ml-data` 1 (e5107026); none 1 (8794f52f FIS) | `select a.tailor_refs->>'summary_variant' ... from applications a join (distinct tailor notes reason='tailored_profile_written' in window) ...` |
| All rows with `tailor_refs`, by variant | none 140, backend-fullstack 12, ai-llm 4, ml-data 1 | `select coalesce(tailor_refs->>'summary_variant','<none>'), count(*) from applications where tailor_refs is not null group by 1` |
| Master v24 variants | `variant-ai-llm=summary-ai-llm`, `variant-backend-fullstack=summary-backend-fullstack`, `variant-ml-data=summary-ml-data`; default `summary_main` | `jsonb_array_elements(profile->'summary_variants')` on `master_profiles` |
| `unresolved_ref` on summary refs / `summary_variant`, all time, incl. first-attempt and retry violations | 2 events. 1 is the variant case (2b7db9a2). 1 is an older unrelated case (e625b50f, 2026-11-02, `skill_node_js`) | lateral over `detail->'violations'`, `detail->'first_attempt_violations'`, `detail->'retry'->'first_attempt_violations'` where `kind='unresolved_ref' and (where in ('summary refs','summary_variant') or ref like 'summary%' or ref like 'variant%')` |
| Picked id not in master (`where:'summary_variant'`) | 0 | same query |

**Findings:**
- **2b7db9a2 is the only case of citing an unpicked variant's summary.** Event at 19:15:51 UTC: `{"kind":"unresolved_ref","ref":"summary-ai-llm","where":"summary refs"}`. The row got no retry (`retry` null): `retryableBullets` covers bullets only, so one bad summary ref fails the whole row.
- **Both rows that cite a summary ref cite their own picked variant correctly:** 8e9d58ce and 8f20a220, `["summary-backend-fullstack"]` with `variant-backend-fullstack`.
- **On master v24, most live rows print no summary paragraph.** 15 of 20 live v24 rows have `tailor_refs.summary` null, 12 of them with a variant picked. Before v24 the summary was nearly always present (2 null of 10).
  - Why: `validator.ts:842` sets `summary: tailored.summary === null ? null : tailored.summary.text`. A picked variant swaps only the headline (`:835`). So a variant pick with a null summary prints the variant headline and no summary at all.
  - Query: `select master_version, summary is null, variant is not null, count(*) from applications where tailor_refs is not null and status in (live statuses) group by 1,2,3`.

## 3. Auditor `unfaithful_rewording` / `summary_unsupported`

| Metric | Count | Query |
|---|---|---|
| Auditor notes in window | 16 (8 rows x 2), every `findings_count` = 0, all `audit_clean` | `select ... detail->>'findings_count', detail->>'audit_verdict' from application_events where agent='auditor' and event_type='note' and created_at > '2026-11-07 18:00+00'` |
| Rows audited by the new auditor (after 18:28:48 UTC) | 5 (8f20a220, a323b808, e5107026, 8794f52f, d0bf75bb) | same, by `created_at` |
| `unfaithful_rewording` in any row's `audit_findings` | 0 | `select f->>'kind', count(*) from applications, jsonb_array_elements(audit_findings) f group by 1` |
| `summary_unsupported` in any row's `audit_findings` | 0 | same |
| Other kinds present | `jd_keyword_dropped` x2 (2 rows, awaiting_approval) | same |
| Current detector re-run locally over the 8 window rows (pinned master + `jobs.description_raw`) | 0 findings on all 8, matching what is stored | `node rerun.mjs` importing `_shared/audit/detector.ts` |
| Positive control (8e9d58ce, inject an untied master skill into a project bullet and "Kubernetes, Terraform and Rust" into the summary) | fires both: `unfaithful_rewording` "Bullet names skill(s) your master never ties to One-on-One ...: LLM, LLM Applications" and `summary_unsupported` "...never mentions: Kubernetes, Rust, Terraform" | in-memory mutation only |

**False-positive spot-check:** not possible. There are zero findings of either kind live. The false-negative side was checked instead: the deployed verdicts equal the current code's re-run (checked 8), and the control shows the checks are not vacuous.

## Findings

1. **Nothing wrong found in trims (checked 12 tailor runs, 0 trims).** Both `page_overflow` refusals stop at the floors. The trim and the editor path have not fired live yet.
2. **Summary variant: 1 bad ref in total (2b7db9a2), 0 invented variant ids.** The distribution leans backend-fullstack, 12 of 17 picks all time.
3. **15 of 20 live v24 resumes print no summary paragraph.** This is the side effect of a variant pick with a null summary (`validator.ts:835, 842`). It may be intended for one-page fit. It may also be the prompt leading the model to treat the variant as "summary handled".
4. **The floors are trim floors, not content minimums.**
   - The tailor itself writes rows below them: 8e9d58ce `exp_aczen=1`, 1849aaa1 `exp_aczen=3`, 8794f52f `exp_aczen=1` with 0 certs, e5107026 `exp_student_tribe=0`.
   - Projects with 1-2 bullets are common.
   - This follows the code (`page-trim.ts` floors limit only removal), but may not match Teja's "Aczen keeps >= 4 bullets".
5. **Auditor: 0 `unfaithful_rewording`, 0 `summary_unsupported` across all rows.** The re-run agrees, and the positive control fires.

## Open questions

- Is a resume with a variant headline and no summary paragraph intended? If not, should the validator print the picked variant's own summary when `tailored.summary` is null, or should the prompt require a summary?
- Should `PAGE_FIT_FLOORS` also constrain what the tailor selects (content minimums), or stay trim-only? Rows such as 8e9d58ce show Aczen at 1 bullet.
- Should a single bad summary ref (2b7db9a2) be retryable, the way bullets are, instead of failing the row?
- `page_overflow` failure events do not record the cuts made before the refusal. Is that acceptable for diagnosis?
- Re-watch after the next tailor run on `dc8ac5c` (Tether 04d5c6e4 and L&T 7890ff1b re-runs are pending per the 00:45 handoff). Those are the first rows likely to produce a real `page_fit_trimmed`.
