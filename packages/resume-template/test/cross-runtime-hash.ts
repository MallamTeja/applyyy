/**
 * applyy — cross-runtime determinism check for the real renderer.
 *
 * NOT part of `node --test` (the filename deliberately does not end in
 * .test.ts). It is a script both Node and Deno can execute, so the two hashes
 * can be compared:
 *
 *   node                       test/cross-runtime-hash.ts
 *   deno run --allow-read=. --config deno.json test/cross-runtime-hash.ts
 *
 * WHY THIS EXISTS SEPARATELY FROM THE UNIT TESTS: the section 20 step 0 spike
 * proved a toy module crossed Deno and Node. This proves the SHIPPING renderer
 * does — the one React uses for the approval preview and the one the Playwright
 * worker uses for the submitted PDF. If those two runtimes ever disagree, "what
 * you approved is byte-for-byte what gets sent" is false, and it would be false
 * silently: both sides would render something plausible.
 *
 * A single test process cannot check this, because a test process is one
 * runtime. That is the whole reason it is a script and not an assertion.
 */

// Public surface, exactly as the worker and React import it.
import { renderResumeHtml } from '../src/index.ts';
// The section 11 worked example.
import { zomatoBackendIntern } from './fixtures/zomato-backend-intern.ts';

// node:crypto is the one hashing API both runtimes expose under the same
// specifier, which is why the check itself is portable.
import { createHash } from 'node:crypto';

// Render once; the function is pure, so one call is the whole observation.
const html = renderResumeHtml(zomatoBackendIntern);
// Hex digest so the two runtimes' output can be compared by eye or by diff.
const digest = createHash('sha256').update(html, 'utf8').digest('hex');
// Length is printed alongside because a hash mismatch says nothing about WHERE
// the difference is, whereas a byte-count difference immediately suggests
// whether it is a line-ending issue or a genuine content change.
console.log(`${digest}  ${String(html.length)} bytes`);
