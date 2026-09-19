# `applyyy` — System Architecture & 17-Agent Topology

## 1. System Overview

`applyyy` is an autonomous multi-agent job application automation system built on Node.js/TypeScript, Supabase Edge Functions (Deno), Postgres with Row Level Security (RLS), and a GitHub Actions + Playwright browser worker.

State orchestration uses **Database-as-Queue** with lease-based claiming (`claimed_at`, `claimed_by`). The `applications.status` column forms a strict, trigger-enforced directed status graph.

---

## 2. Complete 17-Agent Roster & Wiring Matrix

### Pipeline 1: Discovery & Filter Gate

#### 1. Scout-ATS Agent
- **Location**: `supabase/functions/scout-ats/index.ts` & `worker/src/cli/scout.ts`
- **Inputs**: `company_watchlist` table (Greenhouse, Lever, Ashby, Workable, SmartRecruiters board tokens).
- **Outputs**: Inserts raw job rows into `jobs` table; seeds initial `applications` at status `discovered`.
- **UI Connection**: `DiscoveredJobsPage.tsx` displays discovered jobs with ATS source badges; `DiscoveryModal.tsx` triggers manual board scans.

#### 2. Scout-Aggregator Agent
- **Location**: `supabase/functions/_shared/scout/adapters/adzuna.ts`, `jooble.ts`
- **Inputs**: Adzuna & Jooble developer APIs.
- **Outputs**: Inserts tech postings into `jobs` with `discovery_source = ['adzuna']` or `['jooble']`.
- **UI Connection**: `DiscoveredJobsPage.tsx` filters by discovery source.

#### 3. Normalizer Agent
- **Location**: `supabase/functions/normalizer/index.ts` & `_shared/normalize/`
- **Inputs**: `jobs` rows at status `discovered`.
- **Outputs**: Generates SHA-256 fingerprint (`company + title + location`). Refuses duplicates via `UNIQUE(user_id, fingerprint)`. Advances status `discovered -> deduped` (or `dropped_duplicate`).
- **UI Connection**: `DiscoveredJobsPage.tsx` badge displays deduplicated state.

#### 4. Screener Agent
- **Location**: `supabase/functions/screener/index.ts` & `_shared/filter/`
- **Inputs**: `applications` at `deduped`, `filter_rules` table.
- **Outputs**: **0 LLM Cost Filter Gate**. Evaluates title blocklist (Senior/Staff/Lead), location allowlist, experience ceiling, and per-company weekly cap (max 2/week). Advances `deduped -> passed_filters` or `dropped_filter`.
- **UI Connection**: `FiltersPage.tsx` configures rules & thresholds; `DiscoveredJobsPage.tsx` shows dropped reasons.

---

### Pipeline 2: Scoring, Tailoring & Security Audit

#### 5. Matcher Agent
- **Location**: `supabase/functions/matcher/index.ts` & `_shared/match/`
- **Inputs**: `applications` at `passed_filters`, `master_profiles` table.
- **Outputs**: Gemini AI scoring pool calculates fit score & reasoning. Boosts postings $<24\text{h}$ old (`freshness.ts`). Advances `passed_filters -> scored`.
- **UI Connection**: Match score pills on pipeline cards & diff view.

#### 6. Tailor Agent
- **Location**: `supabase/functions/tailor/index.ts` & `_shared/tailor/`
- **Inputs**: `applications` at `scored`, structured `master_profiles` JSON.
- **Outputs**: Rewords resume bullets by referencing master profile node IDs (`bullet_id`, `skill_id`). Never invents text. Advances `scored -> tailored`.
- **UI Connection**: `DiffView.tsx` shows side-by-side diff (master vs tailored).

#### 7. ATS Simulator Agent
- **Location**: `supabase/functions/_shared/tailor/ats-simulator.ts` & `validator-ats.ts`
- **Inputs**: Tailored resume HTML / PDF text layer.
- **Outputs**: Offline text extractor evaluates keyword match density against an **$\ge 85\%$ threshold gate**. Emits warning telemetry if $<85\%$.
- **UI Connection**: Displays ATS match % on approval queue cards.

#### 8. Auditor Agent
- **Location**: `supabase/functions/auditor/index.ts` & `_shared/audit/`
- **Inputs**: `applications` at `tailored`, `master_profiles` snapshot.
- **Outputs**: **Anti-Fabrication Security Gate**. Traces every claim back to a master resume ID. Routes clean claims to `audit_clean` (batch-approve) and unmapped claims to `audit_flagged` (human review).
- **UI Connection**: `ApprovalQueuePage.tsx` partitions queue into Bucket A (Clean) vs Bucket B (Flagged).

#### 9. Approval Gate Agent
- **Location**: `apps/web/src/features/approval/ApprovalQueuePage.tsx`
- **Inputs**: `applications` at `audit_clean` or `audit_flagged`.
- **Outputs**: **Human-in-the-Loop State Machine**. Operator clicks "Approve All Clean" or edits flagged claims. Advances `audit_clean | audit_flagged -> awaiting_approval -> approved`.
- **UI Connection**: `ApprovalQueuePage.tsx` primary interface.

#### 10. Applier Worker Agent
- **Location**: `worker/src/` & `.github/workflows/apply.yml`
- **Inputs**: `applications` at `approved`.
- **Outputs**: **GitHub Actions + Playwright**: Batched cron runner launches Chromium, fills Greenhouse/Lever forms, attaches rendered PDF resumes (`page.pdf()`), and advances `approved -> applying -> applied` (or `blocked_needs_human` on captcha).
- **UI Connection**: `PipelinePage.tsx` Kanban board & Health Page screenshot queue.

---

### Pipeline 3: Post-Apply Tracking & Outreach

#### 11. Email Tracker Agent
- **Location**: `supabase/functions/email-tracker-intake/` & `_shared/email/`
- **Inputs**: Inbound recruiter emails pushed from Google Apps Script (`tejamallam00@gmail.com`).
- **Outputs**: AI classifies outcome (Interview Invite, Rejection, OA Test) and updates `applications` status (`applied -> employer_screening | interview | rejected | oa_pending`).
- **UI Connection**: `EmailMonitoringPage.tsx` displays ingested recruiter email events.

#### 12. Referral Outreach Agent
- **Location**: `supabase/functions/referral/` & `_shared/referral/`
- **Inputs**: `applications` at `passed_filters` or `scored`.
- **Outputs**: Generates cold referral request message drafts (subject, body, networking notes) saved in `application_events` table (`event_type = 'note'`).
- **UI Connection**: Referral Queue / Drawer Panel (to copy message & mark as sent).

#### 13. Follow-Up Nudge Agent
- **Location**: `supabase/functions/follow-up/` & `_shared/follow-up/`
- **Inputs**: `applications` sitting at status `applied` for $\ge 7$ days.
- **Outputs**: Generates polite follow-up email drafts into `follow_up_nudges` table (`status = 'draft'`).
- **UI Connection**: Follow-Up Nudges Queue (to copy email body & mark as sent).

#### 14. Sweeper / Reclaim Agent
- **Location**: `supabase/functions/_shared/agent/` & SQL function `sweep_stale_claims()`
- **Inputs**: Application claims where `claim_expires_at < now()`.
- **Outputs**: Self-healing monitor. Reclaims expired leases; moves stuck `applying` rows to `needs_verification`.
- **UI Connection**: `HealthPage.tsx` displays stale lease count.

---

### Pipeline 4: Compounding & Analytics

#### 15. Skill-Gap Aggregator Agent
- **Location**: `supabase/functions/skill-gap/` & `_shared/analytics/`
- **Inputs**: All scored & rejected job descriptions.
- **Outputs**: Diffs required JD skills against candidate master profile skills; materializes ranked demand metrics into `skill_gap_reports`.
- **UI Connection**: `SkillGapPage.tsx` renders ranked horizontal bar chart.

#### 16. Interview Prep Agent
- **Location**: `supabase/functions/interview-prep/` & `_shared/interview-prep/`
- **Inputs**: `applications` at status `interview`.
- **Outputs**: Generates company research overview, role-specific questions, experience highlights, and talking points into `interview_prep_packs`.
- **UI Connection**: `InterviewPrepPanel.tsx` inside Pipeline view drawer.

#### 17. Keepalive & RLS Agent
- **Location**: `supabase/functions/rls-proof/` & `.github/workflows/keepalive.yml`
- **Inputs**: Scheduled cron ping.
- **Outputs**: Prevents Supabase project idle pause (1 week threshold) & GitHub workflow disabling (60 day threshold). Verifies tenant RLS isolation.
- **UI Connection**: `HealthPage.tsx` keepalive indicator.
