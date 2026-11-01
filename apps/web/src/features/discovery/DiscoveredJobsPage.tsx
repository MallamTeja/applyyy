/* Discovered Jobs Explorer — PROJECT_PLAN.md section 15.
 *
 * Allows the operator to directly inspect all raw discovered jobs captured by the
 * Scout engine across watched career pages and ATS feeds.
 *
 * Enforces:
 *   - Tech & Software Engineering roles only (auto-drops Sales, Marketing, HR, Finance)
 *   - Live Filter Cascade (Experience ceiling, Senior/Staff Title Blocklist, Location allowlist)
 *   - View Tabs: Matched Tech Jobs, All Discovered, and Filtered Out
 *   - Fast client-side search across title, company, locations, and descriptions
 *
 * THIS PAGE CREATES DISCOVERED ROWS; IT NEVER WRITES A STATUS ITSELF. The Scout modal
 * upserts jobs and applications at status `discovered`, and that is the page's whole
 * write surface. The one-click fast path that used to advance a row six statuses to the
 * approval queue was deleted on 2026-09-17 by Teja's ruling: it named six agents and
 * ran none of them, and the rows it produced were read downstream as audited and safe
 * to batch-approve. Status transitions belong to the pipeline agents.
 *
 * The one affordance that moves a row, the per-card "Send through pipeline", exists by
 * a NEW ruling (Teja, 2026-10-08 16:08). It is honest where the fast path was not: it
 * passes THIS row's id to the DEPLOYED normalizer, screener, matcher, tailor and auditor
 * (?application_id=, see features/pipeline/rowPipeline.ts), and each function advances
 * the row with its own agent key under RLS. The browser invokes and re-reads; it writes
 * no status. Any other affordance here still needs its own ruling.
 *
 * REJECT, by its own ruling (Teja, 2026-11-01: "i want a reject button on every card job we have in
 * the page"). The page's one status write: a human move, passed_filters -> dropped_filter as 'human',
 * through rejectJob.ts (one closed pair of moves, reject and its Undo, nothing else). One click, no
 * confirm, because the graph has the human edge back and the status line offers it as Undo. The card
 * leaves only once the database confirms; a refusal or a lost answer keeps it, with the reason on it.
 * The button shows only where canReject says both edges exist, so the Discovered lane has none.
 *
 * TWO LANES (2026-10-09). "Discovered" is the raw inventory above; "Ready to tailor" shows rows the
 * deployed screener already moved to `passed_filters`, so the operator can browse them, pick the
 * ones he wants, and send each through matcher -> tailor -> auditor. The lane -> {status, steps}
 * mapping, the sort, the paging and the "N loaded of M" counters live in discoveredList.ts, where
 * test/discoveredLanes.test.ts asserts them by value. Every count says how much is LOADED, because
 * search, filters, tabs and sort all run in the browser over the loaded pages only.
 */

// useReducer only as a re-render trigger: the per-row lock is a module Set React cannot observe.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { PageHeader } from '../../app/PageHeader';
import { SourceBadge } from '../../app/SourceBadge';
// apply_url is board-supplied: every href built from it goes through the http(s) gate.
import { safeHref } from '../../app/safeHref.ts';
import type { DiscoverySource } from '../../data/contract.ts';
import { supabase } from '../../data/supabase.ts';
import { DiscoveryModal } from '../pipeline/DiscoveryModal';
import { PipelineRunModal } from './PipelineRunModal';
// Internet job search via the scout-web Edge Function; inserts land in this page's inventory.
import { WebScoutPanel } from './WebScoutPanel';
// Paste one job link: it skips every filter and runs straight to the Approval queue (2026-10-31).
import { AddJobLinkPanel } from './AddJobLinkPanel.tsx';
import { getCompanyCooldownInfo } from '../settings/companyCatalog.ts';
import {
  evaluateJobMatch,
  getTechOnlyPreference,
  getFilterRulesReadError,
  isTechRole,
  loadFilterRules,
  setTechOnlyPreference,
} from '../settings/filtersStore.ts';
import type { FilterRuleConfig } from '../settings/filtersStore.ts';
// The drawer's per-row button, reused so both lanes share one lock, one step list and one set of sentences.
// isRowInFlight + withRowLock: Reject takes the SAME per-row lock, so a card never rejects and sends at once.
import { OutcomeNote, SendThroughPipeline, isRowInFlight, withRowLock } from '../pipeline/DrawerAppCard.tsx';
// The tested Reject/Undo pieces: which lanes may reject, the one write, and its sentences.
import { canReject, describeReject, moveRejectedJob } from './rejectJob.ts';
// Type only: the status a rejected card came from, kept so Undo can return it there.
import type { ApplicationStatus } from '../../data/contract.ts';
// Type only: one finished run's answer, kept here after the card unmounts on reload.
import type { SendResult } from '../pipeline/DrawerAppCard.tsx';
// The id shape check the engine also enforces; the step lists now come from the lane mapping.
import { isApplicationId } from '../pipeline/rowPipeline.ts';
// Type only: a step list, kept with each send result so its sentence names the lane it ran in.
import type { PipelineStep } from '../pipeline/rowPipeline.ts';
// The real invoke/read deps, or null on an unconfigured machine (the button then explains itself).
import { liveRowPipelineDeps } from '../pipeline/rowPipelineDeps.ts';
// The tested list logic: lanes, paging, sort, the date marker and the honest counter text.
import { DISCOVERED_LIST_SELECT, LANES, SORT_OPTIONS, appendUnique, emptyListMessage, hasMoreRows, OPENING_LANE, isCurrentLane, keysetFilter, laneCountsFrom, loadedOfText, pageLimit, postedDate, sortItems } from './discoveredList.ts';
// Every status's count in one RPC (application_status_counts), reused rather than a new per-lane query.
import { useApplicationCounts } from '../../data/useApplicationCounts.ts';
// Type only: the job row as the narrowed select delivers it, derived from DISCOVERED_JOB_COLUMNS.
import type { DiscoveredJob, DiscoveredListRow } from './discoveredList.ts';
// Types for the lane switch, the load modes and the sort select.
import type { Lane, LoadMode, SortKey } from './discoveredList.ts';

import './DiscoveredJobsPage.css';

/* The job's name for the send button's accessible name and the results strip. The page already
   treats company_name as optional (getCompanyCooldownInfo, the search filter), and a template string
   would print a missing one as "undefined — Engineer". Only the parts that are real, non-blank text;
   neither part -> a stated placeholder, never an empty name. */
function jobLabel(job: DiscoveredJob): string {
  // Each part kept only when it is a string with visible characters.
  const parts = [job.company_name, job.title].filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  // The joined name, or a placeholder that says the data was missing.
  return parts.length > 0 ? parts.join(' — ') : 'Untitled job';
}

interface DiscoveredItem {
  readonly applicationId?: string;
  // The application's created_at: the list's sort key, and Load more's keyset cursor.
  readonly createdAt: string;
  readonly job: DiscoveredJob;
}

interface EvaluatedDiscoveredItem extends DiscoveredItem {
  readonly passed: boolean;
  readonly isTech: boolean;
  readonly dropReason?: string | undefined;
}

export function DiscoveredJobsPage(): ReactElement {
  const [items, setItems] = useState<readonly DiscoveredItem[]>([]);
  const [filterRules, setFilterRules] = useState<readonly FilterRuleConfig[]>([]);
  const [techOnly, setTechOnly] = useState<boolean>(() => getTechOnlyPreference());
  const [enforceCascade, setEnforceCascade] = useState<boolean>(true);
  // The tab the operator picked; on the ready lane it is overridden to 'all' (see viewTab below).
  const [chosenTab, setViewTab] = useState<'matched' | 'all' | 'dropped'>('matched');
  // Which inventory is shown; always opens on Ready to tailor, where the screener leaves the work.
  const [lane, setLane] = useState<Lane>(OPENING_LANE);
  /* The lane on screen, readable by a loadData closure from an OLDER render. A Send's onSettled runs
     the loadData of the render it was clicked in; if the operator switched lanes meanwhile, that
     loadData must refuse (isCurrentLane) or it would load the old lane's rows under the new label.
     Set at click time in switchLane, before React re-renders, so no window exists. */
  const laneRef = useRef<Lane>(OPENING_LANE);
  /* The lane switch: the ref first (in-flight closures see it at once), then the state (re-render +
     reload). The ONLY place the lane changes: no effect moves the page, so it stays where it opened
     until Teja clicks another lane. */
  const switchLane = (key: Lane): void => {
    // Synchronous, so a settle landing before the re-render is already refused.
    laneRef.current = key;
    // Rebuilds loadData for the new lane, whose effect runs the full load.
    setLane(key);
  };
  // Every status's exact count in one existing RPC: where screened rows went, for the empty-lane sentence.
  const { state: countsState, counts: statusCounts } = useApplicationCounts();
  // Lane-shaped counts, or null until the read actually answers (the tested rule in discoveredList.ts).
  const laneCounts = useMemo(() => laneCountsFrom(countsState.kind, statusCounts), [countsState.kind, statusCounts]);
  // The lane's status and step list, from the one tested mapping.
  const laneSpec = LANES[lane];
  /* The Matched / Filtered Out split is this page's local preview of the screener. On the ready lane
     the DEPLOYED screener has already passed every row, so re-judging them locally could only show a
     second, weaker opinion as "Filtered Out". The ready lane therefore shows "All" only. */
  const viewTab = lane === 'ready' ? 'all' : chosenTab;
  // The client-side sort; 'newest' is the query's own order, so the default changes nothing.
  const [sortKey, setSortKey] = useState<SortKey>('newest');
  // True while a Load more page is in flight, so the button cannot fire twice for the same range.
  const [loadingMore, setLoadingMore] = useState<boolean>(false);

  const [loading, setLoading] = useState<boolean>(true);
  const [search, setSearch] = useState<string>('');
  const [selectedProvider, setSelectedProvider] = useState<string>('all');
  const [selectedArrangement, setSelectedArrangement] = useState<string>('all');
  const [selectedType, setSelectedType] = useState<string>('all');
  const [selectedCompany, setSelectedCompany] = useState<string>('all');
  const [activeJdModal, setActiveJdModal] = useState<DiscoveredJob | null>(null);
  const [discoveryModalMode, setDiscoveryModalMode] = useState<'remote' | 'watchlist' | null>(null);
  const [pipelineModalOpen, setPipelineModalOpen] = useState<boolean>(false);

  /* Why the last load failed, or null. A THIRD state beside "loading" and "rows":
     an outage must not render as an empty list or as somebody else's rows. */
  const [loadError, setLoadError] = useState<string | null>(null);
  /* The exact number of rows at the lane's status, from a count query. The list holds only the
     loaded pages, so its length undercounts; this is the honest total. */
  const [laneTotal, setLaneTotal] = useState<number | null>(null);
  /* Outcomes of "Send through pipeline", newest first. Held HERE, not on the card: a settled
     row has left its lane, so the reload removes its card and the card's own note with it.
     Without this, "Dropped by the screener" would flash and vanish. Each entry keeps the step list
     it ran with, so its sentence stays right after a lane switch. */
  const [sendResults, setSendResults] = useState<readonly { readonly applicationId: string; readonly label: string; readonly steps: readonly PipelineStep[]; readonly result: SendResult }[]>([]);
  /* Re-renders the page so every card re-reads isRowInFlight. The lock is a module-level Set (shared
     with the drawer), so React cannot see it change; the page bumps this when a lock is taken or freed. */
  const [, bumpLockView] = useReducer((n: number) => n + 1, 0);
  /* A failed Reject's sentence, per card. Per card, not one line: rejects run concurrently while the
     operator triages, and a second card's success must never overwrite the first card's failure. */
  const [rejectErrors, setRejectErrors] = useState<Readonly<Record<string, string | null>>>({});
  /* The status line: the latest Reject (with Undo) or Undo outcome. `undo` is what Undo needs to send
     the row back; null once undone. ponytail: one line, so an Undo landing after a newer Reject
     replaces that line and its Undo; a list like sendResults is the upgrade if that ever bites. */
  const [rejectNote, setRejectNote] = useState<{
    // The sentence from describeReject.
    readonly text: string;
    // The row, its lane status and the names the sentences use; null when there is nothing to undo.
    readonly undo: { readonly applicationId: string; readonly from: ApplicationStatus; readonly label: string; readonly laneLabel: string } | null;
  } | null>(null);
  /* The loaded rows, readable inside loadData without making items a dependency (which would
     rebuild loadData, and so rerun the load effect, on every page). Synced after each render. */
  const itemsRef = useRef<readonly DiscoveredItem[]>([]);
  // Keeps itemsRef current; Load more and the silent reload size their range from it.
  useEffect(() => {
    // The rendered rows are the ones the next range must continue from.
    itemsRef.current = items;
  }, [items]);

  /* Which loadData call is the latest. Loads overlap (a send settling while another reload is in
     flight) and can resolve out of order; a stale response applied last would re-show a row that has
     already advanced as `discovered`, with a live button. Only the newest call writes state. */
  const loadSeq = useRef(0);

  /* Load discovered jobs & filter rules. silent=true is the settle path after a per-card send: it
     skips the loading swap, which would replace the whole grid (scroll jumps to the top). It does not
     keep every card: a row another run has already moved past `discovered` leaves the list, and that
     card's step list with it. Its run, lock and onSettled still finish, and its outcome lands in the
     results strip, so only the per-step progress view is lost.
     mode 'more' is Load more: it fetches the next page and appends. It claims loadSeq like every
     other load, so a lane switch (which reruns a full load) makes a slow page stale before it lands. */
  const loadData = useCallback(async (mode: LoadMode = 'full') => {
    // A load built for a lane the operator has left (a Send settling after a switch) does nothing,
    // and returns BEFORE claiming a sequence, so it cannot supersede the current lane's load.
    if (!isCurrentLane(lane, laneRef.current)) return;
    // Claims "latest"; any older call still awaiting now applies nothing.
    const seq = ++loadSeq.current;
    // Re-checked after every await, since a newer call can start during any of them.
    const stale = (): boolean => seq !== loadSeq.current;
    // Rows to fetch: one page, or the whole loaded window on a silent reload, per the tested helper.
    const limit = pageLimit(mode, itemsRef.current.length);
    // The last loaded row in server order: Load more continues strictly after it.
    const last = itemsRef.current[itemsRef.current.length - 1];
    try {
      // Load more keeps the grid and only marks its own button busy.
      if (mode === 'more') setLoadingMore(true);
      // The visible reload only; a silent refresh or a Load more keeps the grid (and its cards) mounted.
      if (mode === 'full') {
        // Swaps the grid for the "Evaluating" message.
        setLoading(true);
        // A retry starts clean; a stale banner over fresh rows would be its own lie.
        setLoadError(null);
        // The old lane's total must not sit under the new lane's label, nor survive a failed read.
        setLaneTotal(null);
        // Same for the old lane's cards.
        setItems([]);
      }
      // The keyset cursor for Load more; null for every other mode (they start at the top).
      const cursor = mode === 'more' && last?.applicationId !== undefined ? keysetFilter({ createdAt: last.createdAt, id: last.applicationId }) : null;
      // Load more with no usable cursor would silently refetch page one as if it were page two.
      if (mode === 'more' && cursor === null) {
        // Said, not guessed; the loaded rows stay as they are.
        setLoadError('Could not continue: the last loaded row has no readable sort key. Reload the page.');
        return;
      }

      if (supabase === null) {
        // No backend: state it rather than render an empty explorer as "no jobs".
        setLoadError('Supabase is not configured, so no discovered jobs can be loaded.');
        return;
      }

      // The list read, built in two steps so Load more can add its cursor.
      let query = supabase
        .from('applications')
        // Only the job columns the page reads (DISCOVERED_JOB_COLUMNS); created_at is the keyset cursor.
        .select<string, DiscoveredListRow>(DISCOVERED_LIST_SELECT)
        // The selected lane's inventory, and only that.
        .eq('status', laneSpec.status);
      // Load more: only rows after the last loaded one, so rows that left the lane cannot shift a page.
      if (cursor !== null) query = query.or(cursor);
      // All three reads in parallel (2026-10-24): the rules were awaited alone first, adding a full
      // browser round trip (~250 ms measured) before the list even started, though the cascade only
      // needs them at render time, after the list arrives anyway.
      const [rules, listResult, countResult] = await Promise.all([
        // The filter cascade's rules; evaluated in the browser over the loaded rows.
        loadFilterRules(),
        query
          // Newest found first, so unloaded pages are the oldest.
          .order('created_at', { ascending: false })
          // Unique tie-break, ascending to match keysetFilter's id.gt: bulk inserts share created_at.
          .order('id', { ascending: true })
          // One page (or the loaded window); browser-side evaluation needs the rows, the page bounds payload.
          .limit(limit),
        supabase
          .from('applications')
          // head:true returns only the count, so the total costs no row payload.
          .select('id', { count: 'exact', head: true })
          // Same predicate as the list, so the two numbers describe the same set.
          .eq('status', laneSpec.status),
      ]);
      // The out-of-order case this guard exists for: drop a response a newer load superseded.
      if (stale()) return;
      // Stored only now, with the list, so a superseded load cannot install its rules over a newer one.
      setFilterRules(rules);
      // A failed rules read returns NO rules, so every job would read as "matched".
      // Say so instead of presenting an unfiltered list as a filtered one.
      const rulesError = getFilterRulesReadError();

      // A failed read is an error state. The old code fell back to EVERY jobs row
      // regardless of status (and on a second failure, returned silently), so an
      // outage rendered as a full, wrong list.
      if (listResult.error) {
        // The database's words, for diagnosis.
        setLoadError(`Could not load ${laneSpec.label} jobs: ${listResult.error.message}`);
        // Never show the previous load's rows under an error.
        setItems([]);
        return;
      }

      // Keep only rows whose job join resolved; a card needs a job to render.
      const mapped: DiscoveredItem[] = [];
      // An empty array is a real "nothing discovered", rendered as empty.
      for (const app of listResult.data ?? []) {
        // A missing job row cannot be rendered as a card.
        if (app.job) {
          mapped.push({
            // Real application id, so downstream actions address the real row.
            applicationId: app.id,
            // The row's own sort key, kept for the next page's cursor.
            createdAt: app.created_at,
            // The joined job row, typed as DISCOVERED_LIST_SELECT's columns by the select generic.
            job: app.job,
          });
        }
      }
      // Cleared here too, because a silent refresh did not clear it at the start.
      setLoadError(null);
      // Load more appends (appendUnique is a belt-and-braces check; the cursor already excludes loaded rows); every other mode replaces.
      setItems(mode === 'more' ? appendUnique(itemsRef.current, mapped) : mapped);
      // A failed count is not fatal to the list; fall back to "unknown" rather than the loaded length.
      setLaneTotal(countResult.error ? null : countResult.count);
      // Surface the rules failure after the list loaded, so the reason is visible beside the rows.
      if (rulesError !== null) {
        // States the consequence: the Matched/Filtered split is not trustworthy.
        setLoadError(`Filter rules failed to load (${rulesError}); the Matched / Filtered Out split below ignores your rules.`);
      }
    } catch (e) {
      // A superseded call's failure is not the page's state any more.
      if (stale()) return;
      // A thrown failure is the same error state as a returned one.
      setLoadError(e instanceof Error ? e.message : 'Failed to load discovered jobs.');
    } finally {
      // Only the latest call ends loading; a stale one finishing first must not hide the spinner
      // of the load that is still running.
      if (!stale()) setLoading(false);
      // Same rule for the Load more button: a superseding load ends it in its own finally.
      if (!stale()) setLoadingMore(false);
    }
  }, [lane]);

  // First visit and every lane switch: loadData is rebuilt per lane, so this reruns a full load.
  useEffect(() => {
    // Claims a new sequence, which also makes any in-flight Load more from the old lane stale.
    void loadData();
  }, [loadData]);

  // Whether this lane's cards get Reject: both the reject edge and Undo's way back must be human moves.
  const laneCanReject = canReject(laneSpec.status);

  /* One card's Reject: one click, no confirm (reversible; see rejectJob.ts). Runs under the card's row
     lock, so its Send is disabled meanwhile and a running Send refuses it. */
  const rejectCard = async (applicationId: string, label: string): Promise<void> => {
    // Narrowed once; the button is only rendered with a client, so null here is a forced call.
    const client = supabase;
    // Nothing to call without a client.
    if (client === null) return;
    // The lane NOW: Undo returns the row here, and its sentence names it.
    const from = laneSpec.status;
    // Same moment, so the sentence and the target cannot disagree.
    const laneLabel = laneSpec.label;
    // The same lock Send takes; released in its finally before the state writes below.
    const run = await withRowLock(applicationId, async () => {
      // Re-render with the lock held: this card's Reject and Send now read as in flight.
      bumpLockView();
      // A previous failure is not this attempt's.
      setRejectErrors((prev) => ({ ...prev, [applicationId]: null }));
      // The one write; never throws.
      return moveRejectedJob(client, { kind: 'reject', applicationId, from });
    });
    // A Send holds the row. Its button disables Reject, so only a click racing the re-render lands here.
    if (!run.started) {
      // Said on the card rather than ignored, and nothing was written.
      setRejectErrors((prev) => ({ ...prev, [applicationId]: 'This row is being sent through the pipeline; reject it once the run ends.' }));
      // Nothing was attempted, so nothing else to settle.
      return;
    }
    // Only a CONFIRMED move removes the card (section 6: never on an unconfirmed write).
    if (run.value.kind === 'moved') {
      // Gone at once, so triaging hundreds stays one click per card.
      setItems((prev) => prev.filter((item) => item.applicationId !== applicationId));
      // The latest reject owns the status line and its Undo.
      setRejectNote({ text: describeReject(run.value, 'reject', label, laneLabel), undo: { applicationId, from, label, laneLabel } });
      // The loaded window and the exact lane total re-read, the same settle a Send gets.
      void loadData('silent');
      // Done; the failure path below is for every other outcome.
      return;
    }
    // Refused or no answer: the card stays, with the database's reason on it.
    setRejectErrors((prev) => ({ ...prev, [applicationId]: describeReject(run.value, 'reject', label, laneLabel) }));
  };

  /* Undo for the status line's reject: dropped_filter back to the lane it came from, as 'human'. */
  const undoReject = async (): Promise<void> => {
    // What this render's line offers; a later line is a later render's closure.
    const target = rejectNote?.undo ?? null;
    // Narrowed once, as in rejectCard.
    const client = supabase;
    // Nothing to undo, or nothing to call.
    if (target === null || client === null) return;
    // The row's lock, so a double click cannot send two undos.
    const run = await withRowLock(target.applicationId, async () => {
      // Re-render so the Undo button disables while the call runs.
      bumpLockView();
      // The way back; moveRejectedJob refuses it locally if the lane has no human edge back.
      return moveRejectedJob(client, { kind: 'undo', applicationId: target.applicationId, from: target.from });
    });
    // A second click while the first runs: the first one's outcome will land.
    if (!run.started) return;
    // Done: the line says so and drops Undo. Not done: the reason, and Undo stays for a retry (safe).
    setRejectNote({ text: describeReject(run.value, 'undo', target.label, target.laneLabel), undo: run.value.kind === 'moved' ? null : target });
    // The card comes back on the re-read, along with the lane total.
    if (run.value.kind === 'moved') void loadData('silent');
  };

  const handleToggleTechOnly = () => {
    const next = !techOnly;
    setTechOnly(next);
    setTechOnlyPreference(next);
  };

  /* Evaluate each job against Tech constraint and Filter Cascade */
  const evaluatedItems: readonly EvaluatedDiscoveredItem[] = useMemo(() => {
    return items.map((item) => {
      const techCheck = isTechRole(item.job.title);
      const cascadeEval = evaluateJobMatch(item.job, filterRules, techOnly);

      // The ready lane skips the local preview: the deployed screener already passed these rows,
      // so no card there may carry a "Filtered" banner from a weaker, browser-side opinion.
      const passed = lane === 'ready'
        ? true
        : enforceCascade
          ? cascadeEval.passed
          : techOnly
            ? techCheck.isTech
            : true;

      const dropReason = !techCheck.isTech
        ? `Non-tech role (${techCheck.reason})`
        : cascadeEval.dropReason;

      return {
        ...item,
        passed,
        isTech: techCheck.isTech,
        dropReason,
      };
    });
  }, [items, filterRules, techOnly, enforceCascade, lane]);

  /* Unique companies for filter dropdown */
  const uniqueCompanies = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) {
      if (item.job.company_name) set.add(item.job.company_name);
    }
    return Array.from(set).sort();
  }, [items]);

  /* Summary counts */
  const matchedCount = useMemo(
    () => evaluatedItems.filter((i) => i.passed).length,
    [evaluatedItems],
  );
  const droppedCount = useMemo(
    () => evaluatedItems.filter((i) => !i.passed).length,
    [evaluatedItems],
  );

  /* Filtered list based on viewTab, search, and dropdown selections */
  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();

    return evaluatedItems.filter((item) => {
      const { job, passed } = item;

      // View Tab gating
      if (viewTab === 'matched' && !passed) return false;
      if (viewTab === 'dropped' && passed) return false;

      // Search match
      if (q.length > 0) {
        const titleMatch = job.title?.toLowerCase().includes(q) ?? false;
        const companyMatch = job.company_name?.toLowerCase().includes(q) ?? false;
        const descMatch = job.description_raw?.toLowerCase().includes(q) ?? false;
        const locMatch = (job.locations || []).some((l) => l.toLowerCase().includes(q));
        if (!titleMatch && !companyMatch && !descMatch && !locMatch) {
          return false;
        }
      }

      // Provider filter
      if (selectedProvider !== 'all' && job.ats_provider !== selectedProvider) {
        return false;
      }

      // Work arrangement filter
      if (selectedArrangement !== 'all' && job.work_arrangement !== selectedArrangement) {
        return false;
      }

      // Employment type filter
      if (selectedType !== 'all' && job.employment_type !== selectedType) {
        return false;
      }

      // Company filter
      if (selectedCompany !== 'all' && job.company_name !== selectedCompany) {
        return false;
      }

      return true;
    });
  }, [evaluatedItems, viewTab, search, selectedProvider, selectedArrangement, selectedType, selectedCompany]);

  // The visible order: the filtered rows sorted by the chosen key (a copy; 'newest' keeps server order).
  const sortedItems = useMemo(() => sortItems(filteredItems, sortKey), [filteredItems, sortKey]);
  // The honest suffix every counter carries: how many rows the browser holds, of how many exist.
  const loadedText = loadedOfText(items.length, laneTotal);

  return (
    <div className="page page--wide discovery">
      <PageHeader path="discovered" />

      {/* Lane switch: which inventory the list, the count and the card's Send work on. Plain
          toggle buttons with aria-pressed, because the view tabs below already own role="tablist". */}
      {/* role=group + a label: the two buttons are announced as one "Job lane" choice. */}
      <div className="discovery__lanes" role="group" aria-label="Job lane">
        {/* Built from LANES, so a new lane needs no edit here and its steps cannot be mis-paired. */}
        {(Object.keys(LANES) as Lane[]).map((key) => (
          <button
            /* One button per lane, keyed by the lane id. */
            key={key}
            /* Not a submit: the page has no form. */
            type="button"
            /* The tab look the page already has, so the switch needs no new visual language. */
            className={`discovery__tab-btn ${lane === key ? 'discovery__tab-btn--active' : ''}`}
            /* Tells assistive tech which lane is on. */
            aria-pressed={lane === key}
            /* Moves laneRef at once, then the state, whose rebuilt loadData reloads the new lane. */
            onClick={() => switchLane(key)}
          >
            {/* The lane's name from the shared mapping. */}
            {LANES[key].label}
          </button>
        ))}
      </div>

      {/* Filter Cascade & Tech Constraint Control Bar */}
      <section className="discovery__cascade-header" aria-label="Filter rules and constraint controls">
        <div className="discovery__view-tabs" role="tablist">
          {/* Matched / Filtered Out are the discovered lane's local screener preview; the ready lane
              shows All only (see viewTab). */}
          {lane === 'discovered' && (
            <button
              /* Not a submit: the page has no form. */
              type="button"
              /* Highlighted while it is the chosen view. */
              className={`discovery__tab-btn ${viewTab === 'matched' ? 'discovery__tab-btn--active' : ''}`}
              /* Client-side only: switching views re-filters the loaded rows, no new read. */
              onClick={() => setViewTab('matched')}
              /* Part of the tablist above, for assistive tech. */
              role="tab"
              /* Which tab is on, announced. */
              aria-selected={viewTab === 'matched'}
            >
              {/* The tab is inline-flex with a gap, so "(", <strong> and ")" as separate
                  children each got a 6px gap: "( 0 )". One span keeps the count a single
                  flex item; all three tabs use this exact shape so they match. The count is over
                  the LOADED rows only, and says so. */}
              🎯 Matched Tech Jobs <span>(<strong>{matchedCount}</strong> of {items.length} loaded)</span>
            </button>
          )}
          <button
            type="button"
            className={`discovery__tab-btn ${viewTab === 'all' ? 'discovery__tab-btn--active' : ''}`}
            onClick={() => setViewTab('all')}
            role="tab"
            aria-selected={viewTab === 'all'}
            /* The full counter on hover, since the tab shows only the exact total. */
            title={loadedText}
          >
            {/* The exact total from the count query; "?" when it failed, never the loaded length. */}
            📋 All {laneSpec.label} <span>(<strong>{laneTotal ?? '?'}</strong>)</span>
          </button>
          {/* Same lane rule as the Matched tab. */}
          {lane === 'discovered' && (
            <button
              /* Not a submit: the page has no form. */
              type="button"
              /* Its own active colour, so "dropped" never looks like the good-news tab. */
              className={`discovery__tab-btn ${viewTab === 'dropped' ? 'discovery__tab-btn--active-dropped' : ''}`}
              /* Client-side only, like the Matched tab. */
              onClick={() => setViewTab('dropped')}
              /* Part of the tablist above. */
              role="tab"
              /* Which tab is on, announced. */
              aria-selected={viewTab === 'dropped'}
              /* What "filtered out" means here: the page's local preview, not the screener's verdict. */
              title="Jobs dropped due to non-tech title, senior experience, or location mismatch"
            >
              {/* Same single-span count shape as the other two tabs, over the loaded rows. */}
              🚫 Filtered Out <span>(<strong>{droppedCount}</strong> of {items.length} loaded)</span>
            </button>
          )}
        </div>

        <div className="discovery__toggle-group">
          {/* The two preview toggles only change the Matched / Filtered split, which the ready lane
              does not show; a toggle that changes nothing would be a false control. */}
          {lane === 'discovered' && (<>
          <button
            type="button"
            className={`discovery__toggle-pill ${techOnly ? 'discovery__toggle-pill--active' : 'discovery__toggle-pill--inactive'}`}
            onClick={handleToggleTechOnly}
            title="When active, filters out Sales, Marketing, HR, Finance, Operations"
          >
            {techOnly ? '✓ Tech Only' : '✕ Tech Only (Off)'}
          </button>

          <button
            type="button"
            className={`discovery__toggle-pill ${enforceCascade ? 'discovery__toggle-pill--active' : 'discovery__toggle-pill--inactive'}`}
            onClick={() => setEnforceCascade(!enforceCascade)}
            title="Enforce Experience Ceiling, Title Blocklist (Senior/Staff), and Locations"
          >
            {enforceCascade ? '⚡ Cascade Active' : '✕ Cascade (Off)'}
          </button>
          </>)}

          <Link
            to="/filters"
            className="chip-btn"
            style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            title="Configure filter rules and thresholds"
          >
            ⚙️ Rules
          </Link>

          <button
            type="button"
            className="chip-btn"
            style={{ fontWeight: 600, /* --accent is always defined; a hex fallback would only mask a typo'd token. */ color: 'var(--accent)', borderColor: 'var(--accent)' }}
            onClick={() => setDiscoveryModalMode('watchlist')}
            title="Scan Greenhouse, Lever, and Ashby boards on your Company Watchlist"
          >
            ⚡ Scout Watchlist
          </button>

          <button
            type="button"
            className="chip-btn"
            style={{ fontWeight: 600, /* --accent is always defined; a hex fallback would only mask a typo'd token. */ color: 'var(--accent)', borderColor: 'var(--accent)' }}
            onClick={() => setDiscoveryModalMode('remote')}
            /* The feeds run daily on a schedule now; the button explains that rather than scanning. */
            title="Remote feeds are scouted automatically every day at 07:00 IST"
          >
            {/* "(daily)" so the label no longer promises a scan on click. */}
            🌐 Remote Feeds (daily)
          </button>

          <button
            type="button"
            className="chip-btn"
            style={{ fontWeight: 600, /* Success token themes via light-dark(); #10b981 was a single shade for both modes. */ color: 'var(--traced)', borderColor: 'var(--traced)' }}
            onClick={() => setPipelineModalOpen(true)}
            title="Run the deployed agent pipeline (Normalizer -> Screener -> Matcher -> Tailor -> Auditor) to tailor and queue jobs"
          >
            {/* Page-level on purpose: the modal runs every eligible row, not one job. */}
            ✨ Run pipeline (all eligible rows)…
          </button>
        </div>
      </section>

      {/* Above web search: a link the human already chose outranks anything the scouts propose.
          Same mount rule as the panel below: nothing to call without a client. */}
      {supabase !== null && (
        <AddJobLinkPanel
          // The real functions client.
          client={supabase}
          // The same deps the Discovered cards run agents with.
          pipelineDeps={liveRowPipelineDeps}
          // Reload so the added (or revived) row shows in the lists.
          onAdded={() => {
            // Same reload the scout panels use.
            void loadData();
          }}
        />
      )}

      {/* Beside the header's scout/run buttons because it is another discovery source.
          Only mounted with a real client: the panel cannot do anything without one.
          onInserted reloads so newly scouted rows appear without a manual refresh. */}
      {supabase !== null && (
        <WebScoutPanel
          client={supabase}
          onInserted={() => {
            // Same reload the scout modals use, so counts and list stay in step.
            void loadData();
          }}
        />
      )}

      {/* Search and Metadata Filters Bar */}
      <section className="discovery__controls" aria-label="Job search and filters">
        <div className="discovery__search-row">
          <input
            /* type=search: the browser's clear button and Escape-to-clear for free. */
            type="search"
            /* The page's existing search look. */
            className="discovery__search-input"
            /* A placeholder is not a label; screen readers need this. */
            aria-label="Search loaded jobs"
            /* Says "loaded": the search runs in the browser over the loaded pages, not the database. */
            placeholder="Search the loaded jobs by title, company, skills, or location..."
            /* Controlled, so a lane switch can keep or clear it deliberately. */
            value={search}
            /* Filters the loaded rows on every keystroke; no network call, so no debounce is needed. */
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="discovery__filters">
          {/* Provider Filter */}
          <select
            className="discovery__filter-select"
            value={selectedProvider}
            onChange={(e) => setSelectedProvider(e.target.value)}
            aria-label="Filter by ATS Provider"
          >
            <option value="all">All ATS Providers</option>
            <option value="greenhouse">Greenhouse</option>
            <option value="lever">Lever</option>
            <option value="ashby">Ashby</option>
            <option value="workable">Workable</option>
            <option value="smartrecruiters">SmartRecruiters</option>
          </select>

          {/* Work Arrangement Filter */}
          <select
            className="discovery__filter-select"
            value={selectedArrangement}
            onChange={(e) => setSelectedArrangement(e.target.value)}
            aria-label="Filter by Work Arrangement"
          >
            <option value="all">All Work Arrangements</option>
            <option value="remote">Remote</option>
            <option value="hybrid">Hybrid</option>
            <option value="onsite">Onsite</option>
          </select>

          {/* Employment Type Filter */}
          <select
            className="discovery__filter-select"
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value)}
            aria-label="Filter by Employment Type"
          >
            <option value="all">All Employment Types</option>
            <option value="full_time">Full-time (FTE)</option>
            <option value="internship">Internship</option>
            <option value="contract">Contract</option>
            <option value="part_time">Part-time</option>
          </select>

          {/* Company Filter */}
          <select
            className="discovery__filter-select"
            value={selectedCompany}
            onChange={(e) => setSelectedCompany(e.target.value)}
            aria-label="Filter by Company"
          >
            <option value="all">All Companies ({uniqueCompanies.length})</option>
            {uniqueCompanies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          {/* Sort select. Client-side over the loaded rows (PostgREST cannot order by a joined
              column without a view), and the label beside it says exactly that. */}
          <select
            /* Same look as the filter selects beside it. */
            className="discovery__filter-select"
            /* The chosen key; 'newest' is the query's own order. */
            value={sortKey}
            /* The option values are exactly the SortKey union, from SORT_OPTIONS. */
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            /* A select needs a name for screen readers. */
            aria-label="Sort jobs"
          >
            {SORT_OPTIONS.map((o) => (
              /* One option per tested sort key. */
              <option key={o.key} value={o.key}>
                {/* The option's visible label. */}
                {o.label}
              </option>
            ))}
          </select>
          {/* The sort's scope, stated: it reorders only what is loaded. */}
          <span className="discovery__sort-scope">Sorts the {loadedOfText(items.length, laneTotal)} rows</span>

          <span className="discovery__meta-count">
            {/* Counter is hidden on a failed load: "Showing 0" would assert zero jobs during an outage.
                Every branch ends with the loaded-of-total text, so no count reads as complete. */}
            {loadError === null && (viewTab === 'matched' ? (
              /* Matched: the local preview's pass count, then how much of the lane is loaded. */
              <span>
                Showing <strong>{filteredItems.length}</strong> clean tech jobs ({droppedCount} dropped by filters) · {loadedText}
              </span>
            ) : viewTab === 'dropped' ? (
              <span style={{ /* Danger token lightens in dark mode; #dc2626 was dim on a near-black ground. */ color: 'var(--fabricated)' }}>
                Showing <strong>{filteredItems.length}</strong> dropped/irrelevant jobs · {loadedText}
              </span>
            ) : (
              /* All: just what is shown, then the loaded-of-total text. */
              <span>
                Showing <strong>{filteredItems.length}</strong> · {loadedText}
              </span>
            ))}
          </span>
        </div>
      </section>

      {/* Error banner: loud, and above the grid, because an empty grid beneath it is not "no jobs". */}
      {loadError !== null && (
        <p className="discovery__error" role="alert">
          {loadError}
        </p>
      )}

      {/* Results of per-card sends. Polite live region, so an outcome is announced without
          interrupting. A plain div, not a named section: it is not a landmark, so an empty one adds
          nothing to landmark navigation. Kept mounted even when empty because a live region that
          mounts WITH its first content is often not announced; while empty, the CSS takes it out of the
          page's flex flow (.discovery__send-results:empty), so it adds no gap. */}
      <div className="discovery__send-results" aria-live="polite">
        {sendResults.map(({ applicationId, label, steps, result }) => (
          /* One row per send: which job, then the agents' own verdict (and the queue link when ready). */
          <div key={applicationId} className="discovery__send-result">
            {/* The card is gone after the reload, so the job is named here. */}
            <strong>{label}</strong>
            {/* The shared sentence, worded for the start status of the lane the send ran in. */}
            <OutcomeNote outcome={result.outcome} httpStatus={result.httpStatus} errorText={result.errorText} steps={steps} />
          </div>
        ))}
        {/* Clearing is local only; the rows themselves are wherever the agents put them. */}
        {sendResults.length > 0 && (
          <button
            /* Not a submit: the page has no form around it. */
            type="button"
            /* The page's existing small-button look. */
            className="chip-btn"
            /* Empties the strip; nothing is written anywhere. */
            onClick={() => setSendResults([])}
          >
            {/* The button's accessible name. */}
            Clear results
          </button>
        )}
      </div>

      {/* The Reject status line: the latest reject and its Undo, or the Undo's outcome. Polite and
          always mounted for the same reason as the strip above (a region that mounts WITH its first
          content is often not announced); empty, the CSS takes it out of the flex flow. */}
      <div className="discovery__reject-status" aria-live="polite">
        {/* Nothing until the first reject. */}
        {rejectNote !== null && (
          <>
            {/* "Rejected Acme — Engineer." or the Undo's sentence. */}
            <span>{rejectNote.text}</span>
            {/* Only while there is a confirmed reject to take back. */}
            {rejectNote.undo !== null && (
              <button
                /* Not a submit: the page has no form. */
                type="button"
                /* The strip's existing small-button look, as Clear results uses. */
                className="chip-btn"
                /* Disabled while this row's undo runs, so a double click cannot send two. */
                disabled={isRowInFlight(rejectNote.undo.applicationId)}
                /* The promise is handled inside undoReject; nothing here awaits it. */
                onClick={() => void undoReject()}
                /* Starts with the visible text (label-in-name), then names the job it restores. */
                aria-label={`Undo: ${rejectNote.undo.label}`}
              >
                {/* The visible name. */}
                Undo
              </button>
            )}
          </>
        )}
      </div>

      {/* Grid of Job Cards */}
      {loading ? (
        <div className="discovery__empty">
          <p>Evaluating discovered jobs against Tech constraints and Filter Cascade...</p>
        </div>
      ) : loadError !== null ? /* After a failed load the banner above is the whole answer; "no jobs match" would be a false claim. */ null : filteredItems.length === 0 ? (
        <div className="discovery__empty">
          {/* Chosen from the exact lane count, so an empty lane is never blamed on the filters. */}
          <p>{emptyListMessage(lane, viewTab, laneTotal, laneCounts)}</p>
          {/* An empty discovered lane means the rows moved on; one click takes the operator to them. */}
          {lane === 'discovered' && laneTotal === 0 && (
            <button
              /* Not a submit: the page has no form. */
              type="button"
              /* The page's existing small-button look. */
              className="chip-btn"
              /* The same lane switch the buttons above use, so the reload and the ref stay in step. */
              onClick={() => switchLane('ready')}
            >
              {/* Named from the shared mapping, so a renamed lane cannot leave a stale label here. */}
              Open {LANES.ready.label}
            </button>
          )}
        </div>
      ) : (
        <div className="discovery__grid">
          {/* The sorted copy; filtering decided WHICH rows, the sort decides their order. */}
          {sortedItems.map(({ applicationId, job, passed, dropReason }) => (
            <article key={job.id} className={`job-card ${!passed ? 'job-card--dropped' : ''}`}>
              {/* If dropped, display clear reason banner */}
              {!passed && dropReason && (
                <div className="job-card__drop-banner" title={dropReason}>
                  <span aria-hidden="true">🚫</span>
                  <div>
                    <strong>Filtered:</strong> {dropReason}
                  </div>
                </div>
              )}

              <div className="job-card__header">
                <div className="job-card__top-bar">
                  <span className="job-card__company">{job.company_name}</span>
                  <SourceBadge
                    discoveredVia={job.discovered_via as readonly DiscoverySource[]}
                    sourceRefs={job.source_refs}
                  />
                </div>
                <h3 className="job-card__title" title={job.title}>
                  {job.title}
                </h3>
              </div>

              {/* Metadata Pills */}
              <div className="job-card__pills">
                {job.employment_type && job.employment_type !== 'unknown' && (
                  <span className="job-pill">
                    {job.employment_type.replace('_', ' ')}
                  </span>
                )}
                {job.work_arrangement && job.work_arrangement !== 'unknown' && (
                  <span className="job-pill">
                    {job.work_arrangement}
                  </span>
                )}
                {/* Posted date, with "≈" and a tooltip when the board gave no real publish date. */}
                {(() => {
                  // Text, tooltip and estimate flag from the tested helper.
                  const posted = postedDate(job);
                  // The approximate modifier sets it in italic, so an estimate never reads like a fact.
                  return (
                    <span className={`job-pill${posted.approximate ? ' job-pill--approx' : ''}`} title={posted.title}>
                      {/* "Posted 2026-10-01" or "Posted ≈ 2026-10-01". */}
                      {posted.text}
                    </span>
                  );
                })()}
                {job.location_raw && (
                  <span className="job-pill" title={job.location_raw}>
                    📍 {job.location_raw.length > 28 ? `${job.location_raw.slice(0, 26)}…` : job.location_raw}
                  </span>
                )}
                {((job.salary_min !== null && job.salary_min !== undefined) ||
                  (job.salary_max !== null && job.salary_max !== undefined)) && (
                  <span className="job-pill job-pill--salary">
                    💰 {job.salary_currency ?? 'INR'}{' '}
                    {job.salary_min ? Number(job.salary_min).toLocaleString() : '0'}
                    {job.salary_max ? ` – ${Number(job.salary_max).toLocaleString()}` : '+'}
                  </span>
                )}
                {(() => {
                  const cooldown = getCompanyCooldownInfo(job.company_name);
                  if (!cooldown) return null;
                  return (
                    <span
                      className="job-pill job-pill--cooldown"
                      title={`Cool-off period for ${job.company_name}:\n• Interview Cooldown: ${cooldown.interview}\n• Screening Cooldown: ${cooldown.screening}${cooldown.notes ? `\n• Notes: ${cooldown.notes}` : ''}`}
                    >
                      {/* Name the dimension in full: this pill carries only the interview
                          cool-off, and the old "int." abbreviation made readers decode it */}
                      {/* toLowerCase folds the catalog's "6 Months" into the sentence so the
                          pill reads as one phrase, not two capitalised fragments */}
                      ⏳ Interview cooldown: {cooldown.interview.toLowerCase()}
                    </span>
                  );
                })()}
              </div>

              {/* Job Description Excerpt */}
              {job.description_raw && (
                <div
                  className="job-card__description"
                  onClick={() => setActiveJdModal(job)}
                  title="Click to view full job description"
                >
                  {job.description_raw.replace(/<[^>]*>?/gm, ' ').slice(0, 220)}...
                </div>
              )}

              {/* Card Footer Actions. The onClick only OBSERVES: a Send click takes the row lock inside the
                  button's own handler, then bubbles here, and the re-render disables this card's Reject.
                  SendThroughPipeline exposes no start callback, so the bubble is the hook. */}
              <div className="job-card__footer" onClick={() => bumpLockView()}>
                <a
                  href={safeHref(job.apply_url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="job-card__link"
                  title="Open original job posting on career page"
                >
                  <span>Apply Link ↗</span>
                </a>

                {/* Reject (Teja's ruling, 2026-11-01): one click, passed_filters -> dropped_filter as
                    'human', undoable from the status line. Only where canReject says the lane has both
                    human edges, only with a client, and only for a real-shaped id the RPC can address. */}
                {laneCanReject && supabase !== null && isApplicationId(applicationId) && (
                  <button
                    /* Not a submit: the page has no form. */
                    type="button"
                    /* The app's outlined "destructive but recoverable" look; job-card__reject places it. */
                    className="button button--reject button--small job-card__reject"
                    /* Off while this row's Send or Reject holds the shared lock. */
                    disabled={isRowInFlight(applicationId)}
                    /* The promise is handled inside rejectCard; nothing here awaits it. */
                    onClick={() => void rejectCard(applicationId, jobLabel(job))}
                    /* Starts with the visible text (label-in-name), then names the job, as Send does. */
                    aria-label={`Reject: ${jobLabel(job)}`}
                  >
                    {/* The visible name. */}
                    Reject
                  </button>
                )}

                {/* Per-card "Send through pipeline" (Teja's ruling, 2026-10-08 16:08). A button
                    on a card claims to act on that card, and this one does: it passes THIS
                    row's applicationId to the deployed agents. The "Tailor & Queue" button that
                    once sat here opened the generic PipelineRunModal, which takes no job id, so
                    it ran every eligible row; the header's "Run pipeline" keeps that batch job.
                    (Before that, this slot held the deleted fast path that forged six agent
                    transitions; see the file header.) This page still writes no status: each
                    function advances the row with its own agent key under RLS.
                    Shown on EVERY tab, Filtered Out included: those rows are still
                    `discovered`, and the Matched / Filtered Out split is this page's local
                    preview, not the screener. The deployed screener is the authority, and the
                    outcome note says "Dropped by the screener" when it disagrees with the
                    preview. Only a real-shaped id gets a button: a row without one cannot be
                    addressed, and the engine would refuse it anyway. */}
                {isApplicationId(applicationId) && (
                  <SendThroughPipeline
                    /* The row the agents act on; also the per-row lock key. */
                    applicationId={applicationId}
                    /* Null on an unconfigured machine: the button disables with a reason. */
                    deps={liveRowPipelineDeps}
                    /* The lane's agents: all five for a discovered row (dedupe and screening first),
                       matcher -> tailor -> auditor for a ready row the screener already passed. */
                    steps={laneSpec.steps}
                    /* The row has usually left `discovered`, so reload; keep the outcome above
                       the grid because the reload unmounts this card. */
                    /* Names the job, so twenty buttons do not share one accessible name. */
                    label={jobLabel(job)}
                    onSettled={(result) => {
                      // null: a refused click (another run holds the row, and ITS settle reloads),
                      // or a throw the engine and deps are written never to make, which the card
                      // reports itself. No result to keep, and no reload owed by this click.
                      if (result === null) {
                        // A throw still released the lock; re-render so this card's Reject re-enables.
                        bumpLockView();
                        // Nothing else to do for a null settle.
                        return;
                      }
                      // Newest first, one entry per row, so a re-send replaces its old line.
                      // The lane's steps travel with the result, so its sentence survives a lane switch.
                      setSendResults((prev) => [{ applicationId, label: jobLabel(job), steps: laneSpec.steps, result }, ...prev.filter((r) => r.applicationId !== applicationId)]);
                      // Silent: the row leaves the grid without the loading swap; the loaded pages are re-read.
                      void loadData('silent');
                    }}
                  />
                )}
              </div>
              {/* A Reject that did not land: the card stayed, and this says why. role=alert because a
                  failed write is the one thing here the operator must not miss. */}
              {applicationId !== undefined && rejectErrors[applicationId] && (
                <p className="job-card__reject-error" role="alert">
                  {/* describeReject's sentence, with the database's code and words. */}
                  {rejectErrors[applicationId]}
                </p>
              )}
            </article>
          ))}
        </div>
      )}

      {/* Load more: the next page of this lane, appended. Hidden once every row is loaded, during a
          full load, and after a failed one (an error state offers no "more" of anything). */}
      {!loading && loadError === null && hasMoreRows(items.length, laneTotal) && (
        <div className="discovery__load-more">
          <button
            /* Not a submit: the page has no form. */
            type="button"
            /* The page's existing small-button look. */
            className="chip-btn"
            /* One page at a time; a second click during the fetch would ask for the same range. */
            disabled={loadingMore}
            /* Goes through loadData so the sequence guard drops it if the lane changes meanwhile. */
            onClick={() => void loadData('more')}
          >
            {/* States what is loaded, so the operator knows how far the list goes. */}
            {loadingMore ? 'Loading…' : `Load more (${loadedText})`}
          </button>
        </div>
      )}

      {/* Full Job Description Modal */}
      {activeJdModal && (
        <div
          className="jd-modal-backdrop"
          onClick={() => setActiveJdModal(null)}
          role="dialog"
          aria-modal="true"
        >
          <div className="jd-modal" onClick={(e) => e.stopPropagation()}>
            <header className="jd-modal__header">
              <div>
                <span className="job-card__company">{activeJdModal.company_name}</span>
                <h2 className="job-card__title">{activeJdModal.title}</h2>
              </div>
              <button
                type="button"
                className="button button--ghost"
                onClick={() => setActiveJdModal(null)}
              >
                ✕ Close
              </button>
            </header>

            <div className="jd-modal__body">
              {activeJdModal.description_raw ? (
                <div>{activeJdModal.description_raw}</div>
              ) : (
                <p>No description text provided for this posting.</p>
              )}
            </div>

            <footer className="jd-modal__footer">
              <a
                href={safeHref(activeJdModal.apply_url)}
                target="_blank"
                rel="noopener noreferrer"
                className="button button--secondary"
              >
                Open Career Page ↗
              </a>
              <button
                type="button"
                className="button button--primary"
                onClick={() => setActiveJdModal(null)}
              >
                Done
              </button>
            </footer>
          </div>
        </div>
      )}
      {discoveryModalMode !== null && (
        <DiscoveryModal
          mode={discoveryModalMode}
          onClose={() => setDiscoveryModalMode(null)}
          onRefresh={() => {
            void loadData();
          }}
        />
      )}
      {pipelineModalOpen && (
        <PipelineRunModal
          onClose={() => setPipelineModalOpen(false)}
          onRefresh={() => {
            void loadData();
          }}
        />
      )}
    </div>
  );
}
