/* The Discovered Jobs page must not advance an application's status.
 *
 * WHY THIS IS A SOURCE-LEVEL TEST AND NOT A RENDER TEST. apps/web has no component
 * render harness, and adding one means a dependency, which means a package.json edit
 * and a lockfile rewrite in a tree four sessions share. The thing worth guarding here
 * is not how the page LOOKS — it is that one specific call is absent from it, and a
 * source assertion guards that exactly, with no new dependency and no runtime.
 *
 * WHAT WAS REMOVED, so a future reader knows what these assertions are defending.
 * The "Tailor & Queue" button walked six status transitions naming six agents and
 * executed NONE of them. Two of those agents — the Normalizer and the Auditor — do not
 * exist as code anywhere in the repo. The button therefore stamped rows `audit_clean`,
 * a verdict attributed to an agent that was never written, and then navigated the
 * operator straight to the batch-approve screen.
 *
 * The consequence reached production: with no Tailor having run, `tailored_profile` was
 * null, so the approval page compared a resume built FROM the master profile AGAINST
 * the master profile, found no discrepancy, and reported "Bucket A — safe to
 * batch-approve". THE CLEAN VERDICT WAS MANUFACTURED BY THE ABSENCE OF THE ARTIFACT IT
 * CLAIMED TO HAVE CHECKED. Teja ruled on 2026-09-17 to delete the affordance rather
 * than disable it or make it honest.
 *
 * These tests fail if anyone restores it, including "temporarily".
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it, before } from 'node:test';
import { fileURLToPath } from 'node:url';

// Resolved from this file rather than from process.cwd(), so the suite passes whether
// it is run from apps/web or from the repo root.
const PAGE_PATH = fileURLToPath(new URL('../src/features/discovery/DiscoveredJobsPage.tsx', import.meta.url));

// Read once in a before hook; every assertion below reads the same snapshot, so a
// failure cannot be blamed on the file changing between cases.
let source = '';
before(async () => {
  source = await readFile(PAGE_PATH, 'utf8');
});

/* EVERY ASSERTION BELOW MATCHES CODE, NOT PROSE — quoted string literals, a call with
 * its opening paren, a className. The first draft matched the bare word `audit_clean`
 * and went red against the page's own comment EXPLAINING why the fast path was removed.
 * That is the wrong trade: the comment is the most valuable thing left at that site, and
 * a guard that forbids describing the bug it guards against will be deleted by the first
 * person it inconveniences. Match the shape that would actually reintroduce the defect.
 */
describe('DiscoveredJobsPage performs no status mutation', () => {
  it('never calls the advance_application_status RPC', async () => {
    // The page's only direct database mutation was this RPC. Its absence is the whole
    // ruling in one assertion: the page may CREATE discovered rows, never advance them.
    assert.equal(
      source.includes("rpc('advance_application_status'"),
      false,
      'DiscoveredJobsPage must not advance application status; the pipeline agents do that',
    );
  });

  it('never stamps the audit_clean status', async () => {
    // Asserted as a quoted literal because that is the only form that can reach the
    // database. This is the specific forgery: audit_clean is the Auditor's verdict, and
    // no Auditor exists anywhere in the repo to produce it.
    assert.equal(
      source.includes("'audit_clean'"),
      false,
      'audit_clean is the Auditor verdict; no Auditor exists, so nothing here may stamp it',
    );
  });

  it('does not route the operator to the approval queue', async () => {
    // Not incidental — this call delivered the operator to the one-click batch-approve
    // lane holding the rows the button had just mislabelled.
    assert.equal(
      source.includes("navigate('/approvals')"),
      false,
      'the page must not push the operator onto the batch-approve screen',
    );
  });

  it('leaves behind no disabled or commented-out fast path', async () => {
    // A greyed-out button, a TODO or a commented-out handler all still assert that the
    // capability exists and is merely unavailable. The ruling was that the UI stop
    // claiming it at all, so the tombstones are checked for too. These three identifiers
    // appear nowhere in prose, so matching them bare is safe.
    assert.equal(source.includes('handleFastTailor'), false, 'the fast-path handler must be gone, not commented out');
    assert.equal(source.includes('tailoringId'), false, 'the fast-path button state must be gone with the button');
    assert.equal(
      source.includes('job-card__tailor-btn'),
      false,
      'the button class must not survive; its CSS rules were deleted with it',
    );
  });
});

describe('what the page must still do', () => {
  it('still creates discovered rows through the Scout modal', async () => {
    // The acceptance criterion for the excision being SURGICAL. The page's job is to
    // discover jobs; only the fraudulent advance was removed. If this goes red, the
    // deletion took the page's actual purpose with it.
    assert.ok(source.includes('DiscoveryModal'), 'the Scout discovery modal must survive the deletion');
  });

  it('still honours the tech-only preference', async () => {
    // The other live feature sharing this file, and the one most likely to be collateral
    // damage in a careless cut.
    assert.ok(source.includes('setTechOnlyPreference'), 'the tech-only toggle must survive the deletion');
  });

  it('allows the operator to trigger the deployed pipeline modal', async () => {
    // Discovered rows trigger the real deployed agent pipeline modal (PipelineRunModal)
    // rather than performing local status mutation.
    assert.ok(
      source.includes('PipelineRunModal') && source.includes('setPipelineModalOpen'),
      'the card footer triggers the deployed agent pipeline modal to process discovered jobs',
    );
  });

  // Teja's ruling 2026-10-08 16:08: each card sends ITS row through the deployed agents. The
  // positive shape is asserted, so the button cannot quietly fall back to the drawer's 3-step list.
  it("renders the per-card SendThroughPipeline over the selected lane's chain", async () => {
    // Scoped to the ONE element: from its opening tag up to the first `/>` that closes it, with no
    // other `<` in between, so a steps={DISCOVERED_STEPS} elsewhere in the file cannot satisfy it.
    // (`[^>]*` would stop at the `=>` of the onSettled arrow, hence the `<`-free span instead.)
    const element = source.match(/<SendThroughPipeline\b[^<]*?\/>/)?.[0] ?? '';
    // The shared component takes the lane's own list; discoveredLanes.test.ts pins that the discovered
    // lane maps to DISCOVERED_STEPS and the ready lane to PASSED_FILTERS_STEPS.
    assert.match(element, /\bsteps=\{laneSpec\.steps\}/, "the card must send its row through the selected lane's steps");
    // laneSpec must be the LANES entry for the selected lane, not a local stand-in.
    assert.ok(source.includes('const laneSpec = LANES[lane];'), 'laneSpec must come from the shared LANES mapping');
  });

  it('never writes to applications directly', async () => {
    // Every write call in the page, as code: `.update(` / `.insert(` / `.upsert(` with an open paren.
    const writes = source.match(/\.(update|insert|upsert|delete)\(/g) ?? [];
    // Positive shape: the page's write surface is the Scout modal and the agents, so it has none.
    // Comments describing the deleted fast path use words, not calls, so they cannot trip this.
    assert.deepEqual(writes, [], 'status changes belong to the deployed agents, never to this page');
  });

  it('selects through the shared narrowed select, typed by its row', async () => {
    // The select's VALUE (id, status, created_at and the named job columns) is pinned in
    // discoveredLanes.test.ts; here the page must use that constant rather than an inline string,
    // and must type the rows with DiscoveredListRow rather than casting them.
    assert.ok(source.includes('.select<string, DiscoveredListRow>(DISCOVERED_LIST_SELECT)'), 'the discovered query must use DISCOVERED_LIST_SELECT with its row type');
  });
});

describe('lane queries and paging', () => {
  it("list and HEAD count both filter on the selected lane's status", () => {
    // Two .eq calls on laneSpec.status: the list and the count describe the same set.
    assert.equal(source.match(/\.eq\('status', laneSpec\.status\)/g)?.length, 2, 'both queries must filter on laneSpec.status');
    // No hard-coded status filter left over from the single-lane page.
    assert.equal(source.includes(".eq('status', 'discovered')"), false, 'a hard-coded discovered filter would ignore the lane switch');
  });

  it('pages by keyset on (created_at desc, id asc), not by offset', () => {
    // The order keysetFilter mirrors: newest first, then id ascending as the unique tie-break.
    assert.match(source, /\.order\('created_at', \{ ascending: false \}\)\s*(\/\/[^\n]*\s*)*\.order\('id', \{ ascending: true \}\)/, 'the list must order by created_at desc then id asc');
    // Load more continues after the last loaded row; an offset would skip rows that left the lane.
    assert.ok(source.includes('query = query.or(cursor);'), 'Load more must apply the keyset cursor');
    // No offset paging left behind.
    assert.equal(source.includes('.range('), false, 'offset paging skips rows that change status between pages');
  });

  it('a stale-lane load is refused before it claims a load sequence', () => {
    // The first statement of loadData: a reload built for another lane (a Send settling after a
    // switch) returns before ++loadSeq, so it cannot supersede the current lane's load.
    assert.match(source, /const loadData = useCallback\(async \(mode: LoadMode = 'full'\) => \{\s*(\/\/[^\n]*\s*)*if \(!isCurrentLane\(lane, laneRef\.current\)\) return;\s*(\/\/[^\n]*\s*)*const seq = \+\+loadSeq\.current;/, 'loadData must check the lane before claiming a sequence');
    // The ref moves at click time, before React re-renders, so an in-flight settle sees the new lane.
    assert.ok(source.includes('laneRef.current = key;'), 'the lane switch must update laneRef synchronously');
  });

  it('a full load clears the old lane\'s total and rows before its first await', () => {
    // The loadData text up to its first await.
    const start = source.indexOf('const loadData = useCallback(');
    // Everything before the first await as code (`= await `), so "every await" in a comment cannot end it early.
    const head = source.slice(start, source.indexOf('= await ', start));
    // Without these, the old lane's total and cards show under the new label, and stay on a failed read.
    assert.ok(head.includes('setLaneTotal(null);') && head.includes('setItems([]);'), 'a full load must clear total and items before awaiting');
  });

  it('Load more renders only while hasMoreRows says rows remain', () => {
    // The button's guard is the tested helper, so it hides when loaded === total.
    assert.match(source, /hasMoreRows\(items\.length, laneTotal\) && \(/, 'Load more must be guarded by hasMoreRows');
  });

  it('the sort control states that it covers only the loaded rows', () => {
    // A client sort over one page of thousands is honest only when it says so.
    assert.match(source, /Sorts the \{loadedOfText\(items\.length, laneTotal\)\}/, 'the sort must say it covers the loaded rows');
  });

  it('a lane switch claims a new load sequence, so a slow Load more cannot append into the new lane', () => {
    // Load more runs through loadData('more'), which claims loadSeq like every other load.
    assert.ok(source.includes("void loadData('more')"), 'Load more must go through loadData so the sequence guard covers it');
    // loadData is rebuilt per lane and the effect reruns it, which claims a newer sequence.
    assert.match(source, /useEffect\(\(\) => \{\s*(\/\/[^\n]*\s*)*void loadData\(\);\s*\}, \[loadData\]\);/, 'the lane change must trigger a fresh loadData');
  });
});

/* A slow load resolving AFTER a newer one must not overwrite the newer state: it would
 * re-show an advanced row as `discovered`, with a live Send button, from a stale snapshot.
 * loadData claims a sequence number and re-checks it after every await. These tests pin
 * that shape, scoped to the loadData body so a guard elsewhere in the page cannot satisfy them.
 */
describe('loadData request-sequence guard', () => {
  // The loadData body only, with `//` comment lines dropped, so prose such as
  // "re-checked after every await" can neither satisfy nor trip an assertion.
  const loadDataCode = (): string => {
    // The opening of the callback; its absence means the function was renamed or removed.
    const start = source.indexOf('const loadData = useCallback(');
    // Fail loudly here instead of slicing from -1 and testing the wrong text.
    assert.ok(start !== -1, 'loadData must still be declared as a useCallback');
    // loadData depends on the lane only (the effect uses [loadData]), so this close is its own.
    const end = source.indexOf('}, [lane]);', start);
    // Same reason: an unmatched close would make every check below vacuous.
    assert.ok(end !== -1, 'loadData must close with a [lane] dependency list');
    // Split on \r?\n because the page is CRLF; drop whole-line comments, keep code.
    return source
      .slice(start, end)
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
  };

  it('claims a sequence from a ref and compares against it', () => {
    // Read once so both assertions see the same slice.
    const body = loadDataCode();
    // The claim: incrementing the ref makes this call the latest and every older call stale.
    assert.match(body, /const seq = \+\+loadSeq\.current;/, 'loadData must claim a sequence number from loadSeq');
    // The comparison every guard below calls.
    assert.match(body, /const stale = \(\): boolean => seq !== loadSeq\.current;/, 'stale() must compare the claimed seq to the ref');
  });

  it('every await in loadData is followed by the stale guard before any state write', () => {
    // Read once so the counts and the checks describe the same text.
    const body = loadDataCode();
    // Every await as code (comment lines are already gone), by position.
    const awaits = [...body.matchAll(/\bawait\b/g)].map((m) => m.index ?? 0);
    // Without awaits the loop below passes vacuously, so require that it has something to check.
    assert.ok(awaits.length > 0, 'loadData must contain awaits for this guard to mean anything');
    // An await is guarded when the stale check comes before the next setX( call after it.
    const guarded = awaits.filter((at) => {
      // Everything after this await.
      const rest = body.slice(at);
      // The next React state write, if any.
      const nextSetter = rest.search(/\bset[A-Z]\w*\(/);
      // The next stale guard, if any.
      const nextGuard = rest.indexOf('if (stale()) return;');
      // A guard must exist, and must win the race to the next state write.
      return nextGuard !== -1 && (nextSetter === -1 || nextGuard < nextSetter);
    });
    // Equal counts: one unguarded await is exactly the out-of-order overwrite this exists to stop.
    assert.equal(guarded.length, awaits.length, 'an await in loadData reaches a state write without `if (stale()) return;`');
  });

  it('the catch bails first when stale and finally only ends loading for the latest call', () => {
    // Read once so both blocks come from the same slice.
    const body = loadDataCode();
    // The catch block's first code statement, after its opening brace.
    const catchFirst = body.match(/catch \(\w+\) \{\s*([^\n]*)/)?.[1]?.trim();
    // A superseded call's error must not become the page's error.
    assert.equal(catchFirst, 'if (stale()) return;', 'the catch block must open with the stale guard');
    // The finally block's statements, up to the end of the slice.
    const finallyBlock = body.match(/finally \{([\s\S]*)$/)?.[1] ?? '';
    // A stale call ending first must not hide the spinner of the load still running.
    assert.match(finallyBlock, /if \(!stale\(\)\) setLoading\(false\);/, 'setLoading(false) in finally must be guarded by !stale()');
  });
});
