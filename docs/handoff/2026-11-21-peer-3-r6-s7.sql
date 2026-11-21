-- S7 live statements (peer 3, 2026-11-21). PREPARED, NOT RUN. The orchestrator runs them, in order, one at a time,
-- reading each result before the next. Every write is guarded so a row that moved since prep changes nothing (0 rows).
-- Tell Teja to stay off /approvals until S7-2 and S7-3 are done (a queue edit mid-approval swallows clicks).

-- S7-1  MASTER v51 (insert-only; triggers assign version + content_hash). Built from live v50 by a script that
--        asserted every change matched exactly once; passes the app checker (checkMasterProfile ok:true).
--        Guard: inserts nothing if the master is no longer at v50. EXPECT: 1 row, version 51.
insert into public.master_profiles (user_id, profile)
select '0f4b24da-e85b-40bb-8606-c81824493b45'::uuid, $v51${"achievements":[{"bullets":[{"id":"bullet_ach_powerbi","tags":["power-bi","data-viz","competition"],"text":"Won 2nd place among 600+ participants by building an analytical Power BI dashboard."}],"description":null,"id":"ach_powerbi","label":"Power BI Workshop, MLRIT (Dec 2024)"},{"bullets":[{"id":"bullet_ach_leetcode","tags":["dsa","leetcode"],"text":"Solved 200+ LeetCode problems covering data structures and algorithms."}],"description":null,"id":"ach_leetcode","label":"LeetCode","links":[{"id":"link_leetcode","label":"LeetCode profile","url":"https://leetcode.com/tejamallam"}]},{"bullets":[{"id":"bullet_ach_hackathon","tags":["hackathon","ml"],"text":"Ranked in the top 20% of 25,000 teams, clearing 6 of 7 rounds with a real-time crop-price prediction app."}],"description":null,"id":"ach_hackathon","label":"Build With India Hackathon"}],"certifications":[{"bullets":[],"description":"IBM Developer Skills Network","id":"cert_ibm_sql","label":"SQL and Relational Databases"},{"bullets":[],"description":"Cognitive Class.ai","id":"cert_prompt_eng","label":"Prompt Engineering","links":[{"id":"link_cert_prompt_eng","label":"Prompt Engineering credential","url":"https://courses.cognitiveclass.ai/certificates/3d00491036424cf3972381b9ecd6ed4b"}]},{"bullets":[],"description":"IBM SkillsBuild","id":"cert_ibm_ml","label":"Machine Learning","links":[{"id":"link_cert_ibm_ml","label":"Machine Learning credential","url":"https://www.credly.com/badges/88ea499b-9c36-4b0c-bdac-e89761a42bb3/public_url"}]},{"bullets":[],"description":"Brainovision","id":"cert_brainovision_java_fs","label":"Java Full Stack"},{"bullets":[],"description":"Infosys","id":"cert_infosys_r_ds","label":"R for Data Science"}],"education":[{"bullets":[],"degree":"B.Tech","end_date":"2027-06-01","end_display":"2027","field":"Computer Science & Data Science (CSD)","grade_display":null,"id":"edu_mlrit","institution":"MLR Institute of Technology","start_date":"2024-08-01","start_display":"2024"},{"bullets":[],"degree":"Diploma","end_date":"2024-05-01","end_display":"2024","field":"Electronics & Communication (ECE)","grade_display":null,"id":"edu_tkr","institution":"TKR College of Engineering and Technology","start_date":"2021-08-01","start_display":"2021"}],"experience":[{"bullets":[{"id":"bullet_aczen_db_indexing","tags":["postgres","indexing","databases"],"text":"Reduced PostgreSQL query latency by 20% by adding indexes on frequently queried columns in Aczen's database layer."},{"id":"bullet_aczen_fintech","tags":["fintech","gst","automation"],"text":"Built features for a fintech platform spanning GST filing, banking, accounting, invoicing and workflow automation, used by 100 businesses."},{"id":"bullet_aczen_rag","tags":["llm","rag","fintech"],"text":"Integrated LLM APIs with RAG pipelines into Aczen Bliz, answering financial and business questions over 43 indexed documents."},{"id":"bullet_aczen_agents","tags":["agents","workflows","automation"],"text":"Built multi-step AI agents that automate repetitive manual workflows across lead enrichment, accounting assistance, customer engagement and social media."},{"id":"bullet_aczen_backend","tags":["fastapi","nodejs","postgres","docker","gcp"],"text":"Developed REST APIs, event-driven workflows and AI orchestration pipelines with FastAPI, Node.js, PostgreSQL, Supabase and Docker, deployed on Google Cloud Platform."}],"company":"Aczen Technologies","end_date":null,"end_display":"Present","id":"exp_aczen","location":"Hyderabad, India","role":"Full Stack AI Engineer Intern","start_date":"2026-06-01","start_display":"Jun 2026"},{"bullets":[{"id":"bullet_st_hackathons","tags":["leadership","hackathons"],"text":"Organized 2+ hackathons and technical workshops for 340+ students, leading a 9-member technical team that mentored 90+ project teams."},{"id":"bullet_st_sawit_genai","tags":["leadership","hackathons","genai","mentoring"],"text":"Led a 10-member technical team at the SAWiT.AI GenAI Hackathon 2025, mentoring 300+ participants on fine-tuning with Colab and Kaggle."}],"company":"Student Tribe","end_date":"2025-02-28","end_display":"Feb 2025","id":"exp_student_tribe","location":"Hyderabad, India","role":"Technical Coordinator","start_date":"2024-11-01","start_display":"Nov 2024"}],"identity":{"email":"tejamallam00@gmail.com","full_name":"Mallam Teja","headline":"Full Stack AI Engineer","links":[{"id":"link_portfolio","label":"Portfolio","url":"https://tejamallam.me"},{"id":"link_github","label":"GitHub","url":"https://github.com/MallamTeja"},{"id":"link_linkedin","label":"LinkedIn","url":"https://linkedin.com/in/tejamallam"},{"id":"link_x","label":"X","url":"https://x.com/Mallam_Teja"}],"location":"Hyderabad, India","phone":"9392256662"},"links":[],"projects":[{"bullets":[{"id":"bullet_one1on1_fullstack","tags":["saas","fullstack","react"],"text":"Built a full-stack SaaS platform for professional networking, personal branding and one-on-one mentorship booking with free and paid sessions."},{"id":"bullet_one1on1_backend","tags":["postgres","redis","webrtc","auth"],"text":"Developed 50+ secure REST endpoints with PostgreSQL, JWT auth, WebRTC and WebSockets, with Bean Validation on request bodies."},{"id":"bullet_one1on1_indexing","tags":["postgres","indexing"],"text":"Designed 40 PostgreSQL indexes, including partial and foreign-key indexes, to keep feed, booking and payment queries fast."},{"id":"bullet_one1on1_gemini","tags":["gemini","prompting","cost-optimization"],"text":"Integrated the Gemini API behind a key pool that enforces per-key request and token-per-minute limits and tracks token usage per call to control cost."},{"id":"bullet_one1on1_devops","tags":["docker","vercel","aws","cicd","blockchain"],"text":"Deployed the frontend on Vercel and the backend on AWS EC2 through GitHub Actions CI/CD, including blockchain-based certificate verification."},{"id":"bullet_one1on1_docs","tags":["documentation","openapi","debugging"],"text":"Documented 50+ REST endpoints in Swagger/OpenAPI and debugged API, database and real-time issues."}],"end_date":null,"end_display":"Present","id":"proj_one_on_one","links":[{"id":"link_one1on1_live","label":"Live Demo","url":"https://1on1-sb.vercel.app"},{"id":"link_one1on1_github","label":"GitHub","url":"https://github.com/mallamteja/1on1"}],"name":"One-on-One – AI-Powered Learning Platform","start_date":"2026-01-01","start_display":"Jan 2026"},{"bullets":[{"id":"bullet_f1_ml_system","tags":["ml","telemetry","python"],"text":"Built an end-to-end Python ML system predicting F1 race pace from qualifying and telemetry data, with circuit-specific models for Austin, Mexico, Qatar and Abu Dhabi."},{"id":"bullet_f1_models","tags":["xgboost","gbr","neural-networks","metrics"],"text":"Reduced MAE by ~40% race over race by training Gradient Boosting, XGBoost and neural network models with feature engineering; found a 59% qualifying-to-race pace correlation."},{"id":"bullet_f1_eda_deploy","tags":["shap","fastapi","cicd"],"text":"Explained predictions with SHAP after exploratory data analysis, and shipped FastAPI /predict, /health and /info endpoints through GitHub Actions CI/CD."},{"id":"bullet_f1_data","tags":["data-engineering","feature-engineering","ml"],"text":"Built training data from FastF1 race results for 2024–2025 (878 driver-race rows, 14 fields), adding rain-probability and temperature forecasts as model features."}],"end_date":"2026-01-31","end_display":"Jan 2026","id":"proj_f1_predictor","links":[{"id":"link_f1_live","label":"Live Demo","url":"https://f1predictor.tech"},{"id":"link_f1_github","label":"GitHub","url":"https://github.com/mallamteja/f1_models"}],"name":"F1 Race Pace Predictor","start_date":"2025-09-01","start_display":"Sep 2025"},{"bullets":[{"id":"bullet_applyy_agents","tags":["agents","multi-agent","supabase","gemini"],"text":"Architected 18 Supabase edge functions, 12 of them Gemini-powered pipeline agents (scouts, screener, matcher, tailor, auditor and more), automating job applications end to end."},{"id":"bullet_applyy_grounding","tags":["scraping","grounding","guardrails","llm"],"text":"Scouted 260+ ATS career boards across Greenhouse, Lever, Ashby and Workday; a tailor limited to master-profile nodes and an auditor block fabrication before human approval."},{"id":"bullet_applyy_safety","tags":["postgres","rls","playwright","cicd"],"text":"Enforced safety in Postgres with RLS on all 21 tables, 4 guard triggers on the status graph and a kill switch; a Playwright worker submits with run caps and robots.txt gating."},{"id":"bullet_applyy_testing","tags":["testing","integration-testing","playwright","debugging"],"text":"Wrote 3,800+ automated tests in 303 files covering the agents, the Postgres safety layer and the Playwright worker, gating every push in CI."}],"end_date":null,"end_display":"Present","id":"proj_applyy","links":[{"id":"link_applyy_live","label":"Live","url":"https://applyyy.vercel.app"},{"id":"link_applyy_github","label":"GitHub","url":"https://github.com/MallamTeja/applyyy"}],"name":"applyy – Multi-Agent Job Application System","start_date":"2026-09-01","start_display":"Sep 2026"},{"bullets":[{"id":"bullet_authscore_model","tags":["ml","lightgbm","embeddings","nlp","python"],"text":"Built an end-to-end Python ML service that scores research papers 0–100 from an uploaded PDF, TXT or MD file, using a LightGBM model on 384-dimension MiniLM sentence embeddings plus metadata features, with deterministic local scoring and no API keys or network calls at serving time."},{"id":"bullet_authscore_pipeline","tags":["data-engineering","feature-engineering","shap","ml"],"text":"Built a four-stage resumable pipeline that pulls arXiv metadata and full text, generates synthetic weak papers to fill the low end of the scale and embeds the text; trained with L1 loss, early stopping and k-fold CV, explained predictions with SHAP, and excluded sub-score columns to prevent target leakage."},{"id":"bullet_authscore_api","tags":["fastapi","openapi","render","deployment"],"text":"Shipped a FastAPI service with /predict and /health endpoints and OpenAPI docs that returns the score, a confidence band and extracted metadata, with input validation and bad-file error handling, deployed on Render with a build-time model download and health checks."},{"id":"bullet_authscore_tests","tags":["pytest","testing","cicd","performance"],"text":"Wrote 92 pytest tests in 14 classes that mock the model and embedder so they run without downloading weights, gated every push and PR through GitHub Actions CI, and added latency and throughput scripts that benchmark about 1,000 predictions."}],"end_date":"2026-03-31","end_display":"Mar 2026","id":"proj_authscore","links":[{"id":"link_authscore_live","label":"Live Demo","url":"https://research-papers-authscore-predictor-zawk.onrender.com/"},{"id":"link_authscore_github","label":"GitHub","url":"https://github.com/MallamTeja/research_papers_authscore_predictor"}],"name":"AuthScore – Research Paper Quality Predictor","start_date":"2025-12-01","start_display":"Dec 2025"}],"schema_version":1,"skills":[{"category":"AI","id":"skill_6411aa6f-e2b1-48cd-b298-a924e239b849","name":"Harness Engineering"},{"category":"AI","id":"skill_rag","name":"RAG Pipelines"},{"category":"AI","id":"skill_prompt_eng","name":"Prompt Engineering"},{"category":"AI","id":"skill_context_eng","name":"Context Engineering"},{"category":"AI","id":"skill_ai_agents","name":"AI Agents & Workflows"},{"category":"AI","id":"skill_tool_calling","name":"Tool Calling"},{"category":"AI","id":"skill_guardrails","name":"Guardrails"},{"category":"Languages","id":"skill_python","name":"Python"},{"category":"Languages","id":"skill_sql","name":"SQL"},{"category":"Languages","id":"skill_javascript","name":"JavaScript"},{"category":"Languages","id":"skill_typescript","name":"TypeScript"},{"category":"Frameworks","id":"skill_fastapi","name":"FastAPI"},{"category":"Frameworks","id":"skill_nodejs","name":"Node.js"},{"category":"Frameworks","id":"skill_react","name":"React.js"},{"category":"Frameworks","id":"skill_langchain","name":"LangChain"},{"category":"Databases","id":"skill_postgres","name":"PostgreSQL"},{"category":"Databases","id":"skill_pgvector","name":"pgvector"},{"category":"Databases","id":"skill_redis","name":"Redis"},{"category":"DevOps & Cloud","id":"skill_docker","name":"Docker"},{"category":"DevOps & Cloud","id":"skill_gcp","name":"Google Cloud Platform"},{"category":"DevOps & Cloud","id":"skill_aws","name":"AWS"},{"category":"DevOps & Cloud","id":"skill_azure","name":"Microsoft Azure"},{"category":"DevOps & Cloud","id":"skill_cicd","name":"CI/CD & GitHub Actions"},{"category":"Testing & Quality","id":"skill_1d3eee7b-1418-4c76-9f76-cca375fd649a","name":"Code review"},{"category":"Databases","id":"skill_47de7558-48b1-48ac-b374-ce02db05b341","name":"MySQL"},{"category":"DevOps & Cloud","id":"skill_7a389571-f8aa-40bd-9da1-fb6d9f9a0e18","name":"Monitoring"},{"category":"Databases","id":"skill_4dcb408a-58dd-4d8f-8eff-8728252aaa21","name":"DBMS"},{"category":"Machine Learning","id":"skill_ensemble_learning","name":"Ensemble Learning"},{"category":"Machine Learning","id":"skill_xgboost","name":"XGBoost"},{"category":"Machine Learning","id":"skill_gradient_boosting","name":"Gradient Boosting"},{"category":"Machine Learning","id":"skill_lightgbm","name":"LightGBM"},{"category":"Machine Learning","id":"skill_feature_eng","name":"Feature Engineering"},{"category":"Machine Learning","id":"skill_shap","name":"SHAP"},{"category":"Machine Learning","id":"skill_sklearn","name":"Scikit-learn"},{"category":"Data Science","id":"skill_pandas","name":"Pandas"},{"category":"Data Science","id":"skill_numpy","name":"NumPy"},{"category":"AI","id":"skill_llm_api_integration","name":"LLM/SLM API Integration"},{"category":"AI","id":"skill_vector_search","name":"Vector Search"},{"category":"AI","id":"skill_multi_agent","name":"Multi-Agent Systems"},{"category":"AI","id":"skill_prompt_injection","name":"Prompt Injection Protection"},{"category":"AI","id":"skill_context_validation","name":"Context Validation"},{"category":"AI","id":"skill_prompt_builders","name":"Prompt Builders"},{"category":"AI","id":"skill_context_builders","name":"Context Builders"},{"category":"AI","id":"skill_prompt_caching","name":"Prompt Caching"},{"category":"AI","id":"skill_token_cost_opt","name":"Token Cost Optimization"},{"category":"AI","id":"skill_quantization","name":"Quantization"},{"category":"Backend Engineering","id":"skill_rest_apis","name":"REST APIs"},{"category":"CS Fundamentals","id":"skill_system_design","name":"System Design (LLD/HLD)"},{"category":"CS Fundamentals","id":"skill_oop","name":"OOP"},{"category":"CS Fundamentals","id":"skill_dsa","name":"DSA"},{"category":"CS Fundamentals","id":"skill_os","name":"Operating Systems"},{"category":"CS Fundamentals","id":"skill_networks","name":"Computer Networks"},{"category":"Backend Engineering","id":"skill_rate_limiting","name":"Rate Limiting"},{"category":"Backend Engineering","id":"skill_idempotency","name":"Idempotency"},{"category":"Backend Engineering","id":"skill_caching","name":"Caching"},{"category":"Databases","id":"skill_supabase","name":"Supabase"},{"category":"Databases","id":"skill_mongodb","name":"MongoDB"},{"category":"Tools","id":"skill_postman","name":"Postman"},{"category":"Tools","id":"skill_openapi","name":"Swagger/OpenAPI"},{"category":"Testing & Quality","id":"skill_junit","name":"JUnit"},{"category":"Testing & Quality","id":"skill_pytest","name":"pytest"},{"category":"Tools","id":"skill_git","name":"Git"},{"category":"Tools","id":"skill_github","name":"GitHub"},{"category":"Tools","id":"skill_cursor","name":"Cursor"},{"category":"Tools","id":"skill_claude_code","name":"Claude Code"},{"category":"Tools","id":"skill_jira","name":"Jira"},{"category":"Testing & Quality","id":"skill_10aa97d1-dd6d-48a7-9e30-8b2e51b4d9bd","name":"Testing"},{"category":"Machine Learning","id":"skill_1da22cd1-c694-4237-8cca-61ccc04f72f4","name":"Machine learning"},{"category":"Languages","id":"skill_c","name":"C"},{"category":"Languages","id":"skill_python_scripting","name":"Python Scripting"},{"category":"Testing & Quality","id":"skill_integration_testing","name":"Integration Testing"},{"category":"Testing & Quality","id":"skill_api_testing","name":"API Testing"},{"category":"Testing & Quality","id":"skill_unit_testing","name":"Unit Testing"},{"category":"Backend Engineering","id":"skill_tech_docs","name":"Technical Documentation"},{"category":"Testing & Quality","id":"skill_playwright","name":"Playwright Testing"},{"category":"Backend Engineering","id":"skill_a0326d9f-992f-4c81-af82-58b52ca90f58","name":"Observability"},{"category":"Languages","id":"skill_html","name":"HTML"},{"category":"Languages","id":"skill_css","name":"CSS"},{"category":"Data Science","id":"skill_matplotlib","name":"Matplotlib"},{"category":"Data Science","id":"skill_seaborn","name":"Seaborn"},{"category":"Data Science","id":"skill_power_bi","name":"Power BI"},{"category":"Data Science","id":"skill_r","name":"R"},{"category":"Data Science","id":"skill_tableau","name":"Tableau"},{"category":"Data Science","id":"skill_excel","name":"Excel"},{"category":"Data Science","id":"skill_jupyter","name":"Jupyter"},{"category":"Data Science","id":"skill_eda","name":"EDA"},{"category":"Data Science","id":"skill_data_viz","name":"Data Visualization"},{"category":"Data Science","id":"skill_sql_analytics","name":"SQL Analytics"},{"category":"Data Science","id":"skill_tensorflow","name":"TensorFlow"},{"category":"Data Science","id":"skill_data_cleaning","name":"Data Cleaning"},{"category":"Data Science","id":"skill_kaggle","name":"Kaggle"},{"category":"Data Science","id":"skill_google_colab","name":"Google Colab"},{"category":"Languages","id":"skill_9e2642b1-51f7-4b26-97d1-2c04bf1a69d0","name":"Java"},{"category":"AI","id":"skill_mcp_integrations","name":"MCP Integrations"},{"category":"Backend Engineering","id":"skill_55f1de65-ac39-40b8-bb72-b267fbb367ae","name":"Spark"},{"category":"Frameworks","id":"skill_7b4932e8-ada6-467b-b444-d1463e85681c","name":"gRPC"},{"category":"Frameworks","id":"skill_3d5cab35-9f10-4b83-8018-6343544dfd58","name":"Express.js"},{"category":"Tools","id":"skill_5d25318b-df21-4268-a1bb-f0a5cb832b5c","name":"YAML Flows"},{"category":"Languages","id":"skill_3780ec43-b7b0-4db5-83a7-3fe03760cea0","name":"C#"},{"category":"Tools","id":"skill_d2d3ae0e-2779-407d-ac48-3f6481f6f9d6","name":"Linux"},{"category":"Backend Engineering","id":"skill_4c9638b1-dc76-46b9-8887-2089b9459f9d","name":"Microservices"},{"category":"Frameworks","id":"skill_a4ecea38-40e1-4887-b13e-776d85eab1ca","name":"Spring"},{"id":"skill_spring_boot","name":"Spring Boot","category":"Frameworks"}],"summary":{"id":"summary_main","text":"Computer Science undergraduate specializing in Data Science with industry experience as a Full Stack AI Engineer Intern. Experienced in building LLM-powered applications, RAG systems, AI agents, agentic workflows, and AI-driven automation for fintech and business applications. Proficient in Python, SQL, FastAPI, PostgreSQL, pgvector, JavaScript, Node.js, Docker, Google Cloud Platform, prompt engineering, context engineering, and AI orchestration."},"summary_variants":[{"headline":"Full Stack AI Engineer | LLM Applications, RAG & AI Agents","id":"variant-ai-llm","label":"AI / LLM engineering","summary":{"id":"summary-ai-llm","text":"Full Stack AI Engineer Intern at Aczen Technologies, integrating LLM APIs with RAG pipelines into Aczen Bliz and building AI agents and multi-step agentic workflows for a fintech platform. Architected an 18-function, 12-agent job application system as Supabase edge functions powered by Gemini, with a grounded tailor agent and an auditor agent that flags fabrication before a human-approval gate."}},{"headline":"Full Stack AI Engineer | Node.js, FastAPI, PostgreSQL, REST APIs","id":"variant-backend-fullstack","label":"Backend / full-stack software engineering","summary":{"id":"summary-backend-fullstack","text":"Full Stack AI Engineer Intern at Aczen Technologies, developing backend services, REST APIs and event-driven workflows with FastAPI, Node.js, PostgreSQL, Supabase and Docker, and adding PostgreSQL indexes to speed up queries. Built a full-stack SaaS mentorship platform with PostgreSQL, Redis, JWT authentication, WebRTC and Socket.IO, deployed as containerized services on Vercel and AWS with GitHub Actions CI/CD."}},{"headline":"Data Science Undergraduate | Machine Learning, XGBoost, SHAP, Python","id":"variant-ml-data","label":"Machine learning / data","summary":{"id":"summary-ml-data","text":"Computer Science & Data Science undergraduate who built an end-to-end ML system predicting F1 driver race pace, training Gradient Boosting, XGBoost and Feed-Forward Neural Network models and reducing MAE by ~40% race over race. Applied SHAP for model explainability with FastAPI services on GitHub Actions CI/CD, and secured 2nd place among 600+ participants with a Power BI analytical dashboard."}}]}$v51$::jsonb
where (select max(version) from public.master_profiles where user_id = '0f4b24da-e85b-40bb-8606-c81824493b45') = 50
returning version, content_hash;

-- S7-2  VS Code out of the 2 awaiting_approval resumes (skills[] only; same guard shape as the browser edit:
--        status + updated_at). approved/applied rows stay frozen. EXPECT: 2 rows.
update public.applications a
   set tailored_profile = jsonb_set(a.tailored_profile, '{skills}',
         (select coalesce(jsonb_agg(s order by o), '[]'::jsonb)
            from jsonb_array_elements(a.tailored_profile->'skills') with ordinality e(s, o)
           where s->>'ref' <> 'skill_vscode'))
 where a.status = 'awaiting_approval'
   and (a.id, a.updated_at) in (('2dd68caa-51dd-44b6-bdf2-8a60ce93665b'::uuid, '2026-11-21 09:50:51.847611+00'::timestamptz),
                                ('f4e2f35f-22b9-4825-b1bb-b8632ec1dc3c'::uuid, '2026-11-21 13:56:24.566692+00'::timestamptz))
returning a.id, a.updated_at, a.tailored_profile::text like '%skill_vscode%' as still_has_vscode;
-- FOLLOW-UP: 8a6bc0d6-bb52-4723-b32e-2d7da290a7cd is at `tailored` WITH VS Code (freeze guard forbids a write there).
--   When the auditor moves it to awaiting_approval, re-run S7-2 with its id + new updated_at.

-- S7-3  Fractal 002b1d10 dropped (Teja: "drop"). The UI reject path: awaiting_approval -> dropped_filter, human,
--        drop_reason in p_detail, stale-stamp guard. EXPECT: no error.
select public.advance_application_status('002b1d10-5f03-43d8-b093-0ab6e0e94b17'::uuid, 'dropped_filter', 'human',
  '{"drop_reason": "rejected at approval gate", "source": "orch_sql", "ruling": "Teja 2026-11-21 19:06-19:12: drop"}'::jsonb,
  '2026-11-11 13:32:11.272647+00'::timestamptz);

-- S7-4  Supabase Auth 4e32dc5c re-tailor (Teja: "re tailor"). It is at APPROVED, so first the human edge back:
--        approved -> passed_filters ("Human withdraws the approval to re-score and re-tailor"). EXPECT: no error.
select public.advance_application_status('4e32dc5c-2643-4017-b9bb-6a9f6f9ee1f9'::uuid, 'passed_filters', 'human',
  '{"source": "orch_sql", "ruling": "Teja 2026-11-21 19:06-19:12: re tailor from the full JD"}'::jsonb,
  '2026-11-21 13:26:18.931992+00'::timestamptz);

-- S7-5  The full JD (4876 chars) from https://jobicy.com/jobs/153449-software-engineer-auth, read 2026-11-21 19:3x IST
--        from its JobPosting ld+json (robots.txt allows /jobs/; validThrough 2026-12-18). The stored copy is the
--        375-char cut. Guard: only while it is still that cut. EXPECT: 1 row, 4876.
update public.jobs set description_raw = $jd$About Supabase

Supabase is the Postgres development platform, built by developers for developers. We provide a complete backend solution including Database, Auth, Storage, Edge Functions, Realtime, and Vector Search. All services are deeply integrated and designed for growth.

About the role

Auth, written in Go (server) and with client libraries for TypeScript, SSR and for other frameworks and technologies, is one of the most popular products in the Supabase stack. We are seeking someone to help us build new and maintain existing Auth features.

What you’ll be responsible for

• 
Designing and implementing secure, scalable authentication features in Go and TypeScript.

• 
Working across the stack: from server-side protocols to client-side libraries for frameworks like Next.js.

• 
Owning the performance, reliability, and scalability of the Auth server across Supabase’s infrastructure.

• 
Contributing to the evolution of our Auth architecture, including support for OAuth, OIDC, SAML, and other protocols.

• 
Planning and executing safe database migrations across a large fleet of Postgres instances.

• 
Building and improving observability: metrics, tracing, alerting, and dashboards to keep the system healthy at scale.

• 
Writing and reviewing RFCs as part of our product development process.

• 
Collaborating with engineers across Supabase to ensure a seamless experience for developers using our tools.

• 
Supporting the community and responding to developer feedback on GitHub, Discord, and other channels.

You might be a good fit if you

• 
(Required) Have 4+ years of professional experience writing and shipping Go in production.

• 
(Required) Have 2+ years of professional experience working on an authentication system (implementing protocol support, maintenance at scale).

• 
(Required) Have strong relational database experience (Postgres or MySQL); Postgres experience is a bonus.

• 
Have strong knowledge of TypeScript in addition to Go (languages used daily).

• 
Have strong knowledge of web technology fundamentals (cookies, sessions, JWT, HTTP, browser APIs).

• 
Have good knowledge of and deep interest in authentication security (passwords, protocols such as OAuth, OIDC or SAML, cryptography fundamentals such as hash functions, signatures and ciphers).

• 
Have experience working with multiple web frameworks like Next.js (or other SSR alternative in the JavaScript space) and traditional web frameworks like Ruby on Rails, Django, Laravel or equivalent (in any language).

• 
Have good technical writing skills (RFC process is an important part of making changes to the Auth product).

• 
Have hands-on experience building and operating services at significant scale.

• 
Have deep understanding of systems-level concerns: memory management, concurrency patterns, and compute resource optimization in Go.

• 
Have experience with Kubernetes and AWS (or comparable cloud platform) in a production setting.

• 
Have solid grasp of observability practices — metrics, distributed tracing, structured logging, and alerting (e.g., Prometheus, Grafana, OpenTelemetry).

• 
Have experience managing database schema migrations safely at scale.

What We Offer

• 
Fully Remote

We hire globally. We believe you can do your best work from anywhere. There are no Supabase offices, but we provide a WeWork membership or co-working allowance you can use anywhere in the world.

• 
ESOP

Every team member receives ESOP (equity ownership) in the company. We want everyone to share in the upside of what we’re building together.

• 
Tech Allowance

Use this budget to set up your ideal work environment—laptop, monitor, headphones, or whatever helps you do your best work.

• 
Health Benefits

Supabase covers 100% of health insurance for employees and 80% for dependents, wherever you are. Your wellbeing and your family’s health are important to us.

• 
Annual Off-Sites

Once a year, the entire company gathers in a new city for a week of connection, collaboration, and fun. It’s a highlight of our year.

• 
Flexible Work

We operate asynchronously and trust you to manage your own time. You know what needs to be done and when.

• 
Professional Development

Every team member receives an annual education allowance to spend on learning—courses, books, conferences, or anything that supports your growth.

About the Team

Supabase was born-remote and open-source-first. We believe our globally distributed team is our secret weapon in building tools developers love.

• 
~400 team members

• 
60+ countries

• 
20+ languages spoken

• 
Over $1B raised (including our $500M Series F)

• 
540,000+ community members

We move fast, build in public, and use what we ship. If it’s in your project, we probably use it in ours too. We believe deeply in the open-source ecosystem and strive to support—not replace—existing tools and communities.$jd$
 where id = '2501b94f-914a-42c0-8dca-62ca9c89754f' and length(description_raw) = 375
returning id, length(description_raw);

-- S7-6  (not SQL) the existing one-row route: matcher -> tailor -> auditor, stops at awaiting_approval at the latest.
--        gh workflow run run-one.yml --ref main -f application_id=4e32dc5c-2643-4017-b9bb-6a9f6f9ee1f9
--        Run AFTER S7-1, so the re-tailor reads master v51.
