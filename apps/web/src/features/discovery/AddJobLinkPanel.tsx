/* AddJobLinkPanel: paste ONE job link (a LinkedIn/X post, a careers page, an ATS posting) and the
 * job skips every filter, gets a tailored resume, and lands in the Approval queue.
 * The `job-link-intake` Edge Function adds the row at passed_filters AND runs matcher -> tailor ->
 * auditor on it server-side (Teja, 2026-11-01: "no need of me pressing that button"), so the run
 * survives a closed tab. This panel only watches the row's status; it offers the shared
 * SendThroughPipeline button only when the server run stalls or was never started.
 * Since 2026-11-01 it is ONE header button that opens a modal holding only the link box (Teja: "if i
 * press that button it will open and i will just paste the link there no jd will be pasted by me"),
 * so the optional job-text box is gone and the request carries the url alone.
 * The client and the pipeline deps are injected, so tests need no network. */

// One request, one result; the effect and refs drive the status watch and the dialog.
import { useEffect, useRef, useState } from 'react';
// Type only: the view takes the input's ref so the wrapper can focus it when the modal opens.
import type { RefObject } from 'react';
// The fallback button (shared with the drawer and the Discovered cards) and the queue-link sentence.
import { OutcomeNote, SendThroughPipeline } from '../pipeline/DrawerAppCard.tsx';
// The agents a passed_filters row needs, their input statuses, and the uuid shape check.
import { PASSED_FILTERS_STEPS, STEP_INPUT_STATUS, isApplicationId } from '../pipeline/rowPipeline.ts';
// Types only: the deps the watch reads with, and the outcome OutcomeNote draws.
import type { RowPipelineDeps, RowPipelineOutcome } from '../pipeline/rowPipeline.ts';
// http(s)-only href gate: the apply link came from a pasted page, so it is untrusted.
import { safeHref } from '../../app/safeHref.ts';
// The same defensive reader WebScoutPanel uses for a function's non-2xx body.
import { isRecord, readErrorBody, type WebScoutClient } from './WebScoutPanel.tsx';
// Shared look with the sibling panel.
import './WebScoutPanel.css';
// Only the modal's placement, scrim and header row; the card look stays WebScoutPanel.css's.
import './AddJobLinkPanel.css';
// The app's in-place confirm (no browser dialogs, CLAUDE.md §8), for "add a dropped job anyway?".
import { InlineConfirm, armConfirm } from '../../app/InlineConfirm.tsx';

// Where the job's fields came from, as the function reports it.
export type IntakeSource = 'ats_board' | 'page' | 'pasted_text';

// A validated 200 body.
export interface IntakeOk {
  // The row the agents run on.
  readonly applicationId: string;
  // True when the server started matcher -> tailor -> auditor; false sends the human to the button.
  readonly pipelineStarted: boolean;
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
  // Nothing broken (kill switch, quota, Gemini busy, closed posting, not a job, unreadable page): a polite notice.
  | { readonly kind: 'notice'; readonly message: string }
  // Something failed; the message says what.
  | { readonly kind: 'error'; readonly message: string }
  // The link points at a job the screener or matcher dropped (leak 2, 2026-11-05): the server's
  // reason, and the link to re-send with confirm_revive only if the human says "add anyway".
  | { readonly kind: 'confirm_revive'; readonly message: string; readonly url: string };

// The InlineConfirm instance id for the revive question; one dialog, so one fixed id.
const REVIVE_CONFIRM_ID = 'add-job-link-revive';

// Body statuses that are not failures, only "not now" or "not this link". needs_text (the page
// could not be read) is one since 2026-11-01: with no text box left there is no remedy to point at,
// so it shows the server's own message verbatim, like any other notice.
const NOTICE_STATUSES = new Set(['disabled', 'quota', 'upstream_unavailable', 'posting_closed', 'not_a_job', 'needs_text']);

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
  // Absent means a function from before the server run (deployed 2026-11-01): read as "not
  // started", which shows the manual button, the safe side. Present, it must be a boolean.
  if (body.pipeline_started !== undefined && typeof body.pipeline_started !== 'boolean') return null;
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
    // Only an explicit true counts as a started run.
    pipelineStarted: body.pipeline_started === true,
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

// Send one link and map every outcome to a state. Never throws.
// confirmRevive: true only after the human confirmed reviving a dropped job; false is the safe side.
export async function runJobLinkIntake(client: WebScoutClient, url: string, confirmRevive = false): Promise<IntakeState> {
  // Trimmed so stray spaces are not part of the link.
  const trimmedUrl = url.trim();
  // Refused here so an empty box costs no request.
  if (trimmedUrl === '') return { kind: 'error', message: 'Paste a job link first.' };
  // The url alone: the function always reads the page itself, so no job text is ever sent.
  // The flag is added only when confirmed, so an ordinary paste sends exactly { url } as before.
  const body: Record<string, unknown> = confirmRevive ? { url: trimmedUrl, confirm_revive: true } : { url: trimmedUrl };
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
        // A dropped job: ask before reviving it, with the server's own words (they name the reason).
        if (errBody.status === 'confirm_revive') return { kind: 'confirm_revive', message: errBody.message, url: trimmedUrl };
        // Not a failure, just not now / not this link (needs_text included).
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

// How often the panel re-reads the row while the server runs the agents.
export const RUN_POLL_MS = 4_000;
// The server run shares the intake request's 150 s wall clock (_shared/agent/deadline.ts), so a
// row still mid-chain 180 s after the response is no longer being moved by it.
export const RUN_STALL_MS = 180_000;

// What the watch shows. Closed, so every status lands in exactly one phase.
export type ServerRunView =
  // The server is still on it; the text names the agent at work.
  | { readonly phase: 'running'; readonly text: string }
  // The row reached the Approval queue.
  | { readonly phase: 'ready' }
  // The run ended somewhere other than the queue; nothing more will happen on its own.
  | { readonly phase: 'stopped'; readonly text: string }
  // The run should have finished by now and did not: the human gets the button.
  | { readonly phase: 'stalled'; readonly text: string };

// The agent each in-progress status is waiting on, in the words the panel shows.
const RUN_STEP_TEXT: Readonly<Record<string, string>> = {
  // The matcher's input.
  passed_filters: 'Scoring the fit (matcher)…',
  // The tailor's input.
  scored: 'Tailoring your resume (tailor)…',
  // The auditor's inputs.
  tailored: 'Checking the tailored resume (auditor)…',
  // Same agent, mid-way.
  audit_clean: 'Checking the tailored resume (auditor)…',
  // Same agent, mid-way.
  audit_flagged: 'Checking the tailored resume (auditor)…',
};

// One status read (null when unreadable) plus the time since the response, mapped to what to show.
export function describeServerRun(status: string | null, elapsedMs: number): ServerRunView {
  // The goal.
  if (status === 'awaiting_approval') return { phase: 'ready' };
  // Pasted rows skip the score floor, so a matcher drop means it could not score the job at all.
  if (status === 'dropped_filter') return { phase: 'stopped', text: 'The matcher could not score this job, so it was dropped. Paste the link again to retry.' };
  // The normalizer's verdict, if a scouted copy won the dedupe.
  if (status === 'dropped_duplicate') return { phase: 'stopped', text: 'Dropped: the same posting is already in the pipeline.' };
  // An agent gave up on the row.
  if (status === 'failed') return { phase: 'stopped', text: 'An agent failed on this job. See System health, failed rows.' };
  // Mid-chain (or unreadable, which may be a blip): still running until the server's clock is up.
  if (status === null || RUN_STEP_TEXT[status] !== undefined) {
    // Past the server's wall clock: nothing is moving it any more.
    if (elapsedMs >= RUN_STALL_MS) return { phase: 'stalled', text: status === null ? 'The job’s status could not be read. Send it through by hand:' : `The server run stopped at ${status}. Send it through by hand:` };
    // Still inside the window.
    return { phase: 'running', text: status === null ? 'Checking on the run…' : (RUN_STEP_TEXT[status] ?? 'Running…') };
  }
  // Anywhere else (a human moved it meanwhile): report it and stop watching.
  return { phase: 'stopped', text: `Now at ${status}.` };
}

// The ready outcome OutcomeNote already words and links (one sentence app-wide for "reached the queue").
const READY_OUTCOME: RowPipelineOutcome = { kind: 'ready_for_approval', finalStatus: 'awaiting_approval' };

// Watches a server run by re-reading the row's status; the button appears only on a stall.
export function ServerRunWatch(props: {
  // The row the server is running.
  applicationId: string;
  // The status the intake response reported, so the first frame needs no read.
  startStatus: string;
  // The status reader (and the fallback button's deps); null means nothing can be read here.
  deps: RowPipelineDeps | null;
  // "Company — Title", for the fallback button's accessible name.
  label: string;
  // Called once when the run settles, so the page reloads its lists.
  onSettled?: (() => void) | undefined;
}) {
  // Destructured once for readability.
  const { applicationId, startStatus, deps, label, onSettled } = props;
  // No reader means no way to follow the run: straight to the button, which explains itself.
  const [view, setView] = useState<ServerRunView>(() => describeServerRun(startStatus, deps === null ? RUN_STALL_MS : 0));
  // When this watch began; a ref so an effect re-run cannot reset the stall clock.
  const startedAt = useRef(Date.now());
  // True once a final phase is shown, so a re-run effect never polls again.
  const settled = useRef(view.phase !== 'running');
  // The latest callback, so a parent re-render (every keystroke) does not restart the poll.
  const onSettledRef = useRef(onSettled);
  // Kept current after every render.
  useEffect(() => {
    // Read at settle time, never captured stale.
    onSettledRef.current = onSettled;
  });
  // The poll: one read every RUN_POLL_MS until a final phase.
  useEffect(() => {
    // Nothing to read with, or already done.
    if (deps === null || settled.current) return;
    // False after unmount, so a late read never sets state.
    let live = true;
    // Interval, not a recursive timeout: a slow read cannot stretch the cadence.
    const timer = setInterval(() => {
      // readStatus never throws: an unreadable row is null.
      void deps.readStatus(applicationId).then((status) => {
        // Unmounted, or another tick already settled it.
        if (!live || settled.current) return;
        // Mapped by the tested pure function.
        const next = describeServerRun(status, Date.now() - startedAt.current);
        // Shown.
        setView(next);
        // Keep polling while the server is on it.
        if (next.phase === 'running') return;
        // Final: stop for good.
        settled.current = true;
        // No more reads.
        clearInterval(timer);
        // The row left the Ready lane (or stalled): the page reloads its lists.
        onSettledRef.current?.();
      });
    }, RUN_POLL_MS);
    // Unmount or a new row: stop this poll.
    return () => {
      // Late reads are ignored.
      live = false;
      // No more ticks.
      clearInterval(timer);
    };
  }, [applicationId, deps]);
  // The sentence in a live region, plus the button only when the human must act.
  return (
    <div>
      {/* Polite and always mounted, so each step change is announced. */}
      <div aria-live="polite">
        {/* The queue sentence and link are OutcomeNote's, shared with every Send button. */}
        {view.phase === 'ready' ? <OutcomeNote outcome={READY_OUTCOME} httpStatus={null} /> : <p className="web-scout__meta">{view.text}</p>}
      </div>
      {/* The hand-off: the engine skips the agents that already ran and resumes at the stalled one. */}
      {view.phase === 'stalled' && <SendThroughPipeline applicationId={applicationId} deps={deps} steps={PASSED_FILTERS_STEPS} label={label} />}
    </div>
  );
}

// Pure view, so tests render every state without a DOM.
export function AddJobLinkView(props: {
  // Which of the closed states to draw.
  state: IntakeState;
  // The link box, controlled by the wrapper.
  url: string;
  // Lifts link edits to the wrapper.
  onUrlChange: (value: string) => void;
  // Starts one intake; the view never calls the network itself.
  onSubmit: () => void;
  // The visible Close button's action; the wrapper closes the dialog (Esc closes it natively).
  onClose: () => void;
  // The link box's ref, so the wrapper can move focus into it on open; optional for tests.
  inputRef?: RefObject<HTMLInputElement> | undefined;
  // The status reader for the watch, and the fallback button's deps; null renders the button disabled with a reason.
  pipelineDeps: RowPipelineDeps | null;
  // Called when the server run settles, so the page can reload its lists; optional for tests.
  onRunSettled?: (() => void) | undefined;
}) {
  // Destructured once for readability.
  const { state, url, onUrlChange, onSubmit, onClose, inputRef, pipelineDeps, onRunSettled } = props;
  // Disables the button so a double click cannot add twice.
  const running = state.kind === 'running';
  // A fragment: the wrapper's <dialog> is the container and is labelled by the heading below.
  return (
    <>
      {/* Heading and Close on one row, so the way out is visible next to the title. */}
      <div className="add-job-link__header">
        {/* Names the dialog through its aria-labelledby. */}
        <h2 id="add-job-link-heading" className="web-scout__title">Add a job by link</h2>
        {/* type=button: inside no form, but stated so it can never submit one. Never disabled: closing mid-request is safe, the wrapper keeps the run. */}
        <button type="button" className="button button--ghost" onClick={onClose}>Close</button>
      </div>
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
          // The wrapper focuses it on open; React's autoFocus fires only at mount, while the dialog is closed.
          ref={inputRef}
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
      </form>
      {/* Polite live region, always mounted so changes are announced. */}
      <div className="web-scout__status" role="status" aria-live="polite">
        {/* Its own text, announced while waiting. */}
        {running ? 'Reading the job. This can take up to a minute.' : ''}
        {/* Not-now notices (an unreadable page too), the server's words verbatim: polite, never alerts. */}
        {state.kind === 'notice' && <p className="web-scout__notice">{state.message}</p>}
      </div>
      {/* A dropped job: the reason sits in the confirm slot; the wrapper arms Confirm/Cancel over it. */}
      {state.kind === 'confirm_revive' && (
        <InlineConfirm id={REVIVE_CONFIRM_ID}>
          {/* Shown when the question is not armed (after Cancel), so the reason stays readable. */}
          <p className="web-scout__notice">{state.message}</p>
        </InlineConfirm>
      )}
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
          {/* The server is running the agents: follow it. Keyed by id, so a second paste starts a fresh watch. */}
          {state.result.pipelineStarted && (
            <ServerRunWatch
              /* A new row means a new watch with its own stall clock. */
              key={state.result.applicationId}
              /* The row the server is running. */
              applicationId={state.result.applicationId}
              /* The first frame, from the response itself. */
              startStatus={state.result.applicationStatus}
              /* The status reader, and the fallback button's deps. */
              deps={pipelineDeps}
              /* Names the job in the fallback button's accessible name. */
              label={`${state.result.companyName} — ${state.result.title}`}
              /* The page reloads once the row leaves the Ready lane. */
              onSettled={onRunSettled}
            />
          )}
          {/* No server run (a function from before 2026-11-01) but agents still owe work: the button, by hand. */}
          {!state.result.pipelineStarted && needsAgents(state.result.applicationStatus) && (
            <SendThroughPipeline
              /* A second paste mounts a fresh card. */
              key={state.result.applicationId}
              /* The row the function just added or revived. */
              applicationId={state.result.applicationId}
              /* Null on an unconfigured machine; the card then explains why it cannot run. */
              deps={pipelineDeps}
              /* matcher -> tailor -> auditor: the row already sits past every filter. */
              steps={PASSED_FILTERS_STEPS}
              /* Names the job in the button's accessible name. */
              label={`${state.result.companyName} — ${state.result.title}`}
            />
          )}
        </div>
      )}
    </>
  );
}

// Stateful wrapper the Discovered page mounts in its header row: the trigger button plus the modal.
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
  // Idle until the human acts.
  const [state, setState] = useState<IntakeState>({ kind: 'idle' });
  // The trigger, so focus can return to it when the modal closes (Safari never focuses a clicked button).
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The native dialog: showModal() brings the focus trap, Esc-to-close and the inert page for free.
  const dialogRef = useRef<HTMLDialogElement>(null);
  // The link box, focused on open so the human can paste at once.
  const inputRef = useRef<HTMLInputElement>(null);
  // The dialog stays mounted while closed, so a request (and its run watch) outlives a close.
  return (
    <>
      {/* chip-btn, like the scout and run buttons beside it in the header row. */}
      <button
        // Not a submit: the page has no form.
        type="button"
        // The header row's small-button look.
        className="chip-btn"
        // Read by the dialog's close handler.
        ref={triggerRef}
        // Tells assistive tech the button opens a dialog.
        aria-haspopup="dialog"
        // Open as a modal, then move focus into the link box rather than wherever the browser picks.
        onClick={() => {
          // Modal, not show(): only the modal form makes the rest of the page inert.
          dialogRef.current?.showModal();
          // Explicit: the browser's own initial-focus choice varies, and the Close button comes first.
          inputRef.current?.focus();
        }}
      >
        {/* The words humanLanes.ts sends people to ("Discovery, Add a job by link"); keep them in step. */}
        Add a job by link
      </button>
      {/* .web-scout makes the dialog itself the card; AddJobLinkPanel.css only centres it and dims the page. */}
      <dialog
        // Read by the open and close handlers.
        ref={dialogRef}
        // Card look plus this panel's placement rules.
        className="web-scout add-job-link"
        // Named by the view's heading.
        aria-labelledby="add-job-link-heading"
        // Fires on Esc and on the Close button alike, so both paths hand focus back to the trigger.
        onClose={() => triggerRef.current?.focus()}
      >
        {/* Everything inside is the pure view, so tests render each state without a DOM or a click. */}
        <AddJobLinkView
          // Passed down so tests can render any state.
          state={state}
          // Controlled value.
          url={url}
          // Stable setter.
          onUrlChange={setUrl}
          // close() fires the dialog's close event, which restores focus above.
          onClose={() => dialogRef.current?.close()}
          // Focused by the trigger's click handler.
          inputRef={inputRef}
          // Injected so the view never imports a client.
          pipelineDeps={props.pipelineDeps}
          // The row has moved on: the page reloads, so it leaves the Ready to tailor list.
          onRunSettled={props.onAdded}
          // Closes over the current input.
          onSubmit={() => {
            // Synchronous flip so the button disables before the await.
            setState({ kind: 'running' });
            // runJobLinkIntake never throws.
            void runJobLinkIntake(props.client, url).then((next) => {
              // Commit the outcome (an ok mounts the watch on the server's run).
              setState(next);
              // A dropped job: ask in place. Confirm re-sends the same link with the flag.
              if (next.kind === 'confirm_revive') {
                // One question at a time, app-wide; Cancel writes nothing and refocuses the link box.
                armConfirm(REVIVE_CONFIRM_ID, {
                  // The server's sentence: the stored reason and, when known, the location.
                  message: next.message,
                  // Names the buttons ("Confirm: add the dropped job ...").
                  action: `add the dropped job ${next.url}`,
                  // The guarded write: the confirmed paste.
                  onConfirm: () => {
                    // Busy again while the confirmed paste runs.
                    setState({ kind: 'running' });
                    // Same never-throwing call, now with the human's confirm.
                    void runJobLinkIntake(props.client, next.url, true).then((confirmed) => {
                      // Its outcome, exactly like a first paste's.
                      setState(confirmed);
                      // A revived row: the page reloads its lists.
                      if (confirmed.kind === 'ok') props.onAdded?.();
                    });
                  },
                  // Focus returns to the link box on Cancel.
                  trigger: inputRef.current,
                });
              }
              // A new or revived row: the page reloads its lists.
              if (next.kind === 'ok') props.onAdded?.();
            });
          }}
        />
      </dialog>
    </>
  );
}
