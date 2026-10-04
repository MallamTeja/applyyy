// THE RLS PROOF. A one-shot diagnostic, not part of the pipeline.
//
// WHY THIS IS THE MOST IMPORTANT VERIFICATION IN THE PROJECT, and why this stream in
// particular needs it: every Edge Function signs in as the app user and runs under
// RLS. So a policy with an inverted predicate, or one comparing the wrong column,
// would present as **"the agent found no work"** — indistinguishable from an idle
// queue and identical in appearance to the §14 silent stop. Nothing anywhere in this
// stream can detect that from the inside. It has to be proven from outside.
//
// WHAT HAS AND HAS NOT BEEN ESTABLISHED SO FAR. `pg_policies` shows RLS enabled on
// 15/15 tables with at least one policy each — but every query that established this
// ran as `postgres`, which carries `BYPASSRLS`. **A completely broken policy looks
// identical in the catalogue.** "The policy exists" and "the policy scopes correctly"
// are different claims and only the first has been checked.
//
// WHY AN EDGE FUNCTION IS A BETTER VEHICLE THAN THE LOCAL psql PLAN IT REPLACED, and
// not merely a fallback: psql proves the policies scope a HAND-SYNTHESISED
// `request.jwt.claims`. This proves they scope a REAL Supabase-issued JWT obtained
// through `signInWithPassword` — the exact path every agent carries in production. A
// more faithful environment, traded for a less controlled one.
//
// ------------------------------------------------------------------------------
// THIS FUNCTION WRITES ROWS INTO THE LIVE DATABASE. Two safeguards, both structural:
//
//   1. It REFUSES TO RUN against a populated database. That constraint could have
//      been a comment saying "never re-run this once real data exists" — but a
//      comment is not a safeguard, it is a hope about who reads it. The emptiness
//      check below makes the dangerous case unreachable instead of discouraged.
//   2. Cleanup failure is a LOUD FAILURE, reported in the response body with a
//      non-2xx status. A silent partial cleanup would leave test tenancies behind
//      that later look exactly like real data — which is worse than not running.
// ------------------------------------------------------------------------------

// The official client, pinned exactly as elsewhere in this stream.
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2.58.0";

// The two test identities. SEPARATE from the app user on purpose: this test must
// prove that two DIFFERENT authenticated users cannot see each other, which is
// unprovable with one account no matter how it is queried.
const TEST_A_EMAIL = "APPLYY_RLS_TEST_A_EMAIL";
const TEST_A_PASSWORD = "APPLYY_RLS_TEST_A_PASSWORD";
const TEST_B_EMAIL = "APPLYY_RLS_TEST_B_EMAIL";
const TEST_B_PASSWORD = "APPLYY_RLS_TEST_B_PASSWORD";
// Reuses the intake's shared secret so this diagnostic is not callable by anyone who
// finds the URL. It runs with `verify_jwt = true` as well, so this is a second lock.
const RUN_SECRET = "EMAIL_INTAKE_SHARED_SECRET";

// Every user-scoped table. `application_status_transitions` is deliberately absent:
// it holds RULES rather than user data and is readable by everyone by design, so
// asserting tenancy isolation on it would assert something false.
const USER_SCOPED_TABLES = [
  "system_settings",
  "master_profiles",
  "jobs",
  "applications",
  "application_events",
  "agent_runs",
  "gemini_key_state",
  "search_preferences",
  "filter_rules",
  "company_watchlist",
  "company_blocklist",
  "answer_bank",
  "email_events",
  "matcher_eval_cases",
] as const;

// ROWS THIS MANY OR FEWER COUNT AS "EMPTY ENOUGH TO BE SAFE". Zero would be ideal but
// is too brittle: `bootstrap_user_defaults()` legitimately seeds settings and filter
// rules. The check that actually matters is on `applications` and `jobs`, which is
// where real work would live, and those are required to be exactly zero below.
const MAX_INCIDENTAL_ROWS = 50;

// One step's outcome. Collected rather than thrown so the response reports EVERY
// failure at once — someone fixing policies needs the whole picture, not the first
// thing that broke followed by silence about the rest.
interface StepResult {
  // What was being checked, in words that name the property rather than the mechanic.
  readonly step: string;
  // Whether the property held.
  readonly passed: boolean;
  // What was actually observed, so a failure is diagnosable without a second run.
  readonly detail: string;
}

// Read an environment variable, treating whitespace as absence.
function readEnv(name: string): string | undefined {
  // Unset returns undefined.
  const raw = Deno.env.get(name);
  // Absent.
  if (raw === undefined) return undefined;
  // Present but empty of content is absence for our purposes.
  const trimmed = raw.trim();
  // One representation of absence rather than two.
  return trimmed.length === 0 ? undefined : trimmed;
}

// Sign in as one of the two test identities and return an RLS-bound client.
async function signIn(url: string, anonKey: string, email: string, password: string): Promise<SupabaseClient | string> {
  // A fresh client per identity: sharing one would let the second sign-in silently
  // replace the first's session, and the test would then compare a user with itself
  // and pass — a test that cannot fail.
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  // Obtain a real Supabase-issued JWT through the same path production uses.
  const { error } = await client.auth.signInWithPassword({ email, password });
  // A failure here is almost always a user that was never created.
  if (error !== null) return `sign-in failed for ${email}: ${error.message}`;
  // Authenticated and RLS-bound.
  return client;
}

// Count rows visible to one client in one table. Returns a number, or a string
// describing why the count could not be taken.
async function countVisible(client: SupabaseClient, table: string): Promise<number | string> {
  // `head: true` asks PostgREST for the count without transferring the rows.
  const { count, error } = await client.from(table).select("*", { count: "exact", head: true });
  // A permission error is itself informative and must not be swallowed.
  if (error !== null) return `${table}: ${error.message}`;
  // A null count with no error is treated as zero rather than crashing.
  return count ?? 0;
}

// The handler.
Deno.serve(async (request: Request): Promise<Response> => {
  // Emit JSON with a status.
  const json = (status: number, body: Record<string, unknown>): Response =>
    new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });

  // POST only. A diagnostic that writes rows must not be triggerable by a link.
  if (request.method !== "POST") return json(405, { error: "method not allowed" });

  // The shared secret, so this is not runnable by anyone who learns the URL.
  const configuredSecret = readEnv(RUN_SECRET);
  // Fail closed on missing configuration, exactly as the intake endpoint does.
  if (configuredSecret === undefined) return json(500, { error: `${RUN_SECRET} is not set` });
  // Compare. Not constant-time here because this endpoint is also JWT-gated and is a
  // one-shot diagnostic — stated rather than left as an oversight for a reader to spot.
  if (request.headers.get("X-Applyy-Intake-Secret") !== configuredSecret) return json(401, { error: "unauthorized" });

  // Platform-injected connection details.
  const url = readEnv("SUPABASE_URL");
  const anonKey = readEnv("SUPABASE_ANON_KEY");
  // Without these the function is running somewhere unexpected.
  if (url === undefined || anonKey === undefined) return json(500, { error: "SUPABASE_URL or SUPABASE_ANON_KEY is not set" });

  // The two test identities.
  const aEmail = readEnv(TEST_A_EMAIL);
  const aPassword = readEnv(TEST_A_PASSWORD);
  const bEmail = readEnv(TEST_B_EMAIL);
  const bPassword = readEnv(TEST_B_PASSWORD);
  // All four are required; a single-user run would prove nothing about isolation.
  if (aEmail === undefined || aPassword === undefined || bEmail === undefined || bPassword === undefined) {
    return json(500, { error: `all four of ${TEST_A_EMAIL}, ${TEST_A_PASSWORD}, ${TEST_B_EMAIL}, ${TEST_B_PASSWORD} must be set` });
  }

  // Sign in as A.
  const clientA = await signIn(url, anonKey, aEmail, aPassword);
  // Report a sign-in failure plainly — it means the users do not exist yet.
  if (typeof clientA === "string") return json(500, { error: clientA });
  // Sign in as B, on its own client.
  const clientB = await signIn(url, anonKey, bEmail, bPassword);
  if (typeof clientB === "string") return json(500, { error: clientB });

  // Their user ids, needed to write rows that deliberately name the OTHER tenant.
  const aId = (await clientA.auth.getUser()).data.user?.id;
  const bId = (await clientB.auth.getUser()).data.user?.id;
  // Without both ids the cross-tenant write cannot be constructed honestly.
  if (aId === undefined || bId === undefined) return json(500, { error: "could not resolve both test user ids" });

  // SAFEGUARD 1 — REFUSE TO RUN AGAINST A POPULATED DATABASE.
  //
  // Structural rather than documented. Writing test tenancies into the live project
  // is tolerable only while it is empty and nothing depends on it, and that stops
  // being true the moment one real application exists. A comment saying "do not
  // re-run this" is a hope about who reads it; this makes the dangerous case
  // unreachable. Counted as A, so it also exercises the read path before relying on it.
  const jobsCount = await countVisible(clientA, "jobs");
  const applicationsCount = await countVisible(clientA, "applications");
  // A count that errored means we cannot establish emptiness, so we must not proceed.
  if (typeof jobsCount === "string" || typeof applicationsCount === "string") {
    return json(500, { error: "could not establish that the database is empty", detail: [jobsCount, applicationsCount] });
  }
  // EXACTLY ZERO on the two tables that would hold real work. Not "few" — one real
  // application is enough to make this test unacceptable.
  if (jobsCount !== 0 || applicationsCount !== 0) {
    return json(409, {
      error: "REFUSING TO RUN: the database is not empty",
      detail: `jobs=${jobsCount}, applications=${applicationsCount}. This test writes rows and must never run against real data.`,
    });
  }

  // Every step's verdict.
  const results: StepResult[] = [];
  // Ids of rows this run created, so cleanup can be exact rather than a blanket delete.
  const createdByA: string[] = [];
  const createdByB: string[] = [];

  // Seed one owned row per tenant. `company_watchlist` is chosen because it is
  // user-scoped, has no foreign keys to satisfy, and is not on the submit path — so a
  // leftover row is inert if cleanup somehow fails.
  const seed = async (client: SupabaseClient, token: string, into: string[]): Promise<string | null> => {
    // Insert without naming user_id, so the column default (`auth.uid()`) decides the
    // owner — which is the ordinary, correct path.
    const { data, error } = await client
      .from("company_watchlist")
      .insert({ ats_provider: "greenhouse", board_token: token, company_name: token, company_slug: token })
      .select("id")
      .single();
    // A failed seed means the rest of the test cannot be interpreted.
    if (error !== null) return `seed failed for ${token}: ${error.message}`;
    // Remember the id for cleanup.
    into.push(data.id as string);
    // Seeded.
    return null;
  };

  // Filled in by the `finally` below, read when building the response.
  const cleanupErrors: string[] = [];
  // Rows still visible to A after cleanup; a string when that count itself failed.
  let remaining: number | string = -1;
  // Set when seeding fails, so the response can say so after cleanup has run.
  let seedFailure: string | null = null;

  // EVERYTHING FROM THE FIRST SEED ON RUNS INSIDE try/finally (2026-10-04). Before, a
  // failed seed of B returned early and A's seeded row was never deleted — and the next
  // run then hit SAFEGUARD 1's sibling problem: a leftover test row that looks like data.
  // The same applied to any exception thrown mid-assertion.
  try {
    // Seed A.
    const seedAError = await seed(clientA, "rls-proof-tenant-a", createdByA);
    // Seed B.
    const seedBError = seedAError === null ? await seed(clientB, "rls-proof-tenant-b", createdByB) : null;
    // Either failure aborts before any assertion, because an unseeded test would pass
    // trivially — both tenants would see zero rows and "isolation" would look perfect.
    if (seedAError !== null || seedBError !== null) {
      // Recorded; the `finally` still removes whatever WAS seeded.
      seedFailure = seedAError ?? seedBError;
      // No assertions on a half-seeded database.
      return json(500, { error: "seeding failed", detail: seedFailure });
    }

    // STEP 2 & 3 — READ ISOLATION, IN BOTH DIRECTIONS.
    //
    // THE MIRROR IS NOT OPTIONAL AND IS THE HALF A CASUAL TEST DROPS. A policy that
    // accidentally compares against a constant, or against the wrong side of a join,
    // can pass for one user and fail for the other. Checking only A would ratify it.
    for (const [label, client, ownToken, otherToken] of [
      ["A", clientA, "rls-proof-tenant-a", "rls-proof-tenant-b"] as const,
      ["B", clientB, "rls-proof-tenant-b", "rls-proof-tenant-a"] as const,
    ]) {
      // What this tenant can see in the seeded table.
      const { data, error } = await client.from("company_watchlist").select("board_token");
      // An error here is a failure, not an absence.
      if (error !== null) {
        results.push({ step: `read isolation as ${label}`, passed: false, detail: `query failed: ${error.message}` });
        continue;
      }
      // The tokens visible to this tenant.
      const visible = (data ?? []).map((row) => row.board_token as string);
      // Its own row must be visible, or the policy is too restrictive — which would
      // present as the silent stop rather than as a leak.
      const seesOwn = visible.includes(ownToken);
      // The other tenant's row must NOT be visible. This is the leak test.
      const seesOther = visible.includes(otherToken);
      // Both halves must hold.
      results.push({
        step: `read isolation as ${label}`,
        passed: seesOwn && !seesOther,
        detail: `sees own=${seesOwn}, sees other tenant=${seesOther}, visible=[${visible.join(", ")}]`,
      });
    }

    // Whole-catalogue sweep as A: no user-scoped table may expose B's row count.
    for (const table of USER_SCOPED_TABLES) {
      // Count as A.
      const asA = await countVisible(clientA, table);
      // Count as B.
      const asB = await countVisible(clientB, table);
      // An error on either side is reported rather than treated as zero.
      if (typeof asA === "string" || typeof asB === "string") {
        results.push({ step: `catalogue sweep ${table}`, passed: false, detail: `${asA} / ${asB}` });
        continue;
      }
      // Only `company_watchlist` was seeded, so it is the only table where a non-zero
      // count is expected — and it must be exactly one each, never two.
      const expected = table === "company_watchlist" ? 1 : 0;
      // Both tenants must see exactly their own.
      results.push({
        step: `catalogue sweep ${table}`,
        passed: asA === expected && asB === expected,
        detail: `A sees ${asA}, B sees ${asB}, expected ${expected} each`,
      });
    }

    // STEP 4 — THE CROSS-TENANT WRITE. The one most likely to break.
    //
    // `with check` IS A SEPARATE MECHANISM FROM `using`. `using` filters what you can
    // SEE; `with check` validates what you WRITE. A policy carrying only `using` reads
    // rows correctly — passing every check made so far — while permitting writes into
    // another tenancy. That combination is invisible to the catalogue and to any
    // read-only test.

    // 4a: A attempts to UPDATE B's row.
    const { data: updated, error: updateError } = await clientA
      .from("company_watchlist")
      .update({ company_name: "HIJACKED BY TENANT A" })
      .eq("board_token", "rls-proof-tenant-b")
      .select("id");
    // Under correct RLS, `using` hides B's row so the update matches nothing: no error,
    // zero rows affected. Rows affected means a genuine cross-tenant write happened.
    results.push({
      step: "cross-tenant UPDATE is refused",
      passed: (updated ?? []).length === 0,
      detail: updateError === null ? `${(updated ?? []).length} rows updated (expected 0)` : `rejected with: ${updateError.message}`,
    });

    // 4b: A attempts to INSERT a row explicitly owned by B.
    //
    // NAMING `user_id` EXPLICITLY IS LOAD-BEARING AND IS THE TRAP IN THIS STEP.
    // `company_watchlist.user_id` DEFAULTS to `auth.uid()`, so an insert that omits it
    // is silently rewritten to A's own id — and the test then passes because the write
    // was never cross-tenant at all. That is a test that cannot fail, the same shape as
    // a type-only bundling probe.
    const { data: inserted, error: insertError } = await clientA
      .from("company_watchlist")
      .insert({ user_id: bId, ats_provider: "greenhouse", board_token: "rls-proof-forged", company_name: "forged", company_slug: "forged" })
      .select("id");
    // A correct `with check` rejects this outright.
    const insertRefused = insertError !== null || (inserted ?? []).length === 0;
    // Record the verdict.
    results.push({
      step: "cross-tenant INSERT naming another user_id is refused",
      passed: insertRefused,
      detail: insertError === null ? `insert SUCCEEDED — with check is missing or wrong (${(inserted ?? []).length} rows)` : `rejected with: ${insertError.message}`,
    });
    // If it somehow succeeded, the row must still be cleaned up — track it as B's,
    // since that is who now owns it.
    for (const row of inserted ?? []) createdByB.push(row.id as string);

    // STEP 5 — NEGATIVE CONTROL. With no session at all, `auth.uid()` is null and every
    // policy predicate must fail closed. If this returns rows, the tables are readable
    // by the world and nothing above matters.
    const anonClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    // A plain select, not `countVisible`: a HEAD request carries no error body, so the
    // SQLSTATE that distinguishes "blocked" from "broken" would be lost.
    const { data: anonRows, error: anonError } = await anonClient.from("company_watchlist").select("id").limit(1);
    // ONLY two outcomes prove anon is blocked: zero rows (RLS filtered everything), or
    // SQLSTATE 42501 insufficient_privilege (no table grant to anon). The old check passed
    // on ANY error — a network failure, a renamed table, a 500 — so a broken probe read as
    // proof of isolation. §5: an error is not an answer.
    const anonBlocked = anonError === null ? (anonRows ?? []).length === 0 : anonError.code === "42501";
    // Record the verdict with the evidence.
    results.push({
      step: "unauthenticated session sees nothing",
      passed: anonBlocked,
      detail: anonError === null
        ? `anon sees ${(anonRows ?? []).length} rows (expected 0)`
        : `rejected with ${anonError.code ?? "no code"}: ${anonError.message} (only 42501 proves a block)`,
    });
  } finally {

    // SAFEGUARD 2 — CLEANUP, WITH LOUD FAILURE.
    //
    // Each tenant deletes its own rows, because under correct RLS neither can delete
    // the other's — and using a privileged path to clean up would undermine the very
    // isolation being tested.
    // Delete A's rows as A.
    for (const [client, ids, label] of [[clientA, createdByA, "A"] as const, [clientB, createdByB, "B"] as const]) {
      // Nothing to remove.
      if (ids.length === 0) continue;
      // Delete by explicit id, never by a blanket predicate — a broad delete against a
      // live database is exactly the mistake this whole function is being careful about.
      const { error } = await client.from("company_watchlist").delete().in("id", ids);
      // Record rather than ignore.
      if (error !== null) cleanupErrors.push(`tenant ${label}: ${error.message}`);
    }
    // Verify the cleanup actually happened rather than trusting the absence of an error.
    remaining = await countVisible(clientA, "company_watchlist");
    // The seed-failure path returns before the response below can report cleanup, so a
    // dirty database is at least logged on every path.
    if (cleanupErrors.length > 0 || remaining !== 0) console.error("[rls-proof] cleanup incomplete:", cleanupErrors, remaining);
  }
  // A leftover row is a loud failure: test tenancies left behind will later look
  // exactly like real data, which is worse than never having run this.
  const cleanupClean = cleanupErrors.length === 0 && remaining === 0;

  // Did every property hold?
  const allPassed = results.every((entry) => entry.passed);
  // A failed cleanup is reported as a failure even when every assertion passed,
  // because the database has been left dirty either way.
  return json(allPassed && cleanupClean ? 200 : 500, {
    // The headline.
    rls_verdict: allPassed ? "ALL PROPERTIES HELD" : "AT LEAST ONE PROPERTY FAILED",
    // Cleanup gets its own top-level field so it cannot be lost among the assertions.
    cleanup: cleanupClean ? "complete" : `INCOMPLETE — ${cleanupErrors.join("; ")} remaining=${remaining}`,
    // Every step, passed or failed, so the report stands alone.
    results,
  });
});
