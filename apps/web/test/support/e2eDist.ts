/* The browser tests' shared harness (2026-11-05): the dist guard, the static SPA server and the fake
 * session. It was copied into each browser test file; appliedE2e.test.ts said to move it here at the third
 * copy. manualApplyResolveE2e and emailsE2e use it; e2eSuite and appliedE2e keep their copies until their
 * owners switch (queued).
 *
 * Every helper here only READS dist/ and serves it locally: no request leaves the machine. */

// File reads and stats for the server and the guard; stdlib, no dependency.
import { readdir, readFile, stat } from 'node:fs/promises';
// The static server.
import { createServer, type Server } from 'node:http';
// Path helpers.
import { extname, join } from 'node:path';
// File URLs to paths, so they resolve from this file whatever the cwd.
import { fileURLToPath } from 'node:url';
// Type only: the context the session is seeded into.
import type { BrowserContext } from 'playwright';

// The bundle under test.
export const DIST = fileURLToPath(new URL('../../dist', import.meta.url));
// The source the bundle must be newer than.
const SRC = fileURLToPath(new URL('../../src', import.meta.url));
// Build inputs outside src/ that also change the bundle.
const ROOT_INPUTS = ['../../index.html', '../../vite.config.ts', '../../.env.e2e'].map((p) => fileURLToPath(new URL(p, import.meta.url)));
// The live project ref: the seeded session key embeds it, so a bundle without it cannot sign in.
export const PROJECT_REF = 'xynqxekcqizwhtskzqrq';
// The one fix for every guard failure, named in each message.
const FIX = 'cd apps/web && ./node_modules/.bin/vite build --mode e2e';
// Content types the static server needs for a Vite bundle.
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

/* Newest file mtime under a directory; throws on an empty walk so the staleness check cannot pass vacuously. */
async function newestMtime(dir: string): Promise<{ path: string; ms: number }> {
  // Below any real file.
  let newest = { path: '(none)', ms: -Infinity };
  // Recursive listing is stdlib.
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    // Files only: a directory's mtime moves when a peer adds a file.
    if (!entry.isFile()) continue;
    // The entry's full path.
    const full = join(entry.parentPath, entry.name);
    // Its modification time.
    const { mtimeMs } = await stat(full);
    // Keep the newest, so the message can name it.
    if (mtimeMs > newest.ms) newest = { path: full, ms: mtimeMs };
  }
  // An empty walk proves nothing.
  if (newest.ms === -Infinity) throw new Error(`e2e guard: no files under ${dir}`);
  return newest;
}

/* Refuses a dist/ that cannot prove anything: missing, older than its source, or built without the project
   URL. Each used to surface as selector timeouts. Call it in before() and rethrow in beforeEach(), so a
   refused dist FAILS each test instead of cancelling it (cancelled tests read as "fail 0"). */
export async function assertDistIsTestable(): Promise<void> {
  // (a) The entry page must exist.
  const index = await stat(join(DIST, 'index.html')).catch(() => null);
  // Missing: name the build command.
  if (!index) throw new Error(`E2E_DIST_MISSING: no dist/index.html. Build it: ${FIX}`);
  // (b) The newest source file, then any newer root input.
  let newest = await newestMtime(SRC);
  // Root inputs one by one; an absent one cannot have changed the bundle.
  for (const input of ROOT_INPUTS) {
    // stat-or-null so an absent file is skipped, not thrown.
    const s = await stat(input).catch(() => null);
    // Newer wins.
    if (s && s.mtimeMs > newest.ms) newest = { path: input, ms: s.mtimeMs };
  }
  // A source touched after the build may not be in the bundle (a 2-day-stale dist once went green).
  if (newest.ms > index.mtimeMs) throw new Error(`E2E_DIST_STALE: dist/index.html is older than ${newest.path}. Rebuild: ${FIX}`);
  // (c) The bundle must carry the project URL, or every page stops at sign-in.
  const js = (await readdir(join(DIST, 'assets')).catch(() => [] as string[])).filter((f) => f.endsWith('.js'));
  // One chunk with the ref is enough.
  for (const f of js) if ((await readFile(join(DIST, 'assets', f), 'utf8')).includes(PROJECT_REF)) return;
  // Zero chunks lands here too, so an empty assets dir cannot pass.
  throw new Error(`E2E_DIST_UNCONFIGURED: none of ${js.length} JS files carry "${PROJECT_REF}". Rebuild: ${FIX}`);
}

/* dist/ served as an SPA on a free local port: unknown paths get index.html so the client router serves them. */
export async function startDistServer(): Promise<{ readonly server: Server; readonly base: string }> {
  // The server.
  const server = createServer(async (req, res) => {
    try {
      // The request path without the leading slash.
      const rel = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/^\//, '');
      // The file it names, if any.
      let file = join(DIST, rel === '' ? 'index.html' : rel);
      // Not a file: the SPA entry.
      if (!(await stat(file).catch(() => null))?.isFile()) file = join(DIST, 'index.html');
      // Served with its type.
      res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'text/html' }).end(await readFile(file));
    } catch (err) {
      // A server fault is visible, never an empty 200.
      res.writeHead(500).end(String(err));
    }
  });
  // Port 0: any free port, so several browser test files can run side by side.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  // The server and the address the page loads from.
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

/* The fake session supabase-js reads on boot; far-future expiry, so no refresh POST is ever sent. */
export async function seedSession(context: BrowserContext, userId: string): Promise<void> {
  // Runs in every page of the context before the app's own scripts.
  await context.addInitScript((id: string) => {
    // The key supabase-js derives from the project URL.
    window.localStorage.setItem('sb-xynqxekcqizwhtskzqrq-auth-token', JSON.stringify({
      // Any string: every request is answered locally.
      access_token: 'e2e-test-token',
      // The scheme.
      token_type: 'bearer',
      // Two hours.
      expires_in: 7200,
      // Two hours from now.
      expires_at: Math.floor(Date.now() / 1000) + 7200,
      // Present, so the session shape is complete.
      refresh_token: 'e2e-test-refresh',
      // What isSessionValid checks.
      user: { id, aud: 'authenticated', role: 'authenticated', email: 'operator@example.test' },
    }));
  }, userId);
}
