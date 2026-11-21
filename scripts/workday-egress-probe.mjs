// Workday egress probe (2026-11-21). One question: does Workday's Cloudflare block the
// GitHub-runner IPs for robots.txt only, or for the jobs POST too? Run the SAME file from the
// runner (.github/workflows/workday-egress-probe.yml) and from Teja's home IP (`node scripts/workday-egress-probe.mjs`)
// and compare: runner 429 + home 200 = IP block; both 200 = transient; both 429 = UA/header block.
// Read-only by construction: one GET and one limit-1 POST per tenant, no secrets, no DB, no writes.

// Three enabled tenants from the live watchlist (company_watchlist, ats_provider='workday', read
// 2026-11-21), each on a different wd cluster (1, 3, 5) so one cluster's edge cannot decide the answer.
const TENANTS = [
  // BlackRock: board_token "blackrock.wd1/BlackRock_Professional".
  { tenant: 'blackrock', wd: 1, site: 'BlackRock_Professional' },
  // Barclays: board_token "barclays.wd3/External_Career_Site_Barclays?locations=…" (facet dropped: limit-1 probe).
  { tenant: 'barclays', wd: 3, site: 'External_Career_Site_Barclays' },
  // Adobe: board_token "adobe.wd5/external_experienced?locationCountry=…" (facet dropped, same reason).
  { tenant: 'adobe', wd: 5, site: 'external_experienced' },
];

// The robots.txt GET headers as the worker sends them since 2026-11-21 (board-pages.ts gateRobots):
// master-robots' Accept, and the SAME full contact UA every page sends. Before that the scout sent
// the bare token "applyy-scout" here (the 2-UA finding); one honest identity for every request now.
const ROBOTS_HEADERS = { 'user-agent': 'applyy-scout/1.0 (+https://github.com/MallamTeja/applyyy)', accept: 'text/plain, */*;q=0.1' };

// The jobs POST headers, copied from worker/src/scout/board-pages.ts:26-30 + :204 (REQUEST_HEADERS
// plus the JSON content type the POST adds). Copied, not imported, so the runner needs no install.
const POST_HEADERS = {
  // What the scout asks the list endpoint for.
  Accept: 'application/json',
  // The scout's honest, contactable identity — never a browser UA (PROJECT_PLAN constraint #5).
  'User-Agent': 'applyy-scout/1.0 (+https://github.com/MallamTeja/applyyy)',
  // The body is JSON, as the scout declares it.
  'Content-Type': 'application/json',
};

// The smallest page the endpoint serves; key order matches the scout's own body (workday.ts:263-272).
const BODY = JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: '' });

// Gap between requests, per the plan: slow enough that our own burst cannot cause a 429.
const GAP_MS = 2000;

// Per-request cap, so one hung edge cannot stall the job; matches a scout-scale timeout.
const TIMEOUT_MS = 15000;

// Wait helper for the 2 s gap; stdlib promise timer, nothing to install.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One request, reduced to the fields the decision table needs. A network error becomes a
// row too (status "ERR"), so a dropped connection reads as its own outcome, never as a pass.
// `kind` is "robots" or "jobs": what a REAL answer looks like differs (text policy vs JSON list).
async function probe(label, kind, url, init) {
  // Wall time, to tell a slow challenge page from a fast refusal.
  const started = Date.now();
  // The request itself; any throw is captured below, not allowed to end the run.
  try {
    // The real fetch, with the per-request timeout.
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    // The whole body, kept for the robots Disallow check; only 120 characters are logged.
    const text = await res.text();
    // The first 120 characters, newlines flattened so one request stays on one log line.
    const body = text.slice(0, 120).replace(/\s+/g, ' ');
    // The four headers that say who answered and why: Cloudflare stamps server + cf-ray.
    // The declared type, part of the evidence for "real answer or soft-200 page".
    const contentType = res.headers.get('content-type');
    return {
      label,
      status: res.status,
      // What the answer IS, never the status alone (§6): the 07:48 UTC runner "200"s were S3 HTML pages.
      class: classify(kind, res.status, contentType, text),
      // Logged so the class can be argued with.
      contentType,
      // Workday's maintenance answer (live 2026-11-21 07:20 UTC: every tenant 503 ERR_TENANT_OUTAGE).
      // Flagged so an outage run reads as INCONCLUSIVE, never as "blocked".
      outage: text.includes('ERR_TENANT_OUTAGE'),
      // Not logged (see the strip in main); the robots check reads it.
      text,
      server: res.headers.get('server'),
      cfRay: res.headers.get('cf-ray'),
      retryAfter: res.headers.get('retry-after'),
      ms: Date.now() - started,
      body,
    };
  } catch (err) {
    // The failure's name and message only: a network error carries no secret.
    return { label, status: 'ERR', class: 'other', error: `${err.name}: ${err.message}`, ms: Date.now() - started };
  }
}

// One answer's class, from status + content-type + the body's actual shape. A 200 is never success
// by itself (CLAUDE.md §6): the 07:48 UTC runner run got 200s from `server: AmazonS3` with HTML bodies
// where the jobs API returns JSON. Classes:
//   json_ok   jobs: 200, JSON content-type, body parses to an object with a numeric `total` (Workday's list shape)
//   robots_ok robots: 200, text/plain, body is not HTML (a real policy file)
//   html_soft any 200 whose type or body is HTML: an edge/error/challenge page, NOT data
//   429       rate limited (Cloudflare or other)
//   outage    Workday's ERR_TENANT_OUTAGE (maintenance)
//   other     anything else (non-200, 200 with an unexpected shape, network error)
function classify(kind, status, contentType, text) {
  // Maintenance first: it arrives as 503 JSON and must not read as a block.
  if (text.includes('ERR_TENANT_OUTAGE')) return 'outage';
  // The rate limit, whatever the body.
  if (status === 429) return '429';
  // Only a 200 can be a real answer.
  if (status !== 200) return 'other';
  // The declared type, lowercased once (null when absent).
  const type = (contentType ?? '').toLowerCase();
  // HTML by header or by body (a page served as text/plain still starts with a tag).
  if (type.includes('text/html') || /^\s*</.test(text)) return 'html_soft';
  // robots.txt: a plain-text policy is the real answer.
  if (kind === 'robots') return type.includes('text/plain') ? 'robots_ok' : 'other';
  // jobs: JSON by header AND by parse AND by shape, or it is not the list.
  if (!type.includes('application/json')) return 'other';
  // The parse; a throw means the body is not JSON despite the header.
  try {
    // Workday's list answer is an object with a numeric total.
    const parsed = JSON.parse(text);
    // Shape check, not just "it parsed": `null` or `[]` parse too.
    return parsed !== null && typeof parsed === 'object' && typeof parsed.total === 'number' ? 'json_ok' : 'other';
  } catch {
    // Declared JSON, not JSON.
    return 'other';
  }
}

// Runs every tenant in order, robots first (as the scout does), 2 s between each request.
async function main() {
  // Where this run came from, so two pasted logs cannot be confused. GITHUB_ACTIONS is set on runners.
  console.log(`origin=${process.env.GITHUB_ACTIONS === 'true' ? 'github-runner' : 'local'} at=${new Date().toISOString()}`);
  // The collected rows, printed as JSON at the end for a machine-readable compare.
  const rows = [];
  // One tenant at a time, never in parallel: the probe must not look like a burst.
  for (const t of TENANTS) {
    // The tenant's own host, built from fixed constants only.
    const origin = `https://${t.tenant}.wd${t.wd}.myworkdayjobs.com`;
    // robots.txt, exactly as the scout's gate asks for it.
    const robots = await probe(`${t.tenant} robots`, 'robots', `${origin}/robots.txt`, { headers: ROBOTS_HEADERS });
    // Kept without the full text, so the log and summary stay small.
    rows.push(log(robots));
    // The gap before the next request to any host.
    await sleep(GAP_MS);
    // Honor robots (Teja, 2026-11-01): a readable robots.txt that disallows the jobs path ends this tenant.
    if (robots.status === 200 && disallowsJobs(robots.text)) {
      // Recorded as its own outcome; the brief says pick another tenant.
      rows.push(log({ label: `${t.tenant} jobs`, status: 'SKIPPED_ROBOTS_DISALLOW' }));
      // No POST for this tenant.
      continue;
    }
    // An outage answers nothing about IPs; skip the POST rather than add load to a down tenant.
    if (robots.outage) {
      // Recorded so the summary shows why there is no POST row.
      rows.push(log({ label: `${t.tenant} jobs`, status: 'SKIPPED_OUTAGE' }));
      // Next tenant.
      continue;
    }
    // The jobs list POST, exactly as the scout sends page one (limit 1 instead of 20).
    rows.push(log(await probe(`${t.tenant} jobs`, 'jobs', `${origin}/wday/cxs/${t.tenant}/${t.site}/jobs`, { method: 'POST', headers: POST_HEADERS, body: BODY })));
    // The gap again, including after the last tenant (harmless, keeps the loop uniform).
    await sleep(GAP_MS);
  }
  // One compact summary line per request, for pasting into the bridge's table.
  console.log('summary:', rows.map((r) => `${r.label}=${r.status}/${r.class ?? '-'}`).join(' '));
  // Any outage row makes the whole run unusable for the IP question: say so in one line.
  if (rows.some((r) => r.outage)) console.log('verdict: INCONCLUSIVE (Workday tenant outage; rerun both halves later)');
}

// Prints one row as a live log line (a killed job still shows what it reached) and returns it
// without the full body text, which only the robots check needs.
function log(row) {
  // Drop the full text; the 120-character `body` stays.
  const { text, ...shown } = row;
  // One JSON object per line, easy to diff between the runner and home logs.
  console.log(JSON.stringify(shown));
  // The trimmed row is what the summary reads.
  return shown;
}

// True when any Disallow rule is a prefix of the jobs path "/wday/cxs/". Group-agnostic on
// purpose (stricter than the scout's per-agent match): the probe fails closed and skips the POST.
function disallowsJobs(robotsText) {
  // Each rule line, comments removed, e.g. "Disallow: /wday/".
  return robotsText.split(/\r?\n/).some((line) => {
    // The rule's directive and value; anything after "#" is a comment.
    const m = /^\s*disallow\s*:\s*(\S*)/i.exec(line.replace(/#.*/, ''));
    // An empty Disallow value allows everything, so only a non-empty prefix counts.
    return m !== null && m[1] !== '' && '/wday/cxs/'.startsWith(m[1].replace(/\*.*$/, ''));
  });
}

// Exit 0 whatever the statuses: a 429 is a FINDING here, not a failure of the probe.
await main();
