/* StatusBadge component — clean pill container with solid contrast and icons.
 *
 * Designed to ensure high readability and rapid scannability across
 * Pipeline, Approvals, Health, and Settings views.
 */

import type { ReactElement } from 'react';
import type { ApplicationStatus } from '../data/contract';

const STATUS_ICONS: Record<string, string> = {
  discovered: '🔎',
  deduped: '🔗',
  passed_filters: '🛡️',
  scored: '📊',
  tailored: '✨',
  audit_clean: '✓',
  audit_flagged: '⚠',
  awaiting_approval: '⏳',
  approved: '✓',
  applying: '⚡',
  applied: '🚀',
  employer_screening: '👀',
  oa_pending: '📝',
  interview: '🎯',
  offer: '🎉',
  rejected: '✕',
  dropped_filter: '⏹',
  dropped_duplicate: '⏹',
  blocked_needs_human: '✋',
  needs_verification: '🔍',
  failed: '✕',
  active: '●',
  paused: '○',
};

export interface StatusBadgeProps {
  readonly status: ApplicationStatus | string;
  readonly label?: string;
  readonly icon?: string;
  readonly className?: string;
}

export function StatusBadge({
  status,
  label,
  icon,
  className = '',
}: StatusBadgeProps): ReactElement {
  const displayIcon = icon ?? STATUS_ICONS[status] ?? '●';
  const displayLabel = label ?? status.replace(/_/g, ' ');
  const combinedClass = `status-badge status-badge--${status} ${className}`.trim();

  return (
    <span className={combinedClass} title={`Status: ${status}`}>
      <span aria-hidden="true">{displayIcon}</span>
      <span>{displayLabel}</span>
    </span>
  );
}
