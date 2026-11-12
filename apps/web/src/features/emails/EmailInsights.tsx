/* The Emails page's Insights panel (Teja, 2026-11-12 12:41 IST: "i need more anyticks , numbers abt my mails to
 * uderstand more abt them , more good uiux"). Presentational only: every number arrives computed by emailStats.ts
 * (unit-tested), so this file decides layout, never figures.
 *
 * A native <details>, open by default: collapsible with no script, keyboard and screen-reader ready. Bars are drawn
 * with CSS widths and carry their number as text beside them, so a bar is never the only signal. Deliberately NOT
 * the .email-stat-card class: e2eSuite pins exactly four of those KPI cards. */

// Types only.
import type { ReactElement } from 'react';
// The figures' shape.
import type { EmailStats } from './emailStats.ts';

/* One labelled bar row: label, a track filled to count/max, and the count as text. */
function Bar(props: { readonly label: string; readonly count: number; readonly max: number }): ReactElement {
  // Share of the largest bar; a zero max draws empty tracks, never NaN.
  const pct = props.max > 0 ? Math.round((props.count / props.max) * 100) : 0;
  return (
    /* One row: the label and count are text, the bar is decoration. */
    <li className="email-bar">
      {/* The label, clipped with an ellipsis when long (full text in the title). */}
      <span className="email-bar__label" title={props.label}>{props.label}</span>
      {/* The track; aria-hidden because the count beside it says the same. */}
      <span className="email-bar__track" aria-hidden="true">
        {/* Width is the only inline style: it is data, not design. */}
        <span className="email-bar__fill" style={{ width: `${pct}%` }} />
      </span>
      {/* The number, always shown. */}
      <span className="email-bar__count">{props.count}</span>
    </li>
  );
}

/* A small card of bars, or a one-line empty state. */
function BarCard(props: { readonly title: string; readonly rows: readonly { readonly label: string; readonly count: number }[]; readonly empty: string }): ReactElement {
  // The longest bar sets the scale.
  const max = Math.max(0, ...props.rows.map((r) => r.count));
  return (
    /* One card. */
    <section className="email-insights__card" aria-label={props.title}>
      {/* h3: the panel's summary is the level above. */}
      <h3 className="email-insights__card-title">{props.title}</h3>
      {/* Bars, or the empty line when there is nothing to draw. */}
      {props.rows.length > 0 && max > 0 ? (
        /* A list, so a screen reader counts the rows. */
        <ul className="email-bars">
          {/* One bar per row; the label is unique within a card. */}
          {props.rows.map((r) => <Bar key={r.label} label={r.label} count={r.count} max={max} />)}
        </ul>
      ) : (
        /* Said, not blank. */
        <p className="email-insights__empty">{props.empty}</p>
      )}
    </section>
  );
}

/* "3 Nov" for a YYYY-MM-DD week start, read as a calendar date (UTC), so the browser's zone cannot shift it a day. */
function weekLabel(weekStart: string): string {
  // Midnight UTC of that date, formatted in UTC.
  return new Date(`${weekStart}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/* The panel. `windowNote` says what the figures cover (the page loads the newest 200 emails). */
export function EmailInsights(props: { readonly stats: EmailStats; readonly windowNote: string }): ReactElement {
  // Destructured for readability.
  const { stats } = props;
  // Share of job mail linked to an application, as a whole percent; none when there is no job mail.
  const trackedPct = stats.jobMail > 0 ? `${Math.round((stats.tracked / stats.jobMail) * 100)}%` : '–';
  // The headline figures, in reading order: volume, reach, outcomes, the owner's own, tracking.
  // `tone` is explicitly optional-or-undefined: the two outcome figures carry a tone only when non-zero.
  const figures: readonly { readonly label: string; readonly value: string; readonly tone?: 'good' | 'bad' | undefined }[] = [
    // Employer job mail.
    { label: 'Job emails', value: String(stats.jobMail) },
    // Distinct employers.
    { label: 'Companies', value: String(stats.companyCount) },
    // Interviews, assessments, offers.
    { label: 'Interviews & offers', value: String(stats.positive), tone: stats.positive > 0 ? 'good' : undefined },
    // No's.
    { label: 'Rejections', value: String(stats.rejections), tone: stats.rejections > 0 ? 'bad' : undefined },
    // Linked share.
    { label: 'Tracked', value: trackedPct },
    // The owner's own mail, kept out of every employer figure.
    { label: 'Sent by you', value: String(stats.fromYou) },
  ];
  return (
    /* Open by default; the summary toggles it. */
    <details className="email-insights" open>
      {/* The toggle, with the window it covers. */}
      <summary className="email-insights__summary">
        {/* The panel's name. */}
        <span className="email-insights__title">Insights</span>
        {/* What the numbers cover. */}
        <span className="email-insights__note">{props.windowNote}</span>
      </summary>
      {/* The headline figures as a description list: term, then value. */}
      <dl className="email-insights__figures">
        {/* One per figure; labels are unique. */}
        {figures.map((f) => (
          /* One figure. */
          <div key={f.label} className="email-insights__figure">
            {/* The name. */}
            <dt className="email-insights__figure-label">{f.label}</dt>
            {/* The value; the tone only colours it, the word already says it. */}
            <dd className={f.tone === undefined ? 'email-insights__figure-value' : `email-insights__figure-value email-insights__figure-value--${f.tone}`}>{f.value}</dd>
          </div>
        ))}
      </dl>
      {/* The three breakdowns. */}
      <div className="email-insights__grid">
        {/* What kind of mail. */}
        <BarCard title="By type" rows={stats.byType.map((t) => ({ label: t.label, count: t.count }))} empty="No job emails yet." />
        {/* Who writes most. */}
        <BarCard title="Top companies" rows={stats.companies.map((c) => ({ label: c.name, count: c.count }))} empty="No employer named yet." />
        {/* When. */}
        <BarCard title="Job emails per week" rows={stats.weekly.map((w) => ({ label: `Week of ${weekLabel(w.weekStart)}`, count: w.count }))} empty="No job emails in these weeks." />
      </div>
    </details>
  );
}
