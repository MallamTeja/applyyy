/* SourceBadge — shows where a job was discovered.
 *
 * Three visual tiers, each with a distinct pill theme so the operator knows at
 * a glance whether a job came from a direct ATS board (highest signal), a
 * LinkedIn founder post (secondary signal), or a portal/aggregator (lowest
 * signal, highest noise).
 *
 *   Tier 1 — Direct Career Pages (ATS: greenhouse, lever, ashby)
 *             the only tier that carries a hue: filled green, solid edge
 *   Tier 2 — LinkedIn Hiring Posts (founder / recruiter posts)
 *             neutral chip, DASHED edge — an indirect, human-posted source
 *   Tier 3 — Portals & Aggregators (naukri, adzuna, jooble, linkedin job board)
 *             neutral chip, hairline edge — the quietest thing on the card
 *
 * Saturation carries the rank rather than three unrelated hues, so the badge
 * row has one loud member instead of three. See SourceBadge.css for why.
 *
 * Clicking opens the source URL in a new tab. Hovering shows provider + URL.
 * Renders nothing when discoveredVia is absent or empty.
 */

import type { ReactElement } from 'react';
import type { DiscoverySource, JobSourceRef } from '../data/contract';
// The shared http(s)-only gate; source_refs urls are board- or LLM-supplied.
import { safeHref } from './safeHref.ts';

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
  label: string;
  url?: string | undefined;
  tooltip: string;
}

/* The tier glyphs, as inline SVG rather than the office / speech-bubble / globe emoji this used
   to render.
   WHY THE SWAP: emoji are painted by the operating system in their own fixed
   colours, so they ignored the badge's palette entirely — three saturated
   full-colour pictograms on a console built from low-chroma tokens — and each
   OS draws them differently, so the badge row was a different shape on every
   machine. These inherit currentColor, which means one definition of the tier
   colour drives the text, the border and the glyph together.
   `stroke-width` is kept at 1.75 so the glyph reads at 0.85em without the
   hairline dropping out on a low-DPI display. */
const TIER_ICONS: Record<PillTheme, ReactElement> = {
  /* An office block: the job came straight from the employer's own board. */
  'career-page': (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75}
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 14V3.2a.7.7 0 0 1 .7-.7h6.1a.7.7 0 0 1 .7.7V14" />
      <path d="M10 6.5h2.8a.7.7 0 0 1 .7.7V14" />
      <path d="M1 14h14M5 5.5h2M5 8h2M5 10.5h2" />
    </svg>
  ),
  /* A speech bubble: a person posted this, it is not a structured listing. */
  'linkedin-post': (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75}
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 9.2a2.3 2.3 0 0 1-2.3 2.3H6.2L2.8 14V4.3A2.3 2.3 0 0 1 5.1 2h6.6A2.3 2.3 0 0 1 14 4.3Z" />
    </svg>
  ),
  /* A globe: an aggregator that republishes other people's listings. */
  portal: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75}
         strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M1.8 8h12.4" />
      <path d="M8 1.8a9.6 9.6 0 0 1 0 12.4 9.6 9.6 0 0 1 0-12.4Z" />
    </svg>
  ),
};

function toBadgeInfo(
  source: DiscoverySource | string,
  refs: readonly JobSourceRef[],
): BadgeInfo {
  const ref = refs.find((r) => r.provider === source) ?? refs[0];
  // http(s) only: this URL reaches window.open, and a stored `javascript:` ref would
  // run there. Undefined makes the badge non-clickable rather than unsafe.
  const url = safeHref(ref?.url);
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
      label: 'LinkedIn post',
      url,
      tooltip: `LinkedIn hiring post by ${author}${url ? '\n' + url : ''}`,
    };
  }

  const atsProvider =
    typeof refMeta?.ats_provider === 'string' ? refMeta.ats_provider : null;
  if (TIER1_SOURCES.has(source) || refMeta?.tier === 1) {
    /* The ATS name when we know it, else the source id read back as words. */
    const providerLabel = atsProvider
      ? atsProvider.charAt(0).toUpperCase() + atsProvider.slice(1)
      : source.replace(/_/g, ' ');
    /* `company_career_page` expands to "company career page", which would make
       the chip read "company career page career page". Only append the suffix
       when the name does not already carry it. */
    const label = /career page/i.test(providerLabel)
      ? providerLabel.charAt(0).toUpperCase() + providerLabel.slice(1)
      : `${providerLabel} career page`;
    return {
      theme: 'career-page',
      label,
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
    label: `${portalLabel} portal`,
    url,
    tooltip: `Job portal: ${portalLabel}${url ? '\n' + url : ''}`,
  };
}

export function SourceBadge({
  discoveredVia,
  sourceRefs,
  className = '',
}: SourceBadgeProps): ReactElement | null {
  // Both props arrive off the wire as untrusted JSON, typed only by a cast at the call sites. A
  // truthiness test let a non-empty string through to .map and crashed the page ("e.map is not a
  // function", 2026-11-07 audit), so the SHAPE is checked (CLAUDE.md section 6): an array of strings.
  const sources: readonly string[] = Array.isArray(discoveredVia) ? discoveredVia.filter((s): s is string => typeof s === 'string') : [];
  // No readable source: no chip, rather than a crash or a guessed one.
  if (sources.length === 0) return null;

  // Same check for the refs: toBadgeInfo reads .provider off each one, so a null entry would throw there.
  const refs: readonly JobSourceRef[] = Array.isArray(sourceRefs) ? sourceRefs.filter((r) => typeof r === 'object' && r !== null) : [];
  // One chip per distinct label+url. A source with no ref of its own borrows refs[0] in toBadgeInfo, so
  // xAI's {greenhouse, manual} (a pasted Greenhouse link, 2026-11-05 A3) drew "Greenhouse career page" twice:
  // the same chip, same link. Identical chips say nothing new; a Map keeps the first one's position.
  const badges: BadgeInfo[] = [...new Map(sources.map((src) => toBadgeInfo(src, refs)).map((b) => [`${b.label}\n${b.url ?? ''}`, b] as const)).values()];

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
          {/* aria-hidden because the label beside it already says the same
              thing; announcing the glyph too would double every badge. */}
          <span className="source-badge__icon" aria-hidden="true">
            {TIER_ICONS[b.theme]}
          </span>
          <span className="source-badge__label">{b.label}</span>
        </span>
      ))}
    </span>
  );
}

/* NewTabCue: the visible + spoken "opens in a new tab" marker for a link or button that opens
   another tab. It replaces the old north-east arrow glyph, which noEmoji.test.ts forbids (U+2197 is
   Extended_Pictographic and some platforms paint it as a colour emoji).
   It lives here because this file already holds the app's inline-SVG icons and their rationale
   (TIER_ICONS above): same 16-unit viewBox, currentColor stroke and 1.75 width, so it takes the
   text colour of whatever control it sits in. */
export function NewTabCue(): ReactElement {
  return (
    <>
      {/* aria-hidden: the arrow is decoration for sighted users; the hidden words below carry the meaning. */}
      <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none" stroke="currentColor"
           strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"
           /* Inline size, so the cue needs no stylesheet; 0.85em matches the badge glyphs; the offset sits it on the text baseline. */
           style={{ width: '0.85em', height: '0.85em', marginInlineStart: '0.3em', verticalAlign: '-0.1em' }}>
        {/* The box-and-arrow "external link" shape: an open square with an arrow leaving its corner. */}
        <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M11.5 9.5v3.3a.7.7 0 0 1-.7.7H3.2a.7.7 0 0 1-.7-.7V5.2a.7.7 0 0 1 .7-.7h3.3" />
      </svg>
      {/* Spoken with the control's name, so a screen reader announces "…, opens in a new tab". */}
      <span className="visually-hidden"> (opens in a new tab)</span>
    </>
  );
}
