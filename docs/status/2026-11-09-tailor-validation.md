# The 9 tailor refusals in the 2026-11-09 drain: one cause, `summary_without_refs` (diagnosis)

**Status: read-only diagnosis. No code changed. The fix is specified below for routing.**
Drain window 11:49–12:33 UTC, live tailor `a3ef168` on master v27.

## Verdict

**All 9 failed for one reason: the model wrote a summary paragraph and cited no master node** (`summary.refs = []`).
`enforceContentRules` only repairs a summary that is `null`, so an uncited one reaches the validator, which refuses it
(`_shared/tailor/validator.ts:786-788`).

**Not the headline cleaner.** All 9 cleaned titles pass `ROLE_TITLE_SHAPE`, and no violation names `headline_title`.
`a3ef168` did not touch the summary path: its diff is `cleanRoleTitle`, its tests, and the
`ats_keyword_coverage` drop.

## Per row (the note written by the same call as the `→failed` event, same `created_at`)

| Row | Score | Job title | Cleaned headline | Violations (whole list) |
| --- | --- | --- | --- | --- |
| `060162ca` | 92 | Software Engineer, Intern | Software Engineer Intern (shape OK) | `summary_without_refs` |
| `dabb8ae2` | 72 | Full Stack Software Engineer - Postgres | Full Stack Software Engineer (OK) | `summary_without_refs` |
| `800e8d08` | 76 | Python Engineer | Python Engineer (OK) | `summary_without_refs` |
| `f4e2f35f` | 72 | Software Engineer - App Stores | Software Engineer (OK) | `summary_without_refs` |
| `38bb2f12` | 68 | Software Engineer - Python - Container Images | Software Engineer (OK) | `summary_without_refs` |
| `05b45e3f` | 58 | Customer Journey - Software Engineer - AVP | Software Engineer (OK) | `summary_without_refs` |
| `dc7cfdec` | 76 | Cloud Developer | Cloud Developer (OK) | `summary_without_refs` |
| `db9b46ef` | 72 | Fullstack Developer | Fullstack Developer (OK) | `summary_without_refs` |
| `22571d3c` | 59 | Frontend Engineer | Frontend Engineer (OK) | `summary_without_refs` |

Each note is exactly `{"reason":"tailor_validation_failed","violations":[{"kind":"summary_without_refs"}]}`, with no
other violation.

| Cause | Count |
| --- | --- |
| `summary_without_refs` | 9 |

## It is new today, and model-side

Tailor notes by day:

| Day | Tailored | Refused | `summary_without_refs` |
| --- | --- | --- | --- |
| 11-04 | 9 | 3 | 0 |
| 11-05 | 3 | 1 | 0 |
| 11-06 | 5 | 0 | 0 |
| 11-07 | 43 | 5 | 0 |
| 11-08 | 24 | 1 | 0 |
| **11-09** | **63** | **9** | **9** |

No code on the summary path changed between 11-08 (0 of 25) and 11-09 (9 of 72). The model has started returning a
summary of its own with no citation, about 12% of the time. Earlier it returned `null`, which the repair fills with
the owner's variant paragraph. The validator is right to refuse it: uncited prose is exactly the fabrication risk the
`refs` rule exists for (`validator.ts:780-785`).

## Reproduced offline through the real tailorer

`createTailorer` with a fixed model reply, plus the `content-rules.test.ts` fixtures:
- The reply's summary is `{text: "Engineer who ships full-stack products.", refs: []}` → `{"kind":"refused","violations":[{"kind":"summary_without_refs"}],"retry":null}`.
  This is identical to the live notes. `retry: null`, so the tailor gives up rather than asking again.
- The same reply with `summary: null` → `tailored`, summary repaired to the owner's variant paragraph
  (`refs: ["summary-ai"]`).

## The fix (for peer 3, or whoever owns `_shared/tailor/content-rules.ts`)

**File `supabase/functions/_shared/tailor/content-rules.ts`, the summary block (`:213-239`, `if (summary === null) {` at `:219`).**
Treat an uncited summary like a missing one: drop the model's paragraph and print the owner's own, cited.

```ts
// An uncited paragraph is untraceable prose (validator: summary_without_refs); it is replaced like a missing one.
if (summary === null || summary.refs.length === 0) {
  // Start from none, so an uncited paragraph is never kept when no owner text exists.
  summary = null;
  // ... the existing body unchanged: picked variant → most JD-matched variant → master.summary ...
}
```

- Setting `summary = null` first matters. If the master had no variant and no summary, the uncited paragraph would
  otherwise survive, and the existing `changes.push(... ref: summary.refs[0]!)` would record an `undefined` ref.
  With it, the result is "no summary", and `checkContentRules` judges that exactly as it does today.
- `ContentRuleChange` needs no new member: the push records `added` for `summary`, which is what happened.
- The model's own variant pick (`summary_variant`) is still honoured first, so its headline framing is kept.
- Rebuild safety: the repair runs before storing, and the stored `tailor_refs` hold the repaired summary. So
  `rebuildOriginal` re-validates to the stored resume, as it does for every other repair.
- Test (red before the fix): the REPRO reply above must come out `tailored`, with
  `outcome.refs.summary.refs` = `["summary-ai"]` (the picked or most JD-matched variant).
- Optional defence in depth (`_shared/tailor/prompt.ts:508`): `minItems: 1` on `summary.refs` in the response
  schema, so the model is asked for a citation in the first place. The repair is still needed, because a schema is
  a request, not a guarantee.

Deploy target after the fix: `tailor`.

## Recovery of the 9 (after the fix is deployed; prepared, NOT run)

All 9 failed from `scored`, so the human edge `failed → passed_filters` is allowed (`guard_failed_rerun`). They then
re-score and re-tailor, costing about 2 Gemini calls each. The CAS values were read at 18:30 IST.

```sql
-- Re-run the 9 summary_without_refs refusals of the 2026-11-09 drain after the content-rules summary fix ships.
select advance_application_status('060162ca-fb0c-4ccb-a170-3de7e2d3aab4'::uuid, 'passed_filters', 'human', '{"reason":"failed_rerun","source":"summary_without_refs_fix_2026_11_09"}'::jsonb, '2026-11-09T11:49:43.81337+00:00'::timestamptz);
select advance_application_status('dabb8ae2-ba92-4eae-9358-312216180f56'::uuid, 'passed_filters', 'human', '{"reason":"failed_rerun","source":"summary_without_refs_fix_2026_11_09"}'::jsonb, '2026-11-09T12:01:00.580922+00:00'::timestamptz);
select advance_application_status('800e8d08-34f8-4e79-8dd4-b023351c49ae'::uuid, 'passed_filters', 'human', '{"reason":"failed_rerun","source":"summary_without_refs_fix_2026_11_09"}'::jsonb, '2026-11-09T12:02:48.396776+00:00'::timestamptz);
select advance_application_status('f4e2f35f-22b9-4825-b1bb-b8632ec1dc3c'::uuid, 'passed_filters', 'human', '{"reason":"failed_rerun","source":"summary_without_refs_fix_2026_11_09"}'::jsonb, '2026-11-09T12:04:44.430334+00:00'::timestamptz);
select advance_application_status('38bb2f12-c3d5-43ca-bcb7-b74e563f08cf'::uuid, 'passed_filters', 'human', '{"reason":"failed_rerun","source":"summary_without_refs_fix_2026_11_09"}'::jsonb, '2026-11-09T12:05:47.560847+00:00'::timestamptz);
select advance_application_status('05b45e3f-903c-47ce-96e1-2731c57b61ee'::uuid, 'passed_filters', 'human', '{"reason":"failed_rerun","source":"summary_without_refs_fix_2026_11_09"}'::jsonb, '2026-11-09T12:10:07.258385+00:00'::timestamptz);
select advance_application_status('dc7cfdec-50b3-4471-9da5-c75390f81858'::uuid, 'passed_filters', 'human', '{"reason":"failed_rerun","source":"summary_without_refs_fix_2026_11_09"}'::jsonb, '2026-11-09T12:16:10.748702+00:00'::timestamptz);
select advance_application_status('db9b46ef-22cb-4742-955c-ea5a8b7ee451'::uuid, 'passed_filters', 'human', '{"reason":"failed_rerun","source":"summary_without_refs_fix_2026_11_09"}'::jsonb, '2026-11-09T12:16:15.901354+00:00'::timestamptz);
select advance_application_status('22571d3c-01c9-4249-b014-4958ae5f42ae'::uuid, 'passed_filters', 'human', '{"reason":"failed_rerun","source":"summary_without_refs_fix_2026_11_09"}'::jsonb, '2026-11-09T12:33:35.502952+00:00'::timestamptz);
```

Then dispatch the post-screen drain: nothing scores `passed_filters` on a cron.
