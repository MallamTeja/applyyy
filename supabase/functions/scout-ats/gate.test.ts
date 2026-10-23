// Node test runner, same as every other pure-function test in supabase/functions.
import { test } from "node:test";
// Bare asserts; no framework (repo convention).
import assert from "node:assert/strict";
// The gate under test.
import { haltedByKillSwitch } from "./gate.ts";

test("force=true does not bypass the kill switch", () => {
  // The whole point: a disabled system halts even a forced manual run.
  assert.equal(haltedByKillSwitch(false, true), true);
  // The ordinary scheduled run halts too.
  assert.equal(haltedByKillSwitch(false, false), true);
  // An enabled system runs, forced or not — the switch halts, it never blocks.
  assert.equal(haltedByKillSwitch(true, true), false);
  assert.equal(haltedByKillSwitch(true, false), false);
});
