/* StatusBadge component — minimalist, human-crafted status indicator.
 *
 * Replaces tacky consumer emojis with a refined status dot, subdued
 * translucent background, and precise typography.
 */

import type { ReactElement } from 'react';
import type { ApplicationStatus } from '../data/contract';

export interface StatusBadgeProps {
  readonly status: ApplicationStatus | string;
  readonly label?: string;
  readonly showDot?: boolean;
  readonly className?: string;
}

export function StatusBadge({
  status,
  label,
  showDot = true,
  className = '',
}: StatusBadgeProps): ReactElement {
  const displayLabel = label ?? status.replace(/_/g, ' ');
  const combinedClass = `status-badge status-badge--${status} ${className}`.trim();

  return (
    <span className={combinedClass} title={`Status: ${status}`}>
      {showDot && <span className="status-badge__dot" aria-hidden="true" />}
      <span className="status-badge__label">{displayLabel}</span>
    </span>
  );
}

