/* Route pages load as separate chunks (2026-11-08).
 *
 * WHY. Teja, 16:32: "pages are slow". Every route shipped in ONE 862 KB chunk, so opening any page parsed all
 * sixteen (Settings 155 KB and Approval 112 KB on every page). App.tsx now loads each page with React.lazy, so
 * Vite emits a chunk per page and the entry chunk holds only the shell. This reads the BUILT output
 * (dist/, the same build the e2e tests serve) because only the bundler can say what got split.
 *
 * RED-ON-REVERT: static page imports in App.tsx put every page back into the entry chunk; test 1 then finds
 * no `<Page>-<hash>.js` files and test 2 finds the Approval page's own text in the entry chunk. */

// Strict asserts, so a near-miss is not a pass.
import assert from 'node:assert/strict';
// Reads the build output.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
// The runner.
import { describe, it } from 'node:test';
// Resolves dist/ next to this test, whatever the cwd.
import { fileURLToPath } from 'node:url';

// The built assets and the page that loads them.
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

// Every page App.tsx routes to, by its exported name; Vite names a lazy chunk after its module file.
const PAGES = [
  'ApprovalQueuePage', 'PipelinePage', 'AppliedJobsPage', 'DiscoveredJobsPage', 'ManualApplyPage', 'HealthPage', 'EmailMonitoringPage',
  'ReferralOutreachPage', 'FollowUpNudgesPage', 'SkillGapPage',
  'SearchPreferencesPage', 'MasterProfilePage', 'AnswerBankPage', 'FiltersPage', 'WatchlistPage', 'BlocklistPage',
];

describe('route pages load as separate chunks', () => {
  // No build: fail with the fix, never pass vacuously (noEmoji.test.ts does the same).
  const assets = `${DIST}assets/`;

  it('1. the build has one chunk per routed page', () => {
    // A missing build is a failure with the command that makes one.
    assert.ok(existsSync(assets), `${assets} does not exist. Build it: cd apps/web && ./node_modules/.bin/vite build --mode e2e`);
    // The shipped JS files.
    const js = readdirSync(assets).filter((name) => name.endsWith('.js'));
    // Pages with no chunk of their own: each one is still parsed on every page load.
    const missing = PAGES.filter((page) => !js.some((name) => name.startsWith(`${page}-`)));
    // All sixteen split out.
    assert.deepEqual(missing, []);
  });

  it('2. the entry chunk the HTML loads does not carry a page\'s own code', () => {
    // The one script index.html loads up front: the entry chunk.
    const entry = /<script[^>]+src="\/assets\/([^"]+\.js)"/.exec(readFileSync(`${DIST}index.html`, 'utf8'))?.[1];
    // An HTML without its entry script is not this app's build.
    assert.ok(entry !== undefined, 'dist/index.html loads no /assets/*.js entry script');
    // Its text.
    const code = readFileSync(`${assets}${entry}`, 'utf8');
    // Non-vacuous: the shell IS in the entry (the rail's own label from routes.ts), so this reads the right file.
    assert.ok(code.includes('Approval queue'), 'the entry chunk does not carry the rail label: not the app shell');
    // The Approval page's own loading sentence lives only in ApprovalQueuePage.tsx: absent from the entry.
    assert.equal(code.includes('Loading the applications waiting for you'), false);
  });
});
