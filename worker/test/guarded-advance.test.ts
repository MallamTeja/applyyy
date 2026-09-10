// The transition guard is the single choke point through which every status
// write in the worker passes, so its tests are the ones that hold constraint #7
// (never submit twice) and constraint #15 (never submit without approval) up.
//
// What makes these tests worth writing rather than trusting the database: the
// guard trigger in Postgres WOULD reject an illegal edge, but it rejects it
// after the worker has already driven a real browser at a real employer's form.
// Failing fast in TypeScript means a bad edge is caught before Playwright
// launches, not mid-submit with an unknown real-world outcome.
import { describe, expect, it, vi } from 'vitest';
import { guardedAdvance } from '../src/guarded-advance.ts';

describe('guardedAdvance', () => {
  it('performs a legal transition for the acting agent', async () => {
    // A spy standing in for the gateway write; asserting it was CALLED is the
    // point, because the guard's job is to let legal edges straight through.
    const advance = vi.fn(async () => {});

    // approved -> applying is the only door into `applying` in the whole graph,
    // and `applier` is the only actor allowed through it.
    await guardedAdvance(
      { advanceStatus: advance },
      { applicationId: 'app-1', from: 'approved', to: 'applying', agent: 'applier' },
    );

    // The write must reach the gateway unchanged; the guard is a gate, not a
    // translator, and any rewriting here would desynchronise it from the DB.
    expect(advance).toHaveBeenCalledWith('app-1', 'applying', 'applier', undefined);
  });

  it('refuses an edge that does not exist in the graph without writing', async () => {
    // Same spy; this time the assertion that matters is that it is NEVER called.
    const advance = vi.fn(async () => {});

    // approved -> applied would skip `applying` entirely, which means skipping
    // the one status the sweeper uses to detect a half-finished submission.
    await expect(
      guardedAdvance(
        { advanceStatus: advance },
        { applicationId: 'app-1', from: 'approved', to: 'applied', agent: 'applier' },
      ),
    ).rejects.toThrow(/approved -> applied/);

    // Not writing is the whole guarantee: a rejected edge must cost nothing.
    expect(advance).not.toHaveBeenCalled();
  });

  it('refuses a real edge the acting agent is not allowed to make', async () => {
    // THE SAFETY-CRITICAL CASE, and the one a future refactor is most likely to
    // reintroduce, because the edge genuinely exists and looks harmless.
    const advance = vi.fn(async () => {});

    // applying -> needs_verification is `['sweeper','human']`. If the applier
    // could make this move it could decide for itself that a submission it is
    // unsure about did not happen — and the only route out of
    // needs_verification is human-only, so a machine writing this edge would be
    // laundering an unknown submit back toward the queue.
    await expect(
      guardedAdvance(
        { advanceStatus: advance },
        { applicationId: 'app-1', from: 'applying', to: 'needs_verification', agent: 'applier' },
      ),
    ).rejects.toThrow(/applier/);

    expect(advance).not.toHaveBeenCalled();
  });

  it('passes the detail payload through on a legal transition', async () => {
    // Detail rides along to application_events, which is what makes "why is this
    // row blocked" answerable later without log archaeology.
    const advance = vi.fn(async () => {});

    // applying -> blocked_needs_human is `['applier']`, so the captcha path is
    // legal for this worker and needs no new edge in the graph.
    await guardedAdvance(
      { advanceStatus: advance },
      {
        applicationId: 'app-2',
        from: 'applying',
        to: 'blocked_needs_human',
        agent: 'applier',
        detail: { block_reason: 'captcha' },
      },
    );

    expect(advance).toHaveBeenCalledWith('app-2', 'blocked_needs_human', 'applier', {
      block_reason: 'captcha',
    });
  });
});
