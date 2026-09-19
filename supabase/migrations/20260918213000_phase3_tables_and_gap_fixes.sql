-- Migration: Phase 3 Tables and Gap Fixes
-- Purpose: Provide schema for follow_up_nudges, skill_gap_reports, interview_prep_packs
-- Purpose: Address gap fixes G3 (gemini_key_state), G4 (email_events), G5 (sweep_stale_claims)
-- Author: applyyy codebase agent

-- Gap Fix G3: Seed gemini_key_state
-- Why: We need initial rows in the state table so the rotation logic can cycle through the keys.
-- Why: The system relies on exactly keys 1-6 being present in order to query their usage/rate limits.
INSERT INTO public.gemini_key_state (key_index) VALUES (1),(2),(3),(4),(5),(6) ON CONFLICT DO NOTHING;

-- Gap Fix G4: Add email_events columns
-- Why: We need to correlate email events back to specific threads in the user's inbox.
ALTER TABLE public.email_events ADD COLUMN IF NOT EXISTS thread_id text;
-- Why: We need to know who the email was originally sent to (recipient_to) for analytics or routing.
ALTER TABLE public.email_events ADD COLUMN IF NOT EXISTS recipient_to text;
-- Why: We need to store Gmail/provider label IDs to understand the context of the email (e.g., INBOX, SENT).
ALTER TABLE public.email_events ADD COLUMN IF NOT EXISTS label_ids text[];

-- Gap Fix G5: Fix sweep_stale_claims double-count
-- Why: The previous implementation double-counted stale claims, causing inconsistencies in worker stats.
-- Why: We replace it with a fixed version that properly isolates 'applying' claims from other claims.
CREATE OR REPLACE FUNCTION public.sweep_stale_claims()
-- Why: We return a table containing both released_count and reset_applying_count to provide metrics to the worker.
RETURNS table (released_count int, reset_applying_count int)
-- Why: We use plpgsql because we need local variables and sequential execution with diagnostics.
LANGUAGE plpgsql
-- Why: Security definer ensures this function runs with elevated privileges regardless of who calls it (useful for background jobs).
SECURITY DEFINER
AS $$
-- Why: Declare block to define our two counters.
DECLARE
  -- Why: Variable to store how many applications were reset from 'applying' state.
  v_applying int;
  -- Why: Variable to store how many other applications were released.
  v_stale int;
BEGIN
  -- Why: Clear claimed_by and claim_expires_at when moving applying -> needs_verification
  -- Why: This happens when an active job application process stalls or times out in Playwright.
  UPDATE public.applications
  -- Why: Move the status back to needs_verification so it can be retried or inspected.
  SET status = 'needs_verification',
      -- Why: Remove the worker claim so another worker can pick it up.
      claimed_by = NULL,
      -- Why: Clear the expiration timestamp since the claim is gone.
      claim_expires_at = NULL,
      -- Why: Update the timestamp to reflect when this reset occurred.
      updated_at = now()
  -- Why: Only target applications that are in the 'applying' state.
  WHERE status = 'applying'
    -- Why: Ensure it actually has a claim.
    AND claimed_by IS NOT NULL
    -- Why: Ensure the claim has actually expired before we forcefully reset it.
    AND claim_expires_at < now();
  -- Why: Capture the number of rows affected by the above query.
  GET DIAGNOSTICS v_applying = ROW_COUNT;

  -- Why: Clear other stale leases for applications that aren't in 'applying' state.
  -- Why: Sometimes a worker grabs a task but it gets stuck in another status, we just need to clear the claim.
  UPDATE public.applications
  -- Why: Remove the worker claim.
  SET claimed_by = NULL,
      -- Why: Clear the expiration timestamp.
      claim_expires_at = NULL,
      -- Why: Update the timestamp to reflect when this release occurred.
      updated_at = now()
  -- Why: Target applications with an active claim.
  WHERE claimed_by IS NOT NULL
    -- Why: Target claims that have expired.
    AND claim_expires_at < now()
    -- Why: Specifically exclude 'applying' because we already handled them above.
    AND status <> 'applying';
  -- Why: Capture the number of rows affected by the second query.
  GET DIAGNOSTICS v_stale = ROW_COUNT;

  -- Why: Return both counts back to the caller for telemetry and logging.
  RETURN QUERY SELECT v_stale, v_applying;
END;
$$;


-- Phase 3 Table: follow_up_nudges
-- Why: We need to store pre-generated nudge emails so users can easily follow up on stagnant applications.
CREATE TABLE IF NOT EXISTS public.follow_up_nudges (
  -- Why: Primary key to uniquely identify the nudge.
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Why: Link back to the user who owns this application.
  user_id uuid NOT NULL REFERENCES auth.users(id),
  -- Why: Link to the specific application this nudge relates to.
  application_id uuid NOT NULL REFERENCES public.applications(id),
  -- Why: Link to the job to quickly fetch company/title context.
  job_id uuid NOT NULL REFERENCES public.jobs(id),
  -- Why: Store the type of nudge, defaulting to day_7 for the first follow-up.
  nudge_type text NOT NULL DEFAULT 'day_7',
  -- Why: Store the generated subject line so the user can review it.
  draft_subject text NOT NULL,
  -- Why: Store the generated body of the email.
  draft_body text NOT NULL,
  -- Why: Track when the AI generated this draft.
  generated_at timestamptz NOT NULL DEFAULT now(),
  -- Why: Track when the user actually sent the email (null if not sent yet).
  sent_at timestamptz,
  -- Why: Track whether this nudge is pending review, sent, or discarded.
  status text NOT NULL DEFAULT 'pending',
  -- Why: Standard creation timestamp for audit purposes.
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Why: Enable RLS so users can only access their own nudges.
ALTER TABLE public.follow_up_nudges ENABLE ROW LEVEL SECURITY;
-- Why: Force RLS so table owners are also bound by the policy (best practice).
ALTER TABLE public.follow_up_nudges FORCE ROW LEVEL SECURITY;
-- Why: Policy to restrict access strictly to the owning user_id.
CREATE POLICY follow_up_nudges_user_policy ON public.follow_up_nudges FOR ALL USING (auth.uid() = user_id);

-- Phase 3 Table: skill_gap_reports
-- Why: We need to track which skills the user lacks compared to market demand to suggest learning paths.
CREATE TABLE IF NOT EXISTS public.skill_gap_reports (
  -- Why: Primary key to uniquely identify the report entry.
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Why: Link back to the user.
  user_id uuid NOT NULL REFERENCES auth.users(id),
  -- Why: The name of the missing skill (e.g., 'React', 'Kubernetes').
  skill_name text NOT NULL,
  -- Why: How many times we've seen this skill required in jobs the user applied/matched to.
  demand_count int NOT NULL DEFAULT 0,
  -- Why: When we last detected this missing skill.
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- Why: The timeframe over which this demand count was aggregated (default 90 days).
  report_window_days int NOT NULL DEFAULT 90,
  -- Why: Standard creation timestamp.
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Why: Standard updated timestamp for when the demand count changes.
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Why: Ensure we only have one row per user per skill to aggregate demand.
  UNIQUE(user_id, skill_name)
);
-- Why: Enable RLS so users only see their own skill gaps.
ALTER TABLE public.skill_gap_reports ENABLE ROW LEVEL SECURITY;
-- Why: Force RLS for maximum data isolation.
ALTER TABLE public.skill_gap_reports FORCE ROW LEVEL SECURITY;
-- Why: Standard user isolation policy.
CREATE POLICY skill_gap_reports_user_policy ON public.skill_gap_reports FOR ALL USING (auth.uid() = user_id);

-- Phase 3 Table: interview_prep_packs
-- Why: We need to store AI-generated interview prep materials to help users succeed after getting an interview.
CREATE TABLE IF NOT EXISTS public.interview_prep_packs (
  -- Why: Primary key to identify the prep pack.
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Why: Link back to the user taking the interview.
  user_id uuid NOT NULL REFERENCES auth.users(id),
  -- Why: Link to the specific application.
  application_id uuid NOT NULL REFERENCES public.applications(id),
  -- Why: Link to the job for details.
  job_id uuid NOT NULL REFERENCES public.jobs(id),
  -- Why: A summary of the company to give the user context before the interview.
  company_overview text,
  -- Why: A JSON array of predicted questions the interviewer might ask based on the role.
  role_specific_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Why: A JSON array mapping user's experiences to the job requirements.
  experience_highlights jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Why: A JSON array of things the user should make sure to mention.
  talking_points jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Why: Track when the AI finished putting this pack together.
  generated_at timestamptz NOT NULL DEFAULT now(),
  -- Why: Standard creation timestamp.
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Why: Enable RLS so users only see their own interview prep.
ALTER TABLE public.interview_prep_packs ENABLE ROW LEVEL SECURITY;
-- Why: Force RLS to avoid data leaks.
ALTER TABLE public.interview_prep_packs FORCE ROW LEVEL SECURITY;
-- Why: Restrict access to the specific user.
CREATE POLICY interview_prep_packs_user_policy ON public.interview_prep_packs FOR ALL USING (auth.uid() = user_id);
