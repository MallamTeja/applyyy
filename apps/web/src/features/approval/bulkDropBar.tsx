/* The approvals page's bulk-drop bar (pending board parcel 8, 2026-11-21): "N selected", Clear,
 * and "Drop N selected" behind the shared inline confirm. Native dialogs are banned here (Teja,
 * 2026-11-04; apps/web/test/inlineConfirm.test.ts scans for them), so the confirm is InlineConfirm.
 * The bar never writes: Confirm hands the ids back to the page, which settles them one RPC per row. */

import type { ReactElement } from 'react';
// The shared inline confirm and its arming call.
import { InlineConfirm, armConfirm } from '../../app/InlineConfirm';
// The sentence and button subject for N rows.
import { bulkDropConfirm } from './bulkDrop';

// One bar per page, so one fixed id among the mounted InlineConfirm instances.
const BULK_DROP_CONFIRM_ID = 'approval-bulk-drop';

export function BulkDropBar(props: {
  // The ticked, on-screen rows, from bulkDropTargets: exactly what Confirm will send.
  readonly targets: readonly string[];
  // Untick everything.
  readonly onClear: () => void;
  // The write, run only by Confirm, with the ids the confirm sentence counted.
  readonly onDrop: (ids: readonly string[]) => void;
}): ReactElement | null {
  // Named once for the JSX below.
  const { targets, onClear, onDrop } = props;
  // Nothing ticked on screen: no bar at all, so there is nothing to click.
  if (targets.length === 0) return null;
  // A stable name for the captured list.
  const ids = targets;
  // The bar, inside the confirm that guards its drop button.
  return (
    /* KEYED on the ids: a tick or untick while the confirm is open remounts this, and InlineConfirm cancels its
       pending confirm on unmount, so Confirm can never send a list other than the one its sentence counted. */
    <InlineConfirm key={ids.join(' ')} id={BULK_DROP_CONFIRM_ID}>
      {/* A named group, so a screen reader says what the two buttons act on. Its layout lives in
          ApprovalQueuePage.css (.queue__bulk-bar), with the page's other row and toolbar rules. */}
      <div role="group" aria-label="Selected applications" className="queue__bulk-bar">
        {/* The count, in words, so the operator sees what the drop will touch before arming it. */}
        <p className="queue__bulk-count">{ids.length} selected</p>
        {/* Untick all; a plain action, nothing to confirm. */}
        <button type="button" className="button button--secondary button--small" onClick={onClear}>
          {/* Says what it does to the ticks, not to the rows: nothing is written. */}
          Clear selection
        </button>
        {/* The guarded drop: the click only arms; Confirm runs onDrop with the captured ids. */}
        <button
          // A button, never a form submit.
          type="button"
          // The danger ink the single Reject wears, so the two drop paths look alike.
          className="button button--secondary button--reject button--small"
          // Arms only; the trigger is where focus returns on Cancel or Escape.
          onClick={(event) => armConfirm(BULK_DROP_CONFIRM_ID, { ...bulkDropConfirm(ids.length), onConfirm: () => onDrop(ids), trigger: event.currentTarget })}
        >
          {/* The count again on the button, so the number is on the thing being clicked. */}
          Drop {ids.length} selected
        </button>
      </div>
    </InlineConfirm>
  );
}
