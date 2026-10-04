import { useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { runFullPipeline } from '../../data/pipelineRunner';
import type { PipelineStepProgress } from '../../data/pipelineRunner';

import './PipelineRunModal.css';

export interface PipelineRunModalProps {
  readonly onClose: () => void;
  readonly onRefresh: () => void;
}

export function PipelineRunModal({ onClose, onRefresh }: PipelineRunModalProps): ReactElement {
  const navigate = useNavigate();
  const [running, setRunning] = useState<boolean>(false);
  const [currentStatus, setCurrentStatus] = useState<string>('Ready to process discovered jobs through the AI tailoring pipeline.');
  const [steps, setSteps] = useState<readonly PipelineStepProgress[]>([]);
  const [done, setDone] = useState<boolean>(false);

  const handleStart = async (): Promise<void> => {
    setRunning(true);
    setDone(false);
    setSteps([]);
    setCurrentStatus('Initializing pipeline agents on Supabase...');

    try {
      const res = await runFullPipeline((agentName, statusText) => {
        setCurrentStatus(`[${agentName}] ${statusText}`);
      });
      setSteps(res.steps);
      setCurrentStatus(res.summary);
      setDone(true);
      onRefresh();
    } catch (err) {
      setCurrentStatus(err instanceof Error ? err.message : 'Pipeline execution encountered an error.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="pipeline-modal-backdrop" onClick={running ? undefined : onClose}>
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
            <h2 id="pipeline-modal-title" className="pipeline-modal__title">✨ Tailor & Process Discovered Jobs</h2>
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
                <strong>Auditor (Gemini)</strong>
                <p>Audits claims against Master Profile & queues verified resumes into Approval Queue.</p>
              </div>
            </div>
          </div>

          <div className="pipeline-modal__status-box">
            <div className="pipeline-modal__status-label">Pipeline Status</div>
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
          {done ? (
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
                Go to Approval Queue ↗
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
              <button
                type="button"
                className="button button--primary"
                onClick={() => void handleStart()}
                disabled={running}
              >
                {running ? 'Processing Pipeline...' : '⚡ Run Pipeline Now'}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
