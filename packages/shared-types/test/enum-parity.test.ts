// Parity between this package and supabase/migrations, enforced rather than asserted.
//
// WHY THIS FILE EXISTS. enums.ts used to say: "If you add a value here you MUST add it
// to the migration, and vice versa. There is no codegen guarding this; the checklist in
// SCHEMA_CONTRACT.md is." A checklist is a guard nobody runs. Four streams import this
// package and read that contract instead of asking questions, so drift here is the most
// expensive drift in the repo — and it is silent, because both sides keep compiling.
// This test turns the checklist into a build failure.
//
// ── THE NON-OBVIOUS PART: ORDER IS PART OF THE CONTRACT ───────────────────────────
// Membership parity is the easy half. Postgres sorts an enum BY DECLARATION ORDER, not
// alphabetically, so `ORDER BY status` yields pipeline order only while the SQL's
// declaration order matches APPLICATION_STATUSES. Reorder one side and nothing breaks
// loudly: every value still exists, every insert still succeeds, every test still
// passes — and the kanban board silently sorts wrong. That failure would surface months
// later as "the board looks odd" with no change to blame, which is why these assertions
// compare sequences and not sets. If you are here because an order assertion failed,
// that is the test working; fix the order rather than relaxing the assertion.
//
// ── WHY THE TWO HALVES USE DIFFERENT TECHNIQUES ───────────────────────────────────
// Enums are compared by IMPORTING the real runtime values from src/index.ts. A test
// that regex-parsed both sides could agree with itself while disagreeing with what
// consumers actually import. Tables are compared by parsing tables.ts as TEXT, because
// a TypeScript `interface` is erased at runtime and there is nothing to import — so
// that half is a weaker check by necessity, and is limited to "does a Row type exist".
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

// Everything a consumer can import. Imported as a namespace so a newly added enum is
// covered by these tests automatically, with no edit here — a guard that needs updating
// whenever the thing it guards changes is just a second checklist.
import * as contract from '../src/index.ts';

// Resolve paths from this file rather than from process.cwd(), so the suite behaves the
// same run from the package, from the repo root, or from a workspace-wide `pnpm -r`.
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', '..', 'supabase', 'migrations');
const SRC_DIR = join(HERE, '..', 'src');

/**
 * TS exports that are arrays of strings but are NOT enum mirrors, so the TS→SQL
 * direction must not demand a `create type` for them.
 *
 * Kept as an explicit list rather than a name pattern on purpose: a new string-array
 * export failing this test until someone classifies it is the desired behaviour. It
 * forces a one-line declaration of intent — "this mirrors a Postgres enum" or "this is
 * derived" — at the moment the ambiguity is introduced, rather than leaving the next
 * reader to guess which kind they are looking at.
 */
const NOT_ENUM_MIRRORS = new Set<string>([
  // Derived SUBSETS of application_status, not types of their own. Deliberately not in
  // the database: they are client-side conveniences, and the authority on "may this row
  // move" is the transition table, not a hardcoded list of terminal states.
  'TERMINAL_STATUSES',
  'NON_RETRYABLE_STATUSES',
  // Per-FIELD answer-block reasons. TS-only BY DESIGN — these live inside
  // applications.block_detail (jsonb), not in a column, so there is deliberately no
  // `create type` to match. See the long note in enums.ts for why merging them into
  // BLOCK_REASONS would mean one enum typing two different granularities.
  'ANSWER_BLOCK_REASONS',
  // Auditor finding kinds, incl. `misattributed_bullet`. TS-only for the same reason:
  // they discriminate one element of the applications.audit_findings jsonb ARRAY, and
  // a row-level enum column cannot type a per-element field.
  'AUDIT_FINDING_KINDS',
]);

/** Every migration file, concatenated. Order is irrelevant: these are declarations, not a replay. */
function readAllMigrations(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  // A silently empty corpus would make every test below pass vacuously, which is worse
  // than failing: it would report "parity verified" having compared nothing at all.
  assert.ok(files.length > 0, `no .sql migrations found in ${MIGRATIONS_DIR}`);
  return files.map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8')).join('\n');
}

/**
 * Extract `create type public.<name> as enum ('a', 'b', ...)` in declaration order.
 *
 * SQL line comments are stripped FIRST. Without that, a commented-out `-- 'draft',`
 * inside an enum body would be read as a live value, and the test would demand a TS
 * value for something Postgres never declares — a false failure that would teach the
 * next person to distrust this suite.
 */
function parseSqlEnums(sql: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const match of sql.matchAll(/create\s+type\s+public\.(\w+)\s+as\s+enum\s*\(([\s\S]*?)\)\s*;/gi)) {
    const [, name, rawBody] = match;
    const body = rawBody!.replace(/--[^\n]*/g, '');
    found.set(name!, [...body.matchAll(/'([^']*)'/g)].map((m) => m[1]!));
  }
  return found;
}

/**
 * Map a Postgres enum name to the const-tuple export that mirrors it:
 * upper-snake, then pluralised. `status` already ends in an s and takes `es`
 * (application_status → APPLICATION_STATUSES); everything else takes a bare `s`.
 */
function expectedTsExportName(sqlEnumName: string): string {
  const upper = sqlEnumName.toUpperCase();
  return upper.endsWith('S') ? `${upper}ES` : `${upper}S`;
}

/** Read one export from the imported namespace, or undefined when it does not exist. */
function tupleExport(name: string): readonly string[] | undefined {
  const value = (contract as Record<string, unknown>)[name];
  // Every element must be a string: this is what separates an enum mirror from
  // STATUS_TRANSITIONS, which is an array of objects.
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return undefined;
  return value as readonly string[];
}

const MIGRATION_SQL = readAllMigrations();
const SQL_ENUMS = parseSqlEnums(MIGRATION_SQL);

test('enum parity — every Postgres enum has a TypeScript mirror, same values in the same order', async (t) => {
  // Parsing nothing would make this suite pass while checking nothing at all.
  assert.ok(SQL_ENUMS.size > 0, 'parsed zero `create type ... as enum` declarations — has the migration layout changed?');

  for (const [sqlName, sqlValues] of SQL_ENUMS) {
    // A subtest per enum so a failure names the enum in its title rather than making
    // someone read a diff of fifteen arrays to find which one moved.
    await t.test(`${sqlName} <-> ${expectedTsExportName(sqlName)}`, () => {
      const tsName = expectedTsExportName(sqlName);
      const tsValues = tupleExport(tsName);

      // This is the assertion that would have caught `eval_label`, which shipped in SQL
      // on 2026-09-09 with no mirror here and no way to notice.
      assert.ok(
        tsValues !== undefined,
        `Postgres declares enum '${sqlName}' but @applyy/shared-types exports no '${tsName}' const tuple. ` +
          `Add it to src/enums.ts with values, in order: ${JSON.stringify(sqlValues)}`,
      );

      // deepEqual on arrays compares element order, which is the point — see the header.
      assert.deepEqual(
        [...tsValues],
        sqlValues,
        `'${tsName}' does not match Postgres enum '${sqlName}'. Values AND order must match: ` +
          `Postgres sorts an enum by declaration order, so a reordering here silently changes ORDER BY.`,
      );
    });
  }
});

test('enum parity — no TypeScript enum mirror lacks a Postgres declaration', () => {
  // The reverse direction. Without it, a value added here and forgotten in the
  // migration would typecheck everywhere and fail only as a runtime 22P02
  // (invalid_text_representation) on the first insert that used it — in production,
  // from an agent, at 3am.
  const sqlExportNames = new Set([...SQL_ENUMS.keys()].map(expectedTsExportName));

  for (const exportName of Object.keys(contract)) {
    // UPPER_SNAKE identifies the const-tuple convention; anything else is a type,
    // interface or function and is not in scope for enum parity.
    if (!/^[A-Z][A-Z0-9_]*$/.test(exportName)) continue;
    if (NOT_ENUM_MIRRORS.has(exportName)) continue;
    if (tupleExport(exportName) === undefined) continue;

    assert.ok(
      sqlExportNames.has(exportName),
      `'${exportName}' looks like an enum mirror but no Postgres enum maps to it. ` +
        `Either add the matching \`create type\` to supabase/migrations, or — if it is intentionally ` +
        `TypeScript-only, like a reason code stored inside a jsonb column — add it to NOT_ENUM_MIRRORS ` +
        `in this file with a comment saying which column carries it.`,
    );
  }
});

test('table parity — every table in the migrations has a Row type', () => {
  // Weaker by necessity: interfaces are erased at runtime, so this parses source text
  // and checks only for EXISTENCE of a Row type, never that its columns are right.
  // Column-level parity needs `supabase gen types typescript`, which needs a live
  // database — see SCHEMA_CONTRACT.md. Until then this catches the whole-table
  // omission, which is the failure that actually happened (matcher_eval_cases).
  const tablesSource = readFileSync(join(SRC_DIR, 'tables.ts'), 'utf8');

  const sqlTables = [...MIGRATION_SQL.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.(\w+)/gi)].map(
    (m) => m[1]!,
  );
  assert.ok(sqlTables.length > 0, 'parsed zero `create table` statements — has the migration layout changed?');

  // Match by NORMALISING both sides to a comparable key rather than predicting the
  // type name from the table name. The first version of this test guessed the name by
  // depluralising (`matcher_eval_cases` -> `MatcherEvalCaseRow`) and produced three
  // FALSE FAILURES: `SystemSettingsRow` and `SearchPreferencesRow` keep the plural,
  // and "cases" -> "cas" under a naive `ses$ -> s` rule. Getting those right needs an
  // English pluraliser, which is an unbounded amount of wrong — and a parity test that
  // cries wolf is worse than no parity test, because people stop reading it.
  //
  // So: strip separators and case, drop one trailing `s` from each side, compare. That
  // asks the question actually worth asking — "is there plausibly a Row type for this
  // table?" — instead of policing how it was spelled.
  const normalise = (name: string): string => name.replace(/_/g, '').toLowerCase().replace(/s$/, '');

  // Every Row interface tables.ts actually declares, keyed for comparison.
  const declaredRows = new Set(
    [...tablesSource.matchAll(/\binterface\s+(\w+)Row\b/g)].map((m) => normalise(m[1]!)),
  );

  const missing = sqlTables.filter((table) => !declaredRows.has(normalise(table)));

  assert.deepEqual(
    missing,
    [],
    `these tables exist in supabase/migrations but have no Row type in src/tables.ts: ${missing.join(', ')}. ` +
      `A consumer needing one of them will hand-declare it, which is how two spellings of one row appear.`,
  );
});

test('status graph parity — the TS mirror matches the transitions seeded into SQL', async (t) => {
  // status-flow.ts calls itself "A MIRROR, NOT THE RULE": Postgres refuses an illegal
  // move whether or not the client consulted it. That is only true while the two agree.
  // A missing edge here greys out a button the database would have allowed (annoying);
  // an EXTRA edge here enables a button the database will reject with a 400 (a bug that
  // reaches the user). Both are silent without this test.
  const seeded = [
    ...MIGRATION_SQL.matchAll(
      // The trailing group captures the `note`, with '' unescaped to a literal quote —
      // note text is user-visible (see the note-parity subtest below), so it is part of
      // the contract rather than a comment.
      /\(\s*'(\w+)'\s*,\s*'(\w+)'\s*,\s*array\[([^\]]*)\]::public\.agent_name\[\]\s*,\s*'((?:[^']|'')*)'\s*\)/gi,
    ),
  ].map((m) => ({
    from: m[1]!,
    to: m[2]!,
    agents: [...m[3]!.matchAll(/'([^']*)'/g)].map((a) => a[1]!),
    note: m[4]!.replace(/''/g, "'"),
  }));

  assert.ok(seeded.length > 0, 'parsed zero seeded transitions — has the guard migration changed shape?');

  const mirror = contract.STATUS_TRANSITIONS;
  const key = (t2: { from: string; to: string }) => `${t2.from} -> ${t2.to}`;

  await t.test('the same set of edges exists on both sides', () => {
    // Sorted, because seed order in SQL is a readability choice and carries no meaning —
    // unlike enum declaration order, which does. Comparing unsorted here would fail on a
    // harmless reshuffle and train people to ignore this suite.
    assert.deepEqual(
      mirror.map(key).sort(),
      seeded.map(key).sort(),
      'STATUS_TRANSITIONS and the seeded application_status_transitions rows describe different graphs',
    );
  });

  await t.test('every edge permits exactly the same agents on both sides', () => {
    const seededAgents = new Map(seeded.map((s) => [key(s), [...s.agents].sort()]));
    for (const edge of mirror) {
      // allowedAgents is not decoration: it is consumed by the FRONTEND's completeness
      // checks as well as by the trigger, so a mismatch changes what the UI offers a
      // human, not just what the database permits.
      assert.deepEqual(
        [...edge.allowedAgents].sort(),
        seededAgents.get(key(edge)),
        `allowed agents differ for ${key(edge)}`,
      );
    }
  });

  await t.test('every edge `note` is identical on both sides', () => {
    // `note` is `text not null` and the frontend renders it, so these are strings a
    // USER can read: two versions means the UI and the database disagree about what a
    // transition means. SQL is the authority here precisely because the UI reads the
    // column, so TS converges on it — 9 of 44 differed on 2026-09-10 (4 punctuation,
    // 5 substantive) and were synced onto the SQL text.
    const seededNotes = new Map(seeded.map((s) => [key(s), s.note]));
    for (const edge of mirror) {
      assert.equal(
        edge.note,
        seededNotes.get(key(edge)),
        `note text differs for ${key(edge)}. SQL is the source of truth for notes because ` +
          `the frontend renders application_status_transitions.note; change the migration first, then sync here.`,
      );
    }
  });

  await t.test('every edge into `approved` is human-only', () => {
    // THE CORRECTED INVARIANT, 2026-09-10. Three places used to assert that
    // `awaiting_approval -> approved` was the ONLY edge into `approved`. It is not:
    // `needs_verification -> approved` is a second one. The safety property survives
    // because BOTH are ['human'] — so this is the true statement, and it is strictly
    // stronger than the false one, since it keeps holding if a third in-edge is added.
    //
    // Asserted rather than commented because the false version was asserted in prose
    // in three places and stayed wrong: prose does not fail.
    const intoApproved = seeded.filter((s) => s.to === 'approved');
    assert.ok(intoApproved.length > 0, 'no edges into `approved` found — the graph cannot be right');
    for (const edge of intoApproved) {
      assert.deepEqual(
        edge.agents,
        ['human'],
        `${key(edge)} is an edge into \`approved\` that a machine can walk. Constraint 15 requires ` +
          `every route into the submit path to be opened by a person.`,
      );
    }
  });

  await t.test('exactly one backward edge is machine-walkable, and it is `interview -> oa_pending`', () => {
    // "Backward" is defined by APPLICATION_STATUSES declaration order, which is
    // pipeline order (and Postgres's sort order for the enum). Six comments across the
    // repo claimed there are NO backward edges; there are seven, and they are the
    // recovery lanes. The property actually worth protecting is that all but one are
    // human-only — a reader who believes "no backward edges" concludes the actor check
    // on reverse moves is redundant, and it is the whole safety property.
    const rank = new Map(contract.APPLICATION_STATUSES.map((s, i) => [s as string, i]));
    const backward = seeded.filter((s) => rank.get(s.to)! < rank.get(s.from)!);

    assert.equal(backward.length, 7, `expected 7 backward edges, found ${backward.length}: ${backward.map(key).join(', ')}`);

    const machineWalkable = backward.filter((s) => s.agents.some((a) => a !== 'human'));
    assert.deepEqual(
      machineWalkable.map((s) => `${key(s)} by ${s.agents.join('/')}`),
      ['interview -> oa_pending by tracker/human'],
      'the set of backward edges an automated agent may walk has changed. Every reverse move except ' +
        'the multi-round interview loop must be human-only.',
    );
  });

  await t.test('TERMINAL_STATUSES is exactly the set of statuses with no outgoing edge in SQL', () => {
    // TERMINAL_STATUSES is now derived from STATUS_TRANSITIONS in status-flow.ts, so
    // this checks it against the OTHER side — the seeded SQL — which is the half that
    // derivation alone cannot guarantee. `failed` must NOT appear: it looks terminal
    // but `failed -> needs_verification` exists.
    const hasOutgoing = new Set(seeded.map((s) => s.from));
    const expected = contract.APPLICATION_STATUSES.filter((s) => !hasOutgoing.has(s));
    assert.deepEqual([...contract.TERMINAL_STATUSES], [...expected]);
  });

  await t.test('`applying` has exactly one edge into it, and it comes from `approved`', () => {
    // CONSTRAINT 15, as a property of the graph rather than a promise in a comment.
    // Everything upstream of `applying` is reversible and nothing downstream is, so this
    // is the single most valuable invariant in the schema: a new edge into `applying`
    // added anywhere, by anyone, on either side, fails here.
    const intoApplying = seeded.filter((s) => s.to === 'applying');
    assert.deepEqual(
      intoApplying.map((s) => `${s.from} -> ${s.to} by ${s.agents.join('/')}`),
      ['approved -> applying by applier'],
      'a second door into `applying` now exists in SQL — constraint 15 (never submit without human approval) is no longer structural',
    );
  });
});
