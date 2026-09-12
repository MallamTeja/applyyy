/* SourceBadge — shows where a job was discovered.
 *
 * Three visual tiers, each with a distinct pill theme so the operator knows at
 * a glance whether a job came from a direct ATS board (highest signal), a
 * LinkedIn founder post (secondary signal), or a portal/aggregator (lowest
 * signal, highest noise).
 *
 *   Tier 1 — Direct Career Pages (ATS: greenhouse, lever, ashby)
 *             pill: emerald green   icon: 🏢
 *   Tier 2 — LinkedIn Hiring Posts (founder / recruiter posts)
 *             pill: electric blue   icon: 💬
 *   Tier 3 — Portals & Aggregators (naukri, adzuna, jooble, linkedin job board)
 *             pill: indigo/slate    icon: 🌐
 *
 * Clicking opens the source URL in a new tab. Hovering shows provider + URL.
 * Renders nothing when discoveredVia is absent or empty.
 */

import type { ReactElement } from 'react';
import type { DiscoverySource, JobSourceRef } from '../data/contract';

import './SourceBadge.css';

export interface SourceBadgeProps {
  readonly discoveredVia?: readonly DiscoverySource[] | null | undefined;
  readonly sourceRefs?: readonly JobSourceRef[] | null | undefined;
  readonly className?: string | undefined;
}

// ── Tier classification (browser-side mirror of tiers.ts classifyDiscoveryTier) ──

const TIER1_SOURCES = new Set<string>([
  'company_career_page', 'greenhouse', 'lever', 'ashby',
  'workable', 'smartrecruiters',
]);

const TIER2_SOURCES = new Set<string>(['linkedin_post']);

type PillTheme = 'career-page' | 'linkedin-post' | 'portal';

interface BadgeInfo {
  theme: PillTheme;
  icon: string;
  label: string;
  url?: string | undefined;
  tooltip: string;
}

function toBadgeInfo(
  source: DiscoverySource | string,
  refs: readonly JobSourceRef[],
): BadgeInfo {
  const ref = refs.find((r) => r.provider === source) ?? refs[0];
  const url = ref?.url ?? undefined;
  const refMeta = ref?.metadata as Record<string, unknown> | undefined | null;

  const isLinkedInPost =
    TIER2_SOURCES.has(source) ||
    (source === 'linkedin' && refMeta?.type === 'post') ||
    (typeof url === 'string' &&
      (url.includes('/feed/update/') || url.includes('/posts/')));

  if (isLinkedInPost) {
    const author =
      typeof refMeta?.author === 'string' && refMeta.author.trim().length > 0
        ? refMeta.author.trim()
        : 'Hiring Lead';
    return {
      theme: 'linkedin-post',
      icon: '💬',
      label: 'LinkedIn Post',
      url,
      tooltip: `LinkedIn hiring post by ${author}${url ? '\n' + url : ''}`,
    };
  }

  const atsProvider =
    typeof refMeta?.ats_provider === 'string' ? refMeta.ats_provider : null;
  if (TIER1_SOURCES.has(source) || refMeta?.tier === 1) {
    const providerLabel = atsProvider
      ? atsProvider.charAt(0).toUpperCase() + atsProvider.slice(1)
      : source.replace(/_/g, ' ');
    return {
      theme: 'career-page',
      icon: '🏢',
      label: `Career Page · ${providerLabel}`,
      url,
      tooltip: `Direct ATS career page (${providerLabel})${url ? '\n' + url : ''}`,
    };
  }

  const portalLabel =
    source === 'linkedin'
      ? 'LinkedIn Jobs'
      : source.charAt(0).toUpperCase() + source.slice(1);
  return {
    theme: 'portal',
    icon: '🌐',
    label: `Portal · ${portalLabel}`,
    url,
    tooltip: `Job portal: ${portalLabel}${url ? '\n' + url : ''}`,
  };
}

export function SourceBadge({
  discoveredVia,
  sourceRefs,
  className = '',
}: SourceBadgeProps): ReactElement | null {
  if (!discoveredVia || discoveredVia.length === 0) return null;

  const refs: readonly JobSourceRef[] = sourceRefs ?? [];
  const badges: BadgeInfo[] = discoveredVia.map((src) => toBadgeInfo(src, refs));

  return (
    <span className={`source-badge-group ${className}`.trim()}>
      {badges.map((b, i) => (
        <span
          key={`${b.theme}-${i}`}
          className={`source-badge source-badge--${b.theme}`}
          title={b.tooltip}
          role={b.url ? 'link' : undefined}
          tabIndex={b.url ? 0 : undefined}
          aria-label={b.tooltip}
          onClick={
            b.url
              ? (e) => {
                  e.stopPropagation();
                  window.open(b.url, '_blank', 'noopener,noreferrer');
                }
              : undefined
          }
          onKeyDown={
            b.url
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    window.open(b.url, '_blank', 'noopener,noreferrer');
                  }
                }
              : undefined
          }
        >
          <span className="source-badge__icon" aria-hidden="true">{b.icon}</span>
          <span className="source-badge__label">{b.label}</span>
        </span>
      ))}
    </span>
  );
}
