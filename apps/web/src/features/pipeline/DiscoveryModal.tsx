import { useState } from 'react';
import type { ReactElement } from 'react';

// The watchlist scan, and the sentence remote mode shows instead of a scan (2026-10-24).
// topDropReasons too (P1-5), so the summary's reason line says exactly what the step sentence says.
import { REMOTE_FEEDS_SCHEDULE_NOTE, runWatchlistScan, topDropReasons } from '../../data/discoveryService';
import type { WatchlistScanResult } from '../../data/discoveryService';

import './DiscoveryModal.css';

/* The results grid of a scan that worked (P1-5, 2026-11-05). It replaced a "New Applications" box
   that counted every inserted row: Teja's 39 "new applications" were all born dropped_filter.
   Passed and dropped are now separate boxes, and a function older than P1-5 (no breakdown) gets
   the raw row count with no claim about screening. Exported for test/scanBreakdown.test.ts. */
export function ScanSummary({ result }: { readonly result: WatchlistScanResult }): ReactElement {
  // undefined on a result that predates the field, null when the server sent none: both "unknown".
  const breakdown = result.breakdown ?? null;
  return (
    <div className="discovery-results">
      <h3 className="discovery-results__heading">Scan Summary</h3>
      <div className="discovery-results__grid">
        {/* Postings the scan upserted, screened or not. */}
        <div className="metric-box">
          {/* The count. */}
          <span className="metric-box__num">{result.jobsInserted}</span>
          {/* Its name. */}
          <span className="metric-box__label">Jobs Processed</span>
        </div>
        {breakdown === null ? (
          /* An older server: the rows are real, whether they passed is not known, so the label
             names rows, never applications. */
          <div className="metric-box">
            {/* Every row inserted. */}
            <span className="metric-box__num">{result.appsCreated}</span>
            {/* A neutral name. */}
            <span className="metric-box__label">New rows</span>
          </div>
        ) : (
          <>
            {/* The success lane, highlighted, and named after where the rows now are. */}
            <div className="metric-box metric-box--highlight">
              {/* Rows born passed_filters. */}
              <span className="metric-box__num">{breakdown.passed}</span>
              {/* One text node, so it reads as one phrase. */}
              <span className="metric-box__label">Passed → Ready to tailor</span>
            </div>
            {/* Drops get their own box, so they can never be read as successes again. */}
            <div className="metric-box">
              {/* Rows born dropped_filter. */}
              <span className="metric-box__num">{breakdown.dropped}</span>
              {/* Its name. */}
              <span className="metric-box__label">Dropped</span>
            </div>
            {/* Only when the screener was down: a third outcome that is neither pass nor drop. */}
            {breakdown.unscreened > 0 && (
              <div className="metric-box">
                {/* Rows born discovered. */}
                <span className="metric-box__num">{breakdown.unscreened}</span>
                {/* Why they are unjudged. */}
                <span className="metric-box__label">Not screened</span>
              </div>
            )}
          </>
        )}
      </div>
      {/* The note under the grid says where the rows went, or what this server could not say. */}
      <p className="discovery-results__note">
        {breakdown === null
          ? 'This server did not report how many passed screening. Check the Discovered page.'
          : breakdown.dropped > 0
            ? `Top drop reasons: ${topDropReasons(breakdown.dropReasons)}. Passed jobs wait in Ready to tailor on the Discovered page.`
            : 'Passed jobs wait in Ready to tailor on the Discovered page.'}
      </p>
    </div>
  );
}

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
      // The result's own sentence, success or failure. Before W8 (2026-11-01) only progress lines
      // reached this box, so a refused or failed scan left "Contacting Scout-ATS..." on screen.
      setStep(res.message);
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

  return (
    <div className="discovery-backdrop" onClick={running ? undefined : onClose}>
      <div className="discovery-modal" onClick={(e) => e.stopPropagation()}>
        <header className="discovery-modal__header">
          <div className="discovery-modal__title-group">
            <div>
              <h2 className="discovery-modal__title">
                {/* "Daily" in the title, so nobody waits for a scan that will not start. */}
                {isRemote ? 'Remote Feeds: Daily Scout' : 'Scan Watchlist ATS Boards'}
              </h2>
              <p className="discovery-modal__subtitle">
                {/* Remote: where the feeds now run. Watchlist: says the scan is ALSO automatic and
                    how much one click covers, because "is this running daily?" was asked twice
                    from this panel (2026-11-01). No clock times: scout.yml's cron is their one
                    source, and GitHub starts it hours late anyway. The 10 is scout-ats
                    DEFAULT_BOARD_LIMIT, since discoveryService sends no ?limit. Providers (P1-5):
                    SmartRecruiters is off since the 2026-11-01 robots ruling and Workday is polled,
                    so the list names what the scan really reads. */}
                {isRemote
                  ? 'Runs on a schedule in GitHub Actions, through the same apply-link check and screener as the company-board scout.'
                  : 'Polls Greenhouse, Lever, Ashby and Workday boards in your Company Watchlist. Every board is scanned automatically ten times a day; each run starts with the least recently scanned companies, and this button scans the 10 least recently polled boards now.'}
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
          {/* Only for a scan that worked: its note says positions were queued, which a failed
              or timed-out scan cannot claim. The step box above carries the failure's sentence. */}
          {/* ScanSummary (P1-5) replaced the old "New Applications" grid, which called dropped rows new. */}
          {watchlistResult?.ok === true && <ScanSummary result={watchlistResult} />}
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
                    {/* No count and no "Applications" (P1-5): appsCreated includes dropped rows. */}
                    Open Discovered page
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
