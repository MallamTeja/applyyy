# Rejection post-mortem — 5 employer rejections (2026-11-23)

Read-only investigation (5 recon agents + live SELECTs + Gmail search). Nothing was written to live data.
Asked by Teja 2026-11-23 23:11 IST: "find why my resume got rejected for those 5 applied jobs".

## The five

| Company / role | App id | Score | Applied → rejected | Main reason | Ours to fix? |
|---|---|---|---|---|---|
| Cisco, SWE Full Stack (Workday, BLR, req 2029300) | 5707448c | 52 | 11-21 17:13 → 11-23 10:59 UTC (~42 h) | Lateral full-time req (sibling reqs 4–8 yrs) vs grad 2027; NMS/networking domain missing | Partly: tailor dropped React (a JD must-have) |
| ElevenLabs, Full-Stack Ads Engine (Ashby via arbeitnow) | 10e737c4 | 86 | 11-11 14:47 → 11-16 11:40 (~5 d) | Founding-engineer seniority; ElevenLabs has 0 junior titles in 123 jobs | Partly: skills list went out with NO language or frontend framework |
| Canonical, Python Engineer (Greenhouse) | 800e8d08 | 83 | 11-11 → 11-12 12:27 (~22 h) | Academic-record form screen (HS rankings + 7.4 CGPA, no 12th/JEE) | Mostly no; answers + resume gaps fixable |
| HackerRank, AI Researcher Intern (Greenhouse) | cac40516 | 49 | 11-05 09:03 → 11-07 12:30 (~51 h) | Requires M.Tech/M.S./Ph.D. + research publications | No (not a fit); the matcher said so |
| Salesforce, SWE MTS Workday Finance (req JR363864) | f68ad292 | — | rejected 11-14 08:23 UTC | Not analysed in depth; email tracker MISSED it (see S38) | — |

## Cross-cutting findings (ours to fix)

1. **Tailor drops must-have JD skills that are in the master (S32).** Cisco: `skills_dropped` incl. React, PostgreSQL, Node.js, FastAPI; React absent from the submitted resume though the JD requires it. ElevenLabs: dropped Python, JS, TS, React, Node, FastAPI, Postgres, Supabase, REST; the skill-count floor added JUnit/Testing/Code review instead. Rule needed: a JD must-have present in the master is never dropped; floor fill ranks by JD relevance.
2. **Matcher scores the master, not the submitted resume, and has no seniority penalty (S33).** ElevenLabs 86 cited React that the tailor then cut; reasoning named "veteran founding engineer" and still said strong. `jobs.min_experience_years` null → experience ceiling never fires.
3. **Auditor does not ground summary text (S34).** HackerRank summary claimed "Applied AI Researcher … Proficient in PyTorch" — neither is in any master version; auditor `findings_count: 0`.
4. **Degree check needs this fixture (S25).** "M.Tech./M.S./Ph.D." listed under "Who you are" (no word "required"); `description_requires_degree` false on that row; 0 jobs have `requires_advanced_degree` set.
5. **Form answers are not recorded when Teja submits by hand (S37).** Cisco, ElevenLabs, Canonical, HackerRank: apply_kit `fields: []` or required fields unanswered; ElevenLabs kit pointed at the arbeitnow page, not the Ashby form. Aggregator rows should resolve to the real ATS posting (true posted date: ElevenLabs was 6 days older than we thought; structured locations).
6. **Canonical needs its own lane (S36).** No-AI declaration + required essays + academic rankings; answer bank held "good"/"very good" (not valid options). 9 Canonical rows await approval, 3 more applied. Manual lane only, exact-option answers, human-written essays, cap 1–2 best fits.
7. **Email tracker (S38).** Salesforce rejection classified `unclassified` (0.30): "we've made the tough choice not to move forward" and subject "Update on Salesforce's … Role" match no rule (`_shared/email/classifier.ts:87-160`, `:192`). Canonical receipt misread as `interview_invite`. About 8 junk `applied` rows were created with email subjects as job titles ("Thank you for applying…", "Great News!…", "Your Application"), so the `applied` count is inflated.
8. **Targeting/latency (S39).** Two of five were "moderate" scores with the blocker named in the matcher's own reasoning (HackerRank degree, Cisco Java/NMS). Applications went out 8–9 days after posting; Cisco sat 7 days in the approval queue. MNC untagged lateral reqs vs new-grad reqs need a screen.

## Out of our control
Grad year 2027 vs full-time lateral reqs; Canonical's academic bar; HackerRank's M.S./Ph.D. requirement; ElevenLabs' senior-only hiring; no founder/research history yet.

## Pending live-data fixes (need Teja's OK)
- Salesforce `f68ad292` → record the rejection (today `failed`).
- Junk `applied` rows built from email subjects → identify and correct via compensating events.
