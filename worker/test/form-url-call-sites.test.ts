// The resolver's two call sites (2026-10-24): the applier (applyToOne) and the kit
// (buildApplyKit) must both ask robots.txt about, and open, the RESOLVED form URL, and the
// kit must record it as form_url. Without these, form-url.ts could be correct and unused,
// which is the failure this repo already met once (a ten-test gate with no callers).
//
// No browser: a page whose goto records the URL and then throws stops each path right
// after the load, which is the last point either path reads the URL.

// vitest, as every worker test.
import { describe, expect, test } from 'vitest';
// Types only: the shapes the fakes satisfy.
import type { MasterProfile } from '@applyy/shared-types';
// The applier entry point and its port types.
import { applyToOne, type ApplierGateway, type ApplicationPage, type ClaimedApplication, type RobotsCheck } from '../src/apply-one.ts';
// The kit entry point and its port types.
import { buildApplyKit, type KitGateway, type KitPage } from '../src/apply-kit.ts';
// The resolver port.
import type { FormUrlResolver } from '../src/form-url.ts';

// The live Aiven wrapper page.
const WRAPPER = 'https://aiven.io/careers/job/4901533101?gh_jid=4901533101';
// The form it resolves to.
const FORM = 'https://job-boards.greenhouse.io/embed/job_app?for=aiven36&token=4901533101';
// A resolver that always answers the form, as a confirmed lookup would.
const resolve: FormUrlResolver = async () => FORM;
// Thrown by goto so each path stops right after the page load.
const STOP = 'stop after goto';

// A robots check that records the URL it was asked about, and allows it.
function recordingRobots(): RobotsCheck & { urls: string[] } {
  // Every URL asked.
  const urls: string[] = [];
  // Allow, so the path continues to goto.
  return Object.assign(async (url: string) => {
    // Recorded.
    urls.push(url);
    // An explicit allow, the only verdict that passes.
    return { kind: 'allow' as const, reason: 'test', crawlDelayMs: null };
  }, { urls });
}

// A page whose goto records and then stops the path.
function stoppingPage(): { page: ApplicationPage & KitPage; gotos: string[] } {
  // Every URL loaded.
  const gotos: string[] = [];
  // Only what both paths touch before and at goto; the rest is never reached.
  const page = {
    // A dry-run page: nothing could be sent even if the path got that far.
    submissionImplemented: false,
    // Records, then stops.
    goto: async (url: string) => {
      // Recorded.
      gotos.push(url);
      // Stops the path here.
      throw new Error(STOP);
    },
  } as unknown as ApplicationPage & KitPage;
  // Both handles.
  return { page, gotos };
}

describe('applyToOne opens the resolved form', () => {
  // The claimed row as the gateway hands it over.
  const row: ClaimedApplication = { id: '0fcd296f-f23b-42ff-b513-8a861f36915b', status: 'approved', applyUrl: WRAPPER, tailoredProfile: null, employerName: 'Aiven' } as unknown as ClaimedApplication;

  test('robots and goto both see the resolved URL', async () => {
    // The two recorders.
    const robots = recordingRobots();
    // The stopping page.
    const { page, gotos } = stoppingPage();
    // Run up to the load.
    await expect(applyToOne({ row, page, gateway: {} as ApplierGateway, answers: [], env: {}, renderResume: async () => { throw new Error('not reached'); }, checkRobots: robots, resolveFormUrl: resolve })).rejects.toThrow(STOP);
    // The gate was asked about the form.
    expect(robots.urls).toEqual([FORM]);
    // And the form was what loaded.
    expect(gotos).toEqual([FORM]);
  });

  test('without a resolver, the stored URL is used (today\'s behaviour)', async () => {
    // The two recorders.
    const robots = recordingRobots();
    // The stopping page.
    const { page, gotos } = stoppingPage();
    // No resolveFormUrl passed.
    await expect(applyToOne({ row, page, gateway: {} as ApplierGateway, answers: [], env: {}, renderResume: async () => { throw new Error('not reached'); }, checkRobots: robots })).rejects.toThrow(STOP);
    // Unchanged.
    expect(gotos).toEqual([WRAPPER]);
  });
});

describe('buildApplyKit reads the resolved form', () => {
  // A gateway with just the reads that run before the page load.
  const gateway = {
    // The Aiven row at a kit status.
    fetchApplication: async () => ({ id: '0fcd296f-f23b-42ff-b513-8a861f36915b', status: 'blocked_needs_human', applyUrl: WRAPPER, tailoredProfile: null, employerName: 'Aiven' }),
    // Any master: only its presence is checked before the load.
    fetchLatestProfile: async () => ({}) as MasterProfile,
    // No answers needed before the load.
    fetchAnswers: async () => [],
  } as unknown as KitGateway;

  test('robots and goto both see the resolved URL', async () => {
    // The two recorders.
    const robots = recordingRobots();
    // The stopping page.
    const { page, gotos } = stoppingPage();
    // Run up to the load.
    await expect(buildApplyKit({ applicationId: 'x', gateway, page, renderResume: async () => { throw new Error('not reached'); }, checkRobots: robots, resolveFormUrl: resolve, runId: null, now: () => new Date(0) })).rejects.toThrow(STOP);
    // The gate was asked about the form.
    expect(robots.urls).toEqual([FORM]);
    // And the form was what loaded.
    expect(gotos).toEqual([FORM]);
  });
});
