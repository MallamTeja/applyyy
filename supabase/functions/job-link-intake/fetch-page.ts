// job-link-intake — fetching a pasted page without letting the link reach a private network.
//
// WHY THIS FILE EXISTS (SSRF, security review of 487162f, 2026-10-31): the link comes from a
// stranger's post and OUR server fetches it. A hostname check alone is not enough: a public
// name can resolve to 127.0.0.1 (e.g. 127.0.0.1.nip.io), `localhost.` slips past a suffix
// match, and an allowed host can 302 to an internal one. So redirects are followed BY HAND and
// every hop is shape-checked, DNS-resolved and address-checked before it is requested.
// ponytail: fetch re-resolves the name after our check, so a DNS-rebinding window remains;
// closing it means pinning the checked IP in a custom connector. Add that if this runtime ever
// sits on a private network worth reaching.
//
// Pure module behind two seams (fetchHop, resolve), so `node --test` covers every branch.

// Hops allowed after the first request: enough for http->https->locale->canonical chains.
export const MAX_REDIRECTS = 5;
// Bytes read from a page before the rest is dropped: pageText keeps 30k chars anyway.
export const MAX_PAGE_BYTES = 2_000_000;

// True for hosts a server-side fetch must never reach: loopback, private names and bare IPs.
export function isBlockedHost(hostname: string): boolean {
  // `localhost.` is the same host as `localhost`; strip the root dot(s) before any check.
  const host = hostname.replace(/\.+$/, "").toLowerCase();
  // IPv6 literals arrive bracketed; any of them is refused (no job board is a bare IP).
  if (host.startsWith("[")) return true;
  // Dotted IPv4 literal of any range: refused for the same reason.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  // A single-label name (no dot) only resolves inside a private network.
  if (!host.includes(".")) return true;
  // Names reserved for local or internal use.
  return /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/.test(host);
}

// The refusal for a URL we will not fetch, or null when it may be fetched. Used for the pasted
// link AND every redirect hop, so the two can never apply different rules.
export function checkPublicUrl(url: URL): string | null {
  // https only, like every board this repo talks to.
  if (url.protocol !== "https:") return "Only https:// links are accepted.";
  // Userinfo and custom ports are lookalike and SSRF tricks.
  if (url.username !== "" || url.password !== "" || url.port !== "") return "Links with a username or port are not accepted.";
  // Never a private name or a bare IP.
  if (isBlockedHost(url.hostname)) return "That host cannot be fetched.";
  // Fetchable, subject to the address check.
  return null;
}

// True only for an address on the public internet. Anything unparseable is NOT public (§6).
export function isPublicAddress(ip: string): boolean {
  // Dotted IPv4.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  // IPv4 ranges that are not the public internet.
  if (v4 !== null) {
    // The first two octets decide every range below.
    const a = Number(v4[1]);
    // Second octet.
    const b = Number(v4[2]);
    // "This network", RFC1918 10/8, loopback 127/8.
    if (a === 0 || a === 10 || a === 127) return false;
    // CGNAT 100.64/10.
    if (a === 100 && b >= 64 && b <= 127) return false;
    // Link-local 169.254/16, which holds the cloud metadata endpoint 169.254.169.254.
    if (a === 169 && b === 254) return false;
    // RFC1918 172.16/12.
    if (a === 172 && b >= 16 && b <= 31) return false;
    // RFC1918 192.168/16 and IETF 192.0.0/24.
    if (a === 192 && (b === 168 || (b === 0 && Number(v4[3]) === 0))) return false;
    // Benchmarking 198.18/15.
    if (a === 198 && (b === 18 || b === 19)) return false;
    // Multicast 224/4 and reserved 240/4.
    return a < 224;
  }
  // Lower-cased once for the IPv6 prefixes.
  const v6 = ip.toLowerCase();
  // Neither family: not an address we can vouch for.
  if (!v6.includes(":")) return false;
  // Unspecified, loopback, v4-mapped and v4-compatible forms all start with "::"; no public one does.
  if (v6.startsWith("::")) return false;
  // ULA fc00::/7, link-local fe80::/10, multicast ff00::/8, NAT64 64:ff9b::/96 and 64:ff9b:1::/48,
  // 6to4 2002::/16 and Teredo 2001:0::/32 (all three can carry a private v4), discard 100::/64.
  return !/^(f[cd]|fe[89ab]|ff|64:ff9b:|2002:|2001:0:|2001::|100::|100:0:0:0:)/.test(v6);
}

// The two effects, injected.
export interface PageFetchDeps {
  // One robots-gated GET with redirect: "manual": a 3xx comes back as a Response; null on 404.
  fetchHop(url: string): Promise<Response | null>;
  // Every A and AAAA address of a host; empty when it has none or cannot be resolved.
  resolve(hostname: string): Promise<string[]>;
}

// At most `max` bytes of the body as text; the rest is dropped, never buffered.
async function readCapped(res: Response, max: number): Promise<string> {
  // No body is an empty page.
  if (res.body === null) return "";
  // Streamed, so a huge page is never held in memory.
  const reader = res.body.getReader();
  // The kept chunks.
  const chunks: Uint8Array[] = [];
  // Bytes kept so far.
  let total = 0;
  // Until the stream ends or the cap is hit.
  while (total < max) {
    // One chunk.
    const { done, value } = await reader.read();
    // End of the page.
    if (done) break;
    // Only up to the cap.
    chunks.push(value.subarray(0, max - total));
    // Counted after trimming.
    total += Math.min(value.byteLength, max - (total));
  }
  // Stop the download if the cap ended it early; a no-op when the stream already ended.
  await reader.cancel().catch(() => {});
  // Blob decodes UTF-8; a character cut at the cap becomes one replacement char.
  // Cast: Deno types stream chunks over ArrayBufferLike, but a fetch body never hands out a SharedArrayBuffer.
  return await new Blob(chunks as BlobPart[]).text();
}

// Fetch a pasted page, re-checking every redirect hop. Never fetches a refused hop. May throw
// whatever fetchHop throws (robots refusal, bot wall, network); the caller maps those.
export async function fetchPublicPage(start: string, deps: PageFetchDeps): Promise<{ ok: true; html: string } | { ok: false; reason: string }> {
  // The URL about to be requested.
  let current = start;
  // The first request plus MAX_REDIRECTS hops.
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Parsed for the checks; a hop that is not a URL is refused, never guessed at.
    let url: URL;
    // new URL only splits the string.
    try {
      // The current hop.
      url = new URL(current);
    } catch {
      // A garbled Location header.
      return { ok: false, reason: "a redirect pointed at an invalid link" };
    }
    // The same rules as the pasted link.
    const refused = checkPublicUrl(url);
    // Named so the human sees why.
    if (refused !== null) return { ok: false, reason: `a redirect was refused: ${refused}` };
    // Where this name really points, root dot stripped like isBlockedHost does.
    const addresses = await deps.resolve(url.hostname.replace(/\.+$/, ""));
    // No address: nothing safe to connect to (also the fail-closed answer if DNS is unavailable).
    if (addresses.length === 0) return { ok: false, reason: "the site's address could not be looked up" };
    // One private address is enough to refuse: the connection may pick any of them.
    if (!addresses.every(isPublicAddress)) return { ok: false, reason: "the site points at a private network address" };
    // The request itself, robots-gated, redirects NOT followed.
    const res = await deps.fetchHop(url.toString());
    // A 404 is a dead link.
    if (res === null) return { ok: false, reason: "page not found" };
    // A redirect: check the next hop before following it.
    if (res.status >= 300 && res.status < 400) {
      // Where it wants to send us.
      const location = res.headers.get("location");
      // The redirect body is never read.
      await res.body?.cancel().catch(() => {});
      // A 3xx without a target cannot be followed.
      if (location === null) return { ok: false, reason: "a redirect without a target" };
      // Relative Locations resolve against this hop; the loop re-checks the result.
      try {
        // Absolute URL of the next hop.
        current = new URL(location, url).toString();
      } catch {
        // An unparseable target is refused like any other bad hop.
        return { ok: false, reason: "a redirect pointed at an invalid link" };
      }
      // Next hop.
      continue;
    }
    // The page, capped.
    return { ok: true, html: await readCapped(res, MAX_PAGE_BYTES) };
  }
  // A redirect loop or a very long chain.
  return { ok: false, reason: "too many redirects" };
}
