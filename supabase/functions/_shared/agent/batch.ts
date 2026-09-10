// HOW MANY ROWS ONE INVOCATION MAY CLAIM. One table, one home, no per-agent literal.
//
// THESE NUMBERS ARE DERIVED FROM THE CPU LIMIT, NOT THE WALL CLOCK. A Supabase free-tier
// function gets ~150s of wall clock and ~2s of CPU, and THE CPU ONE IS BINDING. CPU
// measures active computing, so a 40s Gemini wait costs almost none of it — which means
// CPU-bound and wall-clock-bound stages want OPPOSITE batch sizes and no single number
// can serve both. That is the entire reason this is a table rather than a constant.
//
// EVERY STAGE CLAIMS A BOUNDED BATCH AND LETS `pg_cron` RE-FIRE. The alternative — an
// agent written to "process all pending" — passes every test anyone writes, because a
// fixture has ten rows, and fails in production on four hundred. Worse, a CPU-limit kill
// produces NOTHING and attributes the failure to no row at all, so there is no partial
// progress to inspect. The queue is deepest exactly when the diagnosis is hardest.
//
// A DEEP QUEUE IS NOT A REASON TO RAISE THESE. `pg_cron` fires again; throughput comes
// from more invocations, never from a bigger batch. The change that breaks this will
// look like an improvement, which is why the reasoning is written here beside the values.

// The agent vocabulary. Imported so a typo in a key is a compile error rather than a
// silently absent batch size that reads as "this agent does not claim work".
import type { AgentName } from "../contracts/shared-types.ts";

// The derivation, stage by stage.
//
// PARTIAL BY DESIGN: two agents legitimately have no entry, and their absence is a
// statement rather than an omission. `applier` deliberately drains the whole day's queue
// in ONE GitHub Actions run, because GitHub bills every job rounded up to a whole minute
// and 35 separate runs cost ~35-70 billed minutes against ~2 for one batched run.
// `human` is a person in a dashboard. Making the record `Partial` is what lets those two
// be visibly absent instead of forcing an invented number.
export const AGENT_BATCH_SIZES: Readonly<Partial<Record<AgentName, number>>> = {
  // ONE BOARD. `content=true` returns every full HTML description in a single response,
  // so the risk here is a multi-MB `JSON.parse` — the CPU cost is in the parse, not in
  // the per-job work, and no smaller unit than a board exists to claim.
  scout_ats: 1,
  // Same reasoning as the ATS scout: one page of aggregator results at a time.
  scout_aggregator: 1,
  // Light per-row work — one fingerprint recomputation and at most one lookup — so 50
  // rows of it stays well inside 2s of CPU.
  normalizer: 50,
  // THE ONE STAGE THAT CAN AFFORD VOLUME AND NEEDS IT. No LLM, no network, pure set and
  // regex work. Most discovered jobs die here, and that is precisely what makes six free
  // Gemini keys sufficient rather than merely hopeful (§8).
  screener: 200,
  // Wall-clock bound and ~zero CPU: five sequential Gemini calls fit inside 150s while
  // costing almost nothing against the 2s CPU budget.
  matcher: 5,
  // Same shape as the Matcher, and the largest single prompt in the system.
  tailor: 5,
  // Same again. The Auditor is a second call over the same row, so its cost profile
  // matches the Tailor's exactly.
  auditor: 5,
  // One Gemini call per email, wall-clock bound.
  tracker: 50,
  // The lease reclaimer does its work in a single RPC, so it claims no batch — but it is
  // listed because it DOES run on a schedule, and a reader checking "is this stage
  // bounded?" should find an answer here rather than an absence to interpret.
  sweeper: 1,
};

// Look up a stage's batch size, refusing rather than defaulting.
//
// NO FALLBACK NUMBER, and that is the decision this function exists to encode. A
// `?? 10` here would give a brand-new agent a plausible-looking batch that nobody
// derived from the CPU limit — the exact silent wrong answer this table exists to
// prevent. Throwing means the omission is discovered by whoever adds the agent, at the
// moment they add it, rather than by Teja weeks later reading an empty queue.
export function batchSizeFor(agent: AgentName): number {
  // The derived value, if this stage has one.
  const size = AGENT_BATCH_SIZES[agent];
  // Absent means either a genuinely unbatched agent (the Applier) or an agent someone
  // forgot to derive a size for. Both are programming errors at this call site.
  if (size === undefined) throw new Error(`no batch size derived for agent "${agent}"`);
  // Bounded, finite and positive by the table above.
  return size;
}
