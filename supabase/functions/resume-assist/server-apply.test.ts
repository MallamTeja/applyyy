// applyOnServer (S9i P2, 2026-11-21): resume-assist applies a chat answer itself, under the owner's RLS client, so it
// lands even with the tab closed (Teja 15:34). Pinned here: the stale-row retry that lets parallel prompts both land
// (S9d), the deadline, and the row guards. The fake is supabase-js-shaped (values, never throws), like attest-skill.test.
import assert from "node:assert/strict";
// The runner.
import { describe, it } from "node:test";
// The module under test.
import { applyOnServer } from "./server-apply.ts";
// The engine's own rebuild, so the fixture row is exactly what a tailoring stores.
import { rebuildOriginal } from "../_shared/resume-edit/tailored-edits.ts";
// The maps type.
import type { ApplyMaps } from "../_shared/resume-edit/resolve-ops.ts";

// The pin.
const V3 = 3;
// A small master (attest-skill.test's shape).
const MASTER = {
  schema_version: 1,
  identity: { full_name: "Test Person", headline: "Backend Engineer", email: "test@example.com", phone: null, location: "Hyderabad", links: [] },
  summary: { id: "summary-master", text: "Backend engineer building REST APIs in Node.js." },
  experience: [{ id: "exp-acme", company: "Acme", role: "Backend Intern", location: "Remote", start_display: "Jun 2025", end_display: "Aug 2025", start_date: null, end_date: null, bullets: [{ id: "b-api", text: "Built a REST API with Express and Node.js handling 500 users", tags: [] }, { id: "b-tests", text: "Wrote unit tests for the billing service", tags: [] }] }],
  projects: [], education: [], achievements: [], certifications: [],
  skills: [{ id: "skill-node", name: "Node.js", category: "Frameworks" }, { id: "skill-docker", name: "Docker", category: "Tools" }, { id: "skill-pg", name: "PostgreSQL", category: "Databases" }],
  links: [],
};
// The row's tailor_refs.
const REFS = {
  schema_version: 1, master_version: V3, section_order: ["summary", "experience", "skills"],
  summary: { text: "Backend engineer shipping REST APIs in Node.js.", refs: ["summary-master"] },
  skills: [{ ref: "skill-node" }, { ref: "skill-pg" }],
  experience: [{ ref: "exp-acme", bullets: [{ ref: "b-api", text: "Built a REST API with Express and Node.js handling 500 users" }, { ref: "b-tests", text: "Wrote unit tests for the billing service" }] }],
  projects: [], education: [], achievements: [], certifications: [],
};
// The maps the browser would send for this resume.
const MAPS: ApplyMaps = { bullets: { b0: "b-api", b1: "b-tests" }, entries: { e0: { section: "experience", ref: "exp-acme" } }, availableBullets: {}, availableEntries: {}, skills: [{ name: "Node.js", category: "Frameworks", ref: "skill-node" }, { name: "PostgreSQL", category: "Databases", ref: "skill-pg" }] };

/* A stateful supabase double: the row's stamp moves on every landed update; `staleFirst` makes the first update find
   nothing (another prompt wrote first) and moves the stamp, as the database would. */
function fakeDb(opts: { status?: string; staleFirst?: boolean }) {
  // The stored row.
  const row = { tailored_profile: rebuildOriginal(structuredClone(REFS), structuredClone(MASTER) as never, V3), updated_at: "t1", tailor_refs: structuredClone(REFS), selected_jd_keywords: [], status: opts.status ?? "awaiting_approval" };
  // How many updates were attempted.
  let updates = 0;
  // The client.
  const db = {
    from(table: string) {
      // Read, update or insert, decided by the methods called.
      let kind: "read" | "update" | "insert" = "read";
      // The value an update writes.
      let written: Record<string, unknown> = {};
      // The chainable, thenable builder.
      const builder: Record<string, unknown> = {
        then(resolve: (v: unknown) => unknown) {
          // The master by version.
          if (table === "master_profiles") return Promise.resolve({ data: { profile: structuredClone(MASTER) }, error: null }).then(resolve);
          // An update of the row.
          if (table === "applications" && kind === "update") {
            // Counted.
            updates += 1;
            // Another prompt won: nothing matched the old stamp, and the stamp moved.
            if (opts.staleFirst && updates === 1) { row.updated_at = "t2"; return Promise.resolve({ data: [], error: null }).then(resolve); }
            // Landed: stored, new stamp.
            Object.assign(row, written, { updated_at: `t${updates + 2}` });
            // One row back.
            return Promise.resolve({ data: [{ id: "app-1", updated_at: row.updated_at }], error: null }).then(resolve);
          }
          // A read of the row (maybeSingle or the save's read-back).
          if (table === "applications") return Promise.resolve({ data: structuredClone(row), error: null }).then(resolve);
          // The event insert.
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      // Every method the code chains.
      for (const method of ["select", "eq", "maybeSingle", "single", "order", "limit", "insert", "update"]) {
        builder[method] = (...args: unknown[]) => {
          // The kind of chain.
          if (method === "update") { kind = "update"; written = args[0] as Record<string, unknown>; }
          // Same.
          if (method === "insert") kind = "insert";
          // Chain on.
          return builder;
        };
      }
      // The builder.
      return builder;
    },
  };
  // The double and its counters.
  return { db, row, updates: () => updates };
}

// Fixed seams.
const deps = { now: () => 1000, uuid: () => "u1" };

describe("applyOnServer", () => {
  it("parallel prompts: a save that loses the stamp race re-reads and lands on the retry (S9d)", async () => {
    // The first update finds the stamp moved.
    const fake = fakeDb({ staleFirst: true });
    // Move experience first and take PostgreSQL off.
    const report = await applyOnServer(fake.db as never, { applicationId: "app-1", ops: [{ op: "move_section", section: "experience", place: 1 }, { op: "remove_skill", name: "PostgreSQL" }], maps: MAPS, deadline: 2000 }, deps);
    // Both applied.
    assert.deepEqual(report.outcomes.map((o) => o.status), ["applied", "applied"]);
    // Two update attempts, the second landed.
    assert.equal(fake.updates(), 2);
    // The stored row has both changes.
    assert.deepEqual([(fake.row.tailored_profile as { section_order: string[] }).section_order[0], (fake.row.tailored_profile as { skills: { ref: string }[] }).skills.map((s) => s.ref)], ["experience", ["skill-node"]]);
  });

  it("past the deadline nothing runs and every op says so", async () => {
    // A row that would accept the edit.
    const fake = fakeDb({});
    // The clock is already past the deadline.
    const report = await applyOnServer(fake.db as never, { applicationId: "app-1", ops: [{ op: "remove_skill", name: "PostgreSQL" }], maps: MAPS, deadline: 500 }, deps);
    // Refused with the time reason, and no write.
    assert.deepEqual([report.outcomes[0]?.status, fake.updates()], ["refused", 0]);
  });

  it("a row that is no longer awaiting approval is never written", async () => {
    // Approved already.
    const fake = fakeDb({ status: "approved" });
    // Any edit.
    const report = await applyOnServer(fake.db as never, { applicationId: "app-1", ops: [{ op: "remove_skill", name: "PostgreSQL" }], maps: MAPS, deadline: 2000 }, deps);
    // Refused, no write.
    assert.deepEqual([report.outcomes[0]?.status, fake.updates()], ["refused", 0]);
  });
});
