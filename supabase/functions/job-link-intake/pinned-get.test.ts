// job-link-intake pinned-get: the hop that connects to the address the SSRF guard CHECKED (audit W17).
// Protects: the rebinding fix (the socket opens to the checked IP, never to a fresh lookup of the
// name), the HTTP/1.1 framing the hop parses by hand (Content-Length, chunked, until-close, 1xx),
// the status mapping httpFetch used to do (404 null, 3xx returned, other non-2xx thrown), the
// deadline, and the Deno wiring in index.ts.
// Run with: node --test "supabase/functions/job-link-intake/*.test.ts"
import { test } from "node:test";
// Strict asserts, so a near-miss is a failure rather than a coerced pass.
import assert from "node:assert/strict";
// Tells an IP literal from a name, the way the OS dialer does, for the rebinding fake below.
import { isIP } from "node:net";
// Builds a gzip body for the one server that ignores Accept-Encoding: identity.
import { gzipSync } from "node:zlib";
// The wiring test reads index.ts's source (Deno-only, so node cannot import it).
import { readFileSync } from "node:fs";
// The module under test.
import { fetchPinnedHop, type PinnedConn } from "./pinned-get.ts";
// The guard that hands the hop its checked address.
import { fetchPublicPage } from "./fetch-page.ts";
// The error classes the hop throws, so the caller's mapping is unchanged.
import { HttpError, NetworkError } from "../_shared/http/errors.ts";

// A fake TLS connection that behaves like a Deno.TlsConn: reads hand out the scripted response in
// small pieces (so every parser loop is exercised across read boundaries), writes accept only part
// of a buffer (so the write loop is exercised), a second close() throws like Deno's BadResource,
// and close() rejects a pending read, which is how the real deadline unblocks a stalled server.
function fakeConn(response: string | Uint8Array, opts: { readSize?: number; hang?: boolean } = {}) {
  // The scripted bytes; a string is sent as latin1 so header bytes map one-to-one.
  const bytes = typeof response === "string" ? Uint8Array.from(response, (c) => c.charCodeAt(0)) : response;
  // How far the server has sent.
  let offset = 0;
  // Everything the hop wrote, in order.
  const written: number[] = [];
  // Whether close() ran; checked so a test can prove no socket leaks.
  let closed = false;
  // The reject of a read that is waiting on a silent server.
  let pendingReject: ((err: Error) => void) | null = null;
  // The Deno.TlsConn subset the hop uses.
  const conn: PinnedConn = {
    // Partial writes, like a real socket under back-pressure.
    write(p) {
      // A closed socket cannot be written.
      if (closed) return Promise.reject(new Error("BadResource: closed"));
      // At most 16 bytes per call.
      const n = Math.min(p.length, 16);
      // Recorded for the request-shape assertions.
      written.push(...p.subarray(0, n));
      // The count written, as Deno reports it.
      return Promise.resolve(n);
    },
    // Scripted reads.
    read(p) {
      // A closed socket's read fails, as Deno's does.
      if (closed) return Promise.reject(new Error("BadResource: closed"));
      // A silent server: the read waits until close() rejects it.
      if (opts.hang === true) return new Promise((_, reject) => { pendingReject = reject; });
      // End of the response.
      if (offset >= bytes.length) return Promise.resolve(null);
      // One small piece.
      const n = Math.min(opts.readSize ?? 7, p.length, bytes.length - offset);
      // Copied into the caller's buffer.
      p.set(bytes.subarray(offset, offset + n));
      // Advanced past it.
      offset += n;
      // The count read.
      return Promise.resolve(n);
    },
    // Deno throws on a second close, so the hop must close exactly once.
    close() {
      // A double close is a bug in the hop.
      if (closed) throw new Error("BadResource: already closed");
      // Marked.
      closed = true;
      // Unblocks a pending read, like the real runtime.
      pendingReject?.(new Error("BadResource: closed while reading"));
    },
  };
  // The conn plus the probes.
  return { conn, written: () => String.fromCharCode(...written), isClosed: () => closed };
}

// A dialer over one fake conn that records every (address, serverName) it was asked for.
function fakeDial(fake: ReturnType<typeof fakeConn>) {
  // Every dial, in order.
  const dials: { address: string; serverName: string }[] = [];
  // The PinnedDial seam.
  return { dials, dial: { openTls: (address: string, serverName: string) => { dials.push({ address, serverName }); return Promise.resolve(fake.conn); } } };
}

// Reads a returned hop's body to text.
async function bodyOf(res: Response | null): Promise<string> {
  // A test that expects a body must have a Response.
  assert.ok(res !== null, "expected a Response, got null");
  // Drained like readCapped would.
  return await res.text();
}

test("W17: a rebinding resolver cannot move the connection: the socket opens to the address that was checked", async () => {
  // Zero-TTL rebinding: the first lookup answers a public address, every later one a private one.
  let lookups = 0;
  // The resolver both the guard and (if the hop re-resolved) the dialer would ask.
  const rebindingResolve = (_host: string) => Promise.resolve(lookups++ === 0 ? ["93.184.216.34"] : ["10.0.0.5"]);
  // A page the public server would serve.
  const fake = fakeConn("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello");
  // Where the socket really went: a name is resolved AGAIN, exactly as the OS dialer would do.
  const connectedTo: string[] = [];
  // The SNI / certificate name each dial carried.
  const serverNames: string[] = [];
  // The dialer: an IP literal is used as is; a name is looked up (the rebinding window).
  const dial = {
    // The real one is Deno.connect + Deno.startTls.
    async openTls(address: string, serverName: string) {
      // The OS resolves a name at connect time; an IP literal it does not.
      connectedTo.push(isIP(address) !== 0 ? address : ((await rebindingResolve(address))[0] as string));
      // Recorded for the certificate assertion.
      serverNames.push(serverName);
      // The scripted server.
      return fake.conn;
    },
  };
  // The real guard, with the real pinned hop behind it.
  const result = await fetchPublicPage("https://jobs.example.com/role/1", {
    // The rebinding DNS.
    resolve: rebindingResolve,
    // The production wiring's shape: the checked address goes to the hop.
    fetchHop: (hop, address) => fetchPinnedHop(hop, address, dial),
  });
  // The page was read.
  assert.deepEqual(result, { ok: true, html: "hello" });
  // THE FIX: one connection, to the address the guard checked, never the rebound private one.
  assert.deepEqual(connectedTo, ["93.184.216.34"]);
  // TLS still verifies the certificate against the real host name.
  assert.deepEqual(serverNames, ["jobs.example.com"]);
  // One lookup only: the guard's. Nothing looked the name up again.
  assert.equal(lookups, 1);
});

test("pinned-get writes one plain HTTP/1.1 GET for the path and query, Host = the name, and reads a Content-Length body", async () => {
  // Bytes past Content-Length must be ignored, not appended.
  const fake = fakeConn("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 11\r\n\r\n<p>job</p>\nTRAILING-GARBAGE");
  // Recorded dials.
  const { dials, dial } = fakeDial(fake);
  // A URL with a query, a fragment and a root dot.
  const res = await fetchPinnedHop("https://jobs.example.com./a/b?x=1&y=2#frag", "93.184.216.34", dial);
  // Exactly the declared bytes.
  assert.equal(await bodyOf(res), "<p>job</p>\n");
  // The header came through.
  assert.equal(res?.headers.get("content-type"), "text/html");
  // Dialled the checked address; the name (root dot stripped) is only for TLS.
  assert.deepEqual(dials, [{ address: "93.184.216.34", serverName: "jobs.example.com" }]);
  // The request as written, across 16-byte partial writes.
  const request = fake.written();
  // Path and query, never the fragment.
  assert.ok(request.startsWith("GET /a/b?x=1&y=2 HTTP/1.1\r\n"), request);
  // The real name, so the right virtual host answers.
  assert.match(request, /\r\nHost: jobs\.example\.com\r\n/);
  // The same honest identity httpFetch sends.
  assert.match(request, /\r\nUser-Agent: applyy-scout\//);
  // One request per socket, no compression asked for.
  assert.match(request, /\r\nConnection: close\r\n/);
  // Uncompressed, so Content-Length frames the bytes we read.
  assert.match(request, /\r\nAccept-Encoding: identity\r\n/);
  // A complete head.
  assert.ok(request.endsWith("\r\n\r\n"));
  // Fully read, so the socket was closed.
  assert.equal(fake.isClosed(), true);
});

test("pinned-get decodes a chunked body (extensions, trailers, chunks split across reads) and skips a 1xx", async () => {
  // A 103 first, then a chunked 200 whose chunks carry an extension and end with a trailer.
  const fake = fakeConn("HTTP/1.1 103 Early Hints\r\nLink: </s.css>\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;ext=1\r\nhello\r\n7\r\n, world\r\n0\r\nX-Trailer: t\r\n\r\n", { readSize: 3 });
  // The final status is the 200, and the body is the chunks joined.
  const res = await fetchPinnedHop("https://jobs.example.com/", "93.184.216.34", fakeDial(fake).dial);
  // Status of the FINAL response, not the interim one.
  assert.equal(res?.status, 200);
  // Joined chunk data, sizes and trailers removed.
  assert.equal(await bodyOf(res), "hello, world");
});

test("pinned-get reads to end-of-stream when there is no framing header, and decodes a gzip body sent anyway", async () => {
  // No Content-Length, no Transfer-Encoding: the body ends when the server closes.
  const plain = fakeConn("HTTP/1.0 200 OK\r\n\r\nuntil the end");
  // Read to EOF.
  assert.equal(await bodyOf(await fetchPinnedHop("https://jobs.example.com/", "93.184.216.34", fakeDial(plain).dial)), "until the end");
  // A server that ignores identity and gzips anyway.
  const zipped = gzipSync(Buffer.from("compressed page"));
  // Head as latin1 bytes, then the binary body.
  const head = Uint8Array.from(`HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${zipped.length}\r\n\r\n`, (c) => c.charCodeAt(0));
  // Decoded before the caller sees it, as fetch would.
  const gz = fakeConn(new Uint8Array([...head, ...zipped]));
  // The text, not the gzip bytes.
  assert.equal(await bodyOf(await fetchPinnedHop("https://jobs.example.com/", "93.184.216.34", fakeDial(gz).dial)), "compressed page");
});

test("pinned-get maps statuses like httpFetch did: 404 is null, a 3xx is handed back, any other non-2xx throws HttpError", async () => {
  // A dead link.
  const gone = fakeConn("HTTP/1.1 404 Not Found\r\nContent-Length: 3\r\n\r\nnah");
  // Null, the fetch-page contract for "page not found".
  assert.equal(await fetchPinnedHop("https://jobs.example.com/x", "93.184.216.34", fakeDial(gone).dial), null);
  // And the socket did not leak.
  assert.equal(gone.isClosed(), true);
  // A redirect, for fetch-page to re-check.
  const moved = fakeConn("HTTP/1.1 302 Found\r\nLocation: /next\r\nContent-Length: 0\r\n\r\n");
  // Returned, not followed.
  const res = await fetchPinnedHop("https://jobs.example.com/x", "93.184.216.34", fakeDial(moved).dial);
  // The 3xx itself.
  assert.equal(res?.status, 302);
  // Its target, which fetch-page resolves and checks before any request.
  assert.equal(res?.headers.get("location"), "/next");
  // A server error.
  const broken = fakeConn("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
  // Thrown as the same class httpFetch threw, so the caller's message mapping is unchanged.
  await assert.rejects(fetchPinnedHop("https://jobs.example.com/x", "93.184.216.34", fakeDial(broken).dial), (err: unknown) => err instanceof HttpError && err.status === 503);
  // Closed on the error path too.
  assert.equal(broken.isClosed(), true);
});

test("pinned-get refuses what it cannot vouch for: a garbled status line, an unknown framing, a non-https link, a silent server", async () => {
  // Not HTTP at all.
  const garbled = fakeConn("SSH-2.0-OpenSSH_9.6\r\n\r\n");
  // A NetworkError, never a parsed guess.
  await assert.rejects(fetchPinnedHop("https://jobs.example.com/", "93.184.216.34", fakeDial(garbled).dial), NetworkError);
  // Closed after the refusal.
  assert.equal(garbled.isClosed(), true);
  // A transfer coding we do not decode.
  const odd = fakeConn("HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n");
  // Refused, never read as raw bytes.
  await assert.rejects(fetchPinnedHop("https://jobs.example.com/", "93.184.216.34", fakeDial(odd).dial), NetworkError);
  // A plain-http link (the guard already refuses these; the hop must not depend on that).
  const never = fakeDial(fakeConn(""));
  // Refused before any socket opens.
  await assert.rejects(fetchPinnedHop("http://jobs.example.com/", "93.184.216.34", never.dial), NetworkError);
  // No dial happened.
  assert.equal(never.dials.length, 0);
  // A server that accepts the connection and never answers.
  const silent = fakeConn("", { hang: true });
  // The deadline closes the socket, which fails the pending read.
  await assert.rejects(fetchPinnedHop("https://jobs.example.com/", "93.184.216.34", fakeDial(silent).dial, 50), (err: unknown) => err instanceof NetworkError && /timed out/.test(String((err as NetworkError).cause)));
  // Closed by the deadline.
  assert.equal(silent.isClosed(), true);
});

test("W17 wiring: index.ts hands fetchHop's checked address to the pinned hop, dialled by IP with TLS verified against the name", () => {
  // index.ts is Deno-only (Deno.serve at module scope), so its wiring is pinned by source shape.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  // The guard's checked address goes straight into the pinned hop.
  assert.match(source, /fetchHop: \(hop, address\) => fetchPinnedHop\(hop, address, /);
  // The dial: TCP to the IP literal, then TLS whose SNI and certificate check use the real name.
  assert.match(source, /Deno\.startTls\(await Deno\.connect\(\{ hostname: address, port: 443 \}\), \{ hostname: serverName \}\)/);
});
