// The worker scout's board identity check (2026-11-09).
//
// WHY: greenhouse token "xai" reports "SpaceXSI" since the xAI/SpaceX merger, and the identity guard refused every
// poll (45 consecutive failures). identity.ts now accepts that ONE board through BOARD_IDENTITY_ALIASES, but only for
// a caller that passes the board token; scout-ats does, and worker/src/cli/scout.ts did not, so the worker kept
// failing the board. These tests pin the decision the worker makes and the call that feeds it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// The two shared functions the worker composes, by the same relative path the worker imports them.
import { boardRefusal } from '../../supabase/functions/_shared/ats/registry.ts';
// The identity verdict, with the board-scoped alias.
import { evaluateBoardIdentity } from '../../supabase/functions/_shared/ats/identity.ts';
// The real greenhouse adapter: the verdict is only as good as what it reads out of the payload.
import { greenhouseAdapter } from '../../supabase/functions/_shared/ats/greenhouse.ts';

// One greenhouse posting reporting the given company, the shape readReportedIdentity reads (jobs[].company_name).
function greenhousePayload(companyName: string): unknown {
  // One job is enough: the verdict reads identity, not postings.
  return { jobs: [{ id: 5227940007, title: 'AI Tutor, Design - Temporary', updated_at: '2026-11-09T00:00:00Z', location: { name: 'Remote' }, absolute_url: 'https://job-boards.greenhouse.io/xai/jobs/5227940007', content: '', company_name: companyName }] };
}

// The worker's decision for one board, composed exactly as scout.ts composes it after the fix.
function workerRefusal(board: { company_name: string; board_token: string; last_poll_job_count: number | null }, payload: unknown, postings: number) {
  // Same argument order and fields as worker/src/cli/scout.ts.
  return boardRefusal(evaluateBoardIdentity(greenhouseAdapter, payload, board.company_name, board.board_token), board, postings);
}

describe('worker scout board identity', () => {
  it('the xai board reporting SpaceXSI persists (no refusal)', () => {
    // The live watchlist row (company_watchlist 87ab8299) and the live reported name.
    const refusal = workerRefusal({ company_name: 'xAI', board_token: 'xai', last_poll_job_count: 298 }, greenhousePayload('SpaceXSI'), 304);
    // Null means "persist as normal".
    expect(refusal).toBeNull();
  });

  it('another token reporting SpaceXSI is still refused as an identity mismatch', () => {
    // Same names, different board: the alias is pinned to the token, never to the name.
    const refusal = workerRefusal({ company_name: 'xAI', board_token: 'xai-careers', last_poll_job_count: 298 }, greenhousePayload('SpaceXSI'), 304);
    // Refused, so none of its postings reach jobs.
    expect(refusal?.kind).toBe('identity_mismatch');
  });

  it('scout.ts passes the board token to the identity check and fingerprints with the watchlist name', () => {
    // Read as text: scout.ts runs main() on import, so a source check is the only test of the cron file's wiring.
    const source = readFileSync(new URL('../src/cli/scout.ts', import.meta.url), 'utf8');
    // The token reaches the check, so the board alias can apply (without it the worker fails closed).
    expect(source).toMatch(/evaluateBoardIdentity\(adapter, parseResult\.firstPayload, board\.company_name, board\.board_token\)/);
    // Parity with scout-ats: the fingerprint's company comes from the watchlist row, so both scouts key xai rows alike.
    expect(source).toMatch(/companyName: board\.company_name/);
  });
});
