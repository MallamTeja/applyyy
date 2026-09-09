// A localhost static file server for saved ATS application forms.
//
// PROJECT_PLAN.md §19 forbids testing by submitting real applications
// (constraint #16). The way out is to save real Greenhouse/Lever/Ashby form
// markup to disk and serve it from here, so Playwright drives genuine DOM while
// no employer ever receives anything. This file is test infrastructure, but it
// is production-grade on purpose: it runs on a machine where the resume, .env
// and Supabase keys live a few directories above the fixture root.
import { createServer, type Server } from 'node:http';
// readFile rather than a stream: fixtures are single-page HTML measured in
// kilobytes, and reading whole makes the not-found case a plain try/catch.
import { readFile } from 'node:fs/promises';
// resolve/join/sep are what make the containment check below exact rather than
// a string-prefix guess.
import { join, resolve, sep } from 'node:path';

/** A running fixture server: where to point Playwright, and how to shut it. */
export interface FixtureServer {
  // Origin including the OS-assigned port, e.g. http://127.0.0.1:53124.
  readonly url: string;
  // Releases the port; awaited by tests so the next file can bind cleanly.
  close(): Promise<void>;
}

/**
 * Serve `rootDir` over HTTP on an ephemeral port.
 *
 * Binds port 0 (OS-assigned) rather than a fixed port because a hardcoded port
 * collides the moment two test files, or two Actions jobs, run concurrently.
 */
export async function startFixtureServer(rootDir: string): Promise<FixtureServer> {
  // Canonical absolute form of the served directory. Every request is checked
  // against this exact string, so it must be resolved once, up front.
  const root = resolve(rootDir);

  // One handler; no routing table, because the only resource type is a file.
  const server: Server = createServer((request, response) => {
    // Node hands over a raw request target that may contain a query string, so
    // it is parsed against a dummy origin purely to isolate the path.
    const requestedPath = new URL(request.url ?? '/', 'http://localhost').pathname;

    // The decode is the dangerous step and the reason this guard exists: a
    // client can send %2e%2e%2f, which survives WHATWG URL normalisation in
    // fetch() and only becomes "../" here, inside the server.
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(requestedPath);
    } catch {
      // A malformed escape sequence is never a real fixture request; refuse it
      // rather than letting a throw take down the whole server.
      response.writeHead(400).end();
      return;
    }

    // Join first, then re-resolve: this collapses any "../" the decode produced
    // into a real absolute path that can be compared honestly.
    const candidate = resolve(join(root, decodedPath));

    // Containment check. The `+ sep` matters: without it a sibling directory
    // named "fixtures-secrets" would pass a bare startsWith("fixtures") test.
    // Escaped paths get 404, not 403, so the server never reveals whether the
    // out-of-bounds file exists.
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      response.writeHead(404).end();
      return;
    }

    // Read and serve. A missing file and an unreadable one are both simply
    // "not a fixture", so one catch covers both.
    readFile(candidate)
      .then((contents) => {
        // Fixtures are HTML documents; the charset is explicit so the browser
        // does not sniff an encoding and silently alter the saved markup.
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(contents);
      })
      .catch(() => {
        // Same 404 shape as the traversal refusal, so the two are
        // indistinguishable from outside.
        response.writeHead(404).end();
      });
  });

  // Wrap listen's callback style so callers can simply await the server.
  await new Promise<void>((resolveListen) => {
    // 127.0.0.1, not 0.0.0.0: these fixtures are served on a developer laptop
    // and on shared CI runners, and neither should expose them to the network.
    server.listen(0, '127.0.0.1', resolveListen);
  });

  // listen() is complete, so address() is a populated object rather than null.
  const address = server.address();
  // Narrow the string|AddressInfo|null union; a string means a UNIX socket,
  // which port 0 on 127.0.0.1 cannot produce.
  if (address === null || typeof address === 'string') {
    // Fail loudly here rather than handing back an unusable URL that surfaces
    // later as a confusing Playwright navigation error.
    throw new Error('fixture server did not bind a TCP port');
  }

  return {
    // The port the OS actually chose, which is the only way callers can reach it.
    url: `http://127.0.0.1:${address.port}`,
    // Promisified close so tests can await teardown deterministically.
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        // close() reports an error only if the server was never listening.
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  };
}
