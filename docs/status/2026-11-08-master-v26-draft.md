# Master profile draft (v27) — 2026-11-08

Drafted by peer 2, 16:16–16:45 IST, for Teja's review. **Not written to the database.**
The JSON is next to this file: `docs/status/2026-11-08-master-v26.json`. The file name came from
the brief; the content is **v27**, because live master is already at v26 (§1).

## 1. Version state (live, 2026-11-08 ~16:20 IST)

| version | created (IST) | label | what changed | made by |
|---|---|---|---|---|
| 24 | 2026-11-07 11:22 | "v24: +3 summary variants…" | summary variants | Teja |
| 25 | 2026-11-08 15:47:25 | null | + skill "Flask" (Frameworks) | Teja, approval-queue AI chat click (`resume_attest_skill`, `source: ai_chat_click`, app 9c26dfc6) |
| 26 | 2026-11-08 15:57:55 | null | + skill "Testing & Quality" (Tools) | Teja, the same route (app 4bd46605). **Probable misclick:** removed from that resume 2 minutes later (`resume_remove_skill` 15:59:57 IST), but it is still in master v26 |

The route is `attestSkill` (`apps/web/src/features/approval/attestSkill.ts:196`) → `storeMasterProfile`
(`apps/web/src/features/settings/masterStore.ts:318-331`). No other code path inserts into the table.

**Decision for Teja:** remove `skill_2604ca0c-12df-4e44-9633-e6d270c522af` ("Testing & Quality") in v27?
The draft **keeps** it, because removing an id is his call. No stored resume cites it now.

## 2. What the draft changes

1. **Data Science skill group** (Teja's 8):
   - `skill_pandas` and `skill_numpy` move from "Machine Learning" to "Data Science", with their ids kept.
   - New skills: `skill_matplotlib`, `skill_seaborn`, `skill_power_bi`, `skill_r`, `skill_tableau`, `skill_excel`.
   - The validator allows any category string (`profile-nodes.ts:164`), so "Data Science" is valid.
2. **applyy GitHub link:** `{"id":"link_applyy_github","label":"GitHub","url":"https://github.com/MallamTeja/applyyy"}` is added to `projects[proj_applyy].links`.
3. **Every bullet rewritten** to the formula action verb + what + how + result. **No bullet id changed.**
   - One bullet is new: `bullet_f1_data`, the 4th F1 bullet, which meets the ≥ 4 projects floor.
   - Id-set diff v26 → draft: removed 0; added 8 (`bullet_f1_data`, `link_applyy_github`, 6 skills).
4. **Corrections where the code contradicts the old text** (One-on-One):
   - "Redis" removed: it appears only in a "why not Redis" note in `1on1_sb` `GeminiKeyPool.java`.
   - "Socket.IO" → "WebSockets (STOMP)": `1on1_sb` uses STOMP.
   - "Docker" removed: neither `1on1` nor `1on1_sb` has a Dockerfile.
   - "Blockchain-based certificate verification" is **kept**, per Teja's earlier ruling. The code only does SHA-256 hashing (`1on1_sb` `CertificationController`).

## 3. Where every number comes from

| Number | Bullet | Source |
|---|---|---|
| 20% latency | aczen_db_indexing | Teja, 2026-11-08 16:30 IST |
| 100 businesses | aczen_fintech | Teja, 16:30 |
| 43 documents | aczen_rag | Teja gave a bare "43". "documents" is peer 2's choice, since the master never says "records" |
| 300+ participants | st_sawit_genai | Teja, 16:30 |
| 2+, 340+, 9, 90+, 10 | st_hackathons, st_sawit_genai | already in master v26 |
| 50+ endpoints | one1on1_backend, one1on1_docs | `1on1_sb` @00205bb: 52 `@Get/@Post/@Patch/@Delete` mappings across 12 `@RestController`s (SessionBooking 10, User 9, SessionOffering 8, Post 5, Auth 5, Notification 4, Certification 4, Meeting 2, AiAssistant 2, Review 1, Health 1, Feed 1) |
| 878 rows, 14 fields, 2024–2025 | f1_data | `f1_models/datasets/2024.json` (479 rows) + `2025.json` (399), 14 keys each; FastF1 is imported in `training/10-3.py`, `12-3.py` and `12.py` |
| ~40% MAE, 59% correlation | f1_models | already in master. **No evidence in the repo**, and the README says MAE "comes from ~2 test rows and is not a reliable quality measure". Teja decides |
| 18 functions, 12 agents | applyy_agents | `git ls-tree origin/main supabase/functions` (dirs with `index.ts`, `_shared` excluded) = 18 at a974786 |
| 260+ boards, 4 ATS | applyy_grounding | `select count(*) filter (where enabled) from company_watchlist` = 262; `_shared/ats/registry.ts` ADAPTERS = Greenhouse, Lever, Ashby, Workday |
| 21 tables, 4 guard triggers | applyy_safety | `pg_tables` rowsecurity 21/21; `pg_trigger` on applications = guard_failed_rerun, guard_status_insert, guard_status_transition, guard_tailored_profile_freeze (+ log_status_change, set_updated_at) |
| 3,800+ tests, 303 files | applyy_testing | `git grep -hcE "^\s*(test\|it)(\.only\|\.skip)?\(" origin/main -- '*.test.*'` = 3,828; 303 test files |
| 600+, 2nd; 200+; top 20% of 25,000, 6 of 7 | achievements | already in master v26 |

`[confirm:]` placeholders left: **0**. The number 43 rests on peer 2's wording choice, flagged above.

## 4. Open decisions for Teja

1. **One-on-One evidence lives in the private legacy repo.** The 50+ endpoints, WebRTC, WebSockets,
   Gemini key pool, Swagger, AWS EC2 and certificate hashing exist only in `1on1_sb`. The keeper `1on1`
   implements 8 endpoints, all auth plus health. The project's GitHub link points to the keeper. Choose one:
   - keep the link as it is;
   - link `1on1_sb`, which means making it public;
   - cite the keeper's 8 instead of "50+".
2. **`one1on1_indexing`:** option (a) is in the draft and claims no result. Option (b) adds a design count:
   "Designed 29 PostgreSQL indexes…" (29 `ix_`/`uq_` rows in `1on1/docs/architecture/01-data-model.md`).
   An estimated "% faster" is not offered, because the code has never run.
3. **F1 "~40% MAE" and "59% correlation":** keep them, soften them, or drop them (see §3).
4. **"Testing & Quality" skill:** remove it or keep it (see §1).

## 5. More Data Science skills to consider (not in the draft; Teja picks)

| Candidate | Evidence in master or repos |
|---|---|
| Jupyter Notebooks | yes: `f1_models/visulizations&reports/*.ipynb` |
| Exploratory Data Analysis (EDA) | yes: F1 bullet, the notebooks |
| Data Visualization | yes: Power BI achievement, 2 `.pbix` files in f1_models, correlation heatmaps |
| SQL Analytics | yes: SQL skill, IBM "SQL and Relational Databases" certificate |
| Keras / TensorFlow | yes: feed-forward NN in `f1_models/training/17.py` (experimental, not served) |
| SciPy | yes: imported in 2 f1_models files |
| Data Cleaning & Imputation | yes: imputer bundles in f1_models (`main.py:63`) |
| Google Colab / Kaggle | yes: SAWiT.AI bullet |
| Statistics / Hypothesis Testing | **no** evidence found (no statsmodels or t-test usage) |
| Plotly | **no** (0 hits in f1_models) |

Already in the master, so not suggested: Scikit-learn, Feature Engineering, XGBoost, SHAP.
Teja's own Matplotlib and Seaborn picks have evidence too: both appear in f1_models.

## 6. Validation

```
cd apps/web && node <scratchpad>/check-master.mjs ../../docs/status/2026-11-08-master-v26.json
→ {"ok": true, "summary": {"skills": 89, "experience": 2, "projects": 3, "education": 2,
   "achievements": 3, "certifications": 3, "bullets": 24, "links": 13, "hasSummary": true}, "blocking": []}
exit 0
```

- `check-master.mjs` imports `checkMasterProfile` from `apps/web/src/features/settings/masterIngest.ts:685`, a pure function with no network.
- The normalised `.profile` output equals the input byte for byte. All the nullable keys that the table CHECK `master_profiles_nullable_keys_present` requires are already present.
- There are 5 advisories and 0 blocking findings.
- The validator does not check `summary_variants`. They are carried over from v26 unchanged.

Floors: projects 6 / 4 / 4 bullets (all ≥ 4) · Aczen 5 (≥ 4) · certifications 3 (≥ 3) · achievements 3 (≥ 2).
Bullet lengths: the longest is 176 characters (about 2 printed lines). One-page fit is checked at tailor time, not here.

## 7. The write that creates v27 (orchestrator only, after Teja approves; NOT run)

- **Triggers fill the keys:**
  - `assign_version` = max+1 per user.
  - `assign_content_hash` = sha256 of the jsonb text. It overwrites any supplied hash, so never pass version or hash.
- **Rows are immutable** (`forbid_update`, `forbid_delete`). A mistake can only be superseded by v28.
- **Unique `(user_id, content_hash)`:** an identical profile fails with 23505.

```bash
# from the repo root, Bash; the file is the reviewed draft
node -e "const p=require('./docs/status/2026-11-08-master-v26.json');require('fs').writeFileSync(process.env.TEMP+'/v27.sql',
\"insert into public.master_profiles (user_id, profile, label) values ('0f4b24da-e85b-40bb-8606-c81824493b45', \"+
\"'\"+JSON.stringify(p).replace(/'/g,\"''\")+\"'::jsonb, 'v27: formula bullet rewrite + Data Science group + applyy GitHub link (Teja, 2026-11-08 <HH:MM> IST)') returning version, content_hash;\")"
env -u SUPABASE_ACCESS_TOKEN supabase db query --linked -f "$TEMP/v27.sql" 2>/dev/null
```

The SQL is built with JSON.stringify and quote-doubling, never hand-pasted. The bullets contain
apostrophes ("Aczen's"), so pasting the JSON by hand would break the quoting.

**Before running:**
1. Re-read live `max(version)`. If it is no longer 26, Teja has attested another skill since this draft. Rebuild on top of it rather than overwrite (the draft was built from v26).
2. Then check: `select version, label, content_hash from master_profiles order by version desc limit 1`. Expect 27.

**After running:** stale queue rows still hold v26 resumes. The master-change re-run
(memory: `applyyy-master-change-rerun`) is a separate decision.

## 8. Before → after, every bullet

**exp_aczen** (experience)

| bullet id | before (v26) | after (draft) |
|---|---|---|
| bullet_aczen_db_indexing | Worked primarily on the database layer, adding PostgreSQL indexes to speed up lookups and queries. | Reduced PostgreSQL query latency by 20% by adding indexes on frequently queried columns in Aczen's database layer. |
| bullet_aczen_fintech | Contributed to the development of a fintech platform covering GST compliance, GST filing, banking, accounting, invoicing, and workflow automation modules. | Built features for a fintech platform spanning GST filing, banking, accounting, invoicing and workflow automation, used by 100 businesses. |
| bullet_aczen_rag | Integrated LLM APIs with RAG pipelines into Aczen Bliz, enabling AI-powered financial assistance, contextual business intelligence, and workflow automation. | Integrated LLM APIs with RAG pipelines into Aczen Bliz, answering financial and business questions over 43 indexed documents. |
| bullet_aczen_agents | Built AI agents and multi-step agentic workflows for lead enrichment, accounting assistance, customer engagement, social media automation, and business process optimization. | Built multi-step AI agents that automate repetitive manual workflows across lead enrichment, accounting assistance, customer engagement and social media. |
| bullet_aczen_backend | Developed backend services, REST APIs, event-driven workflows, and AI orchestration pipelines using FastAPI, Node.js, PostgreSQL, Supabase, Docker, and Google Cloud Platform. | Developed REST APIs, event-driven workflows and AI orchestration pipelines with FastAPI, Node.js, PostgreSQL, Supabase and Docker, deployed on Google Cloud Platform. |

**exp_student_tribe** (experience)

| bullet id | before (v26) | after (draft) |
|---|---|---|
| bullet_st_hackathons | Organized and hosted 2+ hackathons and technical workshops with 340+ student attendees, led a 9-member technical team, and mentored 90+ project teams. | Organized 2+ hackathons and technical workshops for 340+ students, leading a 9-member technical team that mentored 90+ project teams. |
| bullet_st_sawit_genai | Served as Technical Team Lead for the SAWiT.AI GenAI Hackathon 2025, leading a 10-member team that mentored participants on fine-tuning, Colab, and Kaggle. | Led a 10-member technical team at the SAWiT.AI GenAI Hackathon 2025, mentoring 300+ participants on fine-tuning with Colab and Kaggle. |

**proj_one_on_one** (projects)

| bullet id | before (v26) | after (draft) |
|---|---|---|
| bullet_one1on1_fullstack | Built a full-stack SaaS platform for professional networking, personal branding, and secure one-on-one mentorship booking with free and paid sessions. | Built a full-stack SaaS platform for professional networking, personal branding and one-on-one mentorship booking with free and paid sessions. |
| bullet_one1on1_backend | Developed backend services using PostgreSQL, Redis, REST APIs, JWT authentication, WebRTC, Socket.IO, rate limiting, and input validation. | Developed 50+ secure REST endpoints with PostgreSQL, JWT auth, WebRTC and WebSockets (STOMP), with Bean Validation on request bodies. |
| bullet_one1on1_indexing | Implemented database indexing in PostgreSQL to improve query performance. | Designed PostgreSQL indexes, including partial and foreign-key indexes, to keep feed, booking and payment queries fast. |
| bullet_one1on1_gemini | Integrated Gemini API to build AI-powered application workflows using prompt builders, context builders, and token-cost optimization strategies. | Integrated the Gemini API behind a key pool that enforces per-key request and token-per-minute limits and tracks token usage per call to control cost. |
| bullet_one1on1_devops | Designed and deployed scalable containerized services on Vercel and AWS using Docker, Git, GitHub Actions, CI/CD, and YAML workflows, including blockchain-based certificate verification. | Deployed the frontend on Vercel and the backend on AWS EC2 through GitHub Actions CI/CD, including blockchain-based certificate verification. |
| bullet_one1on1_docs | Authored technical documentation and Swagger/OpenAPI API docs; debugged and troubleshot API, database, and real-time issues. | Documented 50+ REST endpoints in Swagger/OpenAPI and debugged API, database and real-time issues. |

**proj_f1_predictor** (projects)

| bullet id | before (v26) | after (draft) |
|---|---|---|
| bullet_f1_ml_system | Built an end-to-end ML system predicting F1 driver race pace using qualifying and telemetry data with circuit-specific models for Austin, Mexico, Qatar, and Abu Dhabi. | Built an end-to-end ML system predicting F1 race pace from qualifying and telemetry data, with circuit-specific models for Austin, Mexico, Qatar and Abu Dhabi. |
| bullet_f1_models | Trained Gradient Boosting Regressor, XGBoost Regressor, and Feed-Forward Neural Network models using MAE-based evaluation with extensive feature engineering and normalization, reducing MAE by ~40% race over race and finding a 59% qualifying-to-race pace correlation. | Reduced MAE by ~40% race over race by training Gradient Boosting, XGBoost and neural network models with feature engineering; found a 59% qualifying-to-race pace correlation. |
| bullet_f1_eda_deploy | Performed exploratory data analysis, applied SHAP for model explainability, and implemented CI/CD pipelines with GitHub Actions for FastAPI services exposing /predict, /health, and /info. | Explained predictions with SHAP after exploratory data analysis, and shipped FastAPI /predict, /health and /info endpoints through GitHub Actions CI/CD. |
| bullet_f1_data | *(new)* | Built training data from FastF1 race results for 2024–2025 (878 driver-race rows, 14 fields), adding rain-probability and temperature forecasts as model features. |

**proj_applyy** (projects)

| bullet id | before (v26) | after (draft) |
|---|---|---|
| bullet_applyy_agents | Architected a 14-agent system (scouts, normalizer, screener, matcher, tailor, auditor, cover-letter, follow-up, interview-prep, referral, skill-gap, email tracking) as Supabase edge functions powered by Gemini. | Architected 18 Supabase edge functions, 12 of them Gemini-powered pipeline agents (scouts, screener, matcher, tailor, auditor and more), automating job applications end to end. |
| bullet_applyy_grounding | Scouts 200+ ATS career boards; a grounded tailor agent can only reference master-profile nodes, and an auditor agent flags fabrication before a human-approval gate. | Scouted 260+ ATS career boards across Greenhouse, Lever, Ashby and Workday; a tailor limited to master-profile nodes and an auditor block fabrication before human approval. |
| bullet_applyy_safety | Enforced safety in Postgres (RLS, trigger-guarded status graph, kill switch); a Playwright worker on GitHub Actions submits with run caps, circuit breaker, and robots.txt gating. | Enforced safety in Postgres with RLS on all 21 tables, 4 guard triggers on the status graph and a kill switch; a Playwright worker submits with run caps and robots.txt gating. |
| bullet_applyy_testing | Ran integration testing across ~3,500 automated tests spanning agents, the Postgres safety layer and the Playwright worker; debugged and troubleshot failures. | Wrote 3,800+ automated tests in 303 files covering the agents, the Postgres safety layer and the Playwright worker, gating every push in CI. |

**ach_powerbi** (achievements)

| bullet id | before (v26) | after (draft) |
|---|---|---|
| bullet_ach_powerbi | Secured 2nd place among 600+ participants with an analytical dashboard | Won 2nd place among 600+ participants by building an analytical Power BI dashboard. |

**ach_leetcode** (achievements)

| bullet id | before (v26) | after (draft) |
|---|---|---|
| bullet_ach_leetcode | Solved 200+ problems on LeetCode covering Data Structures & Algorithms | Solved 200+ LeetCode problems covering data structures and algorithms. |

**ach_hackathon** (achievements)

| bullet id | before (v26) | after (draft) |
|---|---|---|
| bullet_ach_hackathon | Ranked in the top 20% among 25,000 teams and cleared 6 of 7 rounds with real-time crop-price prediction application | Ranked in the top 20% of 25,000 teams, clearing 6 of 7 rounds with a real-time crop-price prediction app. |
