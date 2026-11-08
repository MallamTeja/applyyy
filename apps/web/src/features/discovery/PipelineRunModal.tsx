/* The bulk "Run pipeline (all eligible rows)" dialog. Since 2026-10-09 (Teja's ruling) the run fires
 * only after the operator types CONFIRM_PHRASE: the dialog first states how many rows each agent can
 * take and that the Matcher and Tailor spend Gemini calls. Every start goes through
 * startIfConfirmed (pipelineRunConfirm.ts), which test/pipelineRunConfirm.test.ts proves invokes
 * nothing on empty or mismatched text. */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { runFullPipeline } from '../../data/pipelineRunner';
// The whole result, not just the steps: `ok` is what decides success vs failure framing.
import type { PipelineRunResult } from '../../data/pipelineRunner';
/* Every status's count in ONE RPC (application_status_counts), replacing five exact HEAD counts, one
   Sydney round trip each (2026-11-08). Same numbers: the RPC is count(*) per status for user_id =
   auth.uid(), and RLS "own applications" scoped the HEAD counts to that same user. */
import { useApplicationCounts } from '../../data/useApplicationCounts.ts';
// Which statuses each agent's queue selects: the same table pipelineRunConfirm.ts and the runner use.
import { STEP_INPUT_STATUS } from '../pipeline/rowPipeline.ts';
// The typed-confirmation gate and the sentences the confirm step shows.
import { CONFIRM_PHRASE, GEMINI_WARNING, canStartRun, confirmSummary, startIfConfirmed } from './pipelineRunConfirm.ts';
// Type only: the per-agent waiting counts record.
import type { WaitingCounts } from './pipelineRunConfirm.ts';

import './PipelineRunModal.css';

export interface PipelineRunModalProps {
  readonly onClose: () => void;
  readonly onRefresh: () => void;
}

export function PipelineRunModal({ onClose, onRefresh }: PipelineRunModalProps): ReactElement {
  const navigate = useNavigate();
  const [running, setRunning] = useState<boolean>(false);
  const [currentStatus, setCurrentStatus] = useState<string>('Ready to process discovered jobs through the AI tailoring pipeline.');
  // The last run's result, or null before any run. Replaces a bare `done` flag, which
  // could not tell a run that advanced rows from one where every step failed.
  const [result, setResult] = useState<PipelineRunResult | null>(null);
  // Steps of the last run, read off the result so there is one source of truth.
  const steps = result?.steps ?? [];
  // What the operator has typed into the confirmation box; the run unlocks only on CONFIRM_PHRASE.
  const [typed, setTyped] = useState<string>('');
  // The shared per-status counts; loadCounts re-reads them for every caller (the store drops superseded reads).
  const { state: countsState, counts: statusCounts, refetch: loadCounts } = useApplicationCounts();
  /* On open: one fresh read. The dialog confirms a bulk Gemini spend, so it must not settle for a count
     the store read minutes ago; one RPC here replaces the five HEAD counts the open used to make. */
  useEffect(() => {
    // Re-reads for every caller; a superseded read never overwrites a newer one (the store's own guard).
    loadCounts();
  }, [loadCounts]);
  // Only these two states are the database's answer; in them a status absent from the RPC has zero rows.
  const answered = countsState.kind === 'rows' || countsState.kind === 'empty';
  // Widened to string keys: STEP_INPUT_STATUS lists statuses as plain strings (shared with Deno), not the web's union.
  const byStatus: Readonly<Partial<Record<string, number>>> = statusCounts;
  /* Rows waiting at each agent's input statuses: null while the read is loading (the Run button stays
     locked until it lands). Failed, signed out or unconfigured: every agent is null, which the summary
     says as "count unknown" and never as 0 ("nothing waiting" would be a false claim). Never hard-coded,
     because the queues change with every scout and every sweep. */
  const counts: WaitingCounts | null = countsState.kind === 'loading'
    ? null
    // One entry per agent, keyed like STEP_INPUT_STATUS so the record names every PipelineStep.
    : Object.fromEntries(Object.entries(STEP_INPUT_STATUS).map(([step, statuses]) => [
      // The agent id the summary looks up.
      step,
      // The sum over that agent's statuses equals the old .in('status', statuses) exact count.
      answered ? statuses.reduce((sum, status) => sum + (byStatus[status] ?? 0), 0) : null,
    ])) as WaitingCounts;

  const handleStart = async (): Promise<void> => {
    // A retry is another bulk Gemini spend, so the phrase must be typed again for it.
    setTyped('');
    setRunning(true);
    // Clear the previous outcome so a Retry does not show stale success/failure framing.
    setResult(null);
    setCurrentStatus('Initializing pipeline agents on Supabase...');

    try {
      const res = await runFullPipeline((agentName, statusText) => {
        setCurrentStatus(`[${agentName}] ${statusText}`);
      });
      // Keep the classified result; the footer branches on its `ok`.
      setResult(res);
      // The summary states what actually moved, including "0 row(s) advanced".
      setCurrentStatus(res.summary);
    } catch (err) {
      // An unexpected throw is a failed run, so it gets the failure footer (Retry/Close).
      const message = err instanceof Error ? err.message : 'Pipeline execution encountered an error.';
      // Recorded as a result so the footer leaves the "Run" state and offers Retry.
      setResult({ ok: false, summary: message, steps: [] });
      // Show the same message in the status box.
      setCurrentStatus(message);
    } finally {
      // Refresh even on failure: earlier steps may have moved rows before a later one failed.
      onRefresh();
      setRunning(false);
      // The run moved rows between queues, so the counts shown for a Retry must be re-read.
      void loadCounts();
    }
  };

  return (
    <div
      className="pipeline-modal-backdrop"
      onClick={running ? undefined : onClose}
      /* Escape closes (never starts) the dialog, and not mid-run, matching the disabled Close button. */
      onKeyDown={(e) => { if (e.key === 'Escape' && !running) onClose(); }}
    >
      {/* role/aria-modal so screen readers announce it as a dialog, labelled by its title. */}
      <div
        className="pipeline-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pipeline-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="pipeline-modal__header">
          <div>
            <h2 id="pipeline-modal-title" className="pipeline-modal__title">Tailor & Process Discovered Jobs</h2>
            <p className="pipeline-modal__subtitle">
              Runs your deployed agents on Supabase in sequence to advance discovered jobs into your Approval Queue.
            </p>
          </div>
          <button
            type="button"
            className="button button--ghost"
            onClick={onClose}
            disabled={running}
            aria-label="Close modal"
          >
            ✕
          </button>
        </header>

        <div className="pipeline-modal__body">
          <div className="pipeline-steps-list">
            <div className="pipeline-step-item">
              <span className="pipeline-step-item__num">1</span>
              <div>
                <strong>Normalizer</strong>
                <p>Computes canonical SHA-256 fingerprints & removes duplicate postings.</p>
              </div>
            </div>
            <div className="pipeline-step-item">
              <span className="pipeline-step-item__num">2</span>
              <div>
                <strong>Screener</strong>
                <p>Evaluates tech gate, experience ceiling, and cascade filter rules.</p>
              </div>
            </div>
            <div className="pipeline-step-item">
              <span className="pipeline-step-item__num">3</span>
              <div>
                <strong>Matcher (Gemini)</strong>
                <p>Compares candidate master profile against job descriptions and scores fit.</p>
              </div>
            </div>
            <div className="pipeline-step-item">
              <span className="pipeline-step-item__num">4</span>
              <div>
                <strong>Tailor (Gemini)</strong>
                <p>Constructs honest tailored resumes by selecting verified bullet IDs from Master Profile.</p>
              </div>
            </div>
            <div className="pipeline-step-item">
              <span className="pipeline-step-item__num">5</span>
              <div>
                {/* No "(Gemini)" here, unlike step 4: the auditor checks claims against the Master Profile with deterministic code and calls no LLM (supabase/functions/auditor + _shared/audit import none), so the label must not promise one. */}
                <strong>Auditor</strong>
                <p>Audits claims against Master Profile & queues verified resumes into Approval Queue.</p>
              </div>
            </div>
          </div>

          {/* The confirm step: what the run will send and spend, then the typed phrase that unlocks it. */}
          <div className="pipeline-modal__status-box">
            {/* Same label style as the status box below. */}
            <div className="pipeline-modal__status-label">Before you run</div>
            {/* The counts load after the dialog opens; until then, say so rather than show a number. */}
            {counts === null ? (
              /* Not a number yet: an honest "counting" instead of a 0 that would read as "nothing to do". */
              <p className="pipeline-modal__status-text">Counting the rows waiting for each agent…</p>
            ) : (
              /* One line per agent, from the HEAD counts; an unreadable count says "unknown". */
              confirmSummary(counts).split('\n').map((line) => (
                /* One paragraph per summary line; each line is unique, so it is its own key. */
                <p key={line} className="pipeline-modal__status-text">{line}</p>
              ))
            )}
            {/* The spend warning, always shown: it does not depend on the counts, so it must not wait for them. */}
            <p className="pipeline-modal__status-text">{GEMINI_WARNING}</p>
            {/* A real label, so the input is named for screen readers and clickable. */}
            <label className="pipeline-modal__status-text" htmlFor="pipeline-run-confirm">
              Type <strong>{CONFIRM_PHRASE}</strong> to enable the run:
            </label>
            <input
              /* Tied to the label above. */
              id="pipeline-run-confirm"
              /* Reuses the page's search-box look; no new CSS. */
              className="discovery__search-input"
              /* Plain text; autocomplete would offer the phrase back and defeat the point of typing it. */
              type="text"
              /* No browser suggestions, same reason. */
              autoComplete="off"
              /* Focus lands here, so Escape and typing both work without a click. */
              autoFocus
              /* Controlled: the buttons read this value. */
              value={typed}
              /* Every keystroke re-evaluates the gate. */
              onChange={(e) => setTyped(e.target.value)}
              /* Locked during a run, so the phrase cannot be edited under a running batch. */
              disabled={running}
            />
          </div>

          {/* Failure gets role=alert so a screen reader announces it; the --error modifier is
              a hook for styling (no rule exists yet — CSS is outside this change's partition). */}
          <div
            className={`pipeline-modal__status-box${result !== null && !result.ok ? ' pipeline-modal__status-box--error' : ''}`}
            role={result !== null && !result.ok ? 'alert' : undefined}
          >
            {/* Label changes with the outcome so failure is not read as a neutral status. */}
            <div className="pipeline-modal__status-label">
              {result === null ? 'Pipeline Status' : result.ok ? 'Pipeline Finished' : 'Pipeline Did Not Complete'}
            </div>
            <div className="pipeline-modal__status-text">{currentStatus}</div>
            {steps.length > 0 && (
              // Class, not inline style: the inline version carried a light-theme hex fallback.
              <div className="pipeline-modal__status-steps">
                {steps.map((s) => (
                  <div key={s.agent}>
                    • {s.agent.toUpperCase()}: {s.status} {s.message ? `— ${s.message}` : ''}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <footer className="pipeline-modal__footer">
          {/* Success framing and the Approval Queue link only when the run is ok. */}
          {result?.ok === true ? (
            <>
              <button
                type="button"
                className="button button--secondary"
                onClick={onClose}
              >
                Close
              </button>
              <button
                type="button"
                className="button button--primary"
                onClick={() => {
                  onClose();
                  navigate('/approvals');
                }}
              >
                Go to Approval Queue
              </button>
            </>
          ) : result !== null ? (
            <>
              {/* Failed or halted run: no queue link, since nothing reliable reached it. */}
              <button
                type="button"
                className="button button--secondary"
                onClick={onClose}
                disabled={running}
              >
                Close
              </button>
              {/* Retry re-runs the whole pipeline; each agent only picks up rows still at its source status.
                  It is a bulk run too, so it sits behind the same typed gate. */}
              <button
                type="button"
                className="button button--primary"
                /* Through the gate on every click: the phrase was cleared when the last run started. */
                onClick={() => startIfConfirmed(typed, counts !== null, () => void handleStart())}
                /* Off while running, before the counts load, and until the phrase is retyped exactly. */
                disabled={running || !canStartRun(typed, counts !== null)}
              >
                {running ? 'Processing Pipeline...' : 'Retry'}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="button button--secondary"
                onClick={onClose}
                disabled={running}
              >
                Cancel
              </button>
              {/* Disabled until the phrase matches; the click still goes through the gate, so a
                  re-enabled button (devtools, a future refactor) cannot skip it. */}
              <button
                type="button"
                className="button button--primary"
                /* The same gate as Retry, so the two buttons cannot drift apart. */
                onClick={() => startIfConfirmed(typed, counts !== null, () => void handleStart())}
                /* Counts must be loaded too: the operator sees what will be sent before it can be sent. */
                disabled={running || !canStartRun(typed, counts !== null)}
              >
                {running ? 'Processing Pipeline...' : 'Run Pipeline Now'}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
