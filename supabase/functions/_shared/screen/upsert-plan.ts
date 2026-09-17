// The jobs-upsert blanking guard — "ABSENCE IS NOT A CORRECTION".
//
// THE BUG THIS EXISTS TO CLOSE. Both scouts upsert `jobs` with
// `onConflict: "user_id,fingerprint", ignoreDuplicates: false`, which is ON CONFLICT DO
// UPDATE — a FULL-ROW overwrite. `toJobInsert` always emits every key, so a board whose
// listing endpoint omits the job body produces `description_raw: null`, and that null
// overwrites a complete job description captured by an earlier, richer poll. The
// posting did not change; our view of it got thinner. Those two must not look alike.
//
// THE OBVIOUS FIX IS WRONG, AND IT IS WRONG IN A WAY THAT LOOKS RIGHT. Deleting the
// null key from the offending row achieves NOTHING, because postgrest-js 1.17.7 builds
// its column list from the UNION of keys across the whole batch — read from the
// installed source, PostgrestQueryBuilder.js:
//     const columns = values.reduce((acc, x) => acc.concat(Object.keys(x)), []);
//     this.url.searchParams.set('columns', [...new Set(columns)].join(','));
// One sibling row carrying `description_raw` puts that column in `columns=` for the
// ENTIRE request, so it lands in the DO UPDATE SET list and the row that omitted it is
// sent as NULL anyway. A key is genuinely absent only when it is absent from EVERY row
// in the request. That is why this returns GROUPS: one request per distinct key-set.
//
// THE OTHER PLAUSIBLE WRONG ANSWER, written down because someone will try it:
// `defaultToNull: false` (which sends `Prefer: missing=default`) does NOT fix this. It
// governs what a MISSING key means on INSERT — the column's DEFAULT instead of NULL —
// and says nothing about the ON CONFLICT DO UPDATE SET list. On the update path the
// stored value is still replaced. It is not a substitute for grouping.
//
// WHY A PURE FUNCTION AND NOT A COALESCE AT EACH CALL SITE: there are two scouts, one
// Node and one Deno, with near-identical upsert blocks. Two hand-written merges would
// drift, and the first drift would be silent. A comment is not a control — the
// protection has to live inside the one function both paths cross.

// Row shape from the schema owner. Never redefined — a redefined type does not fail,
// it drifts.
import type { JobInsert } from "../contracts/shared-types.ts";

// The columns a thin re-poll may legitimately omit, and which must therefore never be
// blanked by one.
//
// THIS IS AN ALLOWLIST RATHER THAN A RULE LIKE "STRIP EVERY FALSY VALUE", and that is
// the load-bearing choice. A blanket rule would happily strip `posted_at`, which is NOT
// NULL with no default, turning a working upsert into a constraint violation — trading
// a silent data bug for a loud runtime one. Naming the columns means the blast radius
// of this module is exactly these five and cannot grow by accident.
const PRESERVABLE_COLUMNS: ReadonlySet<string> = new Set([
  // The prompt-injection surface and the most expensive field to re-acquire: a board
  // that drops its body on a list endpoint would otherwise erase a full JD.
  "description_raw",
  // Nullable, and sparse boards routinely omit it.
  "location_raw",
  // Nullable; some boards expose a req id only on the detail endpoint.
  "ats_job_id",
  // Nullable, and the archive a parser bug is re-run against — losing it costs history.
  "raw_payload",
  // THE QUIET ONE, and it blanks on EVERY poll rather than only thin ones.
  // `toJobInsert` hard-codes `locations: []` because splitting "Bengaluru, India" into
  // allowlist-matchable tokens is the Normalizer's job. Without this entry, each scout
  // run wipes whatever the Normalizer wrote — and `location_allowlist` reads that
  // column, so the screener would be filtering on data the scout had just erased.
  "locations",
]);

// Whether a value carries no information, and so must not be allowed to overwrite one
// that does.
//
// DELIBERATELY NARROWER THAN FALSY. `0` and `""` are genuine values a board can report,
// and treating them as absent would make this guard lose real data in the name of
// protecting it — the exact inversion it exists to prevent.
function carriesNoInformation(value: unknown): boolean {
  // Both spellings of "the board gave us nothing here".
  if (value === null || value === undefined) return true;
  // An empty array is the array-valued form of the same non-answer.
  if (Array.isArray(value) && value.length === 0) return true;
  // Anything else is a real value, including 0, false and "".
  return false;
}

// Split one batch of job rows into the smallest set of upsert requests that cannot
// blank a stored value.
//
// TOTAL BY CONSTRUCTION: every input row appears in exactly one output group. A guard
// that quietly dropped rows would be worse than the bug, which at least left a row
// behind.
export function planJobUpsertGroups(rows: readonly JobInsert[]): (readonly Partial<JobInsert>[])[] {
  // Keyed by the row's surviving key-set, because that key-set IS what postgrest turns
  // into `columns=`. Rows sharing one can safely share a request; rows that differ
  // cannot, at any batch size.
  const groups = new Map<string, Partial<JobInsert>[]>();

  // One pass; order within a group is preserved so a failure is reproducible.
  for (const row of rows) {
    // Built as a loose record because the keys are decided at runtime; cast once, at
    // the end, rather than fighting the index signature on every assignment.
    const kept: Record<string, unknown> = {};

    // Copy across everything that is either not preservable or genuinely informative.
    for (const [column, value] of Object.entries(row)) {
      // Drop a preservable column only when it would overwrite with nothing. A
      // preservable column holding a real value still travels, which is what keeps a
      // genuine CHANGE overwriting — the other half of the rule.
      if (PRESERVABLE_COLUMNS.has(column) && carriesNoInformation(value)) continue;
      // Everything else is sent as-is.
      kept[column] = value;
    }

    // Sorted so two rows with the same columns in a different insertion order are
    // recognised as the same shape — otherwise the grouping would fan out into one
    // request per row and quietly become a rate-limit problem.
    const shape = Object.keys(kept).sort().join(",");

    // Start a group for a shape we have not seen, or join the existing one.
    const group = groups.get(shape);
    // The cast is confined to this line: `kept` was assembled from `JobInsert`'s own
    // entries, so every surviving key is a real column of that type.
    const trimmedRow = kept as Partial<JobInsert>;
    // Append, creating the bucket on first sight of this shape.
    if (group === undefined) groups.set(shape, [trimmedRow]);
    else group.push(trimmedRow);
  }

  // An empty batch yields no groups at all rather than one empty request: postgrest
  // rejects an empty body, and "this board had nothing new" is the common path.
  return [...groups.values()];
}
