// Turning robots.txt text into groups.
//
// PRECONDITION, AND IT IS THE WHOLE SAFETY ARGUMENT: callers must have run
// classifyRobotsBody() first. This parser is lenient by construction — it skips what
// it does not recognise — so asking it whether the input was valid is meaningless.
// It will parse an HTML page into zero groups without complaint. The shape check is
// what makes "zero groups" trustworthy here; this module does not re-litigate it.
import type { Rule, RobotsGroup, Ruleset } from './types.ts';

// A group under construction. The public RobotsGroup is readonly, so accumulation
// happens in a private mutable shape and is frozen on the way out.
interface PendingGroup {
  rules: Rule[];
  crawlDelayMs: number | null;
}

// Fetch or create the accumulator for one agent token. Groups merge rather than
// replace: a site may address the same token twice, and dropping the earlier block
// would silently discard rules it wrote.
function groupFor(groups: Map<string, PendingGroup>, token: string): PendingGroup {
  // The existing accumulator, when this token has been seen before.
  const existing = groups.get(token);
  // Reusing it is what makes the merge happen.
  if (existing !== undefined) return existing;
  // A fresh group starts with no rules and no published delay.
  const created: PendingGroup = { rules: [], crawlDelayMs: null };
  groups.set(token, created);
  return created;
}

// Convert a Crawl-delay value to milliseconds, or null when we cannot read it.
//
// NULL, NEVER ZERO. Zero would mean "no delay required", so a malformed header would
// become permission to fetch as fast as we like — the same disease as a garbage
// Retry-After reading as "retry immediately". Unknown must stay unknown.
function parseCrawlDelayMs(value: string): number | null {
  // Digits with an optional decimal part. Anchored, so `5s`, `-5` and `soon` all
  // fail here rather than being coerced by Number() into something plausible.
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  // The published figure is in seconds; this package works in milliseconds.
  const seconds = Number(value);
  // Guards the pathological input that satisfies the regex but is not usable.
  if (!Number.isFinite(seconds)) return null;
  return Math.round(seconds * 1000);
}

/**
 * Parse robots.txt text into a Ruleset.
 *
 * Only call this on a body classifyRobotsBody() has accepted.
 */
export function parseRobotsTxt(body: string): Ruleset {
  // Accumulators keyed by lowercased token; '*' is just another key.
  const groups = new Map<string, PendingGroup>();
  // The tokens the rules we are currently reading belong to. Several User-agent
  // lines in a row all address the same following ruleset.
  let currentTokens: string[] = [];
  // Whether the next User-agent line extends the current run or starts a new group.
  // Flips false on the first rule, which is what separates two adjacent groups.
  let acceptingAgents = true;

  for (const rawLine of body.split(/\r?\n/)) {
    // Comments are stripped before parsing so a trailing `# nope` cannot end up
    // inside a pattern and stop the rule matching anything.
    const line = rawLine.split('#', 1)[0]?.trim() ?? '';
    // A blank line is skipped rather than treated as a record separator. THIS IS
    // DELIBERATE AND IS A PORTED BUG FIX: Python's robotparser ends a record on a
    // blank line, drops the rules that follow, and therefore fails open on any site
    // that spaces out its own file. Blank lines inside a record are common.
    if (line === '') continue;
    // Everything robots.txt says is `field: value`; a line without a colon is noise.
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    // Field names are case-insensitive per RFC 9309.
    const field = line.slice(0, colon).trim().toLowerCase();
    // The value keeps its original case: paths are case-sensitive on most servers.
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      // A User-agent line after a rule means the previous group has ended, so the
      // run of tokens restarts rather than accumulating across the boundary.
      if (!acceptingAgents) {
        currentTokens = [];
        acceptingAgents = true;
      }
      // Tokens are compared lowercased, so they are stored lowercased once here
      // rather than being folded at every comparison site.
      const token = value.toLowerCase();
      // An empty `User-agent:` addresses nobody and would otherwise create a group
      // keyed by the empty string that no token could ever select.
      if (token === '') continue;
      currentTokens.push(token);
      // Registering the group now means a group with no rules still exists, which is
      // how "this site addressed us and restricted nothing" stays distinguishable
      // from "this site never addressed us".
      groupFor(groups, token);
      continue;
    }

    // Every remaining field belongs to the group(s) currently open. A rule before
    // any User-agent line addresses nobody and is dropped.
    if (currentTokens.length === 0) continue;

    if (field === 'allow' || field === 'disallow') {
      // The first rule closes the run of agent lines above it.
      acceptingAgents = false;
      // `Disallow:` with an empty value is RFC 9309's explicit "allow everything".
      // It is the ABSENCE of a rule, not a rule matching the empty prefix — which
      // would block the whole site and is the opposite of what the site asked for.
      if (value === '') continue;
      // One rule object shared across the tokens in this run; it is immutable.
      const rule: Rule = { allow: field === 'allow', pattern: value };
      // Each addressed token gets the rule, which is what makes several User-agent
      // lines genuinely share one ruleset.
      for (const token of currentTokens) groupFor(groups, token).rules.push(rule);
      continue;
    }

    if (field === 'crawl-delay') {
      // Crawl-delay sits inside a group and applies to every token addressing it.
      acceptingAgents = false;
      const delay = parseCrawlDelayMs(value);
      // An unreadable value leaves the group's delay untouched at null rather than
      // overwriting a good earlier value with a bad later one.
      if (delay === null) continue;
      for (const token of currentTokens) groupFor(groups, token).crawlDelayMs = delay;
      continue;
    }

    // Sitemap, Host and any future field are ignored by design: RFC 9309 says to
    // skip unrecognised fields, and shape.ts has already confirmed this really is a
    // robots.txt, so an unknown field here is a new directive rather than garbage.
  }

  // Freeze the accumulators into the readonly public shape.
  const frozen = new Map<string, RobotsGroup>();
  for (const [token, pending] of groups) {
    frozen.set(token, { rules: pending.rules, crawlDelayMs: pending.crawlDelayMs });
  }
  return { groups: frozen };
}
