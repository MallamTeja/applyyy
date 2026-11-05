// The manual apply kit, against the REAL captured GitLab form (job 8775507002), in real
// Chromium. The kit exists because Greenhouse's captcha refuses CI submits (2026-10-24):
// Teja applies by hand, with every answer taken from the system. So the kit must equal
// what the bot would have typed (same planner), never invent an answer, take contact
// identity from the LATEST master (one-email ruling, 2026-10-24), and send nothing.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { chromium, type Browser } from 'playwright';
import type { AnswerBankRow, MasterProfile, ResolvedResume } from '@applyy/shared-types';
import { startFixtureServer, type FixtureServer } from '../src/fixture-server.ts';
import { createPlaywrightPage } from '../src/playwright-page.ts';
import { buildApplyKit, createKitGateway, KitSkip, type KitApplication, type KitGateway } from '../src/apply-kit.ts';
// The production file-name rule, so the expected name is never hand-copied.
import { resumeFileName } from '../src/plan-resume-attachment.ts';
import type { SupabaseLike } from '../src/supabase-gateway.ts';
import { syntheticResume } from './resolved-resume-fixture.ts';

let browser: Browser;
let server: FixtureServer;

beforeAll(async () => {
  // Headless, as the CI dispatch runs it.
  browser = await chromium.launch();
  // Serves worker/fixtures on 127.0.0.1.
  server = await startFixtureServer('fixtures');
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

// The exact form the first real kit is for.
const FORM_PATH = '/greenhouse/gitlab-8775507002-backend-india.html';

// The two emails of the ruling: the frozen snapshot's OLD one, and the latest master's.
const OLD_EMAIL = 'tejamallam1233@gmail.com';
const NEW_EMAIL = 'tejamallam00@gmail.com';

// The row's frozen tailored_profile: content to keep, identity that is stale.
const tailored: ResolvedResume = {
  ...(syntheticResume as unknown as ResolvedResume),
  identity: { ...(syntheticResume as unknown as ResolvedResume).identity, full_name: 'Teja Mallam', email: OLD_EMAIL },
};

// The LATEST master (v3): the one source of contact identity.
const latestMaster = {
  identity: {
    full_name: 'Teja Mallam',
    headline: null,
    email: NEW_EMAIL,
    phone: '9392256662',
    location: 'Hyderabad, India',
    links: [{ id: 'l1', label: 'LinkedIn', url: 'https://linkedin.com/in/teja' }],
  },
  // Read by the planner's "previously worked at GitLab?": not GitLab, so it derives "No".
  experience: [{ id: 'e1', company: 'Aczen', role: 'Engineer' }],
} as unknown as MasterProfile;

// The resume's file name: the snapshot's content under the latest master's identity.
const KIT_FILE_NAME = resumeFileName({ ...tailored, identity: latestMaster.identity });

// Name fields come only from the bank (the planner never splits full_name).
const answers = [
  { question_key: 'first_name', answer_value: 'Teja', needs_human: false, answer_type: 'text' },
  { question_key: 'last_name', answer_value: 'Mallam', needs_human: false, answer_type: 'text' },
] as unknown as AnswerBankRow[];

// The row as the database holds it: `applying`, like GitLab ba1e5d1d.
const application: KitApplication = {
  id: 'ba1e5d1d-0000-4000-8000-000000000001',
  status: 'applying',
  applyUrl: '',
  tailoredProfile: tailored,
  employerName: 'GitLab',
};

/** A kit gateway that records every call, with the notes it was asked to append. */
function recordingGateway(row: KitApplication) {
  const calls: string[] = [];
  const notes: Array<Record<string, unknown>> = [];
  const gateway: KitGateway = {
    fetchApplication: async () => {
      calls.push('fetchApplication');
      return row;
    },
    fetchLatestProfile: async () => {
      calls.push('fetchLatestProfile');
      return latestMaster;
    },
    fetchAnswers: async () => {
      calls.push('fetchAnswers');
      return answers;
    },
    uploadResume: async () => {
      calls.push('uploadResume');
      return `user/${row.id}/1792900000000.pdf`;
    },
    appendApplicationNote: async (_id, detail) => {
      calls.push('appendApplicationNote');
      notes.push(detail);
    },
  };
  return { gateway, calls, notes };
}

/**
 * Open the real form behind the production adapter, with every call to a page method
 * that could type or send recorded. The kit's port type offers none of them; this proves
 * the runtime agrees.
 */
async function openKitPage(options: Parameters<typeof createPlaywrightPage>[1] = {}) {
  const raw = await browser.newPage();
  // Every request that could carry data out of the page.
  const sends: string[] = [];
  raw.on('request', (request) => {
    if (request.method() !== 'GET') sends.push(`${request.method()} ${request.url()}`);
  });
  // Options pass through, so a no-form test can shorten the render wait.
  const port = createPlaywrightPage(raw, options);
  // Calls to the three operations the kit must never make.
  const forbidden: string[] = [];
  const page = {
    ...port,
    goto: port.goto.bind(port),
    extractFields: port.extractFields.bind(port),
    detectBlocker: port.detectBlocker.bind(port),
    fill: async (id: string) => void forbidden.push(`fill ${id}`),
    attachFile: async (id: string) => void forbidden.push(`attachFile ${id}`),
    submit: async () => {
      forbidden.push('submit');
      return { kind: 'unconfirmed' as const, detail: 'test' };
    },
  };
  return { raw, page, sends, forbidden };
}

/** A renderer that records the identity it was asked to print. */
function recordingRenderer() {
  const identities: string[] = [];
  const render = async (resume: ResolvedResume) => {
    identities.push(resume.identity.email);
    return { bytes: new Uint8Array([37, 80, 68, 70]), sha256: 'test' };
  };
  return { render, identities };
}

/** Build one kit on the real form; returns the kit plus every recording. */
async function buildOnRealForm(row: KitApplication = application) {
  const { raw, page, sends, forbidden } = await openKitPage();
  const { gateway, calls, notes } = recordingGateway({ ...row, applyUrl: `${server.url}${FORM_PATH}` });
  const renderer = recordingRenderer();
  try {
    const kit = await buildApplyKit({
      applicationId: row.id,
      gateway,
      page,
      renderResume: renderer.render as never,
      // The gate is honoured: an explicit allow, as the live check returns for Greenhouse.
      checkRobots: async () => ({ kind: 'allow' }) as never,
      runId: 'run-1',
      now: () => new Date('2026-10-24T08:00:00.000Z'),
    });
    return { kit, calls, notes, sends, forbidden, identities: renderer.identities };
  } finally {
    await raw.close();
  }
}

describe('the manual apply kit on the real GitLab form', () => {
  test('the kit lists every visible field with label, value, source and required', async () => {
    const { kit, notes } = await buildOnRealForm();
    // Non-vacuity: the real form has more than ten controls.
    expect(kit.fields.length).toBeGreaterThan(10);
    // Every field carries the contract's shape, and a value only with a real source.
    for (const field of kit.fields) {
      expect(field.label.trim().length).toBeGreaterThan(0);
      expect(['identity', 'tailored', 'answer_bank', 'derived', 'unanswered']).toContain(field.source);
      expect(field.value === null).toBe(field.source === 'unanswered');
    }
    // Spot checks, one per source.
    const byLabel = (label: string) => kit.fields.find((field) => field.label === label);
    expect(byLabel('First Name')).toMatchObject({ value: 'Teja', source: 'answer_bank', required: true, input_type: 'text' });
    expect(byLabel('Resume/CV')).toMatchObject({ value: KIT_FILE_NAME, source: 'tailored', required: true, input_type: 'file' });
    expect(byLabel('Cover Letter')).toMatchObject({ value: null, source: 'unanswered', required: false, input_type: 'file' });
    // "Previously worked at GitLab?" is derived from the experience list, not an identity fact.
    expect(kit.fields.find((field) => /worked .*gitlab/i.test(field.label))).toMatchObject({ value: 'No', source: 'derived' });
    // The contract envelope, written as ONE note.
    expect(kit).toMatchObject({ kind: 'apply_kit', v: 1, generated_at: '2026-10-24T08:00:00.000Z', run_id: 'run-1', form_url: `${server.url}${FORM_PATH}` });
    expect(kit.resume).toEqual({ storage_path: `user/${application.id}/1792900000000.pdf`, file_name: KIT_FILE_NAME });
    expect(notes).toEqual([kit]);
  }, 60_000);

  test('contact identity comes from the latest master, with a warning when the snapshot differs', async () => {
    const { kit, identities } = await buildOnRealForm();
    // The form's Email answer is the latest master's.
    expect(kit.fields.find((field) => field.label === 'Email')).toMatchObject({ value: NEW_EMAIL, source: 'identity' });
    // The resume was RE-RENDERED with that identity, not the frozen snapshot's.
    expect(identities).toEqual([NEW_EMAIL]);
    // And the difference is said out loud.
    expect(kit.warnings.some((warning) => warning.includes(OLD_EMAIL) && warning.includes(NEW_EMAIL))).toBe(true);
  }, 60_000);

  test('a required custom question with no answer is value null, source unanswered, and warned', async () => {
    const { kit } = await buildOnRealForm();
    // "Primary programming language/framework" is required and nothing in the bank answers it.
    const question = kit.fields.find((field) => /programming language/i.test(field.label));
    expect(question).toMatchObject({ value: null, source: 'unanswered', required: true });
    // Named in the warnings with the planner's reason, so Teja knows what to type.
    expect(kit.warnings.some((warning) => /programming language/i.test(warning) && warning.includes('no_answer'))).toBe(true);
  }, 60_000);

  test('the kit sends nothing: no fill, attach or submit, and no non-GET request', async () => {
    const { calls, sends, forbidden } = await buildOnRealForm();
    // The page operations that type or send were never called.
    expect(forbidden).toEqual([]);
    // Nothing but page loads left the browser.
    expect(sends).toEqual([]);
    // The only writes: one resume upload and one note. No status method exists on the port.
    expect(calls.filter((call) => call === 'uploadResume' || call === 'appendApplicationNote')).toEqual(['uploadResume', 'appendApplicationNote']);
  }, 60_000);

  test('a row outside the kit statuses is refused before the form opens or anything is written', async () => {
    const { raw, page } = await openKitPage();
    const { gateway, calls } = recordingGateway({ ...application, status: 'applied', applyUrl: `${server.url}${FORM_PATH}` });
    try {
      await expect(
        buildApplyKit({
          applicationId: application.id,
          gateway,
          page,
          renderResume: recordingRenderer().render as never,
          checkRobots: async () => ({ kind: 'allow' }) as never,
          runId: null,
          now: () => new Date(),
        }),
      ).rejects.toThrow(/applied/);
      // Read the row, then stopped.
      expect(calls).toEqual(['fetchApplication']);
    } finally {
      await raw.close();
    }
  }, 60_000);

  // Leak 3 (2026-11-05): GitLab 267dcfcd closed in September; its link redirected to the careers
  // index, and the kit listed "Search" and "Department" as the form for Teja to fill by hand.
  // B2 (2026-11-05): refused with a TYPED KitSkip, so the sweep reports it instead of turning the run red.
  test('a page with no email field (a closed posting redirected to the careers index) is refused as posting_closed, writing nothing', async () => {
    const { raw, page, forbidden } = await openKitPage();
    // The row points at the index page, as GitLab's closed link did after its redirect.
    const { gateway, calls } = recordingGateway({ ...application, applyUrl: `${server.url}/synthetic/careers-index-after-closed-posting.html` });
    try {
      await expect(
        buildApplyKit({
          applicationId: application.id,
          gateway,
          page,
          renderResume: recordingRenderer().render as never,
          checkRobots: async () => ({ kind: 'allow' }) as never,
          runId: null,
          now: () => new Date(),
        }),
      ).rejects.toMatchObject({ name: 'KitSkip', code: 'posting_closed' });
      // No resume uploaded and no kit note written for a page that is not a form.
      expect(calls.filter((call) => call === 'uploadResume' || call === 'appendApplicationNote')).toEqual([]);
      // And nothing typed.
      expect(forbidden).toEqual([]);
    } finally {
      await raw.close();
    }
  }, 60_000);

  /** Builds one kit against a synthetic page; the result or the rejection, plus what was written. */
  async function kitOn(path: string, pageOptions: Parameters<typeof createPlaywrightPage>[1] = {}) {
    // The production adapter over a fresh tab.
    const { raw, page } = await openKitPage(pageOptions);
    // The row points at the fixture.
    const { gateway, calls } = recordingGateway({ ...application, applyUrl: `${server.url}${path}` });
    try {
      // Settled either way, so each test asserts on the outcome it expects.
      const outcome = await buildApplyKit({
        applicationId: application.id,
        gateway,
        page,
        renderResume: recordingRenderer().render as never,
        checkRobots: async () => ({ kind: 'allow' }) as never,
        runId: null,
        now: () => new Date(),
      }).then((kit) => ({ kit, error: null }), (error: unknown) => ({ kit: null, error }));
      // The writes the attempt made.
      return { ...outcome, calls };
    } finally {
      // Closed either way.
      await raw.close();
    }
  }

  // T1 (2026-11-05): zero fields was read as "closed" by the email backstop, which parked 11 OPEN Ashby
  // postings. K2 (2026-11-06): it was then a plain failure, retried every run forever (L&T's peoplestrong
  // form read 0 fields on every run and sat at "Kit pending"). Without the page's own evidence it is now a
  // RESUME-ONLY kit: no form answers, the resume, and a "fill it by hand" warning, written once.
  test('a page that renders no form and does not say it is closed gets a resume-only kit; it is NOT posting_closed', async () => {
    // A short render wait: the page never renders a control.
    const { kit, error, calls } = await kitOn('/synthetic/no-form.html', { formRenderTimeoutMs: 300 });
    // No error of any kind: a kit was made.
    expect(error).toBeNull();
    // No form answers...
    expect(kit?.fields).toEqual([]);
    // ...said in a warning Teja reads.
    expect(kit?.warnings.some((warning) => /could not read the form/.test(warning))).toBe(true);
    // The resume and the one note were written, so the sweep sees a current kit and stops retrying.
    expect(calls.filter((call) => call === 'uploadResume' || call === 'appendApplicationNote')).toEqual(['uploadResume', 'appendApplicationNote']);
  }, 60_000);

  test('a page with no form that SAYS the posting is closed is posting_closed, quoting the page', async () => {
    // The closed notice is the evidence.
    const { error } = await kitOn('/synthetic/closed-no-form.html', { formRenderTimeoutMs: 300 });
    // The typed skip, with the sentence the page showed.
    expect(error).toMatchObject({ name: 'KitSkip', code: 'posting_closed', message: expect.stringMatching(/no longer available/) });
  }, 60_000);

  test('a form that renders late is kitted in full (it is not posting_closed)', async () => {
    // The Ashby-shaped page with the production wait.
    const { kit, error } = await kitOn('/synthetic/late-render-form.html');
    // Built.
    expect(error).toBeNull();
    // Both questions listed.
    expect(kit?.fields.map((field) => field.label)).toEqual(['Full Name', 'Email']);
  }, 60_000);

  // T3 (2026-11-05): every combobox reached Teja with options=[] because react-select renders them
  // only while open; an answer typed from memory never matched an option exactly.
  test('a combobox lists the options its opened menu shows; a search box lists none', async () => {
    // The react-select lookalikes.
    const { kit, error } = await kitOn('/synthetic/combobox-menu.html');
    // Built.
    expect(error).toBeNull();
    // The static list, exactly and in order.
    expect(kit?.fields.find((field) => field.label === 'Do you require visa sponsorship?')?.options).toEqual(['Yes', 'No']);
    // The search box: the key is absent, never an empty list.
    expect(kit?.fields.find((field) => field.label === 'School')).not.toHaveProperty('options');
  }, 60_000);
});

/**
 * The kit gateway over a supabase-js-shaped client that RECORDS every operation and
 * answers like supabase-js: `{ data, error }`, never a throw. Any status RPC or row
 * update gets an `{ error }` back, so a silent write attempt would still be visible here.
 */
function recordingClient(row: { status: string; tailored_profile: unknown; job_id: string }) {
  const ops: string[] = [];
  const builder = (table: string) => {
    let write = false;
    let single = false;
    const b: Record<string, unknown> = {};
    for (const method of ['select', 'order', 'limit', 'eq', 'in']) {
      b[method] = () => {
        ops.push(`${table}.${method}`);
        return b;
      };
    }
    b['maybeSingle'] = () => {
      ops.push(`${table}.maybeSingle`);
      single = true;
      return b;
    };
    for (const method of ['update', 'upsert', 'delete']) {
      b[method] = () => {
        ops.push(`${table}.${method}`);
        write = true;
        return b;
      };
    }
    b['insert'] = () => {
      ops.push(`${table}.insert`);
      return b;
    };
    b['then'] = (resolve: (value: unknown) => unknown) => {
      if (write) return resolve({ data: null, error: { message: 'recording client: writes refused' } });
      if (table === 'applications') return resolve({ data: single ? { id: 'a1', ...row } : [], error: null });
      if (table === 'jobs') return resolve({ data: { apply_url: 'https://job-boards.greenhouse.io/gitlab/jobs/8775507002', company_name: 'GitLab' }, error: null });
      if (table === 'master_profiles') return resolve({ data: [{ profile: latestMaster }], error: null });
      if (table === 'answer_bank') return resolve({ data: answers, error: null });
      return resolve({ data: null, error: null });
    };
    return b;
  };
  const client = {
    rpc: async (fn: string) => {
      ops.push(`rpc.${fn}`);
      return { data: null, error: { message: 'recording client: rpc refused' } };
    },
    from: (table: string) => builder(table),
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string) => {
          ops.push(`storage.${bucket}.upload ${path.endsWith('.pdf') ? 'pdf' : path}`);
          return { data: null, error: null };
        },
      }),
    },
    auth: {
      signInWithPassword: async () => ({ data: { session: null }, error: null }),
      getSession: async () => ({ data: { session: null }, error: null }),
    },
  } as unknown as SupabaseLike;
  return { client, ops };
}

describe('the kit gateway over a supabase-js client', () => {
  test('reads the row and its job, uploads one resume, appends one note, and writes no status', async () => {
    const { client, ops } = recordingClient({ status: 'applying', tailored_profile: tailored, job_id: 'j1' });
    const gateway = createKitGateway(client, { userId: 'user' });
    // The row, joined to its job by a second read.
    expect(await gateway.fetchApplication('a1')).toEqual({
      id: 'a1',
      status: 'applying',
      applyUrl: 'https://job-boards.greenhouse.io/gitlab/jobs/8775507002',
      tailoredProfile: tailored,
      employerName: 'GitLab',
    });
    await gateway.uploadResume('a1', new Uint8Array([1]));
    await gateway.appendApplicationNote('a1', { kind: 'apply_kit' });
    // No RPC (claim, advance, release) and no row update of any kind.
    expect(ops.filter((op) => op.startsWith('rpc.') || /\.(update|upsert|delete)$/.test(op))).toEqual([]);
    // Exactly the two writes the kit is allowed.
    expect(ops.filter((op) => op.includes('upload') || op.endsWith('.insert'))).toEqual(['storage.resumes.upload pdf', 'application_events.insert']);
  });
});

// B2 (2026-11-05, P3 #8): arbeitnow's robots.txt refuses us (403). K2 (2026-11-06): Tether 04d5c6e4 is on
// arbeitnow and sat at "Kit pending". The resume needs no page fetch, so a refusal now gets a RESUME-ONLY
// kit WITHOUT opening the page (the robots ruling holds); a 'wait' (transient) stays a plain failure.
describe('buildApplyKit robots refusal (B2, K2)', () => {
  // A fresh gateway per case, recording every write.
  function gatewayRecording(writes: string[], notes: Array<Record<string, unknown>>): KitGateway {
    return {
      // A row in a kit lane, with a resume snapshot so the resume-only kit has a resume.
      fetchApplication: async () => ({ ...application, id: 'app-r', applyUrl: 'https://example.test/job' }),
      // The latest master: the kit's identity source.
      fetchLatestProfile: async () => latestMaster,
      // No answers needed.
      fetchAnswers: async () => [],
      // The resume upload.
      uploadResume: async () => { writes.push('uploadResume'); return 'resumes/app-r/x.pdf'; },
      // The one note.
      appendApplicationNote: async (_id: string, detail: Record<string, unknown>) => { writes.push('appendApplicationNote'); notes.push(detail); },
    } as unknown as KitGateway;
  }
  // A page that must never be opened: robots said no.
  const page = { goto: async () => { throw new Error('page opened despite robots'); } } as never;
  // A renderer returning a tiny PDF.
  const renderResume = (async () => ({ bytes: new Uint8Array([37, 80, 68, 70]) })) as never;

  test('robots "refuse" gets a resume-only kit without opening the page', async () => {
    // The writes and notes this case made.
    const writes: string[] = [];
    const notes: Array<Record<string, unknown>> = [];
    // Refused.
    const kit = await buildApplyKit({ applicationId: 'app-r', gateway: gatewayRecording(writes, notes), page, renderResume, checkRobots: async () => ({ kind: 'refuse', reason: 'HTTP 403', source: 'status' }) as never, runId: null, now: () => new Date() });
    // No form answers, and the warning says why.
    expect(kit.fields).toEqual([]);
    expect(kit.warnings.some((warning) => /robots\.txt/.test(warning) && /by hand/.test(warning))).toBe(true);
    // The resume and one apply_kit note (not a skip note), with the form URL for "Open the form".
    expect(writes).toEqual(['uploadResume', 'appendApplicationNote']);
    expect(notes[0]).toMatchObject({ kind: 'apply_kit', form_url: 'https://example.test/job', fields: [] });
  });

  test('robots "wait" is a plain error, writing nothing', async () => {
    // The writes this case made.
    const writes: string[] = [];
    // A transient wait.
    const waited = buildApplyKit({ applicationId: 'app-r', gateway: gatewayRecording(writes, []), page, renderResume, checkRobots: async () => ({ kind: 'wait', reason: 'HTTP 503' }) as never, runId: null, now: () => new Date() });
    // Rejected, but NOT a skip: tomorrow may differ, and a red run is how it is seen.
    await expect(waited).rejects.not.toBeInstanceOf(KitSkip);
    // Nothing uploaded or noted.
    expect(writes).toEqual([]);
  });
});
