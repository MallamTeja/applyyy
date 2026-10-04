/* The confirmation screen: what changes if this profile becomes the new truth.
 *
 * WHERE THIS SITS. `masterIngest.ts` has already said the pasted profile is
 * well-formed. That is a different question from the one this screen asks, which
 * is: given what is ALREADY stored, what does accepting this actually do to the
 * node ids that older applications point at? The reconciler answers it,
 * `masterReview.ts` turns the answer into rows, and this file renders them and
 * owns the decision to store.
 *
 * WHY THE UI OWNS THE STORE CALL. `@applyy/master-ingest` is pure by charter -
 * no network, no database - and that is what lets Deno, Node and the browser
 * import it and what makes a wrong reconciliation reproducible from three
 * inputs. The insert lives in `masterStore.ts` and is invoked from here.
 *
 * THE CONSTRAINT THAT SHAPES THE WHOLE LAYOUT, quoted from `masterReview.ts`
 * because it is the only requirement that matters: "he will stop proof-reading
 * by the third re-upload. So a clean re-upload has to be a five-second glance
 * and a suspicious one has to be loud." Every decision below trades against that
 * sentence:
 *
 *   - Nothing that needs a decision is ever collapsed or counted. The settled
 *     and plainly-new lists ARE collapsed, and they are the only two that may
 *     be, because a normalised string was equal and there is nothing to check.
 *   - Accept is gated on EVERY risky row being acknowledged individually, not
 *     on a single "I have read the above" checkbox. `report.ts:285` requires
 *     this: one acknowledgement for the whole list is satisfiable without
 *     reading it, which is the confirmation-theatre outcome wearing a
 *     safeguard's costume.
 *   - The gate is NOT `needsHumanReview === false`. `report.ts:311` warns about
 *     exactly that mistake: gating on it would make a reworded bullet
 *     UNACCEPTABLE rather than reviewable, and leave Teja with no way forward.
 *
 * WHY RE-UPLOADING AN UNCHANGED RESUME IS A CONFIRMATION AND NEVER AN ERROR.
 * `UNIQUE (user_id, content_hash)` makes Postgres reject a byte-identical
 * re-upload with 23505. Teja re-exports from Overleaf whenever he adds a
 * project, so landing on something he has already stored is the ordinary case.
 * A red failure banner for it would teach him this screen cries wolf, and the
 * review list is the only real defence the design has - it cannot afford to
 * spend its credibility on a false alarm.
 *
 * AND WHY THE REPORT DECIDES "UNCHANGED" BEFORE 23505 DOES. The database can
 * only answer after a round trip, and only about byte-identity. The report knows
 * before anything is sent, and knows something more useful: whether any node
 * IDENTITY moved. Those are different questions - see `noNodeIdentityChanges` -
 * so 23505 is the backstop that catches what the report cannot see, not the
 * primary detector.
 */

import { useCallback, useMemo, useState } from 'react';
import type { ReactElement } from 'react';

import { reconcileMasterProfile } from '@applyy/master-ingest';
import type { ReconcileOutput } from '@applyy/master-ingest';

import type { MasterProfile, NodeId } from '../../data/contract';
import { buildMasterReview, noNodeIdentityChanges } from './masterReview';
import type { MasterReview, ReviewRow } from './masterReview';
import { storeMasterProfile } from './masterStore';
import type { StoreOutcome } from './masterStore';
import { extractPdf } from './pdfExtractor';
import { supabase } from '../../data/supabase';

/* Mint a node id. Injected into the reconciler to keep it pure and testable. */
function mintNodeId(): NodeId {
  return crypto.randomUUID();
}

/* --- One review row ---------------------------------------------------- */

/* Cause labels - pairs colour with a readable word for accessibility. */
const CAUSE_LABEL: Readonly<Record<ReviewRow['cause'], string>> = {
  ambiguous: 'Needs your decision',
  fuzzy_carry: 'Matched by similarity',
  dropped: 'No longer in your resume',
  uncertain_mint: 'Treated as new',
};

function ReviewRowItem({
  row,
  acknowledged,
  onToggle,
}: {
  readonly row: ReviewRow;
  readonly acknowledged: boolean;
  readonly onToggle: () => void;
}): ReactElement {
  return (
    <li className={'review-row review-row--' + row.cause}>
      {/* The checkbox leads because acknowledging is the action this row exists
          to collect. A label wrapping it makes the whole row's heading a click
          target, which matters when there are eleven of them. */}
      <label className="review-row__ack">
        <input
          type="checkbox"
          className="review-row__checkbox"
          checked={acknowledged}
          onChange={onToggle}
        />
        <span className="review-row__cause">{CAUSE_LABEL[row.cause]}</span>
      </label>

      {/* THE PARENT, AND IT IS THE MOST IMPORTANT THING ON THE ROW. The failure
          this whole package defends against is a TRUE bullet appearing under
          the WRONG employer, so "Cut p95 latency 40%" is not reviewable on its
          own - it is only reviewable beside "under Full Stack AI Engineer at
          Northwind Systems". Rendered ABOVE the text rather than after it,
          because a reader who stops early must have seen the parent. */}
      {row.parentLabel !== null && (
        <p className="review-row__parent">{row.parentLabel}</p>
      )}

      {/* What the node says now. Not truncated: a real bullet runs to 150-200
          characters and an abbreviation would cut every row mid-sentence,
          which defeats reading the pair. */}
      <p className="review-row__label">{row.label}</p>

      {/* The previous text, when there is one. Rendered as a PAIR directly
          under the incoming text, because a fuzzy carry is reviewed by reading
          the two side by side - the score alone is a number to nod at. */}
      {row.previousLabel !== null && (
        <p className="review-row__previous">
          {/* Labelled, because two unlabelled paragraphs do not say which is
              which - and getting that backwards inverts the review. */}
          <span className="review-row__previous-tag">Previously</span>
          {row.previousLabel}
        </p>
      )}

      <p className="review-row__detail">{row.detail}</p>

      {/* The score, next to the pair it describes rather than alone. Only shown
          when one was computed - an exact match has no score, and printing 1.0
          would make it indistinguishable from a fuzzy match that happened to
          score 1.0. */}
      {row.similarity !== null && (
        <p className="review-row__score">
          Similarity <span className="identifier">{row.similarity.toFixed(3)}</span>
          {/* Reflow gets said next to the number it explains away, because the
              number is what looks alarming. A diff a user has learned to
              distrust is worse than no diff at all. */}
          {row.reflowSuspected && ' - probably just line reflow.'}
        </p>
      )}
    </li>
  );
}

/* --- The collapsed halves ---------------------------------------------- */

/* The two lists that may be collapsed, and nothing else ever may.
 *
 * `report.ts:15` forbids count fields on the report itself, because "a count
 * field is an invitation to render the count and skip the list". That rule is
 * about rows needing a DECISION. These two need none - a normalised string was
 * equal, or the id is new for an unsurprising reason - so a count is the honest
 * summary here, and collapsing them is what keeps the risky rows loud. */
function Collapsed({ count, noun, why }: {
  readonly count: number;
  readonly noun: string;
  readonly why: string;
}): ReactElement | null {
  /* Nothing to say when there are none. Rendering "0 carried unchanged" adds a
     line of chrome to the five-second glance. */
  if (count === 0) return null;

  return (
    <p className="review-collapsed">
      <span className="review-collapsed__count">{count}</span> {noun}
      {/* The reason they are safe to skip, said once. Without it a reader has
          to take on trust that the collapsed half is not where the problem
          is. */}
      <span className="review-collapsed__why">{why}</span>
    </p>
  );
}

/* --- The outcome banner ------------------------------------------------ */

/* What the database said, in the interface's voice rather than Postgres's.
 *
 * The tone per branch is the entire point of this component. `identical` is a
 * CONFIRMATION and is styled as one; only `failed` is styled as a problem. */
function OutcomeNotice({ outcome }: { readonly outcome: StoreOutcome }): ReactElement {
  switch (outcome.kind) {
    case 'stored':
      return (
        <p className="store-notice store-notice--ok">
          Stored as version <span className="identifier">{outcome.version}</span>. Older
          applications still point at the versions they were built from.
        </p>
      );

    case 'identical':
      /* THE BRANCH THIS FILE EXISTS FOR. Postgres raised 23505; the operator is
         told nothing went wrong, because nothing did. The sentence says what is
         true - this is already stored - and what to do about it, which is
         nothing. */
      return (
        <p className="store-notice store-notice--ok">
          This is identical to what is already stored, so nothing was saved and nothing
          needed to be. Re-uploading an unedited export is expected.
        </p>
      );

    case 'version_race':
      /* Distinct from `identical` because the content DID change. Telling him
         "nothing to do" here would discard a real edit. */
      return (
        <p className="store-notice store-notice--warn">
          Another version was stored while you were reviewing, so this one was not saved.
          Nothing is lost - check it again against the newer version and accept.
        </p>
      );

    case 'not_authenticated':
      /* Not a bug and not data loss. The accepted profile is still in the page,
         so the sentence says so rather than implying the work is gone. */
      return (
        <p className="store-notice store-notice--warn">
          Not signed in, so the database refused the row. Your reviewed profile is still
          on this page - sign in and accept again.
        </p>
      );

    case 'failed':
      /* The raw message survives. An unclassified failure is exactly when a
         reader needs the database's own words rather than this file's
         interpretation of them. */
      return (
        <p className="store-notice store-notice--bad">
          Not stored. <span className="identifier">{outcome.message}</span>
        </p>
      );
  }
}

/* --- The screen -------------------------------------------------------- */

export function MasterUploadReview({
  previous,
  incoming,
}: {
  /* The stored profile, or null on a first upload. NULL RATHER THAN AN EMPTY
     PROFILE, matching `ReconcileInput`: it makes "first upload" a
     distinguishable state in the report instead of looking like a resume that
     lost every section. */
  readonly previous: MasterProfile | null;
  readonly incoming: MasterProfile;
}): ReactElement {
  /* Which rows the operator has ticked. A Set of row keys rather than a boolean
     per row in the row objects, so the reconciliation stays a pure derivation
     of its inputs and the acknowledgement state is the only mutable thing. */
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());
  /* Null until Accept has been pressed and answered. Distinct from a `failed`
     outcome, which is a completed attempt. */
  const [outcome, setOutcome] = useState<StoreOutcome | null>(null);
  /* In flight. Guards against a second insert from a double click, which would
     race itself into `version_race` against its own first attempt. */
  const [storing, setStoring] = useState(false);
  /* Client-side resume intake via extractPdf.
   * INVARIANT: Zero server upload of unapproved PDFs.
   * Parsing occurs strictly browser-side before feeding into masterStore.ts.
   */
  const [uploadedProfile, setUploadedProfile] = useState<MasterProfile | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);

  const effectiveIncoming = uploadedProfile ?? incoming;

  const handleFileUpload = useCallback(async (file: File) => {
    setExtracting(true);
    setExtractError(null);
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      // Browser-side parse: PDF bytes never leave the local environment
      const extracted = await extractPdf(bytes);
      // Extraction ONLY feeds the review below. It used to store here, before the
      // reconcile/acknowledge gate — and it stored the RAW extract, not the reconciled
      // profile, so an unreviewed version with fresh node ids became the newest master
      // (highest version wins in the Tailor). The single store path is `accept`.
      setUploadedProfile(extracted);
      // A new file is a new review: ticks given to the previous file's rows must not
      // carry over and pre-unlock Accept for rows the operator has not read.
      setAcknowledged(new Set());
      // Clear the last file's banner so its "Stored as version N" is not read as this file's.
      setOutcome(null);
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : 'Failed to extract resume PDF');
    } finally {
      setExtracting(false);
    }
  }, []);

  /* Reconcile once per input pair rather than on every keystroke of
     acknowledgement state. The reconciler is pure, so memoising it is safe -
     and it mints ids, so re-running it on every render would produce a DIFFERENT
     profile each time and the accepted one would not be the reviewed one. That
     is the real reason this is a `useMemo` and not a bare call. */
  const reconciled: ReconcileOutput = useMemo(
    () => reconcileMasterProfile({ previous, incoming: effectiveIncoming, mintId: mintNodeId }),
    [previous, effectiveIncoming],
  );

  const review: MasterReview = useMemo(
    () => buildMasterReview(reconciled.report),
    [reconciled],
  );

  /* THE GATE. Every risky row acknowledged individually.
     `every` over the rows rather than comparing sizes: a size comparison would
     pass if the operator ticked one row twice in a stale set, and would silently
     unlock if a row disappeared between renders. */
  const allAcknowledged = review.rows.every((row) => acknowledged.has(row.key));

  /* Whether anything about node identity moved. Drives the wording, NOT the
     decision to store - see `noNodeIdentityChanges` for why the two are
     different questions and why only the database can answer the second. */
  const quiet = noNodeIdentityChanges(review);

  const toggle = useCallback((key: string) => {
    setAcknowledged((current) => {
      /* A fresh Set rather than mutating: React compares by reference, and
         mutating in place would not re-render. */
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const accept = useCallback(async () => {
    /* The null-client case. `supabase` is null on an unconfigured machine -
       deliberately null rather than a stub that returns empty results, because
       "not connected" and "no rows" are the two readings this project works
       hardest to keep apart. */
    if (supabase === null) {
      setOutcome({
        kind: 'failed',
        message: 'This console is not connected to Supabase. See apps/web/.env.example.',
      });
      return;
    }

    setStoring(true);
    // try/finally: a thrown network error must not leave the button stuck on "Storing...".
    try {
      /* THE RECONCILED PROFILE, NOT THE INCOMING ONE. This is the single most
         important line in the file: `reconciled.profile` carries the ids that
         were carried forward, and `incoming` carries the throwaway ids the paste
         happened to have. Storing `incoming` would re-identify every node and
         silently break every pinned application, with nothing erroring anywhere -
         which is the entire failure the reconciler exists to prevent. */
      setOutcome(await storeMasterProfile(supabase, reconciled.profile));
    } catch (err) {
      // A throw is still an outcome; render it rather than leaking an unhandled rejection.
      setOutcome({ kind: 'failed', message: err instanceof Error ? err.message : String(err) });
    } finally {
      // Always release the in-flight guard, success or failure.
      setStoring(false);
    }
  }, [reconciled]);

  return (
    <section className="settings-group">
      <h2 className="settings-group__title">
        {/* The heading states the consequence, not the operation. "Review
            changes" describes what he is doing; this says what happens if he
            proceeds, which is the thing worth reading. */}
        {previous === null
          ? 'This will become your first stored profile'
          : 'What changes if you accept this'}
      </h2>

      {/* The orientation line, and it differs by how much there is to check -
          because the five-second glance and the careful read want different
          first sentences. */}
      <p className="settings-group__note">
        {previous === null
          ? 'There is nothing stored to compare against, so every node here gets a fresh id. Nothing below needs checking on a first upload.'
          : quiet
            ? 'Every node kept the id it already had. Nothing moved, nothing was added and nothing was dropped, so there is nothing here to check.'
            : 'Each item below changes which node an id points at, or stops one existing. Applications you have already sent still reference these ids, so tick each one once you have read it.'}
      </p>

      {/* Client-side resume PDF intake: strictly browser-side parsing */}
      <div className="ingest__actions" style={{ margin: 'var(--gap-3) 0 var(--gap-4) 0' }}>
        <label className="pdf-upload-label" style={{ display: 'inline-flex', flexDirection: 'column', gap: 'var(--gap-1)' }}>
          <span style={{ fontSize: 'var(--size-sm)', fontWeight: 600 }}>
            Upload resume PDF (extracted strictly browser-side):
          </span>
          <input
            type="file"
            accept=".pdf"
            className="pdf-upload-input"
            aria-label="Upload resume PDF"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void handleFileUpload(file);
              }
            }}
          />
        </label>
        {extracting && <p className="store-notice store-notice--ok">Extracting resume PDF browser-side...</p>}
        {extractError !== null && <p className="store-notice store-notice--bad">{extractError}</p>}
      </div>

      {/* The rows. Rendered before the collapsed summaries, because the things
          needing a decision must be what the eye lands on. */}
      {review.rows.length > 0 && (
        <ul className="review-list">
          {review.rows.map((row) => (
            <ReviewRowItem
              key={row.key}
              row={row}
              acknowledged={acknowledged.has(row.key)}
              onToggle={() => toggle(row.key)}
            />
          ))}
        </ul>
      )}

      {/* The two collapsible halves, after the rows and visually quieter. */}
      <div className="review-collapsed-group">
        <Collapsed
          count={review.settled.length}
          noun="carried forward unchanged"
          why="matched exactly, so there is nothing to compare."
        />
        <Collapsed
          count={review.plainlyNew.length}
          noun="new"
          why="nothing resembling them existed before."
        />
      </div>

      <div className="ingest__actions">
        <button
          type="button"
          className="ingest__button"
          /* Disabled until every risky row is ticked, and while an insert is in
             flight. Disabled rather than hidden so the button's presence tells
             the operator that acknowledging the rows is what unlocks it. */
          disabled={!allAcknowledged || storing}
          onClick={() => {
            /* `void` because onClick wants a sync handler and the promise is
               fully handled inside `accept` - every branch sets an outcome, so
               there is no rejection to leak. */
            void accept();
          }}
        >
          {storing ? 'Storing...' : 'Accept and store this profile'}
        </button>

        {/* Says what is still outstanding rather than just refusing. A disabled
            button with no explanation is the most common way a gate reads as a
            bug. */}
        {!allAcknowledged && (
          <span className="ingest__reassurance">
            {review.rows.filter((row) => !acknowledged.has(row.key)).length} item(s) still to
            read.
          </span>
        )}
      </div>

      {outcome !== null && <OutcomeNotice outcome={outcome} />}
    </section>
  );
}
