# Watchlist expansion, half B — 103 new verified-pollable boards (2026-10-23)

> **Status 2026-11-08:** Historical. The boards were seeded through `supabase/snippets/2026-10-23-seed-watchlist-expansion.sql`. Later passes added more boards and, on 2026-11-01, disabled dead greenhouse rows, so the counts here are point-in-time. Re-probe live `company_watchlist` rows, not this table; the current coverage query is in [README.md](README.md). The body below is the original record, unedited.

Goal served: discovery coverage toward ~20 new matching intern/new-grad/India/remote
postings per day for the profile (2027 B.Tech, Hyderabad/Bangalore/Pune + remote;
AI/ML, FDE, full-stack/MERN, backend, SDE intern/new-grad). Half B = NEW companies
only; the existing 54 rows' token fixes are half A (peer 2) and are untouched here.

## Probe method (every row re-verifiable the same way)

- Candidate tokens were read by four web-recon agents from each company's own
  careers page — the Greenhouse/Lever/Ashby URL embedded there is ground truth.
  Name-derived token guesses were banned (the September catalog's failure mode).
- Every candidate was then verified centrally on 2026-10-23 ~22:53 IST by ONE
  read-only GET, rate-limited to 1 request/second/host, script
  `verify-boards.mjs` (session scratchpad; logic described here so the probe is
  reproducible):
  - greenhouse: `https://boards-api.greenhouse.io/v1/boards/{token}/jobs`
  - lever: `https://api.lever.co/v0/postings/{token}?mode=json`
  - ashby: `https://api.ashbyhq.com/posting-api/job-board/{token}`
- PASS = HTTP 200 AND body parses as JSON AND matches the provider's expected
  shape (`{jobs: []}` / top-level array) AND >0 postings. A 200 with the wrong
  shape is a FAIL (fail-open guard: never ask a lenient parser if it gave up).
- Gate proven non-vacuous: a deliberate garbage token (`zz-no-such-board-xx`)
  FAILED with HTTP 404 before the batch ran; 3 already-watched tokens PASSED.
- Counts per row, matched on title+location text: `tech` = engineering-titled
  postings; `early` = intern/new-grad/graduate/junior/early-career; `India/remote`
  = tech postings whose location mentions India/Hyderabad/Bangalore/Bengaluru/
  Pune/remote; `early+loc` ranks the table. Counts are point-in-time.

## Honest tally

- Researched: ~140 companies across 4 segments (India-eng-hub, AI/ML, dev-tools,
  early-career-anywhere).
- Candidates with a careers-page-evidenced token: 104.
- **Verified pollable: 103 of 104** (only `ashby/sprinto` failed, HTTP 404 — it
  was flagged "undetermined" by recon and probed as a cheap gamble).
- Not candidates: ~25 confirmed on unsupported ATS (list at bottom), ~25
  unresolved (JS-rendered careers pages; need a headless render to extract a
  token — NOT confirmed rejects).

## Verified boards, prioritized (early+India/remote matches first)

| company | provider | board_token | verified at | matching roles seen (probe counts + examples) |
|---|---|---|---|---|
| Skydio | ashby | `skydio` | 2026-10-23 22:53 IST | total 168, tech 104, early 12, India/remote 83 — e.g. PhD Autonomy Engineer Intern - Computer Vision / Deep Learning Summer 2027 (Zurich, Switze; Autonomy Engineer Intern, Computer Vision / Deep Learning, Summer 2027 (San Mateo, Califor; Software Engineer Intern - Summer 2027 (San Mateo, California, United States remote) |
| 1Password | ashby | `1password` | 2026-10-23 22:53 IST | total 89, tech 38, early 10, India/remote 37 — e.g. Developer Intern, Data Security - Winter 2027 (Remote (United States / Canada) remote); Developer Intern, Machine Identity - Winter 2027 (Remote (United States / Canada) remote); Developer Intern, Vault Team - Winter 2027 (Remote (United States / Canada) remote) |
| Amplify | ashby | `amplify` | 2026-10-23 22:53 IST | total 33, tech 6, early 5, India/remote 6 — e.g. Summer 2027: AI Scientist Intern (Remote - United States remote); Summer 2027: Software Engineering Intern (Remote - United States remote); Summer 2027: Supply Chain Intern (Remote - United States remote) |
| Harvey | ashby | `harvey` | 2026-10-23 22:53 IST | total 349, tech 126, early 4, India/remote 112 — e.g. Software Engineering Intern (Summer 2027) (New York remote); Software Engineer, New Grad (2027) (San Francisco remote); Software Engineering Intern (Summer 2027) (San Francisco remote) |
| Cerebras | ashby | `cerebras` | 2026-10-23 22:53 IST | total 123, tech 94, early 4, India/remote 61 — e.g. Software Engineer - New Grad 2026 (Toronto, CAN remote); DevOps Engineer - New Grad 2026 (Toronto, CAN remote); Kernel Engineer - New Grad (Sunnyvale, CA remote) |
| Quora | ashby | `quora` | 2026-10-23 22:53 IST | total 9, tech 8, early 3, India/remote 8 — e.g. Software Engineer New Grad, Machine Learning Platform - Quora (Remote) (Remote - Multiple ; Full Stack Software Engineer, New Grad - Quora (Remote) (Remote - Multiple Locations remot; Machine Learning Engineer, New Grad - Quora (Remote) (Remote - Multiple Locations remote) |
| Cohere | ashby | `cohere` | 2026-10-23 22:53 IST | total 113, tech 61, early 2, India/remote 54 — e.g. Software Engineer Intern (Winter 2027) (Canada remote); Machine Learning Intern/Co-op  (Winter 2027) (Canada remote) |
| Sentry | ashby | `sentry` | 2026-10-23 22:53 IST | total 42, tech 35, early 2, India/remote 35 — e.g. Software Engineer, Intern (Summer 2027) (Vienna, Austria remote); Software Engineer, New Grad (2027) (Vienna, Austria remote) |
| Qumulo | ashby | `qumulo` | 2026-10-23 22:53 IST | total 23, tech 12, early 2, India/remote 12 — e.g. Software Development Engineer (New Grad / Entry Level) (Seattle (hybrid) remote); Software Development Engineer (Seattle) - Internship 2027 (Seattle (hybrid) remote) |
| Patreon | ashby | `patreon` | 2026-10-23 22:53 IST | total 19, tech 8, early 2, India/remote 7 — e.g. Software Engineering Intern - Summer 2027 (San Francisco remote) |
| Hevo Data | lever | `hevodata` | 2026-10-23 22:53 IST | total 53, tech 21, early 1, India/remote 20 — e.g. Associate Software Development Engineer (SDE) Intern (Bangalore, India) |
| Redgate | ashby | `red-gate` | 2026-10-23 22:53 IST | total 11, tech 6, early 1, India/remote 6 — e.g. Software Engineer Intern (Cambridge remote) |
| Cadence Solutions | greenhouse | `solutions` | 2026-10-23 22:53 IST | total 21, tech 7, early 1, India/remote 6 — e.g. Software Engineering Intern (Remote) |
| SpruceID | ashby | `spruceid` | 2026-10-23 22:53 IST | total 6, tech 5, early 1, India/remote 5 — e.g. Full-Stack Software Engineer (New Grad) – Remote (United States remote) |
| Astera Labs | greenhouse | `asteraearlycareer2027` | 2026-10-23 22:53 IST | total 91, tech 66, early 55, India/remote 0 — e.g. Advanced DV Engineer Intern (San Jose, CA); AMS Design Verification Engineer Intern  (San Jose, CA); AMS Digital Design Engineer Intern (San Jose, CA) |
| Graphcore | greenhouse | `graphcore` | 2026-10-23 22:53 IST | total 214, tech 182, early 20, India/remote 22 — e.g. AI Technology PhD Research Internship (Bristol, UK; Cambridge, UK; London, UK); Graduate Cloud Platform Engineer 2027 (Bristol, UK); Graduate Firmware Engineer 2027 (Bristol, UK) |
| Muon Space | greenhouse | `muonspace` | 2026-10-23 22:53 IST | total 143, tech 99, early 10, India/remote 8 — e.g. Electrical Engineering Intern (Summer 2027) (San Jose, CA); Environmental Test Engineering Intern (Summer 2027) (San Jose, CA); Flight Software Engineering Intern (Summer 2027) (San Jose, CA) |
| Scale AI | greenhouse | `scaleai` | 2026-10-23 22:53 IST | total 171, tech 95, early 8, India/remote 0 — e.g. Machine Learning Research Intern (Summer 2027) (New York, NY; San Francisco, CA); Software Engineering Intern (Summer 2027)  (Doha, Qatar ); Software Engineering Intern (Summer 2027)  (London, UK) |
| Perpay | greenhouse | `perpay` | 2026-10-23 22:53 IST | total 22, tech 13, early 7, India/remote 0 — e.g. Data Engineering Internship, Summer 2027 (Philadelphia, Pennsylvania, United States); Data Science Internship, Summer 2027 (Philadelphia, Pennsylvania, United States); Software Engineering Internship, Summer 2027 (Philadelphia, Pennsylvania, United States) |
| Point72 | greenhouse | `point72` | 2026-10-23 22:53 IST | total 212, tech 94, early 6, India/remote 31 — e.g. 2027 Summer Internship - MS/PhD Data Scientist, Proprietary Research (New York, NY); 2027 Summer Internship – Software Engineer  (New York, NY); Machine Learning Researcher - Intern (New York) |
| DoorDash | greenhouse | `doordashusa` | 2026-10-23 22:53 IST | total 464, tech 128, early 6, India/remote 12 — e.g. Electrical Engineer, Intern - Labs (Summer 2027) (Oakland, CA); Machine Learning Intern (Masters) - Summer 2027 (San Francisco, CA;  Sunnyvale, CA ; New Y; Machine Learning Intern (PhD) - Summer 2027 (San Francisco, CA;  Sunnyvale, CA ; New York  |
| Sierra | ashby | `Sierra` | 2026-10-23 22:53 IST | total 209, tech 99, early 6, India/remote 8 — e.g. Software Engineer, Agent (New Grad) (London); Software Engineer, Agent (New Grad 2027) (San Francisco, CA); Software Engineer Intern, Agent (Summer 2027) (San Francisco, CA) |
| Together AI | greenhouse | `togetherai` | 2026-10-23 22:53 IST | total 83, tech 55, early 5, India/remote 7 — e.g. Hardware Security Engineer Intern (Summer 2027) (San Francisco); Hardware Security Engineer, New Grad (2027) (San Francisco); [Junior / Senior / Staff] Software Engineer, Inference / Compute Infrastructure Engineerin |
| Sigma Computing | greenhouse | `sigmacomputing` | 2026-10-23 22:53 IST | total 77, tech 43, early 5, India/remote 1 — e.g. AI/ML PhD Intern (Summer 2027) (New York, New York); AI/ML PhD Intern (Summer 2027) (San Francisco, CA); Software Engineering Intern (Summer 2027) (New York, NY) |
| SingleStore | greenhouse | `singlestore` | 2026-10-23 22:53 IST | total 40, tech 23, early 3, India/remote 9 — e.g. Software Engineer-Engine-New Grad 2027 (United States); Software Engineer-Helios-New Grad 2027 (United States); Software Engineer Intern- Helios- 2027 (United States) |
| DriveWealth | greenhouse | `drivewealth` | 2026-10-23 22:53 IST | total 24, tech 12, early 3, India/remote 4 — e.g. AI Consulting Associate Program (AI CAP) Brokerage Intern - Summer 2027 (Office - Chicago); AI Consulting Associate Program (AI CAP) Engineering Intern - Summer 2027 (Office - Chicag; AI Consulting Associate Program (AI CAP) Product Owner Intern - Summer 2027 (Office - Chic |
| Klaviyo | greenhouse | `klaviyocampus` | 2026-10-23 22:53 IST | total 8, tech 6, early 3, India/remote 0 — e.g. AI Engineer Intern (Summer 2027) (Boston, MA); Machine Learning Engineer Internship-Summer 2027 (Palo Alto, CA); Software Engineer Intern (Summer 2027) (Boston, MA) |
| Pure Storage | greenhouse | `purestorage` | 2026-10-23 22:53 IST | total 363, tech 169, early 2, India/remote 54 — e.g. Junior DevOps Engineer (Santa Clara, California); Software Engineer Intern (Summer 2027) (Santa Clara, California) |
| LangChain | ashby | `langchain` | 2026-10-23 22:53 IST | total 104, tech 46, early 2, India/remote 15 — e.g. Deployed Engineer (Early Career-NYC) (New York, NY); Deployed Engineer (Early Career- SF) (San Francisco, CA) |
| ZipRecruiter | greenhouse | `ziprecruiter` | 2026-10-23 22:53 IST | total 44, tech 18, early 2, India/remote 11 — e.g. Software Engineer - Intern (Santa Monica, CA); Software Engineer - New Grad (Santa Monica, CA) |
| Vercel | greenhouse | `vercel` | 2026-10-23 22:53 IST | total 95, tech 40, early 2, India/remote 7 — e.g. Software Engineering Intern - Summer '27 (Hybrid - San Francisco); Software Engineering Intern - Winter '27 (Hybrid - San Francisco) |
| GCM Grosvenor | greenhouse | `gcmgrosvenor` | 2026-10-23 22:53 IST | total 13, tech 4, early 2, India/remote 0 — e.g. 2027 Fund Data Reporting and Analytics Summer Intern (Chicago, Illinois, United States); 2027 Software Engineering Summer Intern (Chicago, Illinois, United States) |
| Twitch | greenhouse | `twitch` | 2026-10-23 22:53 IST | total 58, tech 21, early 2, India/remote 0 — e.g. Undergrad Software Engineering Intern (Grad Year: Spring 2028) (San Francisco, CA); Undergrad Software Engineering Intern (Grad Year: Winter 2027) (San Francisco, CA) |
| ID.me | greenhouse | `idme` | 2026-10-23 22:53 IST | total 41, tech 22, early 2, India/remote 0 — e.g. Software Development Engineer II – Life Hub (Super App) (New Grad / Early Career) (Mountai; Software Engineer II, Developer Portal (New Grad / Early Career) (Mountain View, Californi |
| Mistral AI | ashby | `mistral.ai` | 2026-10-23 22:53 IST | total 223, tech 122, early 1, India/remote 46 — e.g. Applied AI, Forward Deployed Machine Learning Engineer - (Internship) (Paris) |
| Glean | greenhouse | `gleanwork` | 2026-10-23 22:53 IST | total 132, tech 59, early 1, India/remote 19 — e.g. Software Engineer, Intern (Summer 2027) (Mountain View, CA) |
| Tessera Labs | ashby | `tessera-labs` | 2026-10-23 22:53 IST | total 26, tech 11, early 1, India/remote 8 — e.g. Software Engineering Intern, Full Stack (San Jose Office (HQ)) |
| Parallel Wireless | lever | `parallelwireless` | 2026-10-23 22:53 IST | total 47, tech 31, early 1, India/remote 7 — e.g. PHY SW Engineer - 12 Month Internship (July 2027) (Bristol) |
| Signifyd | greenhouse | `signifyd95` | 2026-10-23 22:53 IST | total 15, tech 9, early 1, India/remote 6 — e.g. Engineering Intern (Belfast, Northern Ireland; ) |
| Decagon | ashby | `decagon` | 2026-10-23 22:53 IST | total 134, tech 56, early 1, India/remote 5 — e.g. Engineering Intern (Summer 2027) (San Francisco) |
| Chalk | ashby | `chalk` | 2026-10-23 22:53 IST | total 19, tech 16, early 1, India/remote 4 — e.g. Software Engineer - New Grad (SF) |
| Rhombus | lever | `rhombus-systems` | 2026-10-23 22:53 IST | total 7, tech 1, early 1, India/remote 0 — e.g. Software Engineering Intern - Summer 2027 (Sacramento, CA) |
| Steel | ashby | `steel` | 2026-10-23 22:53 IST | total 3, tech 1, early 1, India/remote 0 — e.g. Software Engineer Intern (Summer 2027) (Toronto) |
| Rothesay | greenhouse | `rothesaygraduates` | 2026-10-23 22:53 IST | total 7, tech 1, early 1, India/remote 0 — e.g. 2027 Summer Internship Programme - Software Engineering (London) |
| Courier Health | greenhouse | `courierhealth` | 2026-10-23 22:53 IST | total 20, tech 8, early 1, India/remote 0 — e.g. Software Engineering Intern (Summer 2027) (New York, New York, United States) |
| State Affairs | greenhouse | `stateaffairs` | 2026-10-23 22:53 IST | total 12, tech 4, early 1, India/remote 0 — e.g. Software Engineer Intern (Summer 2027) (Washington, DC) |
| Meow | ashby | `meow` | 2026-10-23 22:53 IST | total 6, tech 2, early 1, India/remote 0 — e.g. Software Engineer - December 2026 Graduates (New York City) |
| Headlands Technologies | greenhouse | `headlandstechnologiesllc` | 2026-10-23 22:53 IST | total 8, tech 4, early 1, India/remote 0 — e.g. C++ Software Developer - New Grad  (Amsterdam; Chicago) |
| Anthropic | greenhouse | `anthropic` | 2026-10-23 22:53 IST | total 680, tech 339, early 0, India/remote 52 — e.g. Anthropic Fellows Program, AI Safety & Security (London, UK; Ontario, CAN; Remote-Friendly; Anthropic Fellows Program, ML Systems & Reinforcement Learning (London, UK; Ontario, CAN; ; Applied AI Architect (Bangalore, India) |
| Baseten | ashby | `baseten` | 2026-10-23 22:53 IST | total 106, tech 51, early 0, India/remote 51 — e.g. Software Engineer - Dedicated Inference (San Francisco remote); Account Executive - AI Native (San Francisco remote); Forward Deployed Engineer (San Francisco remote) |
| Vanta | ashby | `vanta` | 2026-10-23 22:53 IST | total 84, tech 39, early 0, India/remote 36 — e.g. Senior Fullstack Software Engineer, GRC (Remote U.S. remote); Backend Senior Software Engineer, Identity (Remote U.S. remote); Senior Fullstack Software Engineer, Expansion (Remote U.S. remote) |
| Deepgram | ashby | `Deepgram` | 2026-10-23 22:53 IST | total 85, tech 40, early 0, India/remote 34 — e.g. Pre-Sales Solutions Engineer (EST or PST) (USA - Remote remote); Research Staff, Voice AI Foundations (USA - Remote remote); Research Staff, Voice AI Foundations - Remote (The Netherlands remote) |
| Temporal | ashby | `temporal` | 2026-10-23 22:53 IST | total 68, tech 33, early 0, India/remote 33 — e.g. Senior Developer Success Engineer - West (United States (Remote) remote); Staff Software Engineer, Open Source Server (United States (Remote) remote); Senior Software Engineer, Cloud Data Storage (United States (Remote) remote) |
| Fireworks AI | ashby | `fireworks` | 2026-10-23 22:53 IST | total 93, tech 30, early 0, India/remote 28 — e.g. Member of Technical Staff, AI Training Infrastructure (San Mateo remote); AI Deployment Strategist (San Mateo remote); Member of Technical Staff, Applied Machine Learning Engineer (San Mateo remote) |
| Kong | ashby | `kong` | 2026-10-23 22:53 IST | total 91, tech 37, early 0, India/remote 28 — e.g. Site Reliability Engineer 2 (Washington, United States remote); Staff Software Engineer, Identity and Access Management (Toronto, Canada remote); Software Engineer 2, Managed Gateways (Bangalore, India) |
| Render | ashby | `render` | 2026-10-23 22:53 IST | total 39, tech 27, early 0, India/remote 27 — e.g. Software Engineer, Product (all levels) (Remote: United States remote); Software Engineer, Security (all levels) (Remote: United States remote); Software Engineer, Infrastructure (all levels) (Remote: United States remote) |
| Fivetran | greenhouse | `fivetran` | 2026-10-23 22:53 IST | total 170, tech 71, early 0, India/remote 21 — e.g. Lead Sales Engineer, Enterprise (Remote, California, United States, AMER); Manager, Customer Support Engineering (Remote, Australia, APAC); Principal Software Engineer - Data Lakes (Remote, Germany, EMEA) |
| JumpCloud | lever | `jumpcloud` | 2026-10-23 22:53 IST | total 35, tech 19, early 0, India/remote 19 — e.g. Customer Support Engineer, Tier 1 (MacOS and MDM) - Mexico (Mexico City, Mexico - Remote); Customer Support Engineer, Tier 1 Windows - Mexico (Mexico City, Mexico - Remote); Customer Support Engineer, Tier 2 - Mexico (Mexico City, Mexico - Remote) |
| Luma AI | ashby | `lumaai` | 2026-10-23 22:53 IST | total 31, tech 19, early 0, India/remote 19 — e.g. Research Scientist / Engineer – Performance Optimization (Redwood City, CA remote); Research Scientist / Engineer – Reinforcement Learning Infrastructure (Redwood City, CA re; Research Scientist / Engineer – Training Infrastructure (Redwood City, CA remote) |
| WorkOS | ashby | `workos` | 2026-10-23 22:53 IST | total 28, tech 19, early 0, India/remote 19 — e.g. Infrastructure Engineer - SRE (United States & Canada remote); Engineering Leadership (San Francisco remote); Product Engineer - Enterprise (United States & Canada remote) |
| LaunchDarkly | greenhouse | `launchdarkly` | 2026-10-23 22:53 IST | total 53, tech 19, early 0, India/remote 16 — e.g. Backend Engineer (Multiple Positions) (Remote - US); Backend Software Engineer, SDK (Remote - US); Engineering Manager, Cloud Engineering (Remote - US) |
| Runway | ashby | `runway-ml` | 2026-10-23 22:53 IST | total 47, tech 16, early 0, India/remote 15 — e.g. Member of Technical Staff, Backend Engineer, API (Remote remote); Research Engineer, Data Foundations (Remote remote); AI Engagement Manager (New York, NY remote) |
| Sigmoid | greenhouse | `sigmoid` | 2026-10-23 22:53 IST | total 39, tech 16, early 0, India/remote 15 — e.g. Associate Lead Data Scientist (Bengaluru, Karnataka, India); Database Migration Engineer (Bengaluru, Karnataka, India); DataOps Architect/Lead (Bengaluru, Karnataka, India) |
| Keyloop | lever | `keyloop` | 2026-10-23 22:53 IST | total 66, tech 29, early 0, India/remote 13 — e.g. AI Enablement Engineer (India (Hyderabad)); Data Quality Specialist (India (Hyderabad)); Lead IBM i (AS/400) Infrastructure Design Engineer (India (Hyderabad)) |
| Zenoti | greenhouse | `zenoti` | 2026-10-23 22:53 IST | total 57, tech 12, early 0, India/remote 12 — e.g. Data Operator (Hyderabad, Telangana, India); Data Operator (Hyderabad, Telangana, India); Lead - AI Data Intelligence (ETL,Azure, SQL, Python, Spark, Data Lakehouse) 7 - 11 years e |
| Teleport | ashby | `goteleport` | 2026-10-23 22:53 IST | total 22, tech 12, early 0, India/remote 12 — e.g. Senior Field Engineer (United States (Remote) remote); Senior Backend Engineer (United States (Remote) remote); Senior Site Reliability Engineer - US (United States (Remote) remote) |
| Cognition | ashby | `cognition` | 2026-10-23 22:53 IST | total 105, tech 46, early 0, India/remote 11 — e.g. Forward Deployed Engineer - Europe (London remote); Partner Deployed Engineer - APAC (India remote); Forward Deployed Engineer - Federal (Washington DC remote) |
| Amplitude | ashby | `amplitude` | 2026-10-23 22:53 IST | total 40, tech 21, early 0, India/remote 11 — e.g. Senior Software Engineer (Query Infrastructure)  (San Francisco  remote); Staff Software Engineer  (Query Infrastructure) (San Francisco  remote); Staff Software Engineer - DevX (Remote-NAMER remote) |
| Safe Security | lever | `safe` | 2026-10-23 22:53 IST | total 20, tech 12, early 0, India/remote 10 — e.g. Engineering Manager (Bengaluru); Principal Engineer - AI (Bengaluru); SDE II - AI Platform (Bengaluru) |
| Character.AI | ashby | `character` | 2026-10-23 22:53 IST | total 13, tech 11, early 0, India/remote 10 — e.g. Machine Learning Infrastructure Engineer (Redwood City, CA remote); Research Engineer, Post-Training (All Industry Levels) (Redwood City or New York City remo; Software Engineer, Core Product (Redwood City, CA remote) |
| n8n | ashby | `n8n` | 2026-10-23 22:53 IST | total 41, tech 10, early 0, India/remote 10 — e.g. Sr Security Engineer / Remote / Europe (Berlin Office remote); Senior Product Engineer (TS/NodeJS/Vue) (Berlin Office remote); Senior Developer Advocate, US (United States remote) |
| Druva | greenhouse | `druva` | 2026-10-23 22:53 IST | total 31, tech 15, early 0, India/remote 10 — e.g. Sales Engineer (Pune, Maharashtra, India); Senior Staff Engineer, Product Security (Pune, Maharashtra, India); Senior Staff Software Engineer (Pune, Maharashtra, India) |
| Mindtickle | lever | `mindtickle` | 2026-10-23 22:53 IST | total 21, tech 7, early 0, India/remote 7 — e.g. AI Product Engineer (Pune, Maharashtra); Customer Success Engineer - II (Pune, Maharashtra); Lead Design Engineer (Pune, Maharashtra) |
| Sonatype | lever | `sonatype` | 2026-10-23 22:53 IST | total 12, tech 7, early 0, India/remote 7 — e.g. Java Product Support Engineer (Colombia - Remote); Senior Azure DevOps Engineer (Hyderabad); Senior Data Analyst (Canada - Remote) |
| 6sense | greenhouse | `6sense` | 2026-10-23 22:53 IST | total 27, tech 10, early 0, India/remote 7 — e.g. Data Research Specialist I (Bengaluru, Karnataka, India); Manager, Engineering (Bengaluru, Karnataka, India); Principal AI Architect, Agentic Platform (Bengaluru, Karnataka, India) |
| PlanetScale | greenhouse | `planetscale` | 2026-10-23 22:53 IST | total 12, tech 7, early 0, India/remote 4 — e.g. AI Developer Experience Engineer (Remote US ); Enterprise Support Engineer (Remote - NA, APAC, EMEA); Software Engineer - PlanetScale Postgres (Remote) |
| Mixpanel | greenhouse | `mixpanel` | 2026-10-23 22:53 IST | total 45, tech 17, early 0, India/remote 4 — e.g. Senior Customer Engineer - LATAM (Florida, US (Remote)); Senior Customer Engineer - LATAM (Remote, US (Remote)); Senior Customer Engineer - LATAM (Texas, US (Remote)) |
| Gushwork | lever | `gushwork` | 2026-10-23 22:53 IST | total 11, tech 3, early 0, India/remote 3 — e.g. Forward Deployed Engineer (Bengaluru); SDE 2/3 (Backend) (Bengaluru); SDE 2/3 (Full Stack) (Bengaluru) |
| Vapi | ashby | `vapi` | 2026-10-23 22:53 IST | total 6, tech 3, early 0, India/remote 3 — e.g. Solutions Engineer (San Francisco remote); Product Designer — AI UX / Product Experience (San Francisco remote); Member of Technical Staff, Agentic Developer Experience (San Francisco remote) |
| Meltplan | greenhouse | `meltplan` | 2026-10-23 22:53 IST | total 4, tech 3, early 0, India/remote 3 — e.g. AI Research Scientist -Computer Vision (Bengaluru, India); Senior Full Stack Engineer – Frontend Focused (Bengaluru, India); UI Engineering Lead  (Bengaluru, India) |
| Apollo GraphQL | ashby | `apollo-graphql` | 2026-10-23 22:53 IST | total 9, tech 3, early 0, India/remote 3 — e.g. Staff Software Engineer, Rust (United States or Canada (remote) remote); Senior Solution Engineer (Pre-sales) (United States (remote)); Staff Software Engineer - Trust and Telemetry (United States or Canada (remote) remote) |
| Snyk | ashby | `Snyk` | 2026-10-23 22:53 IST | total 33, tech 4, early 0, India/remote 3 — e.g. Senior Product Security Engineer (United States - Boston Office remote); Senior Solutions Engineer (French Speaking) (United Kingdom - London Office remote); Professional Services Engineer (United States - MA Remote remote) |
| Axiad | greenhouse | `axiad` | 2026-10-23 22:53 IST | total 8, tech 4, early 0, India/remote 3 — e.g. AI-First Golang Developer (Microservices, PostgreSQL) (Hyderabad, Telangana, India); GO Developers (Contractors) (Hyderabad, Telangana, India); Senior QA Automation Engineer (Hyderabad, Telangana, India) |
| bswift India | greenhouse | `bswiftindia` | 2026-10-23 22:53 IST | total 4, tech 3, early 0, India/remote 3 — e.g. Database Administrator (Bangalore, India); Software Engineer  (Bangalore, India); Software Engineer   (Bangalore, India) |
| Get Well Network | greenhouse | `getwellnetwork` | 2026-10-23 22:53 IST | total 3, tech 3, early 0, India/remote 3 — e.g. Senior AI QA Engineer (Bengaluru, Karnataka, India); Staff AI Engineer (Bangalore); Staff AI Engineer (Bangalore, Karnataka) |
| ValGenesis | lever | `valgenesis` | 2026-10-23 22:53 IST | total 10, tech 9, early 0, India/remote 2 — e.g. Senior Software Engineer, Full-stack (Hyderabad); Software Engineer, Fullstack (Hyderabad) |
| Suno | ashby | `suno` | 2026-10-23 22:53 IST | total 69, tech 41, early 0, India/remote 2 — e.g. Motion Designer, Paid Social (Contract) (Remote remote); Senior / Staff Full-Stack AI Engineer (San Francisco remote) |
| Sourcegraph | greenhouse | `sourcegraph91` | 2026-10-23 22:53 IST | total 8, tech 2, early 0, India/remote 2 — e.g. ML & Agentic Systems Engineer [IC4] (Remote); Software Engineer - Platform [IC3] (Remote) |
| Zapier | ashby | `zapier` | 2026-10-23 22:53 IST | total 12, tech 2, early 0, India/remote 2 — e.g. Sr. Engineer, Database Reliability (NAMER remote); Sr. Engineer, Infrastructure Security (NAMER remote) |
| Observe.AI | greenhouse | `observeai` | 2026-10-23 22:53 IST | total 9, tech 4, early 0, India/remote 2 — e.g. AI Agent Engineer (Hyderabad, Telangana, India); Staff Infrastructure Security Engineer (Bengaluru) |
| Atlan | ashby | `atlan` | 2026-10-23 22:53 IST | total 6, tech 3, early 0, India/remote 2 — e.g. Principal Software Engineer - Agent & App Platform (India remote); Staff Software Engineer - Infrastructure (AI Native) (India remote) |
| Whoop | ashby | `whoop` | 2026-10-23 22:53 IST | total 169, tech 86, early 0, India/remote 1 — e.g. Retail Account Manager, AUS/NZ (Australia  remote) |
| Cartesia | ashby | `cartesia` | 2026-10-23 22:53 IST | total 23, tech 9, early 0, India/remote 1 — e.g. Product Support Engineer, India (Bangalore) |
| AssemblyAI | greenhouse | `assemblyai` | 2026-10-23 22:53 IST | total 15, tech 9, early 0, India/remote 1 — e.g. Senior GTM AI Engineer (Remote - North America) |
| Netlify | greenhouse | `netlify` | 2026-10-23 22:53 IST | total 5, tech 1, early 0, India/remote 1 — e.g. Senior Staff Data Scientist (Remote) |
| Clerk | ashby | `Clerk` | 2026-10-23 22:53 IST | total 2, tech 1, early 0, India/remote 1 — e.g. GRC Engineer (Remote remote) |
| Suki | greenhouse | `suki` | 2026-10-23 22:53 IST | total 9, tech 3, early 0, India/remote 1 — e.g. IT engineer (Bengaluru ) |
| Capstone Investment Advisors | greenhouse | `capstoneinvestmentadvisors` | 2026-10-23 22:53 IST | total 14, tech 4, early 0, India/remote 0 |
| Imbue | greenhouse | `imbue` | 2026-10-23 22:53 IST | total 2, tech 1, early 0, India/remote 0 |
| Browserbase | greenhouse | `browserbaseinc` | 2026-10-23 22:53 IST | total 11, tech 5, early 0, India/remote 0 |
| E2B | ashby | `e2b` | 2026-10-23 22:53 IST | total 14, tech 8, early 0, India/remote 0 |
| Magic.dev | ashby | `magic.dev` | 2026-10-23 22:53 IST | total 7, tech 3, early 0, India/remote 0 |
| Buildkite | greenhouse | `buildkite` | 2026-10-23 22:53 IST | total 7, tech 5, early 0, India/remote 0 |

Reading the ranking honestly: direct early-career+remote hits cluster at the top
(Skydio, 1Password, Amplify, Harvey, Cerebras, Quora, Cohere, Sentry — several
with Summer/Winter 2027 intakes, Sierra and Vercel with Summer 2027 interns, and
Astera Labs' dedicated `asteraearlycareer2027` board). Most US "remote" intern
rows carry a US/Canada work-authorization caveat — the probe counts location
text, not visa eligibility; the screener owns that judgment. The India-located
supply is mostly mid-level (Hevo's SDE Intern/Associate SDE in Bengaluru is the
best true-junior India hit; Keyloop/Sigmoid/ValGenesis/JumpCloud/Zenoti/Druva
carry steady Hyderabad/Bengaluru/Pune volume). Tail rows with 0 early and 0
India/remote matches today (e.g. Capstone, Imbue, Browserbase, E2B, Magic.dev,
Buildkite) are still verified-pollable; boards change, and polling is cheap —
drop them only if scout runtime becomes a cost.

## Seed

`supabase/snippets/2026-10-23-seed-watchlist-expansion.sql` — additive-only
(no purge, unlike the 09-18 seed, to avoid racing half A), idempotent via
`on conflict (user_id, ats_provider, board_token) do update`, aborts if the
account row is missing, reports the written count. **Execution belongs to the
orchestrator after Teja's approval — never run from a peer session.**

## Rejected — confirmed on an unsupported ATS (adapter-gap evidence)

| company | actual ATS |
|---|---|
| Datadog, Retool, Hasura/PromptQL, Groq | Gem |
| Statsig, RudderStack | Rippling |
| BrowserStack, Uniphore, Chronosphere, Mintlify | Workday |
| Innovaccer | Workable |
| MoEngage | Trakstar |
| CleverTap | Kula |
| Whatfix | Recruiterbox |
| Weights & Biases | folded into CoreWeave careers |
| Replicate | acquired by Cloudflare (already watched) |
| ElevenLabs, Temporal*, Fly.io, Sarvam AI, Fold Money, Juspay, Chargebee, Atomicwork, Postman | own/custom careers flow, no pollable board |

*Temporal's own site hides the ATS but its job detail pages embed
`jobs.ashbyhq.com/temporal` — it IS in the verified table; the reject note is
about its careers index only.

Adapter ruling input: Gem (4 companies) and Workday (4) are the biggest
unsupported clusters in this sweep — still well short of a majority, so no
stop-and-report was triggered; the 3 supported providers covered 103 new boards.

## Unresolved — right provider seen, token only injected by JS (retry with a headless render)

Redpanda (ashby), CircleCI (greenhouse), Pulumi (greenhouse), Airbyte /
Astronomer / Prefect (ashby), Aiven (greenhouse **EU** — note
`boards.eu.greenhouse.io` is a host the adapter may not cover), Stytch
(greenhouse via widget), Scale AI careers page (JS; token `scaleai` was still
recovered from posting URLs and IS verified above), xAI (403), Grafana Labs,
Docker (bot-blocked), Tower Research (Gurgaon roles exist; lever token guess
404'd — needs a browser), plus ~15 India scaleups (InMobi, Thoughtspot, Tekion,
Rippling, Harness, HackerRank, Zepto, Dream11, CoinDCX, Jupiter, Fi, Urban
Company, DevRev, Rubrik, Capillary).

## Headless pass (2026-10-24) — the ~25 JS-unresolved companies, resolved

Method: same bar as above, plus a headless render step. Candidate tokens were
read by 4 recon subagents driving a Playwright headless Chromium (scratch
script `render-board.mjs`, session scratchpad; `worker/node_modules/playwright`
imported by absolute file URL — ESM ignores NODE_PATH) over each company's own
careers page, with a network sniffer recording the ATS API calls the page
itself makes (`net` = strongest evidence; name-derived guesses stayed banned).
Every candidate was then verified centrally on 2026-10-24 ~00:30 IST by one
read-only GET per board, 1 req/s/host, PASS = HTTP 200 + provider JSON shape +
>0 postings + identity check (greenhouse `/v1/boards/{t}` display name; ashby
has no name field, so sample titles + description text were matched to the
company). Gate proven non-vacuous: garbage token `zz-no-such-board-xx` FAILED
with HTTP 404 in the same run.

**Verified pollable: 14 of 25 targeted** (counts point-in-time, same column
definitions as the half-B table).

| company | provider | board_token | verdict (2026-10-24 ~00:30 IST) |
|---|---|---|---|
| xAI | greenhouse | `xai` | PASS — total 298, tech 137, early 4, India/remote 11; e.g. Spring 2027 Software Engineering Internship/Co-op (Palo Alto, CA). Evidence: x.ai/careers itself links boards.greenhouse.io/xai. NOTE: the board's display name reads "SpaceXSI" (shared Musk-co recruiting tooling, roles are unmistakably xAI's — AI Tutor, Palo Alto SWE intern) |
| Tower Research Capital | greenhouse | `towerresearchcapital` | PASS — total 100, tech 74, early 19, India/remote 0 (Gurgaon + Montreal new-grad/intern rows; location regex misses "Gurgaon", screener will see them). Net-sniffed from tower-research.com/open-positions; the old lever guess was the wrong PROVIDER, not just the wrong token |
| HackerRank | greenhouse | `hackerrank` | PASS — total 30, tech 18, early 2, India/remote 14; e.g. Software Development Engineer Intern (Onsite in Bangalore) |
| DevRev | greenhouse | `devrev` | PASS — total 42, tech 20, early 1, India/remote 11; e.g. Junior Forward Deployed Engineer |
| Grafana Labs | greenhouse | `grafanalabs` | PASS — total 133, tech 72, early 0, India/remote 72 (remote-heavy, no early rows today) |
| Harness | greenhouse | `harnessinc` | PASS — total 67, tech 33, early 0, India/remote 17. Token is `harnessinc`, NOT `harness` — net-sniffed from harness.io/company/jobs |
| InMobi | greenhouse | `inmobi` | PASS — total 82, tech 11, early 1, India/remote 6 (Bangalore/Bengaluru rows) |
| CircleCI | greenhouse | `circleci` | PASS — total 13, tech 6, early 0, India/remote 5. Careers index is SSR — only individual posting pages load the greenhouse embed; render postings, not indexes |
| Pulumi | greenhouse | `pulumicorporation` | PASS — total 4, tech 1, early 0, India/remote 0. Token is `pulumicorporation`, not `pulumi` |
| Tekion | ashby | `tekion` | PASS — total 93, tech 52, early 0, India/remote 41 (Bangalore HQ volume) |
| Docker | ashby | `docker` | PASS — total 67, tech 32, early 0, India/remote 0 US/EU-titled. docker.com itself was unreachable from this host (timeout + cert mismatch, network-level); token came from an aggregator lead, so identity was checked harder: sample titles (Staff Backend Engineer, Hub; Senior Software Engineer, Secure Build) + description text name Docker Inc |
| Astronomer | ashby | `astronomer` | PASS — total 18, tech 11, early 0, India/remote 1 (Hyderabad CRE). Token via server 302: their own apply links redirect to jobs.ashbyhq.com/astronomer |
| Airbyte | ashby | `airbyte` | PASS — total 13, tech 7, early 0, India/remote 0 |
| Prefect | ashby | `prefect` | PASS — total 8, tech 6, early 0, India/remote 5 |

**Not seeded, with reasons** (each re-checkable by the same probe):

| company | verdict |
|---|---|
| Rubrik | already live in the watchlist as greenhouse `rubrik` (seeded earlier tonight) — dedupe, nothing to add |
| Fi (Epifi) | lever `epifi` is a VALID board (200, correct shape) but 0 postings on 2026-10-24 — fails the >0 bar; cheap to re-probe later |
| Dream11 | their dreamsports.group/careers page links jobs.lever.co/dreamsports, but both the API and the hosted page 404 — stale link, board removed |
| Redpanda | own careers page net-calls boards-api.greenhouse.io/v1/boards/redpandadata/departments and gets 404 — broken/stale embed, board gone |
| PhonePe | re-probed as directed: greenhouse `phonepe` still 404, and headless renders of both careers pages show zero big-3 references — has not returned |
| Aiven | greenhouse EU confirmed (posting pages embed #grnhse_app and call boards.eu.greenhouse.io) but token unprovable: boards-api.eu.greenhouse.io does not resolve (curl 000), boards.eu/job-boards.eu 404 the /v1 path, and main-host `aiven` is 404 — the adapter only polls boards-api.greenhouse.io, so this is an ADAPTER GAP (EU greenhouse host), not a token problem |

**Confirmed rejects (adapter-gap / no-board evidence):** Thoughtspot (Rippling
ATS, single-source), Rippling (dogfoods its own ATS), Jupiter (Keka, tenant
`jupiter`), Stytch (careers 307s into jobs.twilio.com — Eightfold front over
Twilio's greenhouse; no Stytch board exists post-acquisition), Zepto (no big-3
signal; aggregators disagree on BambooHR vs TalentRecruit).

**Still unresolved:** CoinDCX (careers redirects to about-us; hires via
aggregators), Urban Company (careers SPA makes no big-3 calls — likely
in-house portal), Capillary Technologies (renders no big-3 calls, direct fetch
403, ATS unidentified).

Seed: `supabase/snippets/2026-10-24-seed-watchlist-headless-pass.sql` (+14,
additive, same on-conflict pattern as half B). Execution belongs to the
orchestrator after Teja's approval — never run from a peer session.

Tooling lessons recorded for the next sweep: careers INDEX pages on SSR sites
sniff nothing — render an individual posting URL first; and the sniffer's
token regexes must include `boards.eu.greenhouse.io` hosts to resolve
EU-greenhouse tenants in one run.

## Deliberate exclusions

- ITAR / US-person-only defense & space boards (SpaceX, Anduril, Shield AI,
  Inversion, Mach, True Anomaly): tokens were verified but an India-based 2027
  grad cannot take the roles — polling them would only feed the screener noise.
- Windsurf: same Ashby board as Cognition (`cognition`) — one entry, not two.
- Dagster: careers 308-redirect into Prefect — not a separate board.
