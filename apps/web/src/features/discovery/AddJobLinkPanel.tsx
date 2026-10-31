/* AddJobLinkPanel: paste ONE job link (a LinkedIn/X post, a careers page, an ATS posting) and the
 * job skips every filter, gets a tailored resume, and lands in the Approval queue.
 * The `job-link-intake` Edge Function adds the row at passed_filters; this panel then runs
 * matcher -> tailor -> auditor on it through the same SendThroughPipeline the Discovered cards use.
 * The client and the pipeline deps are injected, so tests need no network. */

// Hooks only: one request, one result.
import { useState } from 'react';
// The run-the-agents card, shared with the drawer and the Discovered page (one lock, one progress list).
import { SendThroughPipeline } from '../pipeline/DrawerAppCard.tsx';
// The agents a passed_filters row needs, their input statuses, and the uuid shape check.
import { PASSED_FILTERS_STEPS, STEP_INPUT_STATUS, isApplicationId } from '../pipeline/rowPipeline.ts';
// Type only: the deps SendThroughPipeline takes.
import type { RowPipelineDeps } from '../pipeline/rowPipeline.ts';
// http(s)-only href gate: the apply link came from a pasted page, so it is untrusted.
import { safeHref } from '../../app/safeHref.ts';
// The same defensive reader WebScoutPanel uses for a function's non-2xx body.
import { isRecord, readErrorBody, type WebScoutClient } from './WebScoutPanel.tsx';
// Shared look with the sibling panel.
import './WebScoutPanel.css';

// Where the job's fields came from, as the function reports it.
export type IntakeSource = 'ats_board' | 'page' | 'pasted_text';

// A validated 200 body.
export interface IntakeOk {
  // The row to run the agents on.
  readonly applicationId: string;
  // Where the row stands right after intake.
  readonly applicationStatus: string;
  // True only when this paste created the application.
  readonly created: boolean;
  // The status a pre-existing row was pulled back from (e.g. dropped_filter), or null.
  readonly revivedFrom: string | null;
  // Where the fields came from.
  readonly source: IntakeSource;
  // The job title, shown in the confirmation.
  readonly title: string;
  // The employer, shown in the confirmation.
  readonly companyName: string;
  // Location text or null.
  readonly locationRaw: string | null;
  // The place to apply; becomes a link only through safeHref.
  readonly applyUrl: string;
}

// Closed union: every render path is one of these.
export type IntakeState =
  // Nothing sent yet.
  | { readonly kind: 'idle' }
  // Waiting on the function; disables the button.
  | { readonly kind: 'running' }
  // Added: the agents start next.
  | { readonly kind: 'ok'; readonly result: IntakeOk }
  // The page could not be read: the remedy is pasting the job text, so the text box is called out.
  | { readonly kind: 'needs_text'; readonly message: string }
  // Nothing broken (kill switch, quota, Gemini busy, closed posting, not a job): a polite notice.
  | { readonly kind: 'notice'; readonly message: string }
  // Something failed; the message says what.
  | { readonly kind: 'error'; readonly message: string };

// Body statuses that are not failures, only "not now" or "not this link".
const NOTICE_STATUSES = new Set(['disabled', 'quota', 'upstream_unavailable', 'posting_closed', 'not_a_job']);

// Validate the 200 body's SHAPE; null on anything unexpected, so a bad body is an error, never "added".
export function parseIntakeOk(body: unknown): IntakeOk | null {
  // Envelope must be an object saying exactly 'ok'.
  if (!isRecord(body) || body.status !== 'ok') return null;
  // The id is run through the agents, so it must be a real uuid.
  if (!isApplicationId(body.application_id)) return null;
  // Status and the created flag, by type.
  if (typeof body.application_status !== 'string' || typeof body.created !== 'boolean') return null;
  // revived_from is a status or null, never undefined.
  if (body.revived_from !== null && typeof body.revived_from !== 'string') return null;
  // Closed set.
  if (body.source !== 'ats_board' && body.source !== 'page' && body.source !== 'pasted_text') return null;
  // The job summary.
  const job = body.job;
  // Must be an object with the strings the confirmation shows.
  if (!isRecord(job) || typeof job.title !== 'string' || typeof job.company_name !== 'string' || typeof job.apply_url !== 'string') return null;
  // Location is string-or-null by contract.
  if (job.location_raw !== null && typeof job.location_raw !== 'string') return null;
  // Copied field by field so nothing unvalidated reaches the DOM.
  return {
    // Proven a uuid above.
    applicationId: body.application_id,
    // Proven a string.
    applicationStatus: body.application_status,
    // Proven a boolean.
    created: body.created,
    // Proven string-or-null.
    revivedFrom: body.revived_from,
    // Proven one of three.
    source: body.source,
    // Proven strings.
    title: job.title,
    // Same.
    companyName: job.company_name,
    // Proven string-or-null.
    locationRaw: job.location_raw,
    // Rendered only through safeHref.
    applyUrl: job.apply_url,
  };
}

// Send one link (and optional text) and map every outcome to a state. Never throws.
export async function runJobLinkIntake(client: WebScoutClient, url: string, text: string): Promise<IntakeState> {
  // Trimmed so stray spaces are not part of the link.
  const trimmedUrl = url.trim();
  // Blank text is omitted, so the function fetches the page instead.
  const trimmedText = text.trim();
  // Refused here so an empty box costs no request.
  if (trimmedUrl === '') return { kind: 'error', message: 'Paste a job link first.' };
  // Body carries only what the contract names.
  const body: Record<string, unknown> = trimmedText === '' ? { url: trimmedUrl } : { url: trimmedUrl, text: trimmedText };
  // A rejected promise (network down) becomes an error state.
  try {
    // Contract: invoke('job-link-intake', { body }).
    const { data, error } = await client.functions.invoke('job-link-intake', { body });
    // Non-2xx: classify by the function's own status field.
    if (error) {
      // The body lives behind error.context in supabase-js.
      const errBody = (await readErrorBody(error)) ?? data;
      // Only a well-formed envelope is trusted.
      if (isRecord(errBody) && typeof errBody.message === 'string') {
        // The page needs a login or JS: ask for the text.
        if (errBody.status === 'needs_text') return { kind: 'needs_text', message: errBody.message };
        // Not a failure, just not now / not this link.
        if (typeof errBody.status === 'string' && NOTICE_STATUSES.has(errBody.status)) return { kind: 'notice', message: errBody.message };
        // Everything else, verbatim.
        return { kind: 'error', message: errBody.message };
      }
      // Unreadable: say so rather than guess.
      return { kind: 'error', message: 'Adding the job failed and returned no readable message.' };
    }
    // 2xx: the shape check decides.
    const parsed = parseIntakeOk(data);
    // A malformed body is an error, never "added".
    if (parsed === null) return { kind: 'error', message: 'Adding the job returned an unexpected response shape.' };
    // Validated.
    return { kind: 'ok', result: parsed };
  // A rejection never escapes: the wrapper relies on this function never throwing.
  } catch (thrown) {
    // Transport failure.
    return { kind: 'error', message: thrown instanceof Error ? thrown.message : 'The request to add the job failed.' };
  }
}

// True when the matcher/tailor/auditor chain still has work for a row at this status.
export function needsAgents(status: string): boolean {
  // Any step whose input status this is; awaiting_approval and later match none.
  return PASSED_FILTERS_STEPS.some((step) => STEP_INPUT_STATUS[step].includes(status));
}

// The one-line confirmation under "Added".
export function describeAdded(result: IntakeOk): string {
  // A brand-new row.
  if (result.created) return 'New job: skipping every filter, now tailoring your resume.';
  // A row the filters had dropped, or one stuck before them.
  if (result.revivedFrom !== null) return `Already found earlier (${result.revivedFrom}): brought back past every filter, now tailoring your resume.`;
  // Mid-pipeline: the run below resumes it.
  if (needsAgents(result.applicationStatus)) return `Already in the pipeline at ${result.applicationStatus}: resuming it.`;
  // At the queue or later: nothing to run.
  return `Already in the pipeline at ${result.applicationStatus}: nothing to redo.`;
}

// Pure view, so tests render every state without a DOM.
export function AddJobLinkView(props: {
  // Which of the closed states to draw.
  state: IntakeState;
  // The link box, controlled by the wrapper.
  url: string;
  // The optional text box, controlled by the wrapper.
  text: string;
  // Lifts link edits to the wrapper.
  onUrlChange: (value: string) => void;
  // Lifts text edits to the wrapper.
  onTextChange: (value: string) => void;
  // Starts one intake; the view never calls the network itself.
  onSubmit: () => void;
  // Handed to the agent-run card; null renders it disabled with a reason.
  pipelineDeps: RowPipelineDeps | null;
}) {
  // Destructured once for readability.
  const { state, url, text, onUrlChange, onTextChange, onSubmit, pipelineDeps } = props;
  // Disables the button so a double click cannot add twice.
  const running = state.kind === 'running';
  // One landmark, labelled by its heading.
  return (
    <section className="web-scout" aria-labelledby="add-job-link-heading">
      {/* Names the panel for the landmark above. */}
      <h2 id="add-job-link-heading" className="web-scout__title">Add a job by link</h2>
      {/* A form so Enter submits; preventDefault stops a reload. */}
      <form
        // Same wrapping row layout as the web-search form beside it.
        className="web-scout__form"
        // Handler on the form so Enter and click share one path.
        onSubmit={(event) => {
          // SPA: never navigate.
          event.preventDefault();
          // Guarded here too: Enter can submit while the button is disabled in some browsers.
          if (!running) onSubmit();
        }}
      >
        {/* Visible label tied to the input. */}
        <label className="web-scout__label" htmlFor="add-job-link-url">Job link (careers page, ATS posting, LinkedIn or X post)</label>
        {/* type=url gives a URL keyboard on mobile; the function does the real check. */}
        <input
          // Matches the label's htmlFor.
          id="add-job-link-url"
          // Shared input styling.
          className="web-scout__input"
          // URL keyboard and basic browser validation.
          type="url"
          // Controlled so it survives a result re-render.
          value={url}
          // An example only; the label carries the meaning.
          placeholder="https://..."
          // Lifts the raw string; trimming happens in runJobLinkIntake.
          onChange={(event) => onUrlChange(event.target.value)}
        />
        {/* aria-busy says "working", not "broken". */}
        <button className="button web-scout__button" type="submit" disabled={running} aria-busy={running}>
          {/* Text changes so the busy state does not rely on colour. */}
          {running ? 'Adding…' : 'Add job'}
        </button>
        {/* Its own label: the text box is optional and says when it is needed. */}
        <label className="web-scout__label" htmlFor="add-job-link-text">Job text (optional; paste the post or description when the link needs a login)</label>
        {/* Full-row box for a pasted post. */}
        <textarea
          // Matches the label's htmlFor.
          id="add-job-link-text"
          // Input look, full row.
          className="web-scout__input web-scout__input--block"
          // Controlled.
          value={text}
          // Points at the needs_text notice when the page could not be read.
          aria-describedby={state.kind === 'needs_text' ? 'add-job-link-needs-text' : undefined}
          // Lifts the raw string.
          onChange={(event) => onTextChange(event.target.value)}
        />
      </form>
      {/* Polite live region, always mounted so changes are announced. */}
      <div className="web-scout__status" role="status" aria-live="polite">
        {/* Its own text, announced while waiting. */}
        {running ? 'Reading the job. This can take up to a minute.' : ''}
        {/* "Paste the text" request, tied to the text box above. */}
        {state.kind === 'needs_text' && <p id="add-job-link-needs-text" className="web-scout__notice">{state.message}</p>}
        {/* Not-now notices: polite, never alerts. */}
        {state.kind === 'notice' && <p className="web-scout__notice">{state.message}</p>}
      </div>
      {/* Failures interrupt. */}
      {state.kind === 'error' && <p className="web-scout__error" role="alert">{state.message}</p>}
      {/* The added job, then the agent run. */}
      {state.kind === 'ok' && (
        // Same result block styling as the sibling panel.
        <div className="web-scout__result">
          {/* What was added, as a link to where you would apply. */}
          <p className="web-scout__summary">
            {/* The verb first, so a screen reader hears the outcome before the job name. */}
            Added{' '}
            {/* External: noopener+noreferrer so the page cannot reach window.opener. */}
            <a className="web-scout__link" href={safeHref(state.result.applyUrl)} target="_blank" rel="noopener noreferrer">{state.result.title}</a>
            {/* Employer and place on the same line; a null location gets words, never "null". */}
            {' '}· {state.result.companyName} · {state.result.locationRaw ?? 'Location not listed'}
          </p>
          {/* Why the next step is (or is not) running. */}
          <p className="web-scout__meta">{describeAdded(state.result)}</p>
          {/* Keyed by id so a second paste mounts a fresh card, which auto-starts once for that row. */}
          {needsAgents(state.result.applicationStatus) && (
            <SendThroughPipeline
              /* A new row means a new card, so autoStart fires once per pasted job. */
              key={state.result.applicationId}
              /* The row the function just added or revived. */
              applicationId={state.result.applicationId}
              /* Null on an unconfigured machine; the card then explains why it cannot run. */
              deps={pipelineDeps}
              /* matcher -> tailor -> auditor: the row already sits past every filter. */
              steps={PASSED_FILTERS_STEPS}
              /* Teja asked for no extra click: pasting the link is the instruction to tailor. */
              autoStart
              /* Names the job in the button's accessible name. */
              label={`${state.result.companyName} — ${state.result.title}`}
            />
          )}
        </div>
      )}
    </section>
  );
}

// Stateful wrapper the Discovered page mounts.
export function AddJobLinkPanel(props: {
  // The functions client; the page passes the real one, tests a fake.
  client: WebScoutClient;
  // Deps for the agent run that follows a successful add.
  pipelineDeps: RowPipelineDeps | null;
  // Called after an add, so the page reloads its lists.
  onAdded?: () => void;
}) {
  // The pasted link.
  const [url, setUrl] = useState<string>('');
  // The optional pasted text.
  const [text, setText] = useState<string>('');
  // Idle until the human acts.
  const [state, setState] = useState<IntakeState>({ kind: 'idle' });
  // The view does all drawing; this wrapper only owns state.
  return (
    <AddJobLinkView
      // Passed down so tests can render any state.
      state={state}
      // Controlled values.
      url={url}
      // Same.
      text={text}
      // Stable setters.
      onUrlChange={setUrl}
      // Same.
      onTextChange={setText}
      // Injected so the view never imports a client.
      pipelineDeps={props.pipelineDeps}
      // Closes over the current inputs.
      onSubmit={() => {
        // Synchronous flip so the button disables before the await.
        setState({ kind: 'running' });
        // runJobLinkIntake never throws.
        void runJobLinkIntake(props.client, url, text).then((next) => {
          // Commit the outcome (an ok mounts the auto-starting agent run).
          setState(next);
          // A new or revived row: the page reloads its lists.
          if (next.kind === 'ok') props.onAdded?.();
        });
      }}
    />
  );
}
