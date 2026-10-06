/* One application card in the pipeline drawer. Split out of PipelineDrawer.tsx (2026-10-06)
   so it renders with no Supabase client: the drawer imports the client singleton, and this
   card's one decision ("does this row offer View resume?") needs a test that can reach it. */

/* Type only: the element type the component returns. */
import type { ReactElement } from 'react';

/* Type only: the snapshot a row carries when it was tailored. */
import type { ResolvedResume } from '../../data/contract';
/* Same badge the drawer rendered inline before the split. With its extension, because
   node --test resolves imports itself and cannot find an extensionless .tsx path. */
import { SourceBadge } from '../../app/SourceBadge.tsx';

/* One row as the drawer maps it from the query. Moved here with the card so the type and
   its only renderer live together. */
export interface DrawerAppItem {
  /* The application id: React key, the short identifier shown, and the preview's id. */
  readonly id: string;
  /* Job title, joined from jobs; the card's heading. */
  readonly role: string;
  /* Employer, joined from jobs; shown under the title. */
  readonly company: string;
  /* When the row was created, shown as a local date. */
  readonly createdAt: string;
  /* Discovery sources for the badge; null when the job carries none. */
  readonly discoveredVia?: readonly string[] | null;
  /* Matcher score, null before scoring, so the card can omit it rather than print 0. */
  readonly score?: number | null;
  /* Null unless tailored_profile passed readResumeSnapshot; null renders no resume action at all. */
  readonly resume: ResolvedResume | null;
}

export function DrawerAppCard({
  app,
  onViewResume,
}: {
  readonly app: DrawerAppItem;
  /* Receives the row whose snapshot to open; the drawer owns the overlay. */
  readonly onViewResume: (app: DrawerAppItem) => void;
}): ReactElement {
  return (
    <article className="drawer__app-card">
      <div className="drawer__app-top">
        <div>
          <h3 className="drawer__app-role">{app.role}</h3>
          <span className="drawer__app-company">{app.company}</span>
        </div>
        {app.discoveredVia && app.discoveredVia.length > 0 && (
          <SourceBadge discoveredVia={app.discoveredVia as any} />
        )}
      </div>
      <div className="drawer__app-meta">
        <span className="identifier">{app.id.slice(0, 8)}</span>
        <span>{new Date(app.createdAt).toLocaleDateString()}</span>
        {app.score !== null && app.score !== undefined && <span>Match: {app.score}%</span>}
        {/* ABSENT, NOT DISABLED, when there is no snapshot: a disabled "View resume"
            invites the question "why not?" and the next fix is a fallback to the master,
            which would show a resume this row was never tailored with. In ANY status,
            because the point is reopening the tailored resume long after approval. */}
        {app.resume !== null && (
          <button
            type="button"
            className="button button--secondary button--small drawer__view-resume"
            onClick={() => onViewResume(app)}
          >
            View resume
          </button>
        )}
      </div>
    </article>
  );
}
