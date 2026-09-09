// Tests for the localhost fixture server: the piece that makes PROJECT_PLAN.md
// §19 possible. Real ATS application forms are saved as static HTML and served
// from here, so the applier can be run against genuine DOM without ever
// touching an employer's site (constraint #16: never test by submitting).
import { describe, expect, test } from 'vitest';
// mkdtemp gives each test its own throwaway directory, so the server tests do
// not depend on which fixtures happen to be checked in at the time.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
// The OS temp dir is used rather than the repo, so a crashed test can never
// leave stray HTML inside worker/fixtures and get mistaken for a real capture.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Subject under test; does not exist yet, which is what makes this test RED.
import { startFixtureServer } from '../src/fixture-server.js';

describe('startFixtureServer', () => {
  test('serves a saved form over http', async () => {
    // A directory standing in for worker/fixtures, holding one known file.
    const dir = await mkdtemp(join(tmpdir(), 'applyy-fixture-'));
    // Recognisable markup so the assertion proves the file was actually read
    // from disk rather than some default response body.
    const html = '<!doctype html><form id="app"><input name="first_name"></form>';
    // Named like a real capture so the test exercises the same path shape the
    // applier will request in anger.
    await writeFile(join(dir, 'greenhouse-basic.html'), html, 'utf8');

    // The server binds an ephemeral port and reports the URL it actually got,
    // because a hardcoded port collides the moment two tests run together.
    const server = await startFixtureServer(dir);

    // The one behaviour under test: a saved fixture comes back byte-for-byte.
    const response = await fetch(`${server.url}/greenhouse-basic.html`);
    // Content must round-trip unchanged; a mangled form is a useless fixture.
    await expect(response.text()).resolves.toBe(html);

    // Release the port even if assertions above passed, so the next file's
    // server can bind cleanly under fileParallelism: false.
    await server.close();
  });

  test('refuses a percent-encoded path that escapes the fixture directory', async () => {
    // A parent directory holding a secret, with the served fixture root nested
    // inside it. This layout mirrors the real repo, where worker/fixtures sits
    // a few levels below .env and the Supabase keys (constraint #11).
    const parent = await mkdtemp(join(tmpdir(), 'applyy-fixture-'));
    // The sentinel MUST exist on disk: a test that escapes to a missing file
    // gets a 404 from absence rather than from the guard, and would therefore
    // pass against a server with no guard at all.
    await writeFile(join(parent, 'secret.txt'), 'SERVICE_ROLE_KEY', 'utf8');
    // The directory actually exposed to the server; everything above is off-limits.
    const root = join(parent, 'fixtures');
    await mkdir(root);

    // Start the server scoped to the nested directory only.
    const server = await startFixtureServer(root);

    // Percent-encoded traversal, not the literal "../secret.txt". WHATWG URL
    // parsing collapses literal dot segments inside fetch() before the request
    // is ever sent, so a plain ../ test silently checks nothing. %2e%2e%2f
    // survives normalisation and reaches the server still encoded, which is
    // what actually exercises the guard.
    const response = await fetch(`${server.url}/%2e%2e%2fsecret.txt`);
    // A refusal, not a leak. 404 rather than 403 so the server never confirms
    // whether the escaped path exists.
    expect(response.status).toBe(404);
    // Belt and braces: prove the key never appeared in the body, so a future
    // change that returns 404 with content still fails this test.
    await expect(response.text()).resolves.not.toContain('SERVICE_ROLE_KEY');

    // Always free the port.
    await server.close();
  });
});
