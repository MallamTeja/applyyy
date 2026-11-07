/* WebScoutPanel: runs the `scout-web` Edge Function (LLM-proposed, server-verified job
 * links) and shows what came back, including what the LLM made up (the rejected list).
 * The client is injected so tests need no network and the page owns the supabase import. */

// Hooks only; no state library, because the panel has one request and one result.
import { useState } from 'react';
// The http(s)-only href gate: a scouted apply_url is LLM-proposed, so it is untrusted.
import { safeHref } from '../../app/safeHref.ts';
// Every browser edge call goes through it: a revoked session refreshes once, else signs out with a plain sentence.
import { invokeEdge, type EdgeClient } from '../../data/edgeCall.ts';
// Styles are co-located so the panel can be mounted or removed as one unit.
import './WebScoutPanel.css';

// The ATS providers the backend contract promises; anything else fails validation.
export type WebScoutProvider = 'greenhouse' | 'lever' | 'ashby';

// One verified job as the backend returns it.
export interface WebScoutJob {
  // The link text the user clicks, so it must be a real string.
  title: string;
  // Shown beside the title so two postings with the same title are distinguishable.
  company_name: string;
  // The only field that becomes an href, hence the http(s) check in parseWebScoutOk.
  apply_url: string;
  // Closed union so the meta line can never print a provider the backend does not support.
  ats_provider: WebScoutProvider;
  // Nullable because many postings list no location; null renders as a label rather than "undefined".
  location_raw: string | null;
}

// One URL the verifier refused, with the reason, so the user can see what was invented.
export interface WebScoutRejected {
  // Kept as text only: it was not verified, so it must never become a link.
  url: string;
  // Why the verifier refused it; this is the evidence of what the LLM invented.
  reason: string;
}

// A validated 200 body.
export interface WebScoutOk {
  // How many links the LLM suggested; the gap to `verified` shows how much it made up.
  proposed: number;
  // How many survived server-side verification.
  verified: number;
  // How many were new rows in Discovered; can be below `verified` when some already existed.
  inserted: number;
  // Verified jobs to list; separate from `rejected` so an invented URL is never mistaken for one.
  jobs: WebScoutJob[];
  // Refused URLs, kept so the user can audit the verifier rather than trust it blindly.
  rejected: WebScoutRejected[];
}

// Closed union: every render path is one of these, so "no jobs" can never mean "bad body".
export type WebScoutState =
  // Nothing requested yet, so the panel claims nothing.
  | { kind: 'idle' }
  // Its own state rather than a boolean beside the others: it disables the button and drives the live message.
  | { kind: 'running' }
  // Carries the validated result; only reachable through parseWebScoutOk.
  | { kind: 'ok'; result: WebScoutOk }
  // Kill switch is off: the backend's own message is shown verbatim, and it is not a failure.
  | { kind: 'disabled'; message: string }
  // Daily Gemini budget spent or every key cooling: neither an error nor "0 jobs", so it gets its own kind.
  | { kind: 'quota'; message: string }
  // Gemini itself is overloaded: self-healing and not our bug, so not an error and not quota.
  | { kind: 'upstream'; message: string }
  // Session expired: the remedy (sign in again) differs from a generic error, so it is separate.
  | { kind: 'unauthorized'; message: string }
  // Everything else that went wrong; the message says what, never a guessed cause.
  | { kind: 'error'; message: string };

// Minimal slice of SupabaseClient the panel needs; structural so a test fake fits. It is invokeEdge's
// client (functions plus auth) since 2026-11-07: a revoked session needs auth.refreshSession and a local
// sign-out, so the old functions-only slice could not survive one.
export type WebScoutClient = EdgeClient;

// Narrowing helper: a plain object, not null or an array, before any property is read.
// Exported (2026-10-31) for AddJobLinkPanel, which validates its function's body the same way.
export function isRecord(value: unknown): value is Record<string, unknown> {
  // typeof null is 'object', and arrays are objects, so both are excluded explicitly.
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A count must be a finite non-negative number; Number('') style coercion is not accepted.
function isCount(value: unknown): value is number {
  // typeof first so strings like "3" are refused rather than coerced.
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// Validates the 200 body's SHAPE. Returns null on anything unexpected so the caller
// reports an error instead of rendering a malformed body as "0 jobs found".
export function parseWebScoutOk(body: unknown): WebScoutOk | null {
  // Not an object at all (null, string, array): reject.
  if (!isRecord(body)) return null;
  // The envelope status must be exactly 'ok'; a missing status is not success.
  if (body.status !== 'ok') return null;
  // All three counters must be real numbers for the summary line to be honest.
  if (!isCount(body.proposed) || !isCount(body.verified) || !isCount(body.inserted)) return null;
  // jobs and rejected must be arrays; a missing `jobs` is an error, never an empty list.
  if (!Array.isArray(body.jobs) || !Array.isArray(body.rejected)) return null;
  // Accumulators filled only with rows that pass the per-row shape checks.
  // Typed arrays so a push of an unvalidated row fails to compile.
  const jobs: WebScoutJob[] = [];
  // Separate list because rejected rows have a different shape and are never linked.
  const rejected: WebScoutRejected[] = [];
  // Every job row is validated; one bad row invalidates the body rather than being dropped silently.
  for (const row of body.jobs) {
    // Row must be an object with the required strings.
    if (!isRecord(row)) return null;
    // Title, company and URL are what the user sees and clicks, so each must be a string.
    if (typeof row.title !== 'string' || typeof row.company_name !== 'string' || typeof row.apply_url !== 'string') return null;
    // Provider is a closed set; an unknown one means the contract drifted.
    if (row.ats_provider !== 'greenhouse' && row.ats_provider !== 'lever' && row.ats_provider !== 'ashby') return null;
    // Location is string-or-null by contract, not undefined or a number.
    if (row.location_raw !== null && typeof row.location_raw !== 'string') return null;
    // Only http(s) URLs may become links; refuses javascript: URLs from a compromised backend.
    // Case-insensitive because schemes are, and anchored so "xhttp://" cannot slip through.
    if (!/^https?:\/\//i.test(row.apply_url)) return null;
    // Copy field by field so extra unknown properties never reach the DOM.
    jobs.push({
      // Each field was narrowed by the checks above, so no cast is needed to satisfy the type.
      title: row.title,
      // Copied by name so an extra backend field can never reach the DOM.
      company_name: row.company_name,
      // Safe to link: the http(s) check above already passed for this row.
      apply_url: row.apply_url,
      // Already proven to be one of the three literals.
      ats_provider: row.ats_provider,
      // Null passes through untouched; the view decides the fallback label.
      location_raw: row.location_raw,
    });
  }
  // Rejected rows are validated the same way; they are displayed as text only.
  for (const row of body.rejected) {
    // Same object guard.
    if (!isRecord(row)) return null;
    // Both fields are rendered, so both must be strings.
    if (typeof row.url !== 'string' || typeof row.reason !== 'string') return null;
    // Copy only the two known fields.
    rejected.push({ url: row.url, reason: row.reason });
  }
  // Fully validated; safe to hand to the view.
  // Counters are re-read from body rather than recomputed, because they are the server's claim to display.
  return { proposed: body.proposed, verified: body.verified, inserted: body.inserted, jobs, rejected };
}

// What the quota state says. Fixed text rather than the server's message, because the remedy
// (wait, or raise the budget setting) is the user's to act on and should read the same every time.
export const QUOTA_MESSAGE = 'Daily Gemini budget used up — try again tomorrow or raise gemini_daily_call_budget.';

// What the upstream state says. Fixed text, like QUOTA_MESSAGE, so the remedy reads the same every time.
export const UPSTREAM_MESSAGE = 'Gemini is overloaded right now — try again in a few minutes.';

// supabase-js puts non-2xx bodies behind error.context (a fetch Response). Read it
// defensively: it may be absent, already consumed, or not JSON.
// Exported (2026-10-31) so AddJobLinkPanel reads its function's refusals the same way.
export async function readErrorBody(error: unknown): Promise<unknown> {
  // No object means no context to read.
  if (!isRecord(error)) return null;
  // The Response lives under `context` in FunctionsHttpError.
  const context = error.context;
  // Only something with a json() method can be read; anything else is skipped.
  // The typeof/null checks come first because a cast alone would throw on a primitive.
  if (typeof context === 'object' && context !== null && typeof (context as { json?: unknown }).json === 'function') {
    // A body that is not JSON must not throw out of the handler.
    try {
      // Call as a method so `this` stays bound to the Response.
      return await (context as { json(): Promise<unknown> }).json();
    } catch {
      // Unreadable body: fall through to the generic message.
      return null;
    }
  }
  // Nothing readable.
  // null (not throw) so the caller's generic-message branch handles it uniformly.
  return null;
}

// Runs one search and maps every outcome to a WebScoutState. Never throws.
export async function runWebScout(client: WebScoutClient, query: string): Promise<WebScoutState> {
  // Empty query is omitted so the backend applies the user's saved preferences.
  // Trimmed so stray spaces neither reach the LLM prompt nor turn a blank into a query.
  const trimmed = query.trim();
  // Body carries only what the contract names.
  const body: Record<string, unknown> = trimmed === '' ? {} : { query: trimmed };
  // The call itself can reject (network down); that must become an error state.
  try {
    // Contract: invoke('scout-web', { body }).
    const answer = await invokeEdge(client, 'scout-web', { body });
    // The session is gone and this browser is signed out: the existing sign-in-again state, with the plain sentence.
    if (answer.kind === 'signed_out') return { kind: 'unauthorized', message: answer.message };
    // The function answered: its own data and error.
    const { data, error } = answer;
    // Non-2xx path: classify by the body's status when it is readable.
    // Checked before `data` because supabase-js returns data null alongside an error.
    if (error) {
      // Prefer the body from error.context; fall back to data in case a client puts it there.
      const errBody = (await readErrorBody(error)) ?? data;
      // 429 {status:'quota'}: the server's skipped_quota run. Checked only here, on the non-2xx path;
      // parseWebScoutOk still refuses any 2xx body whose status is not 'ok', so a 200 can never claim it.
      if (isRecord(errBody) && errBody.status === 'quota') return { kind: 'quota', message: QUOTA_MESSAGE };
      // 503 {status:'upstream_unavailable'}: Gemini overloaded. Non-2xx path only, for the same reason as quota.
      if (isRecord(errBody) && errBody.status === 'upstream_unavailable') return { kind: 'upstream', message: UPSTREAM_MESSAGE };
      // Only a well-formed error envelope is trusted for status and message.
      if (isRecord(errBody) && typeof errBody.message === 'string') {
        // 'disabled' is the kill switch; the user needs to see its message verbatim.
        if (errBody.status === 'disabled') return { kind: 'disabled', message: errBody.message };
        // 'unauthorized' means sign in again, a different remedy from a generic error.
        if (errBody.status === 'unauthorized') return { kind: 'unauthorized', message: errBody.message };
        // Any other readable envelope is a plain error.
        return { kind: 'error', message: errBody.message };
      }
      // Unreadable error body: say so honestly rather than guessing a cause.
      return { kind: 'error', message: 'The web search failed and returned no readable message.' };
    }
    // 2xx path: the shape check decides between result and error.
    const parsed = parseWebScoutOk(data);
    // A malformed body is an error state, never "0 jobs found".
    if (parsed === null) return { kind: 'error', message: 'The web search returned an unexpected response shape.' };
    // Validated result.
    // Wrapped in a kind so the view cannot render a result without going through validation.
    return { kind: 'ok', result: parsed };
  } catch (thrown) {
    // Transport failure: surface the message if there is one.
    // The Error check matters because a promise can reject with a non-Error, which has no .message.
    return { kind: 'error', message: thrown instanceof Error ? thrown.message : 'The web search request failed.' };
  }
}

// Pure view of a state, split out so tests can render every state without a DOM or events.
export function WebScoutView(props: {
  state: WebScoutState;
  query: string;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
}) {
  // Destructured once so the JSX below stays readable.
  const { state, query, onQueryChange, onSearch } = props;
  // Running disables the button so a double click cannot start two paid LLM searches.
  const running = state.kind === 'running';
  // A single return so every state shares the same landmark, form and live region.
  return (
    // Section landmark labelled by its heading so screen readers can jump to it.
    <section className="web-scout" aria-labelledby="web-scout-heading">
      {/* Heading names the panel for the landmark above. */}
      <h2 id="web-scout-heading" className="web-scout__title">Search the web</h2>
      {/* A form so Enter submits; preventDefault stops a page reload. */}
      <form
        className="web-scout__form"
        // Handler on the form, not the button, so Enter in the input and a click take the same path.
        onSubmit={(event) => {
          // SPA: never navigate.
          event.preventDefault();
          // Guard here too, because Enter can submit while the button is disabled in some browsers.
          if (!running) onSearch();
        }}
      >
        {/* Visible label, associated by htmlFor, because a placeholder is not a label. */}
        <label className="web-scout__label" htmlFor="web-scout-query">Optional query</label>
        {/* Controlled input; empty means "use my saved preferences". */}
        <input
          // Matches the label's htmlFor above, which is what gives the input its accessible name.
          id="web-scout-query"
          // Shared input styling lives in the co-located stylesheet.
          className="web-scout__input"
          // Free text; the backend does the interpreting, so no stricter type is useful.
          type="text"
          // Controlled so the typed text survives a result re-render.
          value={query}
          // An example only: the label, not the placeholder, carries the meaning.
          placeholder="e.g. senior backend engineer, remote"
          // Lifts the raw string; trimming is deferred to runWebScout so the box shows what was typed.
          onChange={(event) => onQueryChange(event.target.value)}
        />
        {/* aria-busy tells assistive tech the control is working, not broken. */}
        <button className="button web-scout__button" type="submit" disabled={running} aria-busy={running}>
          {/* The label itself changes so the busy state is visible without relying on colour. */}
          {running ? 'Searching...' : 'Search the web'}
        </button>
      </form>
      {/* Polite live region, always mounted: regions injected together with their text are often not announced.
          A div, not a p, because the non-error notices below are paragraphs and a p cannot contain a p.
          The notices live INSIDE it so a screen-reader user hears why a search produced nothing. */}
      <div className="web-scout__status" role="status" aria-live="polite">
        {/* Plain text, so the running message is the region's own content and is announced on change. */}
        {running ? 'Searching the web and verifying links. This can take a minute.' : ''}
        {/* Disabled kill switch: informational, not an error. */}
        {state.kind === 'disabled' && <p className="web-scout__notice">{state.message}</p>}
        {/* Quota spent: same non-error notice styling, because nothing is broken and it heals tomorrow. */}
        {state.kind === 'quota' && <p className="web-scout__notice">{state.message}</p>}
        {/* Gemini overloaded: a polite notice, never role=alert, because it heals on its own. */}
        {state.kind === 'upstream' && <p className="web-scout__notice">{state.message}</p>}
      </div>
      {/* Unauthorized and error use role=alert so they interrupt. */}
      {/* Errors stay outside the polite region: role=alert is assertive and announces on its own. */}
      {state.kind === 'unauthorized' && <p className="web-scout__error" role="alert">{state.message}</p>}
      {/* Same alert treatment as above, for every other failure. */}
      {state.kind === 'error' && <p className="web-scout__error" role="alert">{state.message}</p>}
      {/* Result block exists only for a validated body, so "no jobs" can never mean "bad body". */}
      {state.kind === 'ok' && (
        <div className="web-scout__result">
          {/* Summary shows all three counts so the gap between proposed and verified is visible. */}
          <p className="web-scout__summary">
            Proposed {state.result.proposed} · verified {state.result.verified} · added {state.result.inserted} to Discovered
          </p>
          {/* Verified jobs; keyed by URL, which is unique per posting. */}
          {/* Semantic list so assistive tech announces "list, N items" for the results. */}
          <ul className="web-scout__jobs">
            {state.result.jobs.map((job) => (
              // One row per posting; the key comment above explains why the URL is the identity.
              <li key={job.apply_url} className="web-scout__job">
                {/* External link: noopener+noreferrer so the target cannot reach window.opener. */}
                {/* The title is the link text, so the accessible name is the job itself. */}
                <a className="web-scout__link" href={safeHref(job.apply_url)} target="_blank" rel="noopener noreferrer">{job.title}</a>
                {/* Company, location and provider on one wrapping meta line. */}
                <span className="web-scout__meta">
                  {job.company_name} · {job.location_raw ?? 'Location not listed'} · {job.ats_provider}
                </span>
              </li>
            ))}
          </ul>
          {/* Collapsed by default; rejected URLs are the evidence of what the LLM invented. */}
          {state.result.rejected.length > 0 && (
            // Native details/summary gives keyboard and screen-reader disclosure without any state of our own.
            <details className="web-scout__rejected">
              {/* The count in the label tells the user what is hidden before they open it. */}
              <summary>Rejected ({state.result.rejected.length})</summary>
              {/* Plain list: rejected rows are evidence to scan, not actions. */}
              <ul className="web-scout__rejected-list">
                {state.result.rejected.map((item) => (
                  // URL plus reason can repeat across rows, so the key adds the reason.
                  <li key={`${item.url}|${item.reason}`}>
                    {/* Plain text, not a link: these were not verified and must not be one click away. */}
                    {/* Distinct class so the URL can wrap or break without touching the reason text. */}
                    <span className="web-scout__rejected-url">{item.url}</span>
                    {/* Leading space keeps the reason apart from the URL when styles are off. */}
                    <span className="web-scout__meta"> {item.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

// Stateful wrapper the page mounts.
export function WebScoutPanel(props: { client: WebScoutClient; onInserted?: (count: number) => void }) {
  // Query text lives here so it survives result changes.
  const [query, setQuery] = useState<string>('');
  // Starts idle so nothing is claimed before the user acts.
  const [state, setState] = useState<WebScoutState>({ kind: 'idle' });
  return (
    <WebScoutView
      // Passed down rather than read inside the view, so tests can render any state directly.
      state={state}
      // Held here so typing does not reset when a result arrives.
      query={query}
      // The setter is stable, so no wrapper callback is needed.
      onQueryChange={setQuery}
      // Defined inline because it closes over the current query and client.
      onSearch={() => {
        // Flip to running synchronously so the button disables before the await.
        setState({ kind: 'running' });
        // Fire-and-forget is safe because runWebScout never throws.
        void runWebScout(props.client, query).then((next) => {
          // Commit the outcome.
          setState(next);
          // Tell the page to refresh only when rows were really added.
          if (next.kind === 'ok' && next.result.inserted > 0) props.onInserted?.(next.result.inserted);
        });
      }}
    />
  );
}
