/* The browser remote-feed write path is retired (2026-10-24).
 *
 * The "Scout Remote Feeds" button used to fetch RemoteOK, Jobicy and Arbeitnow from the
 * browser and insert every posting UNSCREENED at 'discovered', with no apply-URL gate.
 * The feeds now run daily on .github/workflows/scout-remote.yml through the shared safety
 * and screening path, and the button only explains that.
 *
 * WHY SOURCE-SHAPE TESTS: apps/web has no DOM renderer, and discoveryService.ts imports the
 * supabase client. Each check asserts a CLOSED SET (what exists), not the absence of a
 * substring (CLAUDE.md section 6), so a reintroduced writer or host fails by name. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// Files read relative to this test, so it runs from any cwd.
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('browser remote discovery is retired', () => {
  it('the browser path no longer writes: discoveryService exports exactly the watchlist scan, its parser and the schedule note', () => {
    // Every runtime export (functions and consts) of the service.
    const exports = [...read('../src/data/discoveryService.ts').matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map((m) => m[1]).sort();
    // The closed set: a revived runRemoteDiscovery (or any new writer) changes it and fails here.
    assert.deepEqual(exports, ['REMOTE_FEEDS_SCHEDULE_NOTE', 'parseScoutAtsResponse', 'runWatchlistScan']);
  });

  // W8 (2026-11-01 wiring audit): the browser "Scout Watchlist" fallback read company_watchlist and
  // upserted jobs/applications itself. The scan is now the scout-ats call and nothing else.
  it('the watchlist scan touches no table and no ATS host from the browser', () => {
    // The service source, read once for both checks.
    const source = read('../src/data/discoveryService.ts');
    // Every table access as code, `.from(` with its open paren; prose cannot match it.
    const tables = [...source.matchAll(/\.from\(\s*'(\w+)'/g)].map((m) => m[1]);
    // The closed set is empty: a restored fallback names company_watchlist, jobs and applications here.
    assert.deepEqual(tables, [], 'discoveryService must not read or write tables; scout-ats does the scan');
    // Every outbound host the service builds a URL for; the only call left goes through supabase.functions.
    const hosts = [...source.matchAll(/fetch\(\s*`https:\/\/([^/`]+)/g)].map((m) => m[1]);
    // Same closed, empty set: the fallback fetched api.ashbyhq.com directly.
    assert.deepEqual(hosts, [], 'discoveryService must not fetch an ATS host itself');
  });

  it('the modal imports only the watchlist scan and the schedule note from the service', () => {
    // The modal's one runtime import from discoveryService.
    const match = /^import \{ ([^}]+) \} from '\.\.\/\.\.\/data\/discoveryService';$/m.exec(read('../src/features/pipeline/DiscoveryModal.tsx'));
    // Non-vacuity: the import line exists in this exact form.
    assert.ok(match, 'DiscoveryModal no longer imports discoveryService in the expected form; this test would be vacuous');
    // The closed set of names: no remote scan can be called from the modal.
    assert.deepEqual(match[1]!.split(',').map((s) => s.trim()).sort(), ['REMOTE_FEEDS_SCHEDULE_NOTE', 'runWatchlistScan']);
  });

  it('the CSP connects only to the hosts the app still fetches (the three feed hosts are gone)', () => {
    // The exact connect-src host list the app needs: Supabase (https + realtime) and the email
    // tracker's Apps Script. api.ashbyhq.com left with the watchlist scan's browser fallback (W8,
    // 2026-11-01): nothing in the browser fetches it, so the CSP no longer allows it.
    const expected = ['https://script.google.com', 'https://script.googleusercontent.com', 'https://xynqxekcqizwhtskzqrq.supabase.co', "'self'", 'wss://xynqxekcqizwhtskzqrq.supabase.co'].sort();
    // The root config is the only one: Vercel builds from the repo root, and the inert
    // apps/web/vercel.json duplicate was deleted 2026-10-24 so a CSP edit can't land in a dead file.
    const path = '../../../vercel.json';
    // The connect-src directive out of the CSP header value.
    const directive = /connect-src ([^;]+);/.exec(read(path));
    // Non-vacuity: the directive was found.
    assert.ok(directive, `${path}: no connect-src directive found; this test would be vacuous`);
    // The closed host set.
    assert.deepEqual(directive[1]!.trim().split(/\s+/).sort(), expected, `${path}: connect-src changed`);
  });
});
