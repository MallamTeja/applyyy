// Entry point for `pnpm --filter @applyy/worker run rehearse -- --id <application uuid>`, run from the repo root.
//
// PROVES A FIRST ASSISTED SUBMIT WITHOUT DOING ONE (2026-11-07). It folds two things into one read-only run:
//   1. the preflight that lived outside the repo (submit-preflight.mjs, orchestrator 8b): env, owner,
//      status, kill switch, daily cap, kit, resume identity, posting open. Corrected here: the robots check
//      runs on the RESOLVED form URL (assist resolves first since 5e0bcec), and it is no longer "the only
//      robots gate" (assist has had its own since G1);
//   2. the rehearsal (assist/rehearse.ts): every assist step up to the click on the real form.
// WRITES NOTHING. Every DB read is a SELECT through the supabase CLI, owner-scoped because the CLI's role
// bypasses RLS. There is no claim, no status write and no supabase-js client at all, except the optional
// password sign-in check, which signs straight out. The page goes to the rehearsal through readOnlyPage(),
// so fill/attach/submit are not even on the object it gets.
// Exit: 0 = ready; 2 = nothing failed but something waits on Teja; 1 = something failed.

// Runs the supabase CLI for the SELECTs.
import { execFileSync } from 'node:child_process';
// The agent-key hash check, compared to CLAUDE.md §7's digest.
import { createHash } from 'node:crypto';
// The SQL goes through a temp file: the CLI's -f form, and safe from Windows shell mangling.
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
// Temp file location.
import { tmpdir } from 'node:os';
// Path joins.
import { join } from 'node:path';
// The browser that loads the real form and renders the resume.
import { chromium } from 'playwright';
// Type-only: the shapes read from the DB.
import type { AnswerBankRow, MasterProfile, ResolvedResume } from '@applyy/shared-types';
// The production page port, narrowed to reads before the rehearsal sees it.
import { createPlaywrightPage } from '../playwright-page.ts';
// Renders the resume on its own page.
import { createResumeRenderer } from '../resume-renderer.ts';
// The applier's robots gate, the one assist uses.
import { createRobotsCheck } from '../apply-one.ts';
// The applier's form-URL resolver and its JSON GET.
import { createFormUrlResolver, fetchJson, type GreenhouseBoard } from '../form-url.ts';
// The rehearsal and its read-only page adapter.
import { readOnlyPage, rehearseAssisted } from '../assist/rehearse.ts';
// The password check, which ends only its own session.
import { signInCheck, type SignInClient } from '../assist/sign-in-check.ts';
// The client for that one check only; nothing else in this CLI talks to the DB through supabase-js.
import { createClient } from '@supabase/supabase-js';

// sha256 of the seeded APPLYY_AGENT_KEY (CLAUDE.md §7): a copy is checked without printing it.
// gitleaks' generic-api-key rule flagged this line in CI (fc915af): a 64-hex value named *KEY*. It is a
// one-way DIGEST, already published in CLAUDE.md §7, not the key; hence the inline allow marker.
const AGENT_KEY_SHA = '173cffbd0242d72a9d5bb98b993637269d4a3ea0f4e8217686a4e8bc3850d9ce'; // gitleaks:allow
// Env names assist needs (values never printed).
const NEEDED = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'APPLYY_APP_USER_EMAIL', 'APPLYY_APP_USER_PASSWORD', 'APPLYY_AGENT_KEY'] as const;
// The repo root: `pnpm --filter` runs scripts from worker/, a direct `node` call usually from the root.
// Both .env and `supabase --linked` (which reads supabase/.temp) need the root.
const ROOT = existsSync(join(process.cwd(), 'worker', 'package.json')) ? process.cwd() : join(process.cwd(), '..');
// A UUID by shape, so it is safe to place in SQL text.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One line of the final table. */
type Verdict = 'PASS' | 'WAIT' | 'FAIL';

/** `--id <uuid>`, validated by shape; there is no "pick any" mode, as in assist. */
function parseId(argv: readonly string[]): string {
  // The value after --id.
  const value = argv[argv.indexOf('--id') + 1];
  // Absent or malformed: usage, never a guess.
  if (argv.indexOf('--id') === -1 || value === undefined || !UUID.test(value)) throw new Error('usage: rehearse --id <application uuid>');
  // Proven.
  return value;
}

/** One SELECT through the CLI, without the wrong-account token (CLAUDE.md §4); returns the rows. */
function select(sql: string): Record<string, unknown>[] {
  // The environment minus the token that belongs to the wrong account.
  const env = { ...process.env };
  // Removed, not blanked: the CLI then uses its own linked login.
  delete env['SUPABASE_ACCESS_TOKEN'];
  // A per-process temp file for the SQL.
  const file = join(tmpdir(), `rehearse-${process.pid}.sql`);
  // Written, then always removed.
  writeFileSync(file, sql);
  try {
    // JSON output. The shell only on Windows, where `supabase` is a .cmd shim; every argument is ours.
    const raw = execFileSync('supabase', ['db', 'query', '--linked', '-o', 'json', '-f', file], { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    // The JSON object, between its outer braces (the CLI may print a banner).
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { rows?: unknown };
    // Shape check: an array of rows, or nothing.
    return Array.isArray(parsed.rows) ? (parsed.rows as Record<string, unknown>[]) : [];
  } finally {
    // No SQL left behind.
    unlinkSync(file);
  }
}

/** jsonb can arrive decoded or as text; either way, the value. */
function jsonOf(value: unknown): unknown {
  // Text that is JSON is parsed; anything else is already the value.
  if (typeof value !== 'string') return value;
  try {
    // Most jsonb columns.
    return JSON.parse(value);
  } catch {
    // A plain string value.
    return value;
  }
}

async function main(): Promise<void> {
  // The row under rehearsal.
  const id = parseId(process.argv.slice(2));
  // Merged UNDER the environment: loadEnvFile never overrides a set variable.
  if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));
  // The table, printed at the end.
  const results: { name: string; verdict: Verdict; why: string }[] = [];
  // One recorder, so every check reads alike.
  const record = (name: string, verdict: Verdict, why: string) => results.push({ name, verdict, why });

  // 1. Env names, then the agent key by hash.
  const missing = NEEDED.filter((name) => !process.env[name]);
  // A missing secret is Teja's to set, so WAIT, not FAIL.
  record('env names', missing.length === 0 ? 'PASS' : 'WAIT', missing.length === 0 ? `all ${NEEDED.length} set` : `missing: ${missing.join(', ')}`);
  // The key itself, never printed.
  const key = process.env['APPLYY_AGENT_KEY'];
  // A wrong key is a FAIL: assist's writes would be refused (42501).
  record('agent key hash', !key ? 'WAIT' : createHash('sha256').update(key).digest('hex') === AGENT_KEY_SHA ? 'PASS' : 'FAIL', !key ? 'not set' : 'compared to the seeded sha256');

  // 2. Everything the checks and the rehearsal read, in one SELECT, owner-scoped (system_settings
  // holds two accounts; an unfiltered read once answered for the wrong one, CLAUDE.md §6).
  const [row] = select(`select a.status, a.user_id, a.tailored_profile, j.apply_url, j.company_name,
      (select count(*) from system_settings s where s.user_id = a.user_id) n_settings,
      (select system_enabled from system_settings s where s.user_id = a.user_id) sys_on,
      (select auto_apply_on_approve from system_settings s where s.user_id = a.user_id) auto_on,
      (select max_applications_per_day from system_settings s where s.user_id = a.user_id) day_cap,
      (select count(*) from application_events e where e.user_id = a.user_id and e.to_status = 'applied' and e.created_at > now() - interval '24 hours') sent_24h,
      (select profile from master_profiles mp where mp.user_id = a.user_id order by version desc limit 1) master,
      (select coalesce(json_agg(ab), '[]'::json) from answer_bank ab where ab.user_id = a.user_id) answers,
      (select coalesce(json_agg(w.board_token), '[]'::json) from company_watchlist w where w.user_id = a.user_id and w.company_slug = j.company_slug and w.ats_provider = 'greenhouse' and w.enabled) boards,
      (select json_build_object('at', e.created_at, 'fields', jsonb_array_length(e.detail->'fields'),
         'req_open', (select count(*) from jsonb_array_elements(e.detail->'fields') f where (f->>'required')::boolean and f->>'source' = 'unanswered'),
         'refusals', (select count(*) from jsonb_array_elements_text(e.detail->'warnings') w where w like '%needs your answer%'))
       from application_events e where e.application_id = a.id and e.event_type = 'note' and e.detail->>'kind' = 'apply_kit' order by e.created_at desc limit 1) kit
    from applications a join jobs j on j.id = a.job_id where a.id = '${id}'`);
  // No row: nothing else can be checked.
  if (row === undefined) {
    // Said, then the table.
    record('row exists', 'FAIL', 'no such application');
    // Printed and exited below.
    return finish(results);
  }
  // Exactly one settings row for the owner.
  record('row owner', Number(row['n_settings']) === 1 ? 'PASS' : 'FAIL', `user ${String(row['user_id']).slice(0, 8)}, ${String(row['n_settings'])} settings row(s)`);
  // Approved is the only state assist will take; awaiting is Teja's click away.
  record('row approved', row['status'] === 'approved' ? 'PASS' : row['status'] === 'awaiting_approval' ? 'WAIT' : 'FAIL', `status ${String(row['status'])}`);
  // The kill switch must be on.
  record('kill switch', row['sys_on'] === true ? 'PASS' : 'FAIL', `system_enabled ${String(row['sys_on'])}`);
  // Auto-apply must be OFF, or the scheduled applier could claim the row before assist does.
  record('auto-apply off', row['auto_on'] === false ? 'PASS' : 'FAIL', `auto_apply_on_approve ${String(row['auto_on'])}`);
  // Under the daily cap (null = no cap).
  record('daily cap', row['day_cap'] === null || Number(row['sent_24h']) < Number(row['day_cap']) ? 'PASS' : 'FAIL', `applied in 24 h: ${String(row['sent_24h'])}; cap ${String(row['day_cap'] ?? 'none')}`);
  // The newest kit: present, with fields, nothing left open.
  const kit = jsonOf(row['kit']) as { at?: string; fields?: number; req_open?: number; refusals?: number } | null;
  // Absent before approval is a WAIT; after it, a FAIL.
  if (kit === null) record('kit', row['status'] === 'approved' ? 'FAIL' : 'WAIT', 'no apply_kit note yet (built after approval)');
  // Present: fields, zero required open, zero refusals.
  else record('kit', Number(kit.fields) > 0 && Number(kit.req_open) === 0 && Number(kit.refusals) === 0 ? 'PASS' : 'FAIL', `at ${String(kit.at).slice(0, 16)}: ${String(kit.fields)} fields, ${String(kit.req_open)} required open, ${String(kit.refusals)} refusals`);
  // The posting is open per Greenhouse's public API, when it is a Greenhouse board URL.
  const applyUrl = String(row['apply_url']);
  // Board and job id, from the job-boards URL shape.
  const gh = /job-boards\.greenhouse\.io\/([a-z0-9_-]+)\/jobs\/(\d+)/.exec(applyUrl);
  // Only Greenhouse rows have this check; others say so.
  if (gh) record('posting open', (await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${gh[1]}/jobs/${gh[2]}`)).status === 200 ? 'PASS' : 'FAIL', 'Greenhouse public API');
  // Said, so "not checked" is not read as "passed".
  else record('posting open', 'PASS', 'n/a: not a job-boards.greenhouse.io URL');

  // 3. Sign-in with the app password, when set, then out of THAT session only (scope 'local': the default
  // 'global' logged Teja's browser out on 2026-11-07). No other client is ever made.
  for (const line of await signInCheck(process.env, String(row['user_id']), (url, anon) => createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as SignInClient)) record(line.name, line.verdict, line.why);

  // 4. The rehearsal on the real form.
  const boards = (jsonOf(row['boards']) as unknown[]) ?? [];
  // Exactly one board, as supabaseBoardLookup requires; two would be a guess.
  const board: GreenhouseBoard | null = boards.length === 1 && typeof boards[0] === 'string' ? { token: boards[0], companyName: String(row['company_name']) } : null;
  // One browser for the page and the renderer.
  const browser = await chromium.launch();
  // Its own page for the resume, as assist uses.
  const renderer = createResumeRenderer(browser);
  try {
    // The production page port, narrowed to reads: fill/attach/submit are not on what rehearse gets.
    const page = readOnlyPage(createPlaywrightPage(await browser.newPage()));
    // Assist's steps, up to the click.
    const report = await rehearseAssisted({
      applicationId: id,
      applyUrl,
      company: String(row['company_name']),
      tailoredProfile: jsonOf(row['tailored_profile']) as ResolvedResume,
      master: (jsonOf(row['master']) as MasterProfile | null) ?? null,
      answers: (jsonOf(row['answers']) as AnswerBankRow[]) ?? [],
      page,
      // The applier's gate, on the resolved URL inside rehearse.
      checkRobots: createRobotsCheck(),
      // The applier's resolver over the board read above.
      resolveFormUrl: createFormUrlResolver(async () => board, fetchJson),
      // Bound to its owner.
      renderResume: renderer.render,
    });
    // Identity drift is a FAIL: assist would attach a resume with facts Teja did not approve.
    record('resume identity', report.identityDrift.length === 0 ? 'PASS' : 'FAIL', report.identityDrift.length === 0 ? 'tailored = latest master' : report.identityDrift.join('; '));
    // Robots on the RESOLVED URL.
    record('robots (form url)', report.robots?.kind === 'allow' ? 'PASS' : 'FAIL', `${report.formUrl ?? '?'}: ${report.robots ? `${report.robots.kind}: ${report.robots.reason}` : 'not reached'}`);
    // A stop before the form is a FAIL with its reason.
    if (report.stoppedAt !== null) record('rehearsal', 'FAIL', `stopped: ${report.stoppedAt}`);
    // A wall is the human's, so WAIT.
    record('page blocker', report.blocker === null ? 'PASS' : 'WAIT', report.blocker ?? 'none');
    // The plan: fills, and the questions assist would hand to the human.
    record('fill plan', report.plan !== null && report.plan.blockers.length === 0 ? 'PASS' : 'WAIT', report.plan === null ? 'not reached' : `${report.fields.length} fields, ${report.plan.fills.length} fills (${report.plan.fills.map((f) => f.id).join(', ')}), ${report.plan.blockers.length} for the human${report.plan.blockers.length ? `: ${report.plan.blockers.map((b) => b.label).join('; ')}` : ''}`);
    // The resume: a target, a real PDF.
    record('resume attach', report.resume?.isPdf === true || (report.resumeTarget === null && report.stoppedAt === null) ? 'PASS' : 'FAIL', report.resume ? `${report.resume.fileName} -> ${report.resumeTarget}, ${report.resume.bytes} bytes, %PDF ${report.resume.isPdf}` : `target ${report.resumeTarget ?? 'none'}`);
  } finally {
    // Renderer page first, then the browser that owns it.
    await renderer.close();
    // Nothing left running.
    await browser.close();
  }
  // The table and the exit code.
  finish(results);
}

/** Prints the table and exits 0 / 2 / 1. */
function finish(results: readonly { name: string; verdict: Verdict; why: string }[]): void {
  // One line per check.
  for (const r of results) console.log(`${r.verdict.padEnd(4)}  ${r.name.padEnd(18)} ${r.why}`);
  // FAIL wins, then WAIT.
  const code = results.some((r) => r.verdict === 'FAIL') ? 1 : results.some((r) => r.verdict === 'WAIT') ? 2 : 0;
  // The summary line.
  console.log(`exit ${code} (${code === 0 ? 'ready' : code === 2 ? 'waiting on Teja' : 'NOT ready'})`);
  // The exit code is the machine-readable answer.
  process.exitCode = code;
}

// Any throw is a FAIL with its message, never a silent exit 0.
main().catch((error: unknown) => {
  // The message only.
  console.error(`[rehearse] ${error instanceof Error ? error.message : String(error)}`);
  // FAIL.
  process.exitCode = 1;
});
