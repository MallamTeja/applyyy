/* The company blocklist - PROJECT_PLAN.md sections 15 and 16.
 *
 * WHY THIS EARNS A WHOLE PAGE for what is, technically, one table and one WHERE
 * clause. Because of a failure that is invisible from every other screen.
 *
 * Resume-harvesting consultancies post thirty near-identical listings a week -
 * "Hiring 500 freshers for MNC!" - purely to collect resumes. Each one has a
 * different title, a different job id and a different fingerprint, so the
 * deduper correctly treats them as thirty distinct jobs, because they are.
 * Without a blocklist the system sends thirty applications to one staffing firm
 * and THE OPERATOR NEVER NOTICES, because each looked like a different job in
 * the queue. At 35 applications a day that is very nearly an entire day spent
 * applying to a single firm that was never hiring.
 *
 * So the blocklist is not a preference list. It is the only defence against a
 * duplicate that is not a duplicate - and it works at the company level
 * precisely because the job level cannot see the pattern.
 *
 * WHY IT JOINS ON THE SLUG, NOT THE NAME. `jobs.company_slug` is the
 * lower-cased, punctuation-stripped name, and it is what both this blocklist
 * and the per-company weekly cap match on. Matching on the display name would
 * let "Acme Technologies", "ACME Technologies." and "acme technologies" past a
 * block the operator believed he had set. The display name is kept alongside
 * for reading; the slug is what the query uses.
 *
 * WHY A BLOCK CAN EXPIRE. `blocked_until` exists because one of the reasons is
 * inherently temporary: a company that rejected you recently is worth avoiding
 * for a few months, not forever. A permanent block for a time-boxed reason
 * would quietly remove a real employer from the funnel a year later, and
 * nothing on any screen would explain why they stopped appearing.
 */

import type { ReactElement } from 'react';

import { PageHeader } from '../../app/PageHeader';
/* The reason vocabulary comes from the schema. It is not decoration: the reason
   is what tells the operator later why a company he now wants to apply to is
   being skipped, and whether the block was meant to expire. */
import { BLOCKLIST_REASONS } from '../../data/contract';
import type { BlocklistReason } from '../../data/contract';

import './settings.css';

/* --- What each reason means, and how it behaves ----------------------- */

/* Per-reason copy.
 *
 * Keyed by the schema's `BlocklistReason` and PARTIAL on purpose, so a reason
 * added upstream renders with its raw name rather than vanishing from the list
 * of things the operator can choose. */
interface ReasonCopy {
  /* The operator's name for it. */
  readonly label: string;
  /* What it catches, concretely. Vague categories get misused; concrete ones
     get used correctly. */
  readonly catches: string;
  /* Whether a block for this reason should normally carry an expiry. This is
     the field that keeps the list honest over time. */
  readonly expiry: 'permanent' | 'time-boxed';
}

const REASON_COPY: Readonly<Partial<Record<BlocklistReason, ReasonCopy>>> = {
  consultancy: {
    label: 'Staffing firm / consultancy',
    catches:
      'Resume harvesters posting thirty near-identical listings a week. Each has its own fingerprint, so the deduper cannot help - this is the reason the page exists.',
    expiry: 'permanent',
  },
  mlm: {
    label: 'MLM or commission-only outfit',
    catches:
      'Sales and network-marketing schemes dressed up as marketing or business-development internships.',
    expiry: 'permanent',
  },
  ghosted: {
    label: 'Applied, never heard back',
    catches:
      'Companies that took an application and never replied. Worth pausing rather than banning outright - a hiring team changes, and a permanent block on a real employer is a cost you pay silently.',
    expiry: 'time-boxed',
  },
  rejected_recently: {
    label: 'Rejected recently',
    catches:
      'Reapplying immediately after a rejection reads as a negative in most applicant tracking systems. This is the reason that most needs an expiry date - in a few months it stops being true.',
    expiry: 'time-boxed',
  },
  personal_choice: {
    label: 'Would not join',
    catches:
      'Somewhere you have decided against, for whatever reason. At 35 slots a day every wasted slot is a real one, so this needs no further justification.',
    expiry: 'permanent',
  },
  other: {
    label: 'Other',
    catches:
      'Anything the list above does not cover. Worth a note, because in six months the note is the only thing that will explain the block.',
    expiry: 'permanent',
  },
};

/* --- The page --------------------------------------------------------- */

export function BlocklistPage(): ReactElement {
  return (
    <div className="page">
      <PageHeader path="blocklist" />

      {/* Honest state, in the shared idiom. */}
      <p className="not-wired">
        This page is laid out but not yet reading or writing{' '}
        <span className="identifier">company_blocklist</span>. No company is
        currently being excluded.
      </p>

      {/* The argument for the page, stated once. Without it a reader assumes
          this is a nice-to-have preferences screen. */}
      <section className="settings-group">
        <h2 className="settings-group__title">The failure this prevents</h2>
        <p className="settings-group__note">
          A staffing firm posts thirty near-identical listings in a week. Each
          has its own title, its own job id and therefore its own fingerprint,
          so the deduper treats them as thirty different jobs - correctly,
          because that is what they are.
        </p>
        <p className="settings-group__note">
          Without a blocklist you send thirty applications to one firm that was
          never hiring, and you do not notice, because each one looked like a
          different job in the queue. At 35 applications a day that is most of a
          day gone. This is the only screen that can see that pattern, because
          it is the only one that works at the company level.
        </p>
      </section>

      {/* The reasons, driven off the enum. */}
      <section className="settings-group">
        <h2 className="settings-group__title">Reasons, and which ones should expire</h2>
        <p className="settings-group__note">
          The reason is not a label for tidiness. Months later it is the only
          thing that explains why a company you now want to apply to is being
          skipped - and whether the block was ever meant to be permanent.
        </p>
        <div className="settings-table-wrap">
          <table className="settings-table">
            <thead>
              <tr>
                <th scope="col">Reason</th>
                <th scope="col">What it catches</th>
                {/* The column that keeps the list from silently shrinking the
                    funnel over years. */}
                <th scope="col">Expiry</th>
              </tr>
            </thead>
            <tbody>
              {BLOCKLIST_REASONS.map((reason) => {
                /* Undefined for a reason added upstream that this page has not
                   been taught about. */
                const copy = REASON_COPY[reason];
                return (
                  <tr key={reason}>
                    <th scope="row">
                      {copy === undefined ? reason : copy.label}
                      {/* The stored value, shown quietly, so a row in the
                          database can be matched to a row on this page without
                          a translation table. */}
                      <span className="identifier">{reason}</span>
                    </th>
                    <td>
                      {copy === undefined ? (
                        <span className="unknown">
                          Supported by the schema but not yet described here.
                        </span>
                      ) : (
                        copy.catches
                      )}
                    </td>
                    <td>
                      {copy === undefined ? (
                        <span className="unknown">&mdash;</span>
                      ) : (
                        copy.expiry
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* The matching rule, stated because it determines whether a block the
          operator sets actually works. */}
      <section className="settings-group">
        <h2 className="settings-group__title">How a block is matched</h2>
        <p className="settings-group__note">
          Blocks join on{' '}
          <span className="identifier">company_slug</span> - the lower-cased,
          punctuation-stripped name - and not on the display name. Matching the
          display name would let &quot;Acme Technologies&quot;, &quot;ACME
          Technologies.&quot; and &quot;acme technologies&quot; straight past a
          block you thought you had set.
        </p>
        <p className="settings-group__note">
          The same slug is what the per-company weekly cap on the Filters page
          counts against, so the two rules agree by construction rather than by
          both being maintained correctly.
        </p>
      </section>
    </div>
  );
}
