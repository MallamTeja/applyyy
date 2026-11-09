/* The Approval queue's first read, startable BEFORE the page's code chunk arrives (2026-11-09).
 *
 * WHY THIS FILE EXISTS. Routes are React.lazy chunks (App.tsx), so the queue read used to start only once
 * ApprovalQueuePage-<hash>.js had downloaded and mounted. Measured on the built bundle (86 rows, every
 * Supabase call held 300 ms, chunk held 150 ms): the shell's first request left at ~192 ms, the queue read at
 * ~308 ms. App.tsx now calls startQueuePrefetch() while the chunk downloads, and the page takes that one
 * in-flight read instead of sending its own. Proof: apps/web/test/approvalQueuePrefetchE2e.test.ts.
 *
 * This module is imported by App.tsx, so it ships in the ENTRY chunk. Keep it to the client import and
 * the two query builders: anything heavier here would slow every page's first paint, not just this one. */

// The one app-wide client; null when the console is not configured.
import { supabase } from '../../data/supabase';
// The default route, so the index redirect ("/") also counts as opening the queue.
import { DEFAULT_ROUTE } from '../../app/routes';
// The client's type, for the read's parameter (type-only: no runtime import).
import type { SupabaseClient } from '@supabase/supabase-js';

/* Both first-paint reads, started together. The page and the prefetch call this ONE function, so the
   select the prefetch sends can never drift from the one the page would have sent. */
export function readQueue(client: SupabaseClient) {
  /* 0. The NEWEST master, started BEFORE the applications read and awaited with it (2026-11-08).
     The pinned-version reads in the page can only start once the rows say which versions they need,
     so they were a second sequential round trip (~0.3-0.5 s to Sydney). Nearly every row is
     pinned to the newest master, so reading it up front usually leaves nothing for that round.
     It is only a PREFETCH: it is used for a row only when its version equals the row's pin. */
  const newestMasterRead = client
    // The same table the per-version reads use; RLS scopes it to the signed-in user.
    .from('master_profiles')
    // version travels with the profile, so the cache below is keyed by what was actually read.
    .select('profile, version')
    // Highest version first: "newest" is the largest version number, as everywhere else here.
    .order('version', { ascending: false })
    // One row is the newest; nothing else is needed from this read.
    .limit(1)
    // No master at all is an answer (null), not an error.
    .maybeSingle();

  // 1. Fetch applications at awaiting_approval
  const applicationsRead = client
    .from('applications')
    /* apply_url and description_raw added 2026-09-17: the diff could not
       show the operator the job they were approving against, because the
       query never asked for it. Everything here is an explicit column
       list rather than jobs:job_id(*) so that adding a column to the
       jobs table does not silently start shipping it to the browser. */
    /* No raw_payload key any more (2026-11-05). raw_payload->>application_deadline made Postgres
       de-TOAST every job's whole board JSON (~387 KB for 39 rows, ~95% of the query's executor
       time) for a deadline that was null on all 39. The deadline chip went with it. */
    /* The applications columns are explicit too, for the same reason as the jobs list: `*` also
       shipped match_reasoning, claim and failure fields this page never reads. These are the
       fields read here, by queueOrder.ts and by diffAdapter.ts. tailor_refs stays: original
       and attest are rebuilt from it. */
    /* location_raw added 2026-11-07: the row shows the board's own location, and the "Pay band UK/US
       only" chip (finding N2) reads it with description_raw, exactly as the screener's gate does. */
    /* description_raw is NOT in this read any more (2026-11-09). It was 438 KB of the 1.67 MB this
       select returned for 86 rows, and nothing on the first paint shows it: only the pay-band chip
       and the AI chat read it. loadJobDescriptions fetches it once the queue is on screen. */
    .select('id, status, status_changed_at, created_at, updated_at, master_version, tailored_profile, tailor_refs, selected_jd_keywords, match_score, audit_findings, cover_letter, jobs:job_id(title, company_name, employment_type, work_arrangement, locations, salary_min, salary_max, salary_currency, discovered_via, source_refs, apply_url, location_raw)')
    .eq('status', 'awaiting_approval')
    /* Newest entry into review first (2026-10-24): status_changed_at is when the row reached
       awaiting_approval, served by the (user_id, status, status_changed_at desc) index. Not
       created_at, which is the discovery date. See queueOrder.ts. */
    .order('status_changed_at', { ascending: false });
  /* Both in flight at once: Promise.all calls then() on each builder immediately, and a
     PostgREST builder only sends its request on then(). One round trip instead of two. */
  return Promise.all([applicationsRead, newestMasterRead]);
}

// What readQueue resolves to: [applications response, newest-master response].
export type QueueReads = Awaited<ReturnType<typeof readQueue>>;

/* The one prefetched read and when it started. Module state, not React state: it must exist before
   any component mounts, which is the whole point. */
let pending: { readonly reads: Promise<QueueReads | null>; readonly startedAt: number } | null = null;

/* How old a prefetch may be when the page takes it. On a fresh load the page mounts within a second;
   an older read could predate an approve in another tab, so the page reads fresh instead. */
// ponytail: a fixed age bound; key by user id + invalidate on writes if the prefetch ever outlives one boot.
const MAX_AGE_MS = 30_000;

/* Kicks the queue read when this page load is opening the queue. Called once, by App.tsx at module load.
   `pathname` is a parameter (not read from window here) so the caller states which load it is. */
export function startQueuePrefetch(pathname: string): void {
  // Unconfigured console: the page shows its own "not connected" state; nothing to read.
  if (supabase === null) return;
  // First path segment, as routes.ts documentTitleFor reads it ("/approvals/" and "/approvals" alike).
  const segment = pathname.replace(/^\/+/, '').split('/')[0] ?? '';
  // Only the queue, or "/" which redirects to it; any other page would waste ~1.2 MB on a read nobody shows.
  if (segment !== DEFAULT_ROUTE && segment !== '') return;
  // Captured for the async body, so TypeScript keeps the non-null narrowing.
  const client = supabase;
  pending = {
    // getSession first: with NO session, RLS answers [] with no error, which would paint "nothing waiting"
    // after sign-in. getSession reads the stored session (refreshing it if expired), so null = signed out.
    reads: client.auth.getSession().then(({ data }) => (data.session === null ? null : readQueue(client)))
      // Never an unhandled rejection: a throw here means "no prefetch", and the page reads for itself.
      .catch(() => null),
    // performance.now: monotonic, so a clock change cannot make a stale read look fresh.
    startedAt: performance.now(),
  };
}

/* The page's side: the prefetched read, at most once, or null to read for itself. Take-once so a
   remount (StrictMode's dev double-mount, or leaving and coming back) never reuses an old answer. */
export function takeQueuePrefetch(): Promise<QueueReads | null> | null {
  // What was kicked, if anything.
  const taken = pending;
  // Cleared before returning, so a second caller always reads fresh.
  pending = null;
  // None kicked (another first page, signed out at boot, or already taken).
  if (taken === null) return null;
  // Too old to trust: read fresh.
  if (performance.now() - taken.startedAt > MAX_AGE_MS) return null;
  // The in-flight (or settled) read; null inside means "skipped", and the page reads for itself.
  return taken.reads;
}
