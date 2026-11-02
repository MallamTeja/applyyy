// job-link-intake — one HTTP/1.1 GET over a socket opened to the address the SSRF guard CHECKED.
//
// WHY THIS FILE EXISTS (audit W17, 2026-11-02): fetch-page.ts resolves the pasted host and refuses
// any private address, but fetch() then resolved the name AGAIN. A zero-TTL DNS answer can flip
// between the two lookups (DNS rebinding) and send the real request to 10.x, 127.x or the cloud
// metadata address 169.254.169.254. fetch() cannot be told "connect to this IP": Deno's
// createHttpClient has no resolver option, and fetching https://<ip>/ fails the certificate check.
// So this hop dials the checked IP itself and runs TLS with the real name for SNI and the
// certificate check (Deno.connect + Deno.startTls, the pair deno-postgres uses on Supabase).
//
// It stands in for the httpFetch call the pasted page used, keeping what that call did: one
// attempt, the 15 s deadline, the honest User-Agent, 404 as null, a 3xx handed back for fetch-page
// to re-check, any other non-2xx thrown as HttpError, a transport failure as NetworkError. One
// difference: a bot-wall status now throws HttpError, not BotProtectionError. The handler reads
// only the message, and both move the ladder to the browser render.
// ponytail: HTTP/1.1, one request per socket, no keep-alive or HTTP/2, and only the first checked
// address (no fallback to the next one). Enough for one page per paste; add a fallback if hosts
// with a dead first address show up in the logs.
//
// The socket is injected (PinnedDial), so `node --test` drives every branch without a network.

// The same error classes httpFetch throws, so index.ts's message mapping is unchanged.
import { HttpError, NetworkError } from "../_shared/http/errors.ts";
// The transport's deadline and identity, reused so this hop cannot drift from every other request.
import { DEFAULT_TIMEOUT_MS, DEFAULT_USER_AGENT } from "../_shared/http/index.ts";

// The Deno.TlsConn subset this hop uses; Deno's own connection satisfies it as is.
export interface PinnedConn {
  // Fills p; the byte count, or null at end of stream.
  read(p: Uint8Array): Promise<number | null>;
  // Writes some of p; the byte count actually written.
  write(p: Uint8Array): Promise<number>;
  // Releases the socket. Deno throws on a second call.
  close(): void;
}

// The one effect: a TLS connection to an IP literal, its certificate checked against serverName.
export interface PinnedDial {
  // Real: Deno.startTls(await Deno.connect({ hostname: address, port: 443 }), { hostname: serverName }).
  openTls(address: string, serverName: string): Promise<PinnedConn>;
}

// The largest response head accepted; real heads are a few KB, and a bigger one is not a page.
const MAX_HEAD_BYTES = 64 * 1024;
// The largest chunk-size or trailer line accepted.
const MAX_LINE_BYTES = 4096;
// Statuses that never carry a body (RFC 9110), and for which Response refuses one.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
// The status line: HTTP/1.x, a three-digit code from 100 to 599, an optional reason phrase.
const STATUS_LINE = /^HTTP\/1\.[01] ([1-5]\d\d)(?: (.*))?$/;
// A header field: an RFC 9110 token name, a colon, and the value with outer whitespace trimmed.
const HEADER_LINE = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*?)[ \t]*$/;
// A chunk-size line: the hex size, then optional chunk extensions, which are ignored.
const CHUNK_SIZE_LINE = /^([0-9a-fA-F]{1,8})[ \t]*(?:;.*)?$/;

// Bytes received but not parsed yet, shared by the head and body readers of one response.
interface Inbox {
  // The socket being read.
  readonly conn: PinnedConn;
  // What has arrived and not been consumed.
  held: Uint8Array;
}

// Appends one more read to the inbox; false at end of stream.
async function receive(inbox: Inbox): Promise<boolean> {
  // A fresh buffer per read, about one TLS record.
  const buf = new Uint8Array(16 * 1024);
  // One read from the socket.
  const n = await inbox.conn.read(buf);
  // End of stream.
  if (n === null) return false;
  // Room for what was held plus the new bytes.
  const joined = new Uint8Array(inbox.held.length + n);
  // What was held first.
  joined.set(inbox.held);
  // Then the new bytes.
  joined.set(buf.subarray(0, n), inbox.held.length);
  // Held from now on.
  inbox.held = joined;
  // More may follow.
  return true;
}

// Removes and returns the first n held bytes.
function take(inbox: Inbox, n: number): Uint8Array {
  // The bytes handed out.
  const front = inbox.held.subarray(0, n);
  // The rest stays held.
  inbox.held = inbox.held.subarray(n);
  // Never mutated afterwards, so sharing the buffer is safe.
  return front;
}

// Index of the first CRLF (or CRLF CRLF when `blankLine`) in bytes, or -1.
function indexOfLineEnd(bytes: Uint8Array, blankLine: boolean): number {
  // The pattern is 2 or 4 bytes long.
  const width = blankLine ? 4 : 2;
  // Every start position the whole pattern fits after.
  for (let i = 0; i + width <= bytes.length; i++) {
    // CR LF, and for a blank line a second CR LF.
    if (bytes[i] === 13 && bytes[i + 1] === 10 && (!blankLine || (bytes[i + 2] === 13 && bytes[i + 3] === 10))) return i;
  }
  // Not arrived yet.
  return -1;
}

// Header bytes as text, one char per byte: header values are ByteStrings, which Headers requires.
function latin1(bytes: Uint8Array): string {
  // A per-byte map avoids the argument-count limit of String.fromCharCode(...bytes).
  return Array.from(bytes, (b) => String.fromCharCode(b)).join("");
}

// Reads text up to the next CRLF (or the CRLF CRLF that ends a head), consuming the terminator.
async function readUntilLineEnd(inbox: Inbox, blankLine: boolean, max: number, what: string): Promise<string> {
  // Until the terminator arrives.
  for (;;) {
    // Where the terminator is, if it has arrived.
    const at = indexOfLineEnd(inbox.held, blankLine);
    // Found: return the text before it.
    if (at !== -1) {
      // The text itself.
      const text = latin1(take(inbox, at));
      // Drop the terminator.
      take(inbox, blankLine ? 4 : 2);
      // The line or the head.
      return text;
    }
    // A runaway line is refused instead of buffered without bound.
    if (inbox.held.length > max) throw new Error(`${what} longer than ${max} bytes`);
    // The server closed before finishing it.
    if (!(await receive(inbox))) throw new Error(`connection closed inside the ${what}`);
  }
}

// The status, reason and headers of one response head. Throws on anything malformed (§6).
function parseHead(head: string): { status: number; statusText: string; headers: Headers } {
  // The status line, then one field per line.
  const [statusLine = "", ...fieldLines] = head.split("\r\n");
  // Only a real HTTP/1.x status line is accepted.
  const status = STATUS_LINE.exec(statusLine);
  // Anything else (another protocol, garbage) is refused, never guessed at.
  if (status === null) throw new Error(`not an HTTP/1.x status line: ${JSON.stringify(statusLine.slice(0, 40))}`);
  // Collected in the same container fetch hands back.
  const headers = new Headers();
  // Every field line.
  for (const line of fieldLines) {
    // Name and value.
    const field = HEADER_LINE.exec(line);
    // A folded or broken line is refused (RFC 9112 allows rejecting obs-fold).
    if (field === null) throw new Error(`malformed header line: ${JSON.stringify(line.slice(0, 40))}`);
    // Both groups always participate when the pattern matches.
    headers.append(field[1] as string, field[2] as string);
  }
  // Group 1 always participates; the reason phrase is optional.
  return { status: Number(status[1]), statusText: status[2] ?? "", headers };
}

// Exactly n body bytes, yielded as they arrive. The server closing early is an error.
async function* exactly(inbox: Inbox, n: number): AsyncGenerator<Uint8Array> {
  // Bytes still owed.
  let left = n;
  // Until all of them have been yielded.
  while (left > 0) {
    // Nothing held: read more, or fail if the server is gone.
    if (inbox.held.length === 0 && !(await receive(inbox))) throw new Error("connection closed before the body ended");
    // As much as is held, up to what is owed.
    const piece = take(inbox, Math.min(left, inbox.held.length));
    // Counted.
    left -= piece.length;
    // Handed on.
    yield piece;
  }
}

// A chunked body (RFC 9112 §7.1): size line, data, CRLF, repeated; a 0 size, trailers, blank line.
async function* chunked(inbox: Inbox): AsyncGenerator<Uint8Array> {
  // One chunk per pass.
  for (;;) {
    // The size line.
    const size = CHUNK_SIZE_LINE.exec(await readUntilLineEnd(inbox, false, MAX_LINE_BYTES, "chunk size line"));
    // A size that is not hex is refused.
    if (size === null) throw new Error("malformed chunk size line");
    // Group 1 always participates.
    const length = parseInt(size[1] as string, 16);
    // The last chunk.
    if (length === 0) break;
    // Its data.
    yield* exactly(inbox, length);
    // The CRLF after the data; anything else means the size lied.
    if ((await readUntilLineEnd(inbox, false, MAX_LINE_BYTES, "chunk end")) !== "") throw new Error("chunk data overran its size");
  }
  // Trailer fields up to the blank line; nothing here reads them.
  while ((await readUntilLineEnd(inbox, false, MAX_LINE_BYTES, "trailer")) !== "") continue;
}

// A body with no framing header: everything until the server closes (HTTP/1.0 style).
async function* untilClose(inbox: Inbox): AsyncGenerator<Uint8Array> {
  // What already arrived with the head, then every later read.
  do {
    // Hand on whatever is held.
    if (inbox.held.length > 0) yield take(inbox, inbox.held.length);
  } while (await receive(inbox));
}

// The body's bytes as the response frames them (RFC 9112 §6.3), or null when it has none.
function bodyFrames(inbox: Inbox, status: number, headers: Headers): AsyncGenerator<Uint8Array> | null {
  // 204, 205 and 304 never have a body.
  if (NULL_BODY_STATUSES.has(status)) return null;
  // Transfer-Encoding wins over Content-Length.
  const coding = headers.get("transfer-encoding");
  // Only plain chunked is decoded; a layered coding is refused rather than read as raw bytes.
  if (coding !== null) {
    // Anything but exactly "chunked".
    if (coding.toLowerCase() !== "chunked") throw new Error(`unsupported Transfer-Encoding: ${coding}`);
    // Decoded chunk by chunk.
    return chunked(inbox);
  }
  // A declared length.
  const length = headers.get("content-length");
  // Digits only; a list ("5, 5") or junk is refused, never parsed leniently (Number("") is 0).
  if (length !== null) {
    // The positive shape of a length.
    if (!/^\d{1,15}$/.test(length)) throw new Error(`malformed Content-Length: ${length}`);
    // Exactly that many bytes; the rest of the socket is ignored.
    return exactly(inbox, Number(length));
  }
  // No framing: read to end of stream.
  return untilClose(inbox);
}

// The frames as a ReadableStream that closes the socket when the body ends, fails or is cancelled.
function streamOf(frames: AsyncGenerator<Uint8Array>, close: () => void): ReadableStream<Uint8Array> {
  // A pull source, so nothing is read before the caller asks.
  return new ReadableStream<Uint8Array>(
    {
      // One frame per pull.
      async pull(controller) {
        // A socket error becomes a stream error, never an unhandled rejection.
        try {
          // The next frame.
          const next = await frames.next();
          // The body ended: the socket is done.
          if (next.done === true) {
            // Released first.
            close();
            // Then the stream ends.
            controller.close();
          } else {
            // Handed to the reader.
            controller.enqueue(next.value);
          }
        } catch (err) {
          // Released on failure too.
          close();
          // The reader sees the failure.
          controller.error(err);
        }
      },
      // A reader that stops early (readCapped at its cap, fetch-page on a 3xx) releases the socket.
      cancel() {
        // Closing also fails any read still waiting.
        close();
      },
    },
    // No read-ahead: a redirect's body is never pulled.
    { highWaterMark: 0 },
  );
}

// Rejects when the deadline fires, so a dial or handshake that hangs cannot outlive the budget.
function timedOut(deadline: AbortSignal): Promise<never> {
  // Never resolves; rejects on abort.
  return new Promise((_, reject) => deadline.addEventListener("abort", () => reject(new Error("deadline")), { once: true }));
}

// One GET of `url` over a socket to `address` (an IP the guard checked), redirects NOT followed.
// Returns the Response (2xx or 3xx), null on 404; throws HttpError on any other status, and
// NetworkError when the link, the socket, the TLS handshake or the response cannot be used.
export async function fetchPinnedHop(url: string, address: string, dial: PinnedDial, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<Response | null> {
  // Parsed for the request line; fetch-page has already shape-checked it.
  const target = new URL(url);
  // TLS name and Host header: the hostname without root dot(s), the same name fetch-page resolved.
  const serverName = target.hostname.replace(/\.+$/, "");
  // Path and query; the fragment is never sent.
  const path = `${target.pathname}${target.search}`;
  // Only what the guard allows (https on 443), and only bytes that cannot split the request.
  if (target.protocol !== "https:" || target.port !== "" || !/^[a-z0-9._-]+$/.test(serverName) || !/^\/[\x21-\x7e]*$/.test(path)) {
    // Refused before any socket opens.
    throw new NetworkError(url, 1, new Error("the pinned hop takes only https links on port 443 with a plain-ASCII host and path"));
  }
  // One request per connection, uncompressed, so the framing headers describe the bytes read.
  const request = new TextEncoder().encode(
    // The request line, then the headers httpFetch's fetch() sent in substance.
    `GET ${path} HTTP/1.1\r\nHost: ${serverName}\r\nUser-Agent: ${DEFAULT_USER_AGENT}\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`,
  );
  // The hop's whole budget: dial, handshake, head and body share it, as fetch's signal did.
  const deadline = AbortSignal.timeout(timeoutMs);
  // The socket, once open.
  let conn: PinnedConn | null = null;
  // Set by the first close, because Deno throws on a second one.
  let closed = false;
  // Closes the socket at most once; closing also fails a read that is still waiting.
  const close = () => {
    // Nothing open, or already closed.
    if (closed || conn === null) return;
    // Marked first, so a throw below cannot lead to a second attempt.
    closed = true;
    // The runtime may already have released it.
    try {
      // Release.
      conn.close();
    } catch {
      // Already gone: nothing left to release.
    }
  };
  // The deadline closes whatever is open, which unblocks any pending read.
  deadline.addEventListener("abort", close, { once: true });
  // The response head; read inside the try, mapped after it.
  let head: ReturnType<typeof parseHead>;
  // The Response handed back for a 2xx or 3xx.
  let response: Response;
  // Every transport and parse failure becomes one NetworkError.
  try {
    // The dial: an IP literal, so nothing resolves the name again.
    const opening = dial.openTls(address, serverName);
    // A socket that opens after the deadline is closed, never leaked. The close is wrapped: a throw
    // inside this handler would be an unhandled rejection, which can take the isolate down.
    opening.then((late) => { if (deadline.aborted && conn === null) try { late.close(); } catch { /* already gone */ } }, () => {});
    // Open, or the deadline won.
    conn = await Promise.race([opening, timedOut(deadline)]);
    // Bytes of the request sent so far.
    let sent = 0;
    // A socket may accept only part of a buffer per write.
    while (sent < request.length) sent += await conn.write(request.subarray(sent));
    // The bytes the server sends back.
    const inbox: Inbox = { conn, held: new Uint8Array(0) };
    // The first head.
    head = parseHead(await readUntilLineEnd(inbox, true, MAX_HEAD_BYTES, "response head"));
    // 1xx heads (103 Early Hints, 100 Continue) are interim; the real answer follows.
    while (head.status < 200) head = parseHead(await readUntilLineEnd(inbox, true, MAX_HEAD_BYTES, "response head"));
    // The body framing, checked before the status is acted on, so a malformed one is refused.
    const frames = bodyFrames(inbox, head.status, head.headers);
    // A response with no body is finished with the socket now.
    if (frames === null) close();
    // The body as a stream, or none.
    let body: ReadableStream<Uint8Array> | null = frames === null ? null : streamOf(frames, close);
    // We asked for identity; a server that compresses anyway is decoded, as fetch would.
    const encoding = (head.headers.get("content-encoding") ?? "identity").toLowerCase();
    // Only when there is a body and it is not plain.
    if (body !== null && encoding !== "identity") {
      // gzip and zlib-deflate are what DecompressionStream reads; anything else is refused.
      if (encoding !== "gzip" && encoding !== "x-gzip" && encoding !== "deflate") throw new Error(`unsupported Content-Encoding: ${encoding}`);
      // Decoded on the fly; cancelling the output still cancels the socket stream. Cast: Deno types
      // the decoder's input as BufferSource, wider than the Uint8Array chunks this stream carries.
      body = body.pipeThrough(new DecompressionStream(encoding === "deflate" ? "deflate" : "gzip") as ReadableWritablePair<Uint8Array, Uint8Array>);
    }
    // The same shape fetch returns, so fetch-page and readCapped are unchanged.
    response = new Response(body, { status: head.status, statusText: head.statusText, headers: head.headers });
  } catch (cause) {
    // Released on every failure path.
    close();
    // A deadline is named as one; any other cause is passed through for the log.
    throw new NetworkError(url, 1, deadline.aborted ? new Error(`timed out after ${timeoutMs} ms`) : cause);
  }
  // A dead link: the body is not read.
  if (head.status === 404) {
    // Released.
    close();
    // fetch-page's "page not found".
    return null;
  }
  // A 2xx page or a 3xx for fetch-page to re-check (it cancels the body, which closes the socket).
  if (head.status < 400) return response;
  // Any other status ends the hop, as httpFetch with no retries did.
  close();
  // The same error class and message shape as before.
  throw new HttpError(url, head.status, head.statusText, 1);
}
