# Master v52 audit — 2026-11-24

Read-only audit of master profile v52 (created 2026-11-24 05:43 UTC), done for Teja's ask "find gaps in master resume, mistakes and other things".
Method: SELECTs on `master_profiles`, HEAD probes on every link, and `gh` reads. Nothing was written.
Rulings that were respected, so not flagged: no CGPA, one email, one page, max 2 projects, the blockchain claim kept, AWS on the Java One-on-One variant only.
Work item: **S42** in `docs/handoff/2026-11-12-1305-pending-tasks.md`. Every master edit is a live write: the orch runs it after Teja OKs the wording.

## Mistakes (must fix)

1. `identity.links` has `https://tejamallam.me`. The domain is unregistered (curl 000). Remove the link.
2. The One-on-One GitHub link `github.com/mallamteja/1on1` points to the Node/TS repo (no Java). The bullets claim Bean Validation + AWS EC2, and the demo is 1on1-sb. `1on1_sb` is private (404). Fix: either make it public and link it, or drop the code link on the Java variant.
3. There is only one One-on-One entry, so a Node-flavoured render still carries "AWS EC2" (`bullet_one1on1_devops`). Fix: split the entry into Java/Node variants, or tie AWS to the sb link (ruling S19).
4. Java and Spring Boot appear only in skills, never in a bullet. Fix: "…50+ REST endpoints in Java/Spring Boot with PostgreSQL, JWT auth…".
5. "18 Supabase edge functions": the repo has 19 (`ls supabase/functions/*/index.ts`). Fix: re-derive the count, or write "18+".
6. "59% qualifying-to-race pace correlation": a correlation is not a percent. Fix: "0.59 correlation (r)".
7. The project is named "applyy" but the URL and repo are "applyyy". Fix: use "applyyy" everywhere.
8. `variant-backend-fullstack`: "containerized services on Vercel and AWS" (Vercel hosts no containers) and "Socket.IO" (the master says WebSockets). Fix: "frontend on Vercel, Dockerized backend on AWS EC2", and use one name for the realtime tech.
9. The auditor "flags fabrication" in `variant-ai-llm`, but "blocks fabrication" in `bullet_applyy_grounding`. Fix: pick one verb.
10. The One-on-One title says "AI-Powered Learning Platform", but the bullets describe networking, personal branding and mentorship booking. Fix: align the title, e.g. "Mentorship & Networking Platform".

## Gaps (missing)

11. No bullet shows frontend work, yet the headline says Full Stack. Fix: add one React/TypeScript bullet.
12. These skills have no bullet behind them and an interviewer will probe them: LangChain, pgvector (also in the summary), Redis (the tag is there, the text is not), MongoDB, MySQL, Azure, gRPC, Spark, C#, Express.js, JUnit, TensorFlow, Tableau, Quantization, Prompt Caching, MCP Integrations, Harness Engineering, Microservices, YAML Flows, Jira, Pandas/NumPy. Fix: cut each one Teja can't defend, or add a bullet that shows it.
13. Docker is missing from the deploy text (the ruling says Vercel/AWS/Docker). It appears only as a tag.
14. The B.Tech runs 2024–2027 after a 2021–2024 Diploma. Fix: add "(Lateral Entry)".
15. No Relevant Coursework line (DBMS/OS/CN/OOP/DSA sit in skills), and no "B.Tech 2027 / available from" line in the summary.
16. The phone has no country code. Fix: "+91 93922 56662".
17. Certifications have no dates. 3 of 5 have no verify link (IBM SQL, Brainovision Java Full Stack, Infosys R).
18. "Build With India Hackathon" has no year. "Power BI Workshop" claims "2nd place among 600+". Fix: rename it to the competition's real name.

## Weak (could be stronger)

19. Duplicate skills: Spring/Spring Boot; Python/Python Scripting; Testing/Unit-Integration-API Testing; Git/GitHub; Monitoring/Observability; SQL/SQL Analytics; Prompt Builders/Context Builders/Prompt-Context Engineering; Ensemble Learning/Gradient Boosting/XGBoost.
20. Casing is inconsistent: "Code review", "Machine learning", "Spark" (should be Apache Spark, and it is filed under Backend), "Cognitive Class.ai", and the GitHub owner appears as both MallamTeja and mallamteja.
21. Two bullets have no metric: "Built multi-step AI agents that automate…" and "Developed REST APIs, event-driven workflows…".
22. "keep feed, booking and payment queries fast" has no number. "debugged API, database and real-time issues" is filler. "50+ REST endpoints" appears twice.
23. The applyyy scouting bullet packs two ideas into one sentence. Split it. Re-verify "260+ boards".
24. The AuthScore bullets run 45–55 words each. Trim each to about 25 words.
25. "over 43 indexed documents" undersells the work.
26. Student Tribe: "2+ hackathons" is vague. One bullet says a "9-member" team and another says "10-member".
27. ~~Aczen ends "Nov 2026"; show "Present" if still running.~~ NOT a finding: Teja's session set "Mar 2026 – Nov 2026" on purpose in v52 (2026-11-24). Older tailored resumes in the queue still show "Present"; the S22 re-tailor refreshes them.
28. The summary is a keyword list. Fix: lead with one result (20% latency cut, 100 businesses) and "B.Tech 2027".
29. The X link adds little for Indian recruiters.

Verified OK: one email; demo 1on1-sb.vercel.app (200); Python named in the AuthScore and F1 bullets; no VS Code, STOMP or CGPA; "RLS on all 21 tables" matches live. All other links return 200. LeetCode returns 403 (bot-blocked, not verified).
