/* Read the screener's "rule skipped" warnings back out of agent_runs.error_detail.
 *
 * WHY THIS EXISTS. cascade.ts skips a rule when it cannot run (unconfigured, or the job field it
 * needs is null) and returns a warning. Since 9a85f0b the three screening callers persist those
 * warnings into `error_detail` via `withRuleWarnings`
 * (supabase/functions/_shared/screen/run-summary.ts), because agent_runs has no jsonb column.
 * The Health page needs them back as a LIST, per agent, so the operator can see WHICH rules did
 * not fire - the last screener runs dropped 50 of 50 rows with no visible reason.
 *
 * THE WRITER'S SHAPE, which this reader validates rather than searches for:
 *   [<failure summary>; ]rule_warnings: <w1> | <w2> | ...      then .slice(0, 1000)
 * - the segment is appended LAST, after "; " or as the whole string when there is no summary;
 * - items are distinct, sorted, joined by " | ";
 * - the 1000-character cap may cut the last item - or the WHOLE segment, because the failure
 *   summary goes first and worker/src/cli/scout.ts can fill all 1000 characters with db errors.
 * The failure summary in front may itself contain "; " and "\n", and scout-ats puts its own
 * non-error `liveness_refused:` segment there. None of that may leak into the list.
 *
 * PARSE A SHAPE, NEVER DUMP A SUBSTRING (CLAUDE.md §5) - AND NEVER LET "COULD NOT TELL" RENDER
 * AS "NOTHING". Null is reserved for the one case where we KNOW there were no warnings: no label
 * and nothing cut. Every case where warnings may exist but cannot be listed gets its own arm of
 * the closed union below, so the page has to say so out loud. */

// The writer's label, exactly as `withRuleWarnings` spells it, including the separating space.
const LABEL = 'rule_warnings: ';
// The writer's segment separator; the label only counts at the start or right after this.
const SEGMENT_SEPARATOR = '; ';
// The writer's item separator inside the segment.
const ITEM_SEPARATOR = ' | ';
// The writer's cap (run-summary.ts MAX_DETAIL_LENGTH). At or past it, the end may be cut.
export const WRITER_CAP = 1000;
// Another labelled segment ("; liveness_refused: ...") after ours: the writer never produces that.
const TRAILING_SEGMENT = /; [a-z_]+: /;

/** What a run's error_detail says about skipped rules. Null means "known: none". */
export type RuleWarnings =
  // The list, in the writer's order (sorted, distinct); `truncated` = the last item may be cut.
  | { readonly kind: 'warnings'; readonly warnings: readonly string[]; readonly truncated: boolean }
  // No readable segment, but the detail hit the cap: warnings may have existed and been cut off.
  | { readonly kind: 'maybe_cut' }
  // A label at a valid boundary whose body is not the writer's shape: recorded, but not listable.
  | { readonly kind: 'unreadable' };

/** Parse the `rule_warnings:` segment of agent_runs.error_detail; null only when there is surely none. */
export function parseRuleWarnings(detail: unknown): RuleWarnings | null {
  // The column is text or null; any other value is not a run's detail, and a clean run is null.
  if (typeof detail !== 'string') return null;
  // At the cap, the end of the string is the writer's slice, not the writer's content.
  const atCap = detail.length >= WRITER_CAP;
  // The LAST label that follows a segment separator, since the writer appends its segment last.
  const afterSeparator = detail.lastIndexOf(SEGMENT_SEPARATOR + LABEL);
  // Where the label starts: after "; ", or at index 0 when the segment is the whole string, else nowhere.
  const labelAt =
    afterSeparator >= 0 ? afterSeparator + SEGMENT_SEPARATOR.length : detail.startsWith(LABEL) ? 0 : -1;
  // No label: known-clean only if nothing was cut; at the cap the label itself may be what was cut.
  if (labelAt < 0) return atCap ? { kind: 'maybe_cut' } : null;
  // The segment body runs to the end of the string, because the writer puts nothing after it.
  const body = detail.slice(labelAt + LABEL.length);
  // ponytail: a warning that itself contains "; word: " (cascade.ts:297 quotes job.postedAt verbatim
  // from the ATS) also lands here and hides the WHOLE list behind 'unreadable'. That is still loud,
  // never silent; the real fix is writer-side (escape ";" and "|" at cascade.ts:297), outside this lane.
  if (TRAILING_SEGMENT.test(body)) return { kind: 'unreadable' };
  // ponytail: known ceiling - a " | " inside a quoted postedAt splits into bogus extra items here.
  // Same writer-side fix as above; the reader cannot tell the writer's " | " from the job's.
  const warnings = body
    .split(ITEM_SEPARATOR)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  // A label with no items: at the cap the items were what got cut; otherwise not the writer's shape.
  if (warnings.length === 0) return atCap ? { kind: 'maybe_cut' } : { kind: 'unreadable' };
  // Length, not content, is the only evidence of the cap: the writer slices without a marker.
  return { kind: 'warnings', warnings, truncated: atCap };
}

/* The fields `pickRuleWarningRun` reads. Structural, so both the hook's row type and a test's
   plain object fit, and every field is checked at runtime rather than trusted. */
interface RunLike {
  // Which agent wrote the run.
  readonly agent: string;
  // When it closed; null while running or after a mid-run crash.
  readonly finished_at: string | null;
  // How many rows the run took in (agent_runs.rows_in, not null default 0).
  readonly rows_in?: unknown;
}

/** The run whose error_detail answers "which rules did this agent skip?", or null if none can. */
export function pickRuleWarningRun<R extends RunLike>(runs: readonly R[], agent: string): R | null {
  // The best candidate so far, and its close time for ordering.
  let best: R | null = null;
  // -Infinity so the first valid candidate always wins.
  let bestAt = -Infinity;
  // One pass; the read is capped at RUN_WINDOW rows, so this is cheap.
  for (const run of runs) {
    // Another agent's warnings are not this agent's.
    if (run.agent !== agent) continue;
    // An OPEN run has no error_detail yet, so it cannot say the warnings went away.
    if (run.finished_at === null) continue;
    // An IDLE run screened nothing, so its clean detail says nothing about rules. A positive
    // integer only: a string or NaN is not evidence that anything was screened.
    if (typeof run.rows_in !== 'number' || !Number.isInteger(run.rows_in) || run.rows_in <= 0) continue;
    // Ordered by close time, the moment its detail was written.
    const at = Date.parse(run.finished_at);
    // An unparseable time cannot be ordered, so it cannot claim to be newest.
    if (Number.isNaN(at)) continue;
    // Newest closed screening run wins.
    if (at > bestAt) {
      // Keep it.
      best = run;
      // And its time, for the next comparison.
      bestAt = at;
    }
  }
  // Null when no run of this agent ever screened rows: the block renders nothing, truthfully.
  return best;
}
