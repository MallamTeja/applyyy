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
* **Web Test Suite (`apps/web`):** 182 / 182 tests passing (956ms).
* **Worker Unit Suite (`worker`):** 116 / 116 tests passing across 16 test files (26.1s).
* **Workspace Typecheck:** Zero TypeScript errors (`tsc --noEmit` clean on both `web` and `worker`).
* **Vite Production Build:** Compiles cleanly to `apps/web/dist` with asset gzip optimization.

---

## 3. Current Pending Works & Next Steps

### Critical Action Items (Immediate)

1. **GitHub Actions Secrets Configuration:**
   * **State:** Workflows are committed to `.github/workflows/apply.yml` (daily at 02:30 UTC / 08:00 AM IST) and `.github/workflows/keepalive.yml` (every 3 days).
   * **Action Needed:** Add the following repository secrets under GitHub Repository `Settings > Secrets and variables > Actions`:
     * `SUPABASE_URL`: `https://xynqxekcqizwhtskzqrq.supabase.co`
     * `SUPABASE_ANON_KEY`: Your project's anon key
     * `APPLYY_APP_USER_EMAIL`: `tejamallam00@gmail.com`
     * `APPLYY_APP_USER_PASSWORD`: Password created for the Supabase Auth user
     * `STORAGE_STATE_ENC_KEY`: 32-byte hex key for encrypted browser cookies

2. **Supabase Database Seeding (Gemini API Keys):**
   * **State:** The remote Supabase instance has all 7 migrations applied.
   * **Action Needed:** Populate `public.gemini_key_state` with the 6 Gemini API keys from `.env` so `claim_gemini_key()` can distribute quotas to the Tailor, Auditor, and Classifier agents.

3. **Human Recovery Lane Controls:**
   * **State:** Console surfaces system notice for 8 unbuilt recovery transitions originating from `applying`, `needs_verification`, `blocked_needs_human`, and `failed`.
   * **Action Needed:** Implement dedicated operator recovery actions (e.g., "Retry Application", "Mark Abandoned", "Manual Override") in `HealthPage.tsx`.

4. **Production Deployment on Vercel:**
   * **State:** Frontend compiles locally and works with `.env.local`.
   * **Action Needed:** Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in Vercel project environment variables and trigger redeploy.

---

## 4. Verification Commands Quick-Reference

| Task | Command |
|---|---|
| **Run E2E Suite** | `pnpm --filter @applyy/worker run test:e2e` |
| **Run Worker Unit Tests** | `pnpm --filter @applyy/worker test` |
| **Run Web Unit Tests** | `pnpm --filter web test` |
| **Typecheck Full Repo** | `pnpm --filter web typecheck && pnpm --filter @applyy/worker typecheck` |
| **Build Web Bundle** | `pnpm --filter web build` |
| **Start Web Dev Console** | `pnpm --filter web dev` |
