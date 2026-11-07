/* The one Workday predicate (2026-11-07). apply-one's guard, the rehearse CLI and the web's Manual
 * apply card all ask "is this a Workday job?"; before this file only apply-one could answer, so
 * rehearse-assist launched a browser at a Workday form it must never touch. These cases pin the
 * shared answer so the three callers cannot drift apart. */

// vitest, as every worker test.
import { describe, expect, it } from 'vitest';
// The module under test.
import { isWorkdayApplyUrl, isWorkdayJob, WORKDAY_REFUSAL } from '../src/workday.ts';
// apply-one must keep exporting the predicate: worker tests and any relative importer still use it there.
import { isWorkdayApplyUrl as fromApplyOne } from '../src/apply-one.ts';

describe('isWorkdayJob', () => {
  // The host alone is enough: a pasted Workday link can arrive with provider `unknown`.
  it('is true for a Workday host whatever the provider', () => {
    // A real tenant URL shape.
    expect(isWorkdayJob('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/123', 'unknown')).toBe(true);
  });

  // The provider alone is enough: a tenant fronted on the company's own domain.
  it('is true for provider workday on a non-Workday host', () => {
    // careers.company.com in front of Workday.
    expect(isWorkdayJob('https://careers.acme.com/job/123', 'workday')).toBe(true);
  });

  // Neither signal: not Workday. Null inputs never throw and never match.
  it('is false with neither signal, including missing values', () => {
    // A Greenhouse job.
    expect(isWorkdayJob('https://job-boards.greenhouse.io/acme/jobs/1', 'greenhouse')).toBe(false);
    // Nothing known: "—" on the card, never a guess.
    expect(isWorkdayJob(null, null)).toBe(false);
  });

  // A Workday name in a path or a look-alike host is not a Workday host.
  it('matches the host, never a substring', () => {
    // Look-alike apex.
    expect(isWorkdayApplyUrl('https://evilmyworkdayjobs.com/x')).toBe(false);
    // Name in the path.
    expect(isWorkdayApplyUrl('https://example.com/myworkdayjobs.com')).toBe(false);
  });

  // apply-one re-exports the same function, so its guard and tests keep working.
  it('is the same function apply-one exports', () => {
    // Identity, not just equal behaviour.
    expect(fromApplyOne).toBe(isWorkdayApplyUrl);
  });

  // The refusal line the guard and the CLI both print.
  it('names the account requirement in its refusal line', () => {
    // The words Teja reads on the card and in the CLI table.
    expect(WORKDAY_REFUSAL).toMatch(/candidate account/);
  });
});
