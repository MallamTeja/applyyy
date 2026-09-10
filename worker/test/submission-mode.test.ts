// Tests for the DRY_RUN gate — the control that decides whether the applier
// merely fills a form or actually sends an application to a real employer.
//
// PROJECT_PLAN.md §18.6 runs the first three days with nothing submitted so
// Teja can review screenshots of exactly what WOULD have been sent, then flips
// the flag. Constraint #15 forbids automating final submission by default.
// Every test here therefore checks the same property from a different angle:
// anything other than an unambiguous, deliberate opt-in means DO NOT SUBMIT.
import { describe, expect, test } from 'vitest';

// Subject under test; absent, which is what makes this file RED.
import { resolveSubmissionMode } from '../src/submission-mode.ts';

describe('resolveSubmissionMode', () => {
  test('defaults to dry-run when DRY_RUN is unset', () => {
    // The empty environment is the case that matters most: a fresh runner, a
    // forgotten secret, a misspelled variable name in a workflow file. None of
    // those should be able to post an application.
    const mode = resolveSubmissionMode({});
    // Fail-closed default. This is the assertion protecting §18.6's trust period.
    expect(mode.submits).toBe(false);
  });

  test('submits only when DRY_RUN is exactly the string "false"', () => {
    // The single deliberate opt-in path. Written as an exact match so that
    // turning submission ON is always a conscious, unambiguous act.
    const mode = resolveSubmissionMode({ DRY_RUN: 'false' });
    // The one case in this file that is allowed to be true.
    expect(mode.submits).toBe(true);
  });

  test.each([
    // Casing variants: a workflow author writing "False" meant to disable dry
    // run, but guessing their intent is how an accidental submission happens.
    ['False'],
    ['FALSE'],
    // Truthy-looking strings that a shell or YAML might produce.
    ['0'],
    ['no'],
    ['off'],
    // Empty string: what `DRY_RUN: ${{ secrets.MISSING }}` expands to in GitHub
    // Actions when the secret does not exist. This is a real, likely failure.
    [''],
    // Whitespace, which a copy-pasted secret value carries surprisingly often.
    [' false '],
  ])('treats DRY_RUN=%j as dry-run rather than guessing intent', (value) => {
    // Every ambiguous value collapses to the safe branch. The system refuses to
    // interpret; it demands the exact opt-in or it does nothing irreversible.
    const mode = resolveSubmissionMode({ DRY_RUN: value });
    // A single wrong answer here is a real application sent without approval.
    expect(mode.submits).toBe(false);
  });

  test('explains why it chose dry-run so the run log is auditable', () => {
    // §18.6 depends on Teja being able to read a run and know what it did. A
    // bare boolean in a log cannot distinguish "deliberately dry" from
    // "misconfigured and silently dry", which is the failure §14 is about.
    const mode = resolveSubmissionMode({ DRY_RUN: 'nonsense' });
    // The reason must name the offending value, not just say "dry run".
    expect(mode.reason).toContain('nonsense');
  });
});
