// The Workday detail read: gives a NEW, title-passing Workday posting the description its list
// endpoint never carries.
//
// WHY IT EXISTS (2026-11-05). The list endpoint has no description, so the adapter declared
// `descriptionRaw: null` and 5612 of 5612 Workday jobs were saved without one. None was ever
// scored: 5221 were dropped on the title, and the 391 the screener passed failed in the matcher
// as `missing_description`. The detail endpoint carries `jobPostingInfo.jobDescription`. Teja
// ruled (00:10 IST): read it, but only for postings that pass the title gate, never for a whole
// board.
//
// WHERE IT SITS. The adapter contract keeps adapters pure (no network, ats/types.ts), so this
// step runs in each scout between "which rows are new" and the jobs insert. The scout passes
// its own robots-gated GET: scout-ats uses poll-fetch.ts fetchBoard, and the worker uses
// board-pages.ts. Both apply the 'scouting' robots policy, so a site whose robots.txt disallows
// the detail path is never read. Rows are filled IN PLACE, because the scouts hand the same
// row objects to planScreenedApplications; a copy would not reach the screener.

// The pure halves: the detail URL from the apply link, and the description and the sites from
// the response.
import { parseWorkdayDescription, parseWorkdayLocations, WORKDAY_LOCATION_COUNT, workdayDetailUrl } from "./adapters/workday.ts";
// The shared countdown both scouts already use for their own budgets.
import type { Deadline } from "../agent/deadline.ts";
// Row shape from the schema owner.
import type { JobInsert } from "../contracts/shared-types.ts";
// The stage-0 verdict the read decision is made from (type only; tech-gate.ts stays the gate's owner).
import type { TechGateVerdict } from "../screen/tech-gate.ts";

// ponytail: a fixed per-run cap and a fixed pause, not a per-host rate limiter. Ceiling: a
// posting past the cap is saved with no description, the screener drops it as
// missing_description, and only the back-fill can recover it. Raise the cap, or carry the rest
// to the next run, if the cap is often reached. Measured 2026-11-05: 459 title-passing Workday
// postings over 4 days of first sightings, about 115 a day; steady state is lower.
// The pause between two detail reads, so one run never bursts at one Workday host.
export const WORKDAY_DETAIL_PAUSE_MS = 500;

// Detail reads allowed per scout run, across all its boards. One constant for both scouts, so
// scout-ats and the worker cannot drift apart. 40 covers about a third of a day's ~115
// title-passing first sightings per run, and twice-daily worker runs plus manual scans cover the rest.
export const WORKDAY_DETAIL_CAP = 40;

// The least time a read may start with: one transport attempt (15 s, transport.ts:62) plus the
// pause, with room to spare, so a read never runs the scout past its own budget.
export const WORKDAY_DETAIL_MIN_REMAINING_MS = 20_000;

// What a scout supplies.
export interface WorkdayDetailDeps {
  // One robots-gated GET. It may throw (robots refusal, HTTP error, network); a throw counts as
  // "no description", never as a failed board.
  readonly get: (url: string) => Promise<Response | null>;
  // Whether this title is worth a detail read: both scouts pass worthDetailRead over the title-only
  // verdict. False only for a DEFINITE drop, which is what keeps the reads to a fraction of a board.
  readonly worthReading: (title: string) => boolean;
  // The scout's own budget: reads stop when too little is left.
  readonly deadline: Deadline;
  // The pause between reads; injected so tests do not sleep.
  readonly pause: (ms: number) => Promise<void>;
}

// One scout run's state: the deps, the reads left, and the counters for the run log.
export interface WorkdayDetailRun extends WorkdayDetailDeps {
  // Reads still allowed this run, shared across every board.
  left: number;
  // Reads made.
  fetched: number;
  // Reads that produced a description.
  filled: number;
  // Title-passing postings not read because the cap or the deadline came first.
  skipped: number;
}

// A fresh run, created once per scout run so the cap spans all its boards.
export function newWorkdayDetailRun(deps: WorkdayDetailDeps, cap: number): WorkdayDetailRun {
  // Counters start at zero; the cap is the run's whole allowance.
  return { ...deps, left: cap, fetched: 0, filled: 0, skipped: 0 };
}

// WHICH TITLES ARE READ (2026-11-12). Every title-only verdict except a DEFINITE drop. Before this, only
// titles the gate PASSED were read, and a title-only "tech_gate_unclassified" counted as a drop. It is not
// one: the configured keywords are also matched against the description head (tech-gate.ts haystack), which a
// title-only call has not seen. Live, all 668 Workday rows dropped unclassified in 3 days had an empty body
// (Concentrix SDET, Northern Trust "Associate - Software Eng", a Cigna intern). Every other drop code is
// decided by the title alone (an excluded term, seniority, PhD-only, non-software, a campus programme), so a
// read could not change it and is not spent. Exported so both scouts call the one rule.
export function worthDetailRead(verdict: TechGateVerdict): boolean {
  // A pass is read, as before; only "unclassified" among the drops still depends on the body.
  return !verdict.drop || verdict.code === "tech_gate_unclassified";
}

// Fill `description_raw` in place on every new Workday row that has no text, passes the title
// gate and still fits the run's cap and deadline. Every other row is left exactly as it was.
export async function fillWorkdayDescriptions(rows: readonly JobInsert[], run: WorkdayDetailRun): Promise<void> {
  // In board order, so a capped run reads the board's first postings.
  for (const row of rows) {
    // Only Workday lacks a description at list time.
    if (row.ats_provider !== "workday") continue;
    // A row that already has text (a pasted link, a re-run) is never read again.
    if (typeof row.description_raw === "string" && row.description_raw.trim().length > 0) continue;
    // A title definitely dropped is never read; the screener drops it with that same code.
    if (!run.worthReading(row.title)) continue;
    // The detail URL, or null for a link of any other shape; null is never guessed at.
    const url = workdayDetailUrl(row.apply_url);
    // An unbuildable URL is no read.
    if (url === null) continue;
    // Out of reads or out of time: counted, so the run log shows what the cap cost.
    if (run.left <= 0 || run.deadline.remainingMs() < WORKDAY_DETAIL_MIN_REMAINING_MS) {
      // The posting is saved without a description and dropped as missing_description.
      run.skipped += 1;
      // Next row; it is skipped the same way, and counted.
      continue;
    }
    // A pause between reads, never before the first.
    if (run.fetched > 0) await run.pause(WORKDAY_DETAIL_PAUSE_MS);
    // One read spent.
    run.left -= 1;
    // Counted before the result, so a read that fails still shows.
    run.fetched += 1;
    // The parsed body, or null for anything unreadable.
    const payload = await readDetail(run.get, url);
    // Only jobPostingInfo.jobDescription with real text counts.
    const description = parseWorkdayDescription(payload);
    // Only real text is written; null leaves the row as the list built it.
    if (description !== null) {
      // In place: the scout hands this same object to planScreenedApplications.
      row.description_raw = description;
      // Counted for the run log.
      run.filled += 1;
    }
    // The SAME response also names every site (2026-11-07, P2 #16): no extra request, so the
    // cap above bounds this too. Only the list's "N Locations" is replaced; a place the list
    // already named is kept. The gate reads "N Locations" as unknown, which passes.
    if (typeof row.location_raw === "string" && WORKDAY_LOCATION_COUNT.test(row.location_raw)) {
      // Every site joined for the gate, or null for a response without the expected shape.
      const sites = parseWorkdayLocations(payload);
      // null keeps the list's text, so a bad read is "unknown" as before, never an invented place.
      if (sites !== null) row.location_raw = sites;
    }
  }
}

// One detail read: the parsed JSON body, or null for a refusal, a non-2xx or a non-JSON body.
// Never throws, so one bad posting cannot fail its board. The field parsers decide the shape.
async function readDetail(get: WorkdayDetailDeps["get"], url: string): Promise<unknown> {
  try {
    // The robots-gated GET.
    const res = await get(url);
    // No response, or an error status: nothing to read.
    if (res === null || !res.ok) return null;
    // Text first, so a soft-200 HTML page is refused by the parse below, not by a throw.
    const text = await res.text();
    // JSON or nothing; the parsers refuse any JSON of the wrong shape.
    try { return JSON.parse(text); } catch { return null; }
  } catch {
    // A robots refusal, an HTTP error or a network failure: nothing read.
    return null;
  }
}
