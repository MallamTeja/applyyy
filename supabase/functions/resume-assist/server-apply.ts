// SERVER-SIDE APPLY OF ONE CHAT ANSWER (S9i P2, 2026-11-21).
//
// WHY IT EXISTS: Teja 15:34, "every edit he prompts in the resume chat is applied and done … Edits must land even if he
// closes the chat, the tab or the job, so the apply runs server-side, not in a browser loop. Several prompts apply in
// parallel." So once resume-assist has the AI's ops, it applies them HERE, under the owner's own RLS client (the same
// writes the browser made: one updated_at-guarded UPDATE of applications.tailored_profile, an append-only event, and
// for a new skill or bullet an insert-only master version). index.ts runs this inside EdgeRuntime.waitUntil, so a
// closed tab does not stop it.
//
// CONCURRENCY: two prompts on one row race on the updated_at stamp. The loser's save is refused (changed_elsewhere),
// re-reads the row, re-plans the SAME actions on the newer resume and saves once more (S9d). A second loss is reported,
// never looped.
//
// DEADLINE: every step checks the wall clock first; past it, the rest is reported as not done, never run half-way.

// The pure resolver and planner.
import { resolveWireOp, actionLabel, type ApplyMaps, type ServerAction, type WireOp } from "../_shared/resume-edit/resolve-ops.ts";
// Same.
import { planServerEdits, type PureServerAction, type ServerOutcome } from "../_shared/resume-edit/server-plan.ts";
// The engine's row readers.
import { isResumeShape, masterFromRow, rebuildOriginal, resolveFullMaster, type SectionKind } from "../_shared/resume-edit/tailored-edits.ts";
// The guarded save and its stale-row message.
import { saveTailoredEdit } from "../_shared/resume-edit/save-tailored-edit.ts";
// The master-first paths for a new skill and a dictated bullet.
import { attestSkill } from "../_shared/resume-edit/attest-skill.ts";
// Same.
import { attestBullet } from "../_shared/resume-edit/attest-bullet.ts";
// Types only.
import type { MasterProfile, ResolvedResume } from "../_shared/contracts/shared-types.ts";

// The owner's RLS-bound client (index.ts: createAuthorizedAppUserClient). The attest paths take the real type; tests
// pass a fake with the same chain, cast. Type-only, so node --test never loads the package.
import type { SupabaseClient } from "@supabase/supabase-js";
// This file's name for it.
type Client = SupabaseClient;

// The seams: the clock and the id minting, injected so tests are deterministic.
export interface ApplyDeps {
  // Milliseconds since the epoch.
  readonly now: () => number;
  // A fresh unique id for a new master node.
  readonly uuid: () => string;
}

// What the server did with one answer: each op's outcome, in answer order, for the reply and the chat row.
export interface ApplyReport {
  // Applied, refused (with why), or suggested (with why).
  readonly outcomes: readonly ServerOutcome[];
  // The stamp after the last write, or null when nothing was written.
  readonly updatedAt: string | null;
}

// One row as this file reads it, or the reason it cannot be edited.
type LoadedRow =
  | { readonly ok: true; readonly current: ResolvedResume; readonly original: ResolvedResume; readonly master: MasterProfile; readonly full: ResolvedResume; readonly tailorRefs: unknown; readonly jd: readonly string[]; readonly stamp: string }
  | { readonly ok: false; readonly why: string };

/* The row and everything an edit is checked against, read fresh (the browser's RowSource, Page:176-192). Same guards:
   a shape-checked resume, its pinned master, a rebuildable original, a FULL master. */
async function loadRow(db: Client, applicationId: string): Promise<LoadedRow> {
  // The row, under the owner's RLS.
  const { data: row, error } = await db.from("applications").select("tailored_profile, updated_at, tailor_refs, selected_jd_keywords, status").eq("id", applicationId).maybeSingle();
  // Unreadable, or not this owner's.
  if (error || row === null || typeof row !== "object") return { ok: false, why: "This application could not be read, so nothing was changed." };
  // Only a resume awaiting approval is editable (the DB freeze trigger refuses the rest anyway).
  if (row.status !== "awaiting_approval") return { ok: false, why: "This application is no longer awaiting approval, so nothing was changed." };
  // The resume, shape-checked before anything reads it (CLAUDE.md §6).
  if (!isResumeShape(row.tailored_profile) || typeof row.updated_at !== "string") return { ok: false, why: "The stored resume is malformed, so nothing was changed." };
  // Its pin.
  const version = row.tailored_profile.master_version;
  // The pinned master.
  const { data: masterRow } = await db.from("master_profiles").select("profile").eq("version", version).maybeSingle();
  // Shape-gated, as the page does.
  const master = masterFromRow(masterRow?.profile ?? null);
  // No master: nothing can be traced.
  if (master === null) return { ok: false, why: "The master profile this resume was tailored from could not be read, so nothing was changed." };
  // The tailor's own version and FULL, both from the pin.
  const original = rebuildOriginal(row.tailor_refs, master, version);
  // Same.
  const full = resolveFullMaster(master, version);
  // Either missing switches editing off, as on the page.
  if (original === null || full === null) return { ok: false, why: "This resume cannot be rebuilt from its master, so it cannot be edited here." };
  // The JD keywords, strings only.
  const jd = Array.isArray(row.selected_jd_keywords) ? row.selected_jd_keywords.filter((k: unknown): k is string => typeof k === "string") : [];
  // Everything an edit needs.
  return { ok: true, current: row.tailored_profile, original, master, full, tailorRefs: row.tailor_refs, jd, stamp: row.updated_at };
}

// The reason every step past the deadline is reported with.
const OUT_OF_TIME = "The server ran out of time before this change; ask again to apply it.";

/* Apply one answer's ops to one application. Never throws: every failure is an outcome. */
export async function applyOnServer(db: Client, args: { readonly applicationId: string; readonly ops: readonly WireOp[]; readonly maps: ApplyMaps; readonly deadline: number }, deps: ApplyDeps): Promise<ApplyReport> {
  // The row as it stands now.
  let row = await loadRow(db, args.applicationId);
  // Nothing can land: every op says why.
  if (!row.ok) { const why = row.why; return { outcomes: args.ops.map((op) => ({ status: "refused", label: op.op, why })), updatedAt: null }; }
  // Each op resolved against the maps and the printed section order.
  const resolved = args.ops.map((op) => resolveWireOp(op, args.maps, (row as Extract<LoadedRow, { ok: true }>).current.section_order as SectionKind[]));
  // Outcomes by op index, filled as each path finishes.
  const outcomes: (ServerOutcome | undefined)[] = resolved.map((r) => (r.ok ? undefined : { status: "refused", label: r.what, why: r.why }));
  // The resume-only actions, with their op index.
  const pure = resolved.flatMap((r, i) => (r.ok && r.action.kind !== "attest_skill" && r.action.kind !== "attest_bullet" ? [{ i, action: r.action as PureServerAction }] : []));
  // The master-writing ones, in order.
  const attests = resolved.flatMap((r, i) => (r.ok && (r.action.kind === "attest_skill" || r.action.kind === "attest_bullet") ? [{ i, action: r.action }] : []));
  // The stamp after the last landed write.
  let updatedAt: string | null = null;
  // 1. The resume-only actions: one plan, one guarded save, one retry on a stale row (S9d).
  if (pure.length > 0) {
    // At most two tries.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Past the deadline: report, never half-run.
      if (deps.now() > args.deadline) { for (const { i, action } of pure) outcomes[i] = { status: "refused", label: actionLabel(action), why: OUT_OF_TIME }; break; }
      // The current row (narrowed: a re-read that failed has already returned below).
      const loaded = row as Extract<LoadedRow, { ok: true }>;
      // The plan on the resume as it stands.
      const plan = planServerEdits({ current: loaded.current, master: loaded.master, full: loaded.full, jdKeywords: loaded.jd, actions: pure.map(({ action }) => ({ action, label: actionLabel(action) })) });
      // Each action's outcome, by its op index.
      pure.forEach(({ i }, k) => { outcomes[i] = plan.outcomes[k]; });
      // Nothing to save.
      if (plan.resume === null) break;
      // The first step names the event; the batch names every step.
      const [first] = plan.steps;
      // The browser's save, unchanged: trace check, stamp guard, event.
      const saved = await saveTailoredEdit(db, {
        // This row.
        applicationId: args.applicationId,
        // The planned end state.
        resume: plan.resume,
        // What it was planned from.
        previous: loaded.current,
        // The tailor's own version.
        original: loaded.original,
        // The pin.
        master: loaded.master,
        // Lands only if nobody wrote since the read.
        expectedUpdatedAt: loaded.stamp,
        // Recorded as the chat's own automatic apply.
        event: { kind: first!.kind, ref: first!.ref, before: first!.before, after: first!.after, source: "ai_chat_auto", ...(plan.trimmed.length > 0 ? { pageFitTrimmed: plan.trimmed.map((t) => ({ step: t.step, ref: t.ref, text: t.text })) } : {}), ...(plan.steps.length > 1 ? { batch: plan.steps } : {}) },
      });
      // Landed.
      if (saved.ok) { updatedAt = saved.updatedAt; break; }
      // Another prompt won the race: re-read once and re-plan the same actions on its result.
      if (saved.reason === "changed_elsewhere" && attempt === 0) {
        // Fresh.
        row = await loadRow(db, args.applicationId);
        // Unreadable now: every action says why.
        if (!row.ok) { const why = row.why; for (const { i, action } of pure) outcomes[i] = { status: "refused", label: actionLabel(action), why }; break; }
        // Again.
        continue;
      }
      // Any other refusal, or a second loss: every applied action is refused with the save's own words.
      for (const { i } of pure) { const o = outcomes[i]; if (o?.status === "applied") outcomes[i] = { status: "refused", label: o.label, why: saved.message }; }
      // Done.
      break;
    }
  }
  // 2. The master-writing actions, one at a time, each on a freshly read row (the previous one moved the stamp).
  for (const { i, action } of attests) {
    // The card label.
    const label = actionLabel(action as ServerAction);
    // Past the deadline.
    if (deps.now() > args.deadline) { outcomes[i] = { status: "refused", label, why: OUT_OF_TIME }; continue; }
    // Fresh row.
    const fresh = await loadRow(db, args.applicationId);
    // Unreadable.
    if (!fresh.ok) { outcomes[i] = { status: "refused", label, why: fresh.why }; continue; }
    // A skill: at the pin, or a new master version plus a repin (attestSkill decides).
    if (action.kind === "attest_skill") {
      // The browser's own call (Page:1666), with the row read here.
      const result = await attestSkill(db, { applicationId: args.applicationId, keyword: action.keyword, category: action.category, current: fresh.current, original: fresh.original, tailorRefs: fresh.tailorRefs, expectedUpdatedAt: fresh.stamp, newSkillId: `skill_${deps.uuid()}`, source: "ai_chat_auto", pinnedMaster: fresh.master, jdKeywords: fresh.jd, wrap: "refuse" });
      // Landed or refused, in its own words.
      outcomes[i] = result.ok ? { status: "applied", label } : { status: "refused", label, why: result.message };
      // The new stamp.
      if (result.ok) updatedAt = result.updatedAt;
      // Next.
      continue;
    }
    // A dictated bullet (the parser already refused undictated words).
    if (action.kind === "attest_bullet") {
      // The browser's own call (Page:1744).
      const result = await attestBullet(db, { applicationId: args.applicationId, section: action.section, parentRef: action.parentRef, text: action.text, current: fresh.current, original: fresh.original, tailorRefs: fresh.tailorRefs, expectedUpdatedAt: fresh.stamp, newBulletId: `bullet_${deps.uuid()}`, source: "ai_chat_auto", jdKeywords: fresh.jd });
      // Landed or refused.
      outcomes[i] = result.ok ? { status: "applied", label } : { status: "refused", label, why: result.message };
      // The new stamp.
      if (result.ok) updatedAt = result.updatedAt;
    }
  }
  // Every op has an outcome (a gap would be a bug: reported, never silently dropped).
  return { outcomes: outcomes.map((o, i) => o ?? { status: "refused", label: args.ops[i]!.op, why: "Not applied (internal: no outcome)." }), updatedAt };
}
