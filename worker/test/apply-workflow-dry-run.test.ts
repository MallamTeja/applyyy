// W30 (wiring audit 2026-11-01): apply.yml decided DRY_RUN with a GitHub expression, and
// GitHub's `==` ignores case. `dry_run=FALSE` ran live, and `APPLYY_CRON_LIVE=TRUE` made
// cron live. The decision now lives in the "Run the applier" step's shell, compared with `=`.
//
// WHY THIS RUNS THE WORKFLOW'S OWN SHELL instead of a copy or a script: the step text IS the
// control. A copy in a test or a helper script could be fixed while the YAML stays broken.
// So the test cuts the `run: |` block out of apply.yml and runs it in bash, the shell GitHub
// uses on ubuntu-latest, with `pnpm` replaced by a shell function that prints what the worker
// would receive. Asserting the positive outcome (DRY_RUN=true|false) rather than the absence
// of `==` in the YAML follows CLAUDE.md §6: a substring ban fires on the comment naming it.
//
// Needs bash on PATH. CI is ubuntu; locally, run vitest from Git Bash (from PowerShell,
// `bash` resolves to the WSL stub in System32 first).
import { describe, expect, test } from 'vitest';
// The workflow is read from disk, so the test always runs the committed step.
import { readFileSync } from 'node:fs';
// bash runs the step exactly once per case, synchronously, with a clean environment.
import { spawnSync } from 'node:child_process';

/** The `run: |` body of the step named `name`, dedented, or a throw when its shape is not found. */
function stepScript(workflow: string, name: string): string {
  // Lines, so indentation can be measured; the repo checks this file out with LF (measured).
  const lines = workflow.split('\n');
  // The step's own `- name:` line.
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  // A renamed step must fail loudly, never run an empty script that passes (§6).
  if (start < 0) throw new Error(`apply.yml has no step named ${JSON.stringify(name)}`);
  // The step's `run: |` line, the first one after its name.
  const runAt = lines.findIndex((line, index) => index > start && line.trim() === 'run: |');
  // Same rule: no block scalar, no test.
  if (runAt < 0) throw new Error(`step ${JSON.stringify(name)} has no "run: |" block`);
  // The block's indentation is set by its first line.
  const first = lines[runAt + 1] ?? '';
  // Leading spaces of that line.
  const indent = first.length - first.trimStart().length;
  // Collected until a non-blank line indented less than the block (the step's `env:` key).
  const body: string[] = [];
  // Walk forward from the first body line.
  for (let index = runAt + 1; index < lines.length; index += 1) {
    // The current line.
    const line = lines[index]!;
    // A shallower non-blank line ends the block scalar.
    if (line.trim() !== '' && line.length - line.trimStart().length < indent) break;
    // Dedented, as YAML hands it to the shell.
    body.push(line.slice(indent));
  }
  // The script text.
  return body.join('\n');
}

// The committed workflow, resolved from this test file so the cwd does not matter.
const workflow = readFileSync(new URL('../../.github/workflows/apply.yml', import.meta.url), 'utf8');
// The applier step's shell, cut out once.
const script = stepScript(workflow, 'Run the applier');

/** Runs the step as GitHub would, with only the given variables set, and reports what the worker would get. */
function runStep(env: Record<string, string>): { code: number | null; worker: string | null; cap: string | null; stdout: string; stderr: string } {
  // `pnpm` becomes a function, which bash prefers over any PATH binary: it prints the worker's view.
  // A second line carries the per-run cap (P1-6), so the existing exact WORKER-line asserts stay as they were.
  const fakePnpm = 'pnpm() { echo "WORKER DRY_RUN=${DRY_RUN-unset} APPLY_ONLY_ID=${APPLY_ONLY_ID-unset}"; echo "WORKER_CAP APPLY_MAX_SUBMITS=${APPLY_MAX_SUBMITS-unset}"; }';
  // GitHub's bash invocation on ubuntu: errexit and pipefail on.
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', `${fakePnpm}\n${script}`], {
    // Captured as text.
    encoding: 'utf8',
    // PATH only, so no DRY_RUN or APPLY_ONLY_ID from the caller's shell can leak into a case.
    env: { PATH: process.env['PATH'] ?? '', ...env },
  });
  // The fake worker's one line, or null when the step stopped before starting it.
  const worker = result.stdout.split('\n').find((line) => line.startsWith('WORKER ')) ?? null;
  // The cap the worker would get, or null when it never started.
  const cap = result.stdout.split('\n').find((line) => line.startsWith('WORKER_CAP '))?.slice('WORKER_CAP '.length) ?? null;
  // Everything a failing case needs to explain itself.
  return { code: result.status, worker, cap, stdout: result.stdout, stderr: result.stderr };
}

// A real-shaped application id for the manual live cases.
const ID = 'ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154';

describe('apply.yml "Run the applier" decides DRY_RUN by exact comparison (W30)', () => {
  test('W30: a manual run with dry_run exactly "false" and an id runs live, on that one row', () => {
    // The one manual opt-in.
    const out = runStep({ EVENT_NAME: 'workflow_dispatch', DRY_RUN_INPUT: 'false', ONLY_ID: ID });
    // Started, live, and filtered to the one id.
    expect(out.code, out.stderr).toBe(0);
    expect(out.worker).toBe(`WORKER DRY_RUN=false APPLY_ONLY_ID=${ID}`);
  });

  test('W30: dry_run "FALSE" (any case but exact) stays dry; GitHub\'s == would have run it live', () => {
    // Each spelling the case-insensitive expression accepted, plus padded and blank values.
    for (const input of ['FALSE', 'False', 'false ', ' false', '', 'no']) {
      // Same id, so only the input differs from the live case above.
      const out = runStep({ EVENT_NAME: 'workflow_dispatch', DRY_RUN_INPUT: input, ONLY_ID: ID });
      // Started (a dry run needs no guard), and dry.
      expect(out.code, `${JSON.stringify(input)}: ${out.stderr}`).toBe(0);
      expect(out.worker, JSON.stringify(input)).toBe(`WORKER DRY_RUN=true APPLY_ONLY_ID=${ID}`);
    }
  });

  test('W30: cron is live only when APPLYY_CRON_LIVE is exactly "true"', () => {
    // The scheduled opt-in.
    expect(runStep({ EVENT_NAME: 'schedule', CRON_LIVE: 'true' }).worker).toBe('WORKER DRY_RUN=false APPLY_ONLY_ID=unset');
    // Every near miss stays dry, including the case GitHub's == accepted.
    for (const value of ['TRUE', 'True', 'true ', '', '1', 'yes']) {
      // A scheduled run supplies no inputs, so only the variable differs.
      expect(runStep({ EVENT_NAME: 'schedule', CRON_LIVE: value }).worker, JSON.stringify(value)).toBe('WORKER DRY_RUN=true APPLY_ONLY_ID=unset');
    }
    // An unset variable (GitHub expands it to '') also stays dry.
    expect(runStep({ EVENT_NAME: 'schedule' }).worker).toBe('WORKER DRY_RUN=true APPLY_ONLY_ID=unset');
  });

  test('W30: a manual run never reads APPLYY_CRON_LIVE', () => {
    // The variable is on, but this is a manual run with the default input.
    const out = runStep({ EVENT_NAME: 'workflow_dispatch', DRY_RUN_INPUT: 'true', CRON_LIVE: 'true' });
    // Dry: the variable governs cron alone.
    expect(out.worker).toBe('WORKER DRY_RUN=true APPLY_ONLY_ID=unset');
  });

  test('guard 1 kept: a live manual run without apply_only_id is refused before the worker starts', () => {
    // The whole-queue live submit the guard exists to stop.
    const out = runStep({ EVENT_NAME: 'workflow_dispatch', DRY_RUN_INPUT: 'false' });
    // Red, with the annotation, and the worker never ran.
    expect(out.code).toBe(1);
    expect(out.stdout).toContain('::error::dry_run=false requires apply_only_id');
    expect(out.worker).toBeNull();
  });
});

// P1-6 (2026-11-05): apply on approve. dispatch-apply starts a LIVE manual run with drain_approved
// "true": the whole approved queue, no per-run cap (the breaker and the settings daily cap still stop
// it). Everything else keeps Guard 1's one-application rule.
describe('apply.yml drain_approved (P1-6)', () => {
  // The cap the workflow's step env always sets; a drain replaces it.
  const STEP_ENV = { APPLY_MAX_SUBMITS: '3' };

  test('a live manual drain runs the whole queue with APPLY_MAX_SUBMITS=unlimited', () => {
    // Exactly what dispatch-apply sends.
    const out = runStep({ ...STEP_ENV, EVENT_NAME: 'workflow_dispatch', DRY_RUN_INPUT: 'false', DRAIN_INPUT: 'true' });
    // Ran, live, over the whole queue.
    expect(out.code).toBe(0);
    // No single-row filter.
    expect(out.worker).toBe('WORKER DRY_RUN=false APPLY_ONLY_ID=unset');
    // No per-run cap.
    expect(out.cap).toBe('APPLY_MAX_SUBMITS=unlimited');
  });

  test('anything but the exact "true" is not a drain: a live manual run is refused as before', () => {
    // Case and typos compare unequal, like dry_run's "false" (W30).
    for (const drain of ['TRUE', 'True', 'yes', '1', '']) {
      // Live, no single id, a near-miss drain.
      const out = runStep({ ...STEP_ENV, EVENT_NAME: 'workflow_dispatch', DRY_RUN_INPUT: 'false', DRAIN_INPUT: drain });
      // Refused by Guard 1 before the worker starts.
      expect(out.code, drain).toBe(1);
      // The worker never ran.
      expect(out.worker, drain).toBeNull();
    }
  });

  test('a drain naming one application is refused as ambiguous', () => {
    // Both scopes at once.
    const out = runStep({ ...STEP_ENV, EVENT_NAME: 'workflow_dispatch', DRY_RUN_INPUT: 'false', DRAIN_INPUT: 'true', ONLY_ID: ID });
    // Red, said why, worker never ran.
    expect(out.code).toBe(1);
    expect(out.stdout).toContain('::error::drain_approved and apply_only_id cannot both be set');
    expect(out.worker).toBeNull();
  });

  test('a scheduled run never drains, and keeps the per-run cap', () => {
    // Cron supplies no inputs; even a leaked value must not lift the cap.
    const out = runStep({ ...STEP_ENV, EVENT_NAME: 'schedule', CRON_LIVE: 'true', DRAIN_INPUT: 'true' });
    // The cron run, live under the variable, capped.
    expect(out.cap).toBe('APPLY_MAX_SUBMITS=3');
  });

  test('a manual run with apply_only_id keeps the per-run cap', () => {
    // The 1-job proof run.
    const out = runStep({ ...STEP_ENV, EVENT_NAME: 'workflow_dispatch', DRY_RUN_INPUT: 'false', ONLY_ID: ID });
    // One application, capped as before.
    expect(out.worker).toBe(`WORKER DRY_RUN=false APPLY_ONLY_ID=${ID}`);
    // Unchanged.
    expect(out.cap).toBe('APPLY_MAX_SUBMITS=3');
  });
});
