// THE KILL SWITCH — PROJECT_PLAN.md §18.1, and the one safety-critical check in this
// stream that every single agent performs before anything else.
//
// WHY IT LIVES IN ITS OWN MODULE rather than as three lines inside each agent: there are
// five agents, and a rule that depends on five callers each remembering to do the same
// thing first is not a rule, it is a hope. One function, called from one place in the
// shared loop, is checkable in one place.
//
// ────────────────────────────────────────────────────────────────────────────────────
// THE SWITCH HAS THREE "OFF" STATES AND ONLY ONE OF THEM IS OBVIOUS.
//
//   1. `system_enabled = false`  — the deliberate stop. What Teja flips at 2am.
//   2. NO settings row at all    — the account was never bootstrapped. THIS IS THE
//                                  CURRENT STATE OF THE LIVE DATABASE, so it is
//                                  production behaviour and not a hypothetical.
//   3. The read FAILED           — transport, RLS, a paused project.
//
// The natural implementation gets 2 and 3 wrong IN THE SAME DIRECTION: an absent row
// reads as an absent objection, and a failed read looks like something to retry past.
// Both would have an agent acting on Teja's behalf while unable to confirm it is allowed
// to, which is the worst behaviour available to a system that submits real applications.
//
// So all three halt, and they halt with DIFFERENT NAMES, because the remedies are
// different: `disabled` needs nobody, `no_settings_row` needs one RPC call, `unreadable`
// is a genuine incident. A health page that cannot tell them apart reports an outage
// every time Teja pauses the system — and a page that cries wolf is a page he stops
// reading, which quietly costs more than the bug it was supposed to surface.
//
// NOTE WHAT THIS IS NOT: it is not the only enforcement. `claim_applications()` and
// `claim_gemini_key()` both check `system_enabled` internally, so an agent that skipped
// this call would still claim nothing. That redundancy is deliberate — but the SQL check
// alone would present as "the queue is empty", indistinguishable from a quiet day. This
// check is what turns the same condition into a named, visible reason.

// The settings read is the only port this module touches.
import type { RunPort, SettingsSnapshot } from "./port.ts";

// The verdict. A discriminated union rather than a boolean, because the three refusals
// demand three different operator responses and a boolean would erase the distinction
// at exactly the moment it is needed.
export type KillSwitchVerdict =
  // Proceed. Carries the settings so the caller does not read the same row twice —
  // every field the pipeline needs downstream is on it.
  | { readonly allowed: true; readonly settings: SettingsSnapshot }
  // Teja turned it off. NOT an incident: no alert, no error count, and the run is
  // recorded as `skipped_disabled` so the health page can say why nothing happened.
  | { readonly allowed: false; readonly reason: "disabled"; readonly detail: null }
  // The account was never bootstrapped. Needs a human, but a different human action
  // than an outage would: the orchestrator, AS postgres, runs
  // `select applyy_internal.seed_user_defaults('<user_id>')` once (the id copied from
  // auth.users). Not `public.bootstrap_user_defaults()`: since migration 20261105203000
  // `authenticated` has no EXECUTE on it, and as postgres it reads a NULL auth.uid() and
  // refuses (42501). Normally the signup trigger (20261008180000) seeds the row, so this
  // reason means that trigger raised its never-blocking WARNING for this user.
  | { readonly allowed: false; readonly reason: "no_settings_row"; readonly detail: null }
  // The control panel could not be read. The only one of the three that is an incident.
  | { readonly allowed: false; readonly reason: "unreadable"; readonly detail: string };

// Ask whether this agent may do any work at all.
//
// CALLED FIRST, BEFORE EVERYTHING — before opening a run row, before sweeping, before
// claiming. Cheap by construction (one indexed single-row read) precisely so that
// "put it first" is never in tension with "save a round trip"; the moment it were
// expensive, somebody would move it after the claim as an optimisation.
export async function checkKillSwitch(port: RunPort): Promise<KillSwitchVerdict> {
  // The one read.
  const result = await port.readSettings();
  // COULD NOT READ. Fail closed: an agent that cannot confirm it is permitted to act
  // must not act. The reason is carried through so the incident is diagnosable rather
  // than presenting as an unexplained idle pipeline.
  if (!result.ok) return { allowed: false, reason: "unreadable", detail: result.reason };
  // NO ROW. The schema defaults `system_enabled` to FALSE for exactly this reason, and
  // absence must inherit that default rather than being read as permission.
  if (result.value === null) return { allowed: false, reason: "no_settings_row", detail: null };
  // THE DELIBERATE STOP. Checked last of the three so a genuine off-switch is never
  // misreported as a configuration problem.
  if (!result.value.systemEnabled) return { allowed: false, reason: "disabled", detail: null };
  // Permitted. The settings travel with the verdict so the caller has the budget and
  // the dry-run flag without a second query.
  return { allowed: true, settings: result.value };
}
