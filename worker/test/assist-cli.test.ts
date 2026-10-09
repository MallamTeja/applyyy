// The assist CLI must refuse to start without the machine-agent key.
//
// Without APPLYY_AGENT_KEY every agent RPC (claim, advance, release) fails with 42501 only
// AFTER sign-in and a browser launch, so the human fills a form whose status can never be
// recorded. The check belongs at startup, before any network call.
//
// A SUBPROCESS rather than an import: assist.ts runs main() on import, so importing it here
// would execute the real CLI inside the test runner. Spawning it is also the honest test:
// it observes the exit code and stderr exactly as Teja sees them in a terminal.
import { spawnSync } from 'node:child_process';
// Resolves the worker directory from this file, so the test runs from any cwd.
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The worker package root, where `src/cli/assist.ts` resolves relative to.
const workerDir = fileURLToPath(new URL('..', import.meta.url));

/** Runs the assist CLI with exactly `extra` added to a minimal, otherwise-complete environment. */
function runAssist(extra: Record<string, string>) {
  // A fixed, well-formed id so --id parsing passes and the agent-key check is the next gate.
  const args = ['src/cli/assist.ts', '--id', '00000000-0000-4000-8000-000000000000'];
  // Built from scratch rather than spreading process.env, so a developer's real key cannot leak in.
  const env = {
    // Needed to resolve the node binary's own dependencies on every OS.
    PATH: process.env.PATH ?? '',
    // Windows refuses to start some processes without it.
    SystemRoot: process.env.SystemRoot ?? '',
    // Port 9 (discard) on loopback refuses, so even a regression never reaches a real host.
    SUPABASE_URL: 'http://127.0.0.1:9',
    // Present so a missing anon key cannot be the error that ends the run.
    SUPABASE_ANON_KEY: 'anon-test',
    // Present so the user credentials cannot be the error that ends the run either.
    APPLYY_APP_USER_EMAIL: 'nobody@example.test',
    // Same reason: only the agent key is allowed to be what is missing.
    APPLYY_APP_USER_PASSWORD: 'x',
    // The per-test variation (an empty key, or nothing at all).
    ...extra,
  };
  // Synchronous: the test has nothing to do until the process exits. 60s caps a hang.
  return spawnSync(process.execPath, args, { cwd: workerDir, env, encoding: 'utf8', timeout: 60_000 });
}

describe('assist CLI startup', () => {
  it('assist refuses to start without APPLYY_AGENT_KEY', () => {
    // No extra env: the key is simply absent, the realistic fresh-shell mistake.
    const result = runAssist({});

    // A non-zero exit is what a script or a human notices.
    expect(result.status).toBe(1);
    // Names the missing variable, so the fix is obvious from the message alone.
    expect(result.stderr).toContain('APPLYY_AGENT_KEY is not set');
    // Proves it stopped BEFORE the network: sign-in is the first call that would fail here.
    expect(result.stderr).not.toContain('sign-in failed');
  }, 70_000);

  it('assist refuses an empty APPLYY_AGENT_KEY', () => {
    // An empty value is how a missing GitHub secret or a blank `set` arrives; it must count as absent.
    const result = runAssist({ APPLYY_AGENT_KEY: '' });

    // Same refusal as the absent case.
    expect(result.status).toBe(1);
    // Same message: empty and absent are one failure.
    expect(result.stderr).toContain('APPLYY_AGENT_KEY is not set');
    // Still stopped before any network call.
    expect(result.stderr).not.toContain('sign-in failed');
  }, 70_000);
});
