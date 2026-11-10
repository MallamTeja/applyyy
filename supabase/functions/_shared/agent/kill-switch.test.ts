// THE KILL SWITCH (§18.1) — safety-critical, so it gets the most direct tests here.
//
// What makes this worth its own file: the switch has THREE "off" states and only one of
// them is the one anybody thinks about. `system_enabled = false` is the deliberate stop.
// A MISSING settings row and an UNREADABLE settings row are also "off", and the natural
// implementations of both are wrong in the same direction — an absent row reads as an
// absent objection, and a failed read gets retried past. Every one of those must halt.
import { test } from "node:test";
// Strict, so `undefined` never quietly compares equal to `false`.
import assert from "node:assert/strict";
// Extension-suffixed specifier so this runs under Deno and `node --test` alike.
import { checkKillSwitch } from "./kill-switch.ts";
// The shared recording double.
import { makeFakePort } from "./test-port.ts";
// The settings projection.
import type { SettingsSnapshot } from "./port.ts";

// A control panel with the switch ON. Every other field is ordinary.
const ENABLED: SettingsSnapshot = {
  systemEnabled: true,
  dryRun: true,
  geminiDailyCallBudget: null,
};

// NON-VACUITY TWIN, and it comes first deliberately: a guard that refuses everything
// passes every rejection test below while stopping the whole system. This is the test
// that distinguishes a correct kill switch from a broken-closed one.
test("an enabled system is allowed to proceed, and carries its settings forward", async () => {
  // A control panel with the switch on.
  const port = makeFakePort({ settings: ENABLED });
  // Ask.
  const verdict = await checkKillSwitch(port);
  // Allowed.
  assert.equal(verdict.allowed, true);
  // And the settings are handed back, so the caller does not read them twice.
  // dryRun is the sentinel now that freshnessWindowDays is retired (2026-11-10): any
  // field that only the fixture sets proves the same row came back.
  assert.equal(verdict.allowed === true && verdict.settings.dryRun, true);
});

test("system_enabled = false halts the agent", async () => {
  // The deliberate stop: one row, one boolean, every agent halted on its next tick.
  const port = makeFakePort({ settings: { ...ENABLED, systemEnabled: false } });
  // Ask.
  const verdict = await checkKillSwitch(port);
  // Refused.
  assert.equal(verdict.allowed, false);
  // And the reason distinguishes a deliberate stop from a configuration failure, which
  // is what stops the health page reporting an incident for a switch Teja flipped.
  assert.equal(verdict.allowed === false && verdict.reason, "disabled");
});

test("a MISSING settings row halts the agent — absence is not consent", async () => {
  // NO LONGER the live state (CORRECTED 2026-10-24: the signup trigger `20261008180000`
  // seeds defaults via `seed_user_defaults`). A mis-provisioned account can still lack
  // the row, so the halt-on-absence contract stays tested as a regression guard.
  const port = makeFakePort({ settings: null });
  // Ask.
  const verdict = await checkKillSwitch(port);
  // Refused. A missing kill switch must read as "off", never as "no objection" — the
  // schema defaults `system_enabled` to FALSE for exactly this reason.
  assert.equal(verdict.allowed, false);
  // Named distinctly, because the remedy differs: this one needs a human to bootstrap
  // the account, whereas `disabled` needs nobody.
  assert.equal(verdict.allowed === false && verdict.reason, "no_settings_row");
});

test("an UNREADABLE control panel halts the agent — fail closed, never fail open", async () => {
  // A transport failure, an RLS surprise, a paused project. All the same shape.
  const port = makeFakePort({ settingsError: "connection reset" });
  // Ask.
  const verdict = await checkKillSwitch(port);
  // Refused. Proceeding here would be an agent submitting applications while unable to
  // confirm it is allowed to — the single worst behaviour available to this system.
  assert.equal(verdict.allowed, false);
  // Distinct again: this is the only one of the three that is a genuine incident.
  assert.equal(verdict.allowed === false && verdict.reason, "unreadable");
  // And the underlying error survives to the log, or the incident is undiagnosable.
  assert.match(String(verdict.allowed === false ? verdict.detail : ""), /connection reset/);
});

test("the kill switch reads settings and NOTHING else", async () => {
  // The check must be cheap enough that putting it first costs nothing — otherwise
  // somebody will move it after the claim to "save a round trip".
  const port = makeFakePort({ settings: ENABLED });
  // Ask.
  await checkKillSwitch(port);
  // Exactly one call, and it is the settings read.
  assert.deepEqual(port.names(), ["readSettings"]);
});
