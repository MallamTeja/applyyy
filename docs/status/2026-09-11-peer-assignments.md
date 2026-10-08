> **Historical record as of 2026-09-11.** Current state: [SYSTEM_ARCHITECTURE.md](../SYSTEM_ARCHITECTURE.md) · [PROGRESS.md](../PROGRESS.md).

# Orchestrator Peer Session Assignments & Status Registry

**Dispatched by:** Orchestrator (Autonomous Command Desk)  
**Execution Directives:** Enforced via `GEMINI.md` utilizing **Loop Engineering**, **Prompt Engineering**, and **Context Engineering**.

---

## 1. Executive Status: Completed vs. Pending Tasks

### Completed Tasks ✅
1. **GEMINI.md Protocol Standard:** Updated both project and global `GEMINI.md` to mandate Loop Engineering, Prompt Engineering, and Context Engineering across the orchestrator and all peers.
2. **Email Setup & Intake Verification:**
   - Supabase Edge Function `email-tracker-intake` deployed with `--no-verify-jwt`.
   - Secret `EMAIL_INTAKE_SHARED_SECRET` configured in Supabase.
   - **Live End-to-End Verification Confirmed:** Live test POST payload verified via PowerShell with `X-Applyy-Intake-Secret` header:
     - Run 1: `accepted: 1, duplicates: 0, rejected: 0` (HTTP 202 Accepted, inserted into `email_events`).
     - Run 2: `accepted: 0, duplicates: 1, rejected: 0` (Idempotent deduplication verified).
3. **Design System & Dark Theme Modernization:** Overhauled `tokens.css` to Obsidian/Midnight elevations (`#090a0f`, `#11141c`, `#181c26`) with Electric Indigo accent (`#6366f1`). Verified clean (174/174 web tests pass, pushed to `origin/main` commit `1c25e87`).
4. **Operator Authentication & Strict Per-User Dynamic Isolation:**
   - Implemented `useAuth.ts` reactive session hook and `LoginPage.tsx` / `LoginPage.css`.
   - Default operator email `tejamallam00@gmail.com`.
   - Database RLS strictly enforced on all tables `(select auth.uid()) = user_id`.
   - Added `auth.test.ts`; all 182/182 web tests pass and `pnpm --filter web build` passes cleanly.
5. **Master PDF Extractor Math (Peer 1):**
   - Coordinate gap spacing and delimiter stripping resolved.
   - 22/22 tests passing in `@applyy/master-pdf`.
6. **Tailor & Schema Contracts:** Validator suite passing 266/266 tests.
7. **Worker / Playwright Automation:** ATS parse checks and form filler passing 116/116 tests.

---

### Pending Tasks 🟡
1. **Email Monitoring Section in Web Console (Peer 3):**
   - Dedicated "Email Monitoring" page (`/emails`) showing live stream of recruiter emails from `email_events`, classified categories (acknowledgement, interview, rejection), confidence, and matching applications.
2. **Master Resume PDF Ingest & Review UI (Peer 3):**
   - Connect `<input type="file" accept=".pdf">` in `MasterUploadReview.tsx` to `extractPdf()` and reconcile against existing profile in `masterStore.ts`.
3. **Runtime Edge Functions (Peer 2):**
   - Deploy and wire `screener`, `normalizer`, and `scout-ats` entrypoints in `supabase/functions/`.
4. **Git Pathspec Gated Commits & Push:**
   - Commit and push landed parcels across Peers 1, 3, and 4.

---

## 2. Peer Task Directives (Loop, Prompt & Context Engineered)

### Peer 1: `peer-pdf` (Parser Convergence & Pathspec Landing)
- **Loop Engineering:**
  - Cycle: Verify 22/22 tests $\rightarrow$ Typecheck $\rightarrow$ Pathspec Commit.
  - Convergence Gate: `pnpm --filter @applyy/master-pdf test` exits 0 with 22 passed.
- **Prompt Engineering:**
  - Role: PDF text layer extraction specialist.
  - Negative Constraints: Do NOT modify files outside `packages/master-pdf/**`. Do NOT add external dependencies to `package.json`.
- **Context Engineering:**
  - Files: `packages/master-pdf/src/layout.ts`, `packages/master-pdf/src/links.ts`, `packages/master-pdf/test/**`.
  - Action: Commit and push:
    ```bash
    git add packages/master-pdf/src/ packages/master-pdf/test/
    git commit -m "feat(master-pdf): fix band gap spacing and link trailing delimiters" -- packages/master-pdf/
    git push origin main
    ```

---

### Peer 3: `peer-web` (Email Monitoring Page & Master Resume Upload)
- **Loop Engineering:**
  - Cycle: Implement `/emails` monitoring route $\rightarrow$ Wire `MasterUploadReview.tsx` $\rightarrow$ Run `pnpm --filter web test` $\rightarrow$ Run `pnpm --filter web build`.
  - Convergence Gate: Zero TypeScript errors, 182+ web tests passing, Vite production build succeeds.
- **Prompt Engineering:**
  - Role: Web Frontend & Operator Experience Engineer.
  - Negative Constraints: Do NOT bypass Postgres RLS. All reads to `email_events` must be bound by authenticated session. Zero server uploads of unapproved PDFs.
- **Context Engineering:**
  - Files:
    - `apps/web/src/app/routes.ts`: Add `emails` route under `OPERATIONS_SECTION`.
    - `apps/web/src/features/emails/EmailMonitoringPage.tsx` & `EmailMonitoringPage.css`: Table/cards displaying `provider_message_id`, `from_address`, `subject`, `snippet`, `detected_category`, `received_at`.
    - `apps/web/src/features/settings/MasterUploadReview.tsx`: Finalize client-side PDF intake.
  - Action: Commit and push:
    ```bash
    git add apps/web/src/features/emails/ apps/web/src/features/settings/ apps/web/src/app/routes.ts
    git commit -m "feat(web): add email monitoring section and master resume upload" -- apps/web/
    git push origin main
    ```

---

### Peer 4: `peer-auth` (Authentication Verification & Pathspec Landing)
- **Loop Engineering:**
  - Cycle: Verify auth state $\rightarrow$ Run 182 web tests $\rightarrow$ Pathspec Commit.
  - Convergence Gate: `auth.test.ts` passes; `LoginPage.tsx` renders clean dark cards.
- **Prompt Engineering:**
  - Role: Security & Identity Guardian.
  - Negative Constraints: Never expose service role key to frontend bundle. Never allow unauthenticated data bleed.
- **Context Engineering:**
  - Files: `apps/web/src/data/useAuth.ts`, `apps/web/src/features/auth/**`, `apps/web/src/app/AppShell.*`, `apps/web/test/auth.test.ts`.
  - Action: Commit and push:
    ```bash
    git add apps/web/src/features/auth/ apps/web/src/app/ apps/web/src/data/useAuth.ts apps/web/test/auth.test.ts apps/web/src/data/supabase.ts
    git commit -m "feat(web): operator authentication, login page, and dynamic per-user rls isolation" -- apps/web/
    git push origin main
    ```
