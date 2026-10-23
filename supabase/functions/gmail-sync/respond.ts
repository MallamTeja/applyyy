// PURE RESPONSE SHAPING FOR gmail-sync, split from index.ts so node --test can reach it
// (index.ts runs Deno.serve on import — the decide.ts / gate.ts pattern).
//
// The function proxies the dashboard's "sync now" to the Apps Script Web App so the
// shared secret stays SERVER-SIDE: the old route put the /exec URL with ?secret= into a
// VITE_ env var, which compiles into the public browser bundle. The invariant this
// module enforces end to end: THE SECRET NEVER APPEARS IN ANY RESPONSE BODY.

// What the browser receives. Fixed contract with the web hook (2026-10-23):
// { ok: boolean, cooldown?: boolean, details?: unknown, error?: string }.
export interface SyncBody {
  // Whether the sync (or the honest cooldown skip) went through.
  readonly ok: boolean;
  // Present and true when the Apps Script's 60s server-side cooldown skipped the run.
  readonly cooldown?: boolean;
  // The script's own result payload, passed through for the drawer's detail view.
  readonly details?: unknown;
  // Short, fixed error strings only — never upstream text, which could carry the URL.
  readonly error?: string;
}

// One verdict shape for every path: the HTTP status and the body travel together so
// index.ts cannot pair them wrong.
export interface SyncVerdict {
  // HTTP status for the browser.
  readonly status: number;
  // The JSON body.
  readonly body: SyncBody;
}

/**
 * The config gate. Null/empty env vars mean "not configured" — a plain 503 the
 * dashboard can show verbatim, never a crash. The sync URL will not exist until Teja
 * deploys the Web App, and the function must ship cleanly before that.
 */
export function configVerdict(url: string | null, secret: string | null): { readonly ok: true; readonly url: string; readonly secret: string } | { readonly ok: false; readonly verdict: SyncVerdict } {
  // Either missing or blank: same refusal, stated plainly.
  if (url === null || url.trim() === "" || secret === null || secret.trim() === "") {
    return { ok: false, verdict: { status: 503, body: { ok: false, error: "gmail sync not configured" } } };
  }
  // Both present: hand back trimmed concrete values.
  return { ok: true, url: url.trim(), secret: secret.trim() };
}

/**
 * Maps the upstream (Apps Script Web App) response to the browser's verdict.
 * Fail closed on shape (CLAUDE.md §6): a non-JSON or non-object body is an upstream
 * failure, never "probably fine". And the secret must not survive into the output —
 * Google error pages can echo the request URL, query string included.
 */
export function upstreamVerdict(status: number, bodyText: string, secret: string): SyncVerdict {
  // The Web App always answers JSON over 200; anything else is Google infrastructure
  // (login wall, quota page, 302-to-HTML) — an upstream failure with a fixed message.
  if (status !== 200) {
    return { status: 502, body: { ok: false, error: "upstream sync failed" } };
  }
  // Parse defensively; a throw here is the HTML-instead-of-JSON case.
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 502, body: { ok: false, error: "upstream sync failed" } };
  }
  // Only an object with a boolean `ok` is the script's shape; anything else fails closed.
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { ok?: unknown }).ok !== "boolean") {
    return { status: 502, body: { ok: false, error: "upstream sync failed" } };
  }
  // The script's reply, narrowed.
  const reply = parsed as { ok: boolean; cooldown?: unknown; skipped?: unknown; details?: unknown; error?: unknown };
  // Rebuild the body from known fields only — never spread upstream JSON wholesale.
  const body: SyncBody = {
    // The script's own verdict.
    ok: reply.ok,
    // Carried only when the script said so, as a literal true.
    ...(reply.cooldown === true ? { cooldown: true } : {}),
    // The drawer's detail payload, if any.
    ...(reply.details === undefined ? {} : { details: reply.details }),
    // Upstream error text is replaced with a fixed string: it can quote the request.
    ...(reply.ok === false ? { error: "upstream sync failed" } : {}),
  };
  // THE INVARIANT, checked last so it covers every carried field: if the secret leaked
  // into the details (an echo of the request URL, a misconfigured script), withhold the
  // body entirely rather than forward it to the browser.
  if (secret.length > 0 && JSON.stringify(body).includes(secret)) {
    return { status: 502, body: { ok: false, error: "upstream response withheld" } };
  }
  // Clean pass-through.
  return { status: 200, body };
}
