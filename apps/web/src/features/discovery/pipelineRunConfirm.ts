/* The typed confirmation in front of "✨ Run pipeline (all eligible rows)…" (Teja's ruling,
 * 2026-10-09). The bulk run invokes every agent over its waiting rows and spends Gemini calls, so it
 * fires only when the operator types CONFIRM_PHRASE exactly.
 *
 * WHY A PURE FILE: the gate and the sentence it shows are tested by value in
 * test/pipelineRunConfirm.test.ts, with a spy in place of the run. The modal imports supabase.ts and
 * apps/web has no DOM renderer, so logic left inside the modal could only be grepped, not run. */

// Which statuses each agent's queue selects: the same table the per-row engine uses, never a copy.
import { STEP_INPUT_STATUS } from '../pipeline/rowPipeline.ts';
// Type only: the five agent ids, so a counts record must name every one.
import type { PipelineStep } from '../pipeline/rowPipeline.ts';

// The exact text that unlocks the run. Exact: no trim, no case folding, so a near miss stays locked.
export const CONFIRM_PHRASE = 'run all';

// True only for the exact phrase; drives the Run/Retry buttons' disabled state.
export function isRunConfirmed(typed: string): boolean {
  // Strict equality; a lenient match ("Run all ", "run") would make the gate a formality.
  return typed === CONFIRM_PHRASE;
}

// True when a run may start: the exact phrase AND the waiting counts on screen, so the operator has
// seen what the run takes before confirming. Drives the Run/Retry buttons' disabled state.
export function canStartRun(typed: string, countsReady: boolean): boolean {
  // Both halves of the confirm step: what it costs is stated, and the operator typed the phrase.
  return countsReady && isRunConfirmed(typed);
}

// The one door to a bulk run: calls start() only when canStartRun holds, and says whether it did.
// Every Run/Retry click in the modal goes through here (the modal-source test counts them).
export function startIfConfirmed(typed: string, countsReady: boolean, start: () => void): boolean {
  // Wrong or empty text, or counts not shown yet: nothing is invoked at all.
  if (!canStartRun(typed, countsReady)) return false;
  // The phrase matched: exactly one run.
  start();
  // Tells the caller a run began.
  return true;
}

// Rows each agent takes per run. Mirrors `BATCH_LIMIT` in src/data/pipelineRunner.ts, which is not
// exported; the test reads that file and fails if the two drift, so this sentence cannot misstate the run.
export const RUN_BATCH_LIMIT = 10;

// Run order, display names, and which agents call Gemini (the auditor is deterministic code).
const AGENTS: readonly { readonly id: PipelineStep; readonly name: string; readonly gemini: boolean }[] = [
  // Dedupe: no LLM.
  { id: 'normalizer', name: 'Normalizer', gemini: false },
  // Rule cascade: no LLM.
  { id: 'screener', name: 'Screener', gemini: false },
  // Scores fit with Gemini.
  { id: 'matcher', name: 'Matcher', gemini: true },
  // Builds the tailored resume with Gemini.
  { id: 'tailor', name: 'Tailor', gemini: true },
  // Checks claims with code; calls no LLM.
  { id: 'auditor', name: 'Auditor', gemini: false },
];

// Waiting rows per agent, or null where that agent's count is unknown.
export type WaitingCounts = Readonly<Record<PipelineStep, number | null>>;

// Reads every agent's waiting count with an injected counter (the modal passes a HEAD count). Each
// agent is contained on its own: a rejection or a null becomes null for THAT agent, so one failed
// query can neither reject the whole read (leaving "Counting…" forever) nor blank the others.
export async function readWaitingCounts(countOne: (statuses: readonly string[]) => Promise<number | null>): Promise<WaitingCounts> {
  // allSettled, not all: one rejection must not discard the other four counts.
  const settled = await Promise.allSettled(AGENTS.map((a) => countOne(STEP_INPUT_STATUS[a.id])));
  // Rebuilt as a record keyed by agent, in the same order; a rejected count is unknown, not zero.
  return Object.fromEntries(AGENTS.map((a, i) => {
    // This agent's outcome.
    const r = settled[i];
    // Only a fulfilled number is a count.
    return [a.id, r !== undefined && r.status === 'fulfilled' ? r.value : null];
  })) as Record<PipelineStep, number | null>;
}

// The agents that may spend Gemini calls, for the warning line.
const GEMINI_AGENTS = AGENTS.filter((a) => a.gemini);

// The spend warning, shown always (also while counts load or after they fail). "May": the matcher
// pre-gates its backlog without Gemini, so not every row it takes costs a call.
export const GEMINI_WARNING = `${GEMINI_AGENTS.map((a) => a.name).join(' and ')} may call Gemini: the Matcher for each row that passes its pre-gate, the Tailor for each row it takes. That is up to ${RUN_BATCH_LIMIT * GEMINI_AGENTS.length} rows of Gemini calls in this run (a rate-limited call is retried, which adds calls).`;

// The confirm step's text: the row cap the run applies and what is waiting right now per agent.
// counts holds HEAD counts per agent's input statuses; null means the count is unknown.
// One line per entry, joined with "\n"; the modal renders each line as a paragraph.
export function confirmSummary(counts: WaitingCounts): string {
  // The run's real ceiling: one batch per agent, and nothing more.
  const head = `This run sends at most ${RUN_BATCH_LIMIT} rows to each of the ${AGENTS.length} agents (${RUN_BATCH_LIMIT * AGENTS.length} row-steps in total). Rows one agent moves can be taken by the next agent in the same run.`;
  // Per agent: what is waiting now, and how much of it this run can take.
  const perAgent = AGENTS.map((a) => {
    // The statuses this agent's queue selects, named so the operator can check them.
    const statuses = STEP_INPUT_STATUS[a.id].join('/');
    // This agent's waiting count, or null when the HEAD query failed.
    const waiting = counts[a.id];
    // A failed count is said, never guessed.
    if (waiting === null) return `${a.name}: count unknown (queue: ${statuses}), takes up to ${RUN_BATCH_LIMIT}.`;
    // The real take is the smaller of the cap and the queue.
    return `${a.name}: ${waiting} waiting at ${statuses}, takes up to ${Math.min(RUN_BATCH_LIMIT, waiting)} of those.`;
  });
  // Cap first, then the queues; the Gemini warning is rendered separately (GEMINI_WARNING).
  return [head, ...perAgent].join('\n');
}
