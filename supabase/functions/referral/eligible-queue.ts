// The referral queue query, in its own module so node --test can drive it with a fake
// client: index.ts calls Deno.serve at import time and cannot be loaded by a test.
//
// WHO IS ELIGIBLE (ruled by Teja 2026-11-02 ~20:50 IST: "Only awaiting_approval/approved").
// A referral ask spends a Gemini call and, once sent, a real contact's goodwill. Asking
// before Teja has looked at the tailored application wastes both on jobs he may reject,
// so only rows he is about to approve or has approved are drafted.

// Type-only, so node strips it and the test never resolves a jsr: specifier.
import type { SupabaseClient } from "@supabase/supabase-js";

// Closed list of statuses a draft may be written for. `as const` keeps it a literal tuple,
// so a widening edit shows up in the diff and the named test, not only at runtime.
export const REFERRAL_ELIGIBLE_STATUSES = ["awaiting_approval", "approved"] as const;

// Placeholder id for an empty exclusion list: PostgREST rejects `not.in.()`, and no real
// application carries the all-zero uuid, so it excludes nothing.
const NO_DRAFTED_ID = "00000000-0000-0000-0000-000000000000";

// The oldest eligible applications that have no draft yet, at most `batchSize` of them.
// Returns the builder itself, so the caller awaits it and keeps supabase-js's row typing.
export function selectReferralQueue(db: SupabaseClient, draftedIds: readonly string[], batchSize: number) {
  // Built once, so the `.not` call below reads as one value.
  const excluded = draftedIds.length > 0 ? draftedIds.join(",") : NO_DRAFTED_ID;
  // The application row plus the job fields the prompt is built from.
  return db
    // Target applications queue table.
    .from("applications")
    // Select application ID, status, match score, match reasoning, and joined job record details.
    .select("id, job_id, user_id, status, match_score, match_reasoning, jobs ( id, title, company_name, company_slug, location_raw, locations, employment_type, description_raw )")
    // Only the statuses Teja ruled eligible; filtered in the database so `.limit` counts them only.
    .in("status", REFERRAL_ELIGIBLE_STATUSES)
    // Skip applications that already have a draft. ponytail: the id list travels in the
    // URL, so this ceiling is a few thousand drafts; a `not exists` RPC removes it.
    .not("id", "in", `(${excluded})`)
    // Order applications by creation timestamp ascending for FIFO queue processing order.
    .order("created_at", { ascending: true })
    // Limit returned application rows to resolved batch size ceiling.
    .limit(batchSize);
}
