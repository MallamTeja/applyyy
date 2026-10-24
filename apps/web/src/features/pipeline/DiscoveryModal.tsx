import { useState } from 'react';
import type { ReactElement } from 'react';

// The watchlist scan, and the sentence remote mode shows instead of a scan (2026-10-24).
import { REMOTE_FEEDS_SCHEDULE_NOTE, runWatchlistScan } from '../../data/discoveryService';
import type { WatchlistScanResult } from '../../data/discoveryService';

import './DiscoveryModal.css';

export interface DiscoveryModalProps {
  readonly mode: 'remote' | 'watchlist';
  readonly onClose: () => void;
  readonly onRefresh: () => void;
  readonly onOpenDiscovered?: () => void;
}

/* Two modes. 'watchlist' runs the Watchlist ATS scan. 'remote' used to fetch the remote
   feeds from the browser and insert them unscreened; that write path is retired, and the
   feeds run daily on .github/workflows/scout-remote.yml. Remote mode now explains that
   instead of offering a scan, so every remote button in the app tells the same truth. */
export function DiscoveryModal({
  mode,
  onClose,
  onRefresh,
  onOpenDiscovered,
}: DiscoveryModalProps): ReactElement {
  const [running, setRunning] = useState<boolean>(false);
  // Remote mode opens on the schedule sentence; watchlist mode on its ready prompt.
  const [step, setStep] = useState<string>(mode === 'remote' ? REMOTE_FEEDS_SCHEDULE_NOTE : 'Ready to start job hunting scan.');
  // The watchlist scan's summary; the only result this modal can show now.
  const [watchlistResult, setWatchlistResult] = useState<WatchlistScanResult | null>(null);

  const isRemote = mode === 'remote';

  // Watchlist only: remote mode renders no start button, so this is never reached for it.
  const handleStart = async () => {
    // Locks the close button and backdrop while the scan writes.
    setRunning(true);
    // A rescan starts with no stale summary on screen.
    setWatchlistResult(null);

    try {
      // The Watchlist ATS scan, reporting progress into the step box.
      const res = await runWatchlistScan((currentStep) => {
        setStep(currentStep);
      });
      // The summary for the results grid.
      setWatchlistResult(res);
      // The page behind the modal reloads, so the new rows appear.
      onRefresh();
    } catch (err) {
      setStep(err instanceof Error ? err.message : 'Discovery scan encountered an error.');
    } finally {
      setRunning(false);
    }
  };

  // Only the watchlist scan produces a result now.
  const hasResult = watchlistResult !== null;
  // 0 before any scan; the buttons below only read these after hasResult.
  const appsCreated = watchlistResult?.appsCreated ?? 0;
  const jobsInserted = watchlistResult?.jobsInserted ?? 0;

  return (
    <div className="discovery-backdrop" onClick={running ? undefined : onClose}>
      <div className="discovery-modal" onClick={(e) => e.stopPropagation()}>
        <header className="discovery-modal__header">
          <div className="discovery-modal__title-group">
            <span className="discovery-modal__icon">
              {isRemote ? '🌍' : '🏢'}
            </span>
            <div>
              <h2 className="discovery-modal__title">
                {/* "Daily" in the title, so nobody waits for a scan that will not start. */}
                {isRemote ? 'Remote Feeds: Daily Scout' : 'Scan Watchlist ATS Boards'}
              </h2>
              <p className="discovery-modal__subtitle">
                {/* Remote: where the feeds now run; watchlist: unchanged. */}
                {isRemote
                  ? 'Runs on a schedule in GitHub Actions, through the same apply-link check and screener as the company-board scout.'
                  : 'Polls Greenhouse, Lever, and Ashby boards registered in your Company Watchlist.'}
              </p>
            </div>
          </div>
          {!running && (
            <button
              type="button"
              className="discovery-modal__close-btn"
              onClick={onClose}
              aria-label="Close"
            >
              ✕
            </button>
          )}
        </header>

        <div className="discovery-modal__body">
          {/* Progress / Step Box */}
          <div className={`discovery-step ${running ? 'discovery-step--running' : ''}`}>
            {running && <div className="discovery-step__spinner" />}
            <p className="discovery-step__text">{step}</p>
          </div>

          {/* Results Summary */}
          {hasResult && (
            <div className="discovery-results">
              <h3 className="discovery-results__heading">Scan Summary</h3>
              <div className="discovery-results__grid">
                <div className="metric-box">
                  <span className="metric-box__num">{jobsInserted}</span>
                  <span className="metric-box__label">Jobs Processed</span>
                </div>
                <div className="metric-box metric-box--highlight">
                  <span className="metric-box__num">{appsCreated}</span>
                  <span className="metric-box__label">New Applications</span>
                </div>
              </div>
              <p className="discovery-results__note">
                ✓ New positions have been queued into the <strong>Discovered</strong> column in your Pipeline.
              </p>
            </div>
          )}
        </div>

        <footer className="discovery-modal__footer">
          <div className="discovery-modal__footer-actions">
            {/* Remote mode: nothing to start, only a way out. */}
            {isRemote && (
              <button
                /* Not a submit: the modal has no form. */
                type="button"
                /* The primary look, since it is the only action. */
                className="btn-primary"
                /* Closes the explanation; nothing runs and nothing is written. */
                onClick={onClose}
              >
                {/* The button's accessible name. */}
                Close
              </button>
            )}

            {!isRemote && !running && !hasResult && (
              <button
                type="button"
                className="btn-primary"
                onClick={handleStart}
              >
                Start Watchlist Scan
              </button>
            )}

            {!running && hasResult && (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleStart}
                >
                  Scan Again
                </button>
                {appsCreated > 0 && onOpenDiscovered && (
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => {
                      onClose();
                      onOpenDiscovered();
                    }}
                  >
                    View Discovered Applications ({appsCreated})
                  </button>
                )}
                {appsCreated === 0 && (
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={onClose}
                  >
                    Done
                  </button>
                )}
              </>
            )}

            {running && (
              <span className="discovery-modal__scanning-note">
                Agent is scanning live job feeds, please wait...
              </span>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
