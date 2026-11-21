# Resume tailoring: findings and improvement plan (2026-11-18)

Goal: the tailor's first draft is one Teja approves **without chat edits**, while staying
truthful and defensible in an interview. KPI: chat edits per tailored resume (today ~5 user
turns and ~19 `add_skill` ops per resume) trending to 0.

Data basis (pulled live 2026-11-18, read-only): `resume_chat_messages` (361 user turns over 64
applications, 2026-11-01..11-16), 108 `applications` rows with a `tailored_profile`, 47
`master_profiles` rows. Re-derive, never quote: the analysis scripts are throwaway; rerun the
queries in §7.

## 1. What Teja changes (chat edit patterns)

| Finding | Evidence |
|---|---|
| Edits are skill top-ups | 1,221 of 1,403 ops (87%) are `add_skill`; `add_bullet` 27, `remove_skill` 68, `rejected` 47 |
| Adds are not JD-driven | 8% of checkable adds name a skill the JD mentions |
| Same skills every time | Cursor 41/64 apps, Postman 40, VS Code 38, Git 37, GitHub 37, System Design 34, OOP 33, DSA 33, OS 32, Swagger 32, Claude Code 31, Jira 30, Computer Networks 30, Caching 25 |
| Hidden target size | chat-edited resumes end at 34.8 skills / 6.7 groups; untouched 20.3 / 4.4 |
| Groups asked for (apps) | Tools 51, CS Fundamentals 35, AI 34, Backend Eng 33, DevOps & Cloud 18, Frameworks 15, Databases 14 |
| Removals undo the assistant | Agile (9/10 apps added earlier in same chat), LLM Applications, VS Code, Vector Search, Slack |
| Not improving | adds per app ~2 (11-01) to 20-25 (11-10..11-16); masters v45-47 still needed 23-40 adds |
| Funnel waste | of 64 edited apps: 20 applied, 27 failed, 11 dropped_filter |

## 2. Root causes (code first, prompt second)

_Snapshot of 2026-11-18. Since then `SKILLS_PER_GROUP_CAP` is 10 (Teja 2026-11-21), `shapeSkillGroups` takes a
`SkillProfile` (`skill-profile.ts`), and several §5 items shipped (provenance gates `e1f4b520`, `add_group`, tailor
temperature, `empty_summary`). Read the code before quoting a line number below._

1. Code, not the LLM, picks skills: `shapeSkillGroups`, `supabase/functions/_shared/tailor/tailorer.ts:224-327`.
2. Every group must fit ONE printed line (`tailorer.ts:291`, `packages/resume-template/src/page-fit.ts`) = ~3-5 skills, despite `SKILLS_PER_GROUP_CAP = 7` (`tailorer.ts:204`).
3. 6 group seats, AI forced into one; group relevance = exact master-name match in the JD (`tailorer.ts:240`); spare seats go in master order.
4. Only the AI group has a floor (`content-rules.ts:399-405`).
5. Prompt has no skills guidance and the output schema has no group field (`prompt.ts:252-254, 525-530`); extracted JD keywords are computed after the call, never shown to the model (`tailorer.ts:602`); no temperature set.
6. `jd-keywords.ts` is a fixed ~60-term list; misses Next.js, Postman, Git, Jest, JS/TS aliases.
7. Chat: one op per skill, `MAX_OPS = 12` (`resume-assist/assist.ts:63`), no add-group op.

## 3. Mistakes found

Tailored resumes:
- FamPay (failed, master v39): Aczen role retitled "Data Analyst Intern"; not in master; auditor silent. The chat refused it, so another write path set it.
- Gushwork and Revature were **applied with no summary**.
- Chat replies claim "I added X, Y" while every op was rejected (5 replies); 43 replies made no change.
- 85% of summaries copy a master variant verbatim (one on 60 resumes); none names the company.
- 85/108 headlines copy the JD title, incl. team names and roles never held.
- Bullet cuts dropped real metrics (Stripe lost "260+", "878 rows", "59%").
- Duplicates/twins: DBMS + OS + OOPS next to long forms; Express + Express.js; Postgres + PostgreSQL in 100/108.
- Group cap off by one on untouched rows (groups of 7 vs the 4-6 rule); chat ignores the cap (2-18).
- Agile still on 20/108, LLM Applications on 57/108.

Master resume (latest row 47, labelled "v46"):
- One-on-One project: bullets describe `1on1_sb` (Java/Spring/EC2), link points to `1on1` (Node).
- 50 of 110 skills have no supporting bullet: TypeScript (ships on 93 resumes), LangChain 53, pgvector 38; depth claims Kubernetes, Kafka, Spark, gRPC, C#, .NET.
- Main summary unchanged since v8, 56-word keyword list, no metric; backend variant mentions Redis/Socket.IO/containers that bullets no longer show.
- AuthScore bullets 39-49 words; picked by only 3 of 34 recent tailorings.
- 29 of 47 versions unlabelled; row/label numbering drifted.
- Chat bullet source looks stale: 19/27 `add_bullet` ops proposed pre-v27 text.

## 4. Rulings (Teja, 2026-11-18)

| Question | Ruling |
|---|---|
| Skills strategy | **Core + JD fill**: each group ships a fixed core, then fills to a per-group size with JD-ranked master skills; a never-list is blocked |
| One-page room | **Compact skills block**: smaller/tighter skills section, a group may wrap to 2 lines; page-trim drops the weakest project bullet first |
| Summary + headline | **Per-JD summary, JD title kept as headline** |
| One-on-One project | **Stack follows the JD**: Java/Spring roles show the `1on1_sb` (Java/Spring) bullets + link; MERN/Node/other roles show the `1on1` (Node/TS, PostgreSQL, no MongoDB) bullets + link |

Second round (Teja, 2026-11-18 21:47):

| Area | Ruling | Guard (so the ruling cannot ship a fabrication) |
|---|---|---|
| Bullets | **AI writes the bullets** for the JD (today it may only reuse the bullet's own master words, `prompt.ts:389-395`) | Every number, tool, system and outcome must trace to a master bullet the AI cites by ref; validator rejects any token class (number, tech name) absent from the cited master bullets |
| Aczen role title | **AI picks the Aczen internship title** per JD | Chosen from an allow-list of titles the actual work supports (e.g. Full Stack AI Engineer Intern, Software Engineer Intern, Backend Engineer Intern, AI Engineer Intern); a discipline the bullets do not show (e.g. "Data Analyst Intern", the FamPay case) is refused. Background checks compare titles with HR records |
| Resume headline | **AI writes the whole-resume title** | Must be a job title (not a team name, not bare "Intern"); seniority never above the JD's |
| Skills | **Most-needed first, twice:** inside each group, JD-required skills first, then JD-preferred, then core; groups ordered by how much of the JD they cover | Ordering only; content still from master + core lists |
| Projects | Same ordering: most JD-relevant project first | Max 2 projects still holds |
| Achievements | Same ordering: most JD-relevant first | All achievements still ship (2026-11-09 ruling) |
| Layout | **Fix formatting/alignment of Certifications and Achievements** (the side-by-side row since 2026-11-08) | Render QA under way; defects + file:line go in the build brief |

Open, needs Teja:
- Evidence gate for the 50 unsupported skills was not ruled; default until ruled = ship as now.
- The `1on1` (Node) variant must not claim AWS: `1on1` has **no AWS resources** (CLI audit 2026-09-06; RDS chosen, not provisioned). Only `1on1_sb` ran on AWS EC2.
- "JD title as headline" still needs a sanity filter (reject team names like "Models Infrastructure Platform Enablement", bare "Intern"); proposed: keep the JD title only when it is a job title.

## 5. Plan (ordered by edits saved per unit of work)

| # | Change | Where | Saves / fixes |
|---|---|---|---|
| P0 | Hard gates: empty summary fails; auditor compares role/company/dates to master; bullet shortening must keep numbers | `validator.ts`, `auditor/` | 3 shipped defects |
| P0 | Chat reply states only applied ops (rewrite reply from the applied set) | `resume-assist/assist.ts` | false "I added" |
| P1 | Skill preference profile as DATA: per-group `core[]`, `min`, `max`, `order`; global `never[]`; aliases/twins map | new `system_settings` column or `_shared/tailor/skill-profile.ts` | ~1,100 of 1,221 adds |
| P1 | Compact skills block: allow 2-line groups, skills-only font step | `packages/resume-template` page-fit | room for ~35 skills |
| P1 | `shapeSkillGroups`: core first, then JD-ranked fill (semantic + alias match, not exact name), enforce min/max, never-list, twin collapse | `tailorer.ts` | thin groups, duplicates |
| P2 | Prompt: pass extracted JD requirements; requirement-to-evidence map step; group field in schema; one good worked example; temperature ~0.2; self-check list | `prompt.ts`, `tailorer.ts` | weak relevance |
| P2 | Per-JD summary: 2-3 lines, master facts only, 2+ JD keywords, 1 real metric, never verbatim variant | `prompt.ts`, `validator.ts` | 85% copied summaries |
| P2 | JD-driven One-on-One variant: two master project entries tagged by stack; selector by JD stack | master + `tailorer.ts` | stack mismatch |
| P1 | Relevance ordering: score each skill/group/project/achievement against JD (required > preferred > mentioned > core); sort within and across groups, and in projects and achievements | `tailorer.ts`, renderer keeps given order | "most needed first" |
| P2 | AI-written bullets + Aczen title + headline, with the ref-trace validator and title allow-list | `prompt.ts`, `validator.ts`, `content-rules.ts` | generic bullets, copied titles |
| P2 | Certifications / Achievements formatting and alignment fix | `packages/resume-template/src/print-styles.ts`, `render-resume-html.ts` | Teja's layout complaint |
| P3 | Chat: `add_group {name, n}` op; count ops per group not per skill | `assist.ts` | 12-op rejections |
| P3 | `jd-keywords.ts`: aliases (JS/TS, k8s), add Next.js/Postman/Git/Jest; drop vague terms | `jd-keywords.ts` | missed keywords |
| P3 | Master cleanup: twins, lowercase, wrong groups, Agile out, AuthScore 20-25 words, labels on every version | master (via UI) | hygiene |
| P4 | Tailor later in the funnel (after a human "interested" signal) | pipeline | 27 failed + 11 dropped edited resumes |

## 6. Evaluation loop (so changes are measured, not guessed)

- **Golden set:** the 64 chat-edited resumes; final edited skills = target.
- **Metrics per run:** skills recall vs target, never-list hits, duplicates, summary verbatim-copy rate, fabrication count (must be 0), one-page pass.
- **Rule:** a tailor change ships only if golden-set recall rises and fabrication stays 0.
- **Learning loop:** weekly job mines new `resume_chat_messages` ops and proposes profile updates (core/never lists) for Teja to accept.
- **Dashboard KPI:** chat ops per tailored resume, by week.

## 7. Truth model: generate freely, verify strictly

Pattern name: **constrained generation with provenance** (generator-verifier). Teja's
2026-11-18 rulings give the model more freedom (bullets, Aczen title, headline). Freedom is
safe only if code verifies the output, because a prompt rule is not a control (repo §6).

- **Bullets.** The model writes JD-tailored text and returns, per bullet, the master bullet
  ref(s) it draws from. The validator extracts every number and every technology/system name
  from the new text and requires each one to appear in the cited master bullets (alias-aware:
  `Postgres` = `PostgreSQL`). A missing source fails the tailoring. Shortening must keep the
  cited bullet's numbers (the Stripe case lost "260+", "878 rows", "59%").
- **Aczen internship title.** Picked from an allow-list of titles the actual work supports:
  Full Stack AI Engineer Intern, Software Engineer Intern, Backend Engineer Intern,
  AI Engineer Intern. Anything else is refused (allow-list approved by Teja 2026-11-18 21:55). **Why:** employment background checks compare
  titles with HR records; the FamPay resume already shipped "Data Analyst Intern" (not in
  master v39, auditor silent). Widening the list is Teja's call, made explicitly.
- **Resume headline.** Must be a job title: not a team name ("Models Infrastructure Platform
  Enablement"), not bare "Intern", never more senior than the JD's.
- **Chat assistant.** Its reply text is rebuilt from the ops actually applied, so it can never
  say "I added X" when X was rejected.
- **Auditor.** Compares role, company and dates with the master on every row.

## 8. Build split (write ownership)

Four parcels with disjoint files, so they can run as parallel peer sessions. Each brief must
carry this doc's §3-§7 facts, the comment rule, and the eval set as its done-check.

| Parcel | Owns (writes) | Scope |
|---|---|---|
| 1. Gates + provenance | `_shared/tailor/validator.ts`, `_shared/tailor/content-rules.ts`, `auditor/`, `resume-assist/assist.ts` | empty-summary fail, role/company/date audit, bullet ref-trace, title allow-list, headline check, honest chat reply, `add_group` op |
| 2. Skills engine | `_shared/tailor/tailorer.ts`, `_shared/tailor/jd-keywords.ts`, new skill-profile data, `packages/resume-template/src/page-fit.ts` | core + JD fill, never-list, twins, relevance ordering (skills, groups, projects, achievements), compact 2-line skills block |
| 3. Prompt | `_shared/tailor/prompt.ts` | JD requirements in prompt, requirement-to-evidence step, AI-written bullets/headline/Aczen title/per-JD summary, worked example, temperature, self-check |
| 4. Layout + eval | `packages/resume-template/src/print-styles.ts`, `render-resume-html.ts`, new eval fixtures from the 64 edited resumes | Certifications/Achievements alignment fix (render QA findings), golden-set scorer |

Ordering: parcel 3's new output fields (bullet refs, title) are read by parcel 1's validator;
land the validator's reader first, or both in one deploy (repo CLAUDE.md §3: the strict reader
ships before the producer emits).

## 9. Re-derive the data

```sql
-- chat edit ops by kind
select o->>'op' kind, count(*) from resume_chat_messages m, jsonb_array_elements(m.ops) o
where m.role = 'assistant' and jsonb_typeof(m.ops) = 'array' group by 1 order by 2 desc;
-- most-added skills by app count
select o->>'name' skill, count(distinct m.application_id) apps from resume_chat_messages m, jsonb_array_elements(m.ops) o
where m.role = 'assistant' and jsonb_typeof(m.ops) = 'array' and o->>'op' = 'add_skill' group by 1 order by 2 desc limit 30;
```
