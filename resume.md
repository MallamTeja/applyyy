# `applyy` — Project Status, Completed Works & Pending Roadmap

**Document Location:** `resume.md` (Project Root)  
**Last Updated:** 2026-09-11 22:36 IST  
**Target Operator:** Mallam Teja (`tejamallam00@gmail.com`)  
**Repository:** `https://github.com/MallamTeja/applyyy` (Branch: `main`)

---

## 1. Executive Summary

`applyy` is an autonomous, budget-conscious job application system designed to discover, tailor, audit, and submit high-quality applications to targeted ATS job boards (Greenhouse, Lever, Ashby, Workable, SmartRecruiters) under strict human-in-the-loop oversight and Postgres Row Level Security (RLS).

All core frontend, backend database schemas, worker automation pipelines, and end-to-end Playwright testing suites are fully integrated, verified, and pushed to `origin/main` (commit `b54ea16`).

---

## 2. Works Done (Completed & Verified)

### A. Web Console & Operator Experience
1. **Interactive Company Watchlist CRUD (`apps/web/src/features/settings/WatchlistPage.tsx`):**
   * Real-time CRUD backed directly by Supabase `public.company_watchlist`.
   * Dynamic **Add Board** form with token extraction hints per ATS (`greenhouse`, `lever`, `ashby`, `workable`, `smartrecruiters`).
   * Overview KPI cards: Target Boards, Active Polling, and Historical Poll Count.
   * Row actions: Instant **Enable / Pause** toggles and **Remove** controls.
   * Real DB verification: Stripe Greenhouse board live in database (`b24bbfcc-0a12-4266-a09e-2ed7fa18ed24`).

2. **Zero Mock Data in Web Console:**
   * Fully decoupled `apps/web/src/features/approval/ApprovalQueuePage.tsx` from synthetic fixtures (`approvalQueueFixture`, Zomato/Swiggy mocks).
   * Console screens strictly query real Supabase tables scoped by Postgres RLS: `(select auth.uid()) = user_id`.
   * Transparent empty states render when no live applications are in queue.

3. **Master Profile Intake & Review Surface (`apps/web/src/features/settings/MasterProfilePage.tsx`):**
   * Browser-side PDF extraction of root `master-resume.pdf` using PDF.js.
   * Section breakdown for Work Experience, Projects, Education, and Skills.
   * ATS match comparison against Job Descriptions with keyword chip overlays.

4. **Email Intake & Interview Lead Monitoring (`apps/web/src/features/emails/EmailMonitoringPage.tsx`):**
   * Strict heuristic and classification filter: isolates interview invitations, screening calls, and technical rounds while disqualifying generic newsletters, Google alerts, and LinkedIn notifications.
   * Direct **"Open in Gmail"** deep-links (`https://mail.google.com/mail/u/0/#search/rfc822msgid:${id}`).
   * Summary KPI metrics: Total Interview Invitations, Linked Applications, Direct Inbound Leads.

5. **Typography & UI Polish:**
   * Modernized font tokens in `tokens.css`: `IBM Plex Sans` (machine UI), `IBM Plex Serif` (resume paper prose), and `IBM Plex Mono` (identifiers, tokens, hashes).
   * Balanced line height (`1.55`), tight heading tracking (`-0.018em`), and tabular numeric figures (`font-variant-numeric: tabular-nums`) for identifiers and metrics.
   * Light/Dark theme switching with persistent localStorage hydration.

### B. Worker Automation & ATS Pipeline
1. **Headless Playwright Runner (`worker/`):**
   * Greenhouse and Lever form field extractors and fill planners.
   * Deterministic resume attachment via browser-side PDF generation.
   * Strict `DRY_RUN` safety guard: screenshots and fills fields, but refuses submission unless explicitly opted out (`submission-mode.ts`).

2. **Playwright End-to-End Test Suite (`worker/test/e2e-runner.mjs`):**
   * Automated 7-stage end-to-end verification passing at 100%:
     1. Root `master-resume.pdf` text extraction & ATS readability (5,295 chars, candidate name `Mallam Teja`, Aczen Technologies, One-on-One, skills).
     2. Unauthenticated operator login gatekeeper and pre-filled email validation.
     3. Approval queue zero-mock invariant verification.
     4. Interactive Company Watchlist CRUD form & stats rendering.
     5. Master profile intake and review surface.
     6. Email monitoring dashboard & refresh controls.
     7. Typography tokens (`IBM Plex Sans`) & theme toggle execution.

### C. Test & Quality Convergence
* **Functions Test Suite (`supabase/functions`):** 273 / 273 tests passing (1.4s) — covering kill switch, key pool rotation, ATS adapters, LinkedIn post parsing, and tailoring audit.
* **Web Test Suite (`apps/web`):** 207 / 207 tests passing across 7 suites (1.7s) — covering human lane graph coverage, master profile intake, tokens, themes, and RLS guards.
* **Worker Unit Suite (`worker`):** 116 / 116 tests passing across 16 test files (26.1s).
* **Workspace Typecheck:** Zero TypeScript errors (`tsc --noEmit` clean on all packages).
* **Vite Production Build:** Compiles cleanly to `apps/web/dist` with asset gzip optimization.
* **Total Automated Tests:** 596 / 596 passing (100% green).

---

## 3. Current Completed Works & Operational State

### Completed Infrastructure & Feature Items ✅

1. **GitHub Actions Secrets Configuration & Live Execution:**
   * **State:** Configured under GitHub Repository `Settings > Secrets and variables > Actions`.
   * **Secrets Live:** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `APPLYY_APP_USER_EMAIL`, `APPLYY_APP_USER_PASSWORD`, `STORAGE_STATE_ENC_KEY`.
   * **Live Verification Confirmed:**
     * `applyy keepalive` (Runs `34635276043`, `34635940759`): **PASSED ✅** (Supabase pinged, idle-pause reset).
     * `applyy applier (daily batch)` (Runs `34635284619`, `34635944614`): **PASSED ✅** (Chromium installed, kill switch checked, dry-run executed safely).

2. **Supabase Database Seeding (Gemini API Keys & User Defaults):**
   * **State:** Successfully seeded on live remote Supabase instance for operator `0f4b24da-e85b-40bb-8606-c81824493b45` (`tejamallam00@gmail.com`).
   * **Tables Seeded:**
     * `public.system_settings`: 1 row (`system_enabled: false`, `dry_run: true`).
     * `public.search_preferences`: 1 row.
     * `public.gemini_key_state`: 6 keys initialized (`key_index` 1–6, `requests_today: 0`).
     * `public.filter_rules`: 9 cascade rules initialized with default configurations.

3. **Production Deployment on Vercel:**
   * **State:** Verified active via Vercel CLI across `Production`, `Preview`, and `Development` environments.
   * **Variables Configured:** `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

4. **Human Recovery Lane Controls & Graph Coverage (`HealthPage.tsx`):**
   * **State:** **COMPLETED & VERIFIED ✅** (Commit `a811841`).
   * **Panels Added:**
     * `StuckSubmissionQueuePanel` (`applying` &rarr; `needs_verification`).
     * `NeedsVerificationQueuePanel` (`needs_verification` &rarr; `applied`, `approved`, `failed`).
     * `BlockedQueuePanel` (`blocked_needs_human` &rarr; `applied`, `dropped_filter`, `failed`).
     * `FailedRowsPanel` (`failed` &rarr; `needs_verification`).
   * **Graph Invariant:** `UNBUILT_HUMAN_CONTROLS = 0`. All 31 human-reachable transitions now have dedicated affordance panels and controls.

5. **Edge Function Deployments on Supabase Remote:**
   * **Functions Live:** `email-tracker-intake` (v5, `verify_jwt: false`), `rls-proof` (v9).

---

## 4. Verification Commands Quick-Reference

| Task | Command |
|---|---|
| **Run All Tests (Repo-wide)** | `pnpm test` (596 tests: 273 functions + 207 web + 116 worker) |
| **Run Functions Unit Tests** | `pnpm run test:functions` |
| **Run Web Unit Tests** | `pnpm --filter web test` |
| **Run Worker Unit Tests** | `pnpm --filter @applyy/worker test` |
| **Run Playwright E2E Suite** | `pnpm --filter @applyy/worker run test:e2e` |
| **Typecheck Full Repo** | `pnpm run typecheck` |
| **Build Web Bundle** | `pnpm --filter web build` |
| **Deploy Functions** | `npx supabase functions deploy <slug>` |

