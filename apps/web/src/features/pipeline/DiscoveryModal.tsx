import { useState } from 'react';
import type { ReactElement } from 'react';

import { runRemoteDiscovery, runWatchlistScan } from '../../data/discoveryService';
import type { DiscoveryResult, WatchlistScanResult } from '../../data/discoveryService';

import './DiscoveryModal.css';

export interface DiscoveryModalProps {
  readonly mode: 'remote' | 'watchlist';
  readonly onClose: () => void;
  readonly onRefresh: () => void;
  readonly onOpenDiscovered?: () => void;
}

export function DiscoveryModal({
  mode,
  onClose,
  onRefresh,
  onOpenDiscovered,
}: DiscoveryModalProps): ReactElement {
  const [running, setRunning] = useState<boolean>(false);
  const [step, setStep] = useState<string>('Ready to start job hunting scan.');
  const [remoteResult, setRemoteResult] = useState<DiscoveryResult | null>(null);
  const [watchlistResult, setWatchlistResult] = useState<WatchlistScanResult | null>(null);

  const isRemote = mode === 'remote';

  const handleStart = async () => {
    setRunning(true);
    setRemoteResult(null);
    setWatchlistResult(null);

    try {
      if (isRemote) {
        const res = await runRemoteDiscovery((currentStep) => {
          setStep(currentStep);
        });
        setRemoteResult(res);
      } else {
        const res = await runWatchlistScan((currentStep) => {
          setStep(currentStep);
        });
        setWatchlistResult(res);
      }
      onRefresh();
    } catch (err) {
      setStep(err instanceof Error ? err.message : 'Discovery scan encountered an error.');
    } finally {
      setRunning(false);
    }
  };

  const hasResult = Boolean(remoteResult || watchlistResult);
  const appsCreated = remoteResult?.appsCreated ?? watchlistResult?.appsCreated ?? 0;
  const jobsInserted = remoteResult?.jobsInserted ?? watchlistResult?.jobsInserted ?? 0;

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
                {isRemote ? 'Global Remote & Web Discovery' : 'Scan Watchlist ATS Boards'}
              </h2>
              <p className="discovery-modal__subtitle">
                {isRemote
                  ? 'Scours open international feeds (RemoteOK, Jobicy, Arbeitnow, global ATS boards) for remote roles.'
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
                {isRemote && remoteResult && (
                  <>
                    <div className="metric-box">
                      <span className="metric-box__num">{remoteResult.totalFetched}</span>
                      <span className="metric-box__label">Total Evaluated</span>
                    </div>
                    <div className="metric-box">
                      <span className="metric-box__num">{remoteResult.matchedCount}</span>
                      <span className="metric-box__label">Preferences Matched</span>
                    </div>
                  </>
                )}
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
            {!running && !hasResult && (
              <button
                type="button"
                className="btn-primary"
                onClick={handleStart}
              >
                {isRemote ? 'Start Global Remote Scan' : 'Start Watchlist Scan'}
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
