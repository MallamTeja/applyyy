// Tests for .github/workflows/jd-refetch.yml (2026-11-24, orch round peer 1): the drain must not depend on
// one best-effort cron slot a day.
//
// WHY THIS EXISTS. On 2026-11-23 Teja moved 111 no-description Workday rows to Ready to tailor (S8b). The
// workflow drained 30 rows per run, and main carried ONE schedule slot (05:07Z) that GitHub started 8-11 h
// late, so the backlog would have taken 4 days. The fix (pinned here, each part red on its own revert):
// 1. A run that hit its row cap AND moved at least one row out of passed_filters re-dispatches itself, so one
//    trigger drains the whole backlog. Bounded: a depth cap, and "no progress = no chain".
// 2. The ids a run tried without progress (still thin, retry later) are carried into the next run as
//    skip_ids, so a block of permanently-thin rows at the front cannot starve the rows behind it.
// 3. Triggers: three cron slots, plus workflow_run after the ATS scout (the state change that creates thin
//    rows; Teja 2026-10-24 "automate, don't hand-dispatch").
// 4. actions: write only on the one-step redispatch job (the apply-kit.yml pattern), never on the job that
//    handles secrets.
//
// HOW: the yml's inline Node script is cut out of the file and RUN against a local fake Supabase, so the
// verdict is tested as behaviour, not as a substring. The YAML parts are shape-checked with anchors that
// must exist first (CLAUDE.md §6: a check that can pass on nothing is not a check).
import { test } from "node:test";
// Strict asserts, so a near-miss is never treated as equal.
import assert from "node:assert/strict";
// The workflow is read from disk, so the test checks the working-tree file.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
// The extracted script is run as a child process, exactly as the runner runs it.
import { spawn } from "node:child_process";
// The fake Supabase the script talks to.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
// Temp files for the extracted script and its GITHUB_OUTPUT.
import { tmpdir } from "node:os";
// Joined paths, OS-correct.
import { join } from "node:path";

// The workflows folder, resolved from this file so the runner's cwd does not matter.
const WORKFLOWS = new URL("../../../.github/workflows/", import.meta.url);
// The file under test, CRLF normalised so line anchors are EOL-proof (working copies are CRLF here).
const YML = readFileSync(new URL("jd-refetch.yml", WORKFLOWS), "utf8").replace(/\r\n/g, "\n");
// The ATS scout, whose `name:` the workflow_run trigger must match exactly.
const SCOUT = readFileSync(new URL("scout.yml", WORKFLOWS), "utf8").replace(/\r\n/g, "\n");

// The file's lines with full-line comments dropped, so a comment can never be read as config.
function codeLines(yaml: string): string[] {
  // Comment lines go; everything else stays in order.
  return yaml.split("\n").filter((line) => !/^\s*#/.test(line));
}

// The lines strictly inside the block opened by the exact line `header`. Throws when the header is absent.
function block(lines: string[], header: string): string[] {
  // The anchor, asserted present, never assumed.
  const start = lines.indexOf(header);
  // No anchor: the file changed shape; red, never an empty block that passes.
  if (start < 0) throw new Error(`no \`${header.trim()}\` line`);
  // The header's indent; the block is every later line indented deeper.
  const indent = /^ */.exec(header)![0].length;
  // The first later non-blank line at the same or shallower indent ends it.
  const end = lines.findIndex((line, i) => i > start && line.trim() !== "" && /^ */.exec(line)![0].length <= indent);
  // Blank lines carry nothing.
  return lines.slice(start + 1, end < 0 ? undefined : end).filter((line) => line.trim() !== "");
}

// The inline Node script of the refetch step, dedented. Throws unless exactly one heredoc is found.
function extractScript(yaml: string): string {
  // Every heredoc opener; exactly one is expected.
  const lines = yaml.split("\n");
  // The opener line's index.
  const openers = lines.flatMap((line, i) => (/node --input-type=module <<'EOF'$/.test(line.trim()) ? [i] : []));
  // Zero or two openers: the test would run the wrong code or none.
  if (openers.length !== 1) throw new Error(`expected one inline script, found ${openers.length}`);
  // The terminator: the first later line that is only EOF.
  const end = lines.findIndex((line, i) => i > openers[0]! && line.trim() === "EOF");
  // No terminator: malformed.
  if (end < 0) throw new Error("inline script has no EOF line");
  // The body.
  const body = lines.slice(openers[0]! + 1, end);
  // The common indent of the non-blank lines, removed as the shell's heredoc would see it after YAML.
  const indent = Math.min(...body.filter((l) => l.trim() !== "").map((l) => /^ */.exec(l)![0].length));
  // Dedented script text.
  return body.map((l) => l.slice(indent)).join("\n");
}

// One scripted answer of the fake jd-refetch function.
type Answer = { kind: string; id: string | null; extra?: Record<string, unknown> };

// What a run did: its exit code, stdout, the GITHUB_OUTPUT lines and every skip_ids list it sent.
type RunResult = { code: number; stdout: string; outputs: Record<string, string>; skipLists: string[][] };

// A uuid for row n, the only id shape the script and the function accept.
function uuid(n: number): string {
  // Zero-padded into the last group.
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

// Run the extracted script against a fake Supabase that answers `answers` in order (then "none").
async function runScript(answers: Answer[], env: Record<string, string>): Promise<RunResult> {
  // Every skip_ids body the script sent, in call order.
  const skipLists: string[][] = [];
  // The next scripted answer.
  let next = 0;
  // The fake: the password grant and the function, nothing else.
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // The request body, collected before answering.
    let raw = "";
    // Chunks as they come.
    req.on("data", (c) => (raw += c));
    // Answer once the body is in.
    req.on("end", () => {
      // Sign-in: a token the script forwards.
      if (req.url?.startsWith("/auth/v1/token")) {
        // 200 with the one field the script reads.
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "t" }));
        // Done with this request.
        return;
      }
      // The function: record what was skipped, then answer the next outcome.
      skipLists.push((JSON.parse(raw) as { skip_ids: string[] }).skip_ids);
      // Past the script: nothing thin left.
      const a = answers[next++] ?? { kind: "none", id: null };
      // The function's 200 contract.
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ status: "ok", outcome: { kind: a.kind, ...(a.extra ?? {}) }, application_id: a.id }),
      );
    });
  });
  // Any free port on loopback.
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  // The port the OS gave.
  const port = (server.address() as { port: number }).port;
  // A private temp folder for the script and its output file.
  const dir = mkdtempSync(join(tmpdir(), "jd-refetch-wf-"));
  // The extracted script, as a module.
  const file = join(dir, "run.mjs");
  // Written fresh from the yml under test.
  writeFileSync(file, extractScript(YML));
  // The GITHUB_OUTPUT file the runner provides.
  const outFile = join(dir, "out.txt");
  // Starts empty.
  writeFileSync(outFile, "");
  // Run it the way the step does, with the step's env names.
  const child = spawn(process.execPath, [file], {
    env: {
      // PATH etc. for the child Node.
      ...process.env,
      // The fake Supabase.
      SUPABASE_URL: `http://127.0.0.1:${port}`,
      // Any non-empty values: the fake does not check them.
      SUPABASE_ANON_KEY: "anon",
      APPLYY_APP_USER_EMAIL: "e",
      APPLYY_APP_USER_PASSWORD: "p",
      // No real 45 s Gemini pause in a test.
      JD_REFETCH_PACE_MS: "0",
      // The runner's output file.
      GITHUB_OUTPUT: outFile,
      // The case's own inputs.
      ...env,
    },
  });
  // Stdout for the assertions.
  let stdout = "";
  // Collected as it comes.
  child.stdout.on("data", (c) => (stdout += c));
  // The exit code.
  const code = await new Promise<number>((r) => child.on("close", (c) => r(c ?? -1)));
  // The fake is done.
  server.close();
  // key=value lines of GITHUB_OUTPUT.
  const outputs = Object.fromEntries(
    readFileSync(outFile, "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  // Everything the assertions need.
  return { code, stdout, outputs, skipLists };
}

// n answers of one kind, ids starting at `from`.
function many(n: number, kind: string, from = 1): Answer[] {
  // One answer per row.
  return Array.from({ length: n }, (_, i) => ({ kind, id: uuid(from + i), extra: kind === "dropped" ? { code: "c", reason: "r" } : {} }));
}

test("cap hit with progress: re-dispatch, next depth, and the no-progress ids carried", async () => {
  // 3 rows, cap 3: one dropped (progress), one still thin, one retry later.
  const r = await runScript(
    [{ kind: "dropped", id: uuid(1), extra: { code: "c", reason: "r" } }, { kind: "still_thin", id: uuid(2), extra: { reason: "x" } }, { kind: "retry_later", id: uuid(3), extra: { reason: "y" } }],
    { MAX_ROWS: "3", CHAIN_DEPTH: "2" },
  );
  // A normal run.
  assert.equal(r.code, 0, r.stdout);
  // The chain continues.
  assert.equal(r.outputs.redispatch, "true");
  // One deeper.
  assert.equal(r.outputs.next_depth, "3");
  // Only the rows still at passed_filters ride along; the dropped row has left the status.
  assert.equal(r.outputs.carry_skip_ids, `${uuid(2)},${uuid(3)}`);
});

test("carried ids are sent as skip_ids from the first call, so the chain walks past thin rows", async () => {
  // Two ids from the previous link.
  const carried = `${uuid(90)},${uuid(91)}`;
  // One row, then none.
  const r = await runScript(many(1, "dropped"), { MAX_ROWS: "5", CARRY_SKIP_IDS: carried });
  // Normal.
  assert.equal(r.code, 0, r.stdout);
  // The very first call already skips them.
  assert.deepEqual(r.skipLists[0], [uuid(90), uuid(91)]);
  // And the second call adds the row this run tried.
  assert.deepEqual(r.skipLists[1], [uuid(90), uuid(91), uuid(1)]);
});

test("'none' before the cap: the backlog is empty, no re-dispatch", async () => {
  // Two rows then none, cap 30.
  const r = await runScript(many(2, "dropped"), {});
  // Normal.
  assert.equal(r.code, 0, r.stdout);
  // Done.
  assert.equal(r.outputs.redispatch, "false");
});

test("cap hit with zero progress: no re-dispatch (a chain must shrink the backlog to continue)", async () => {
  // Every row still thin.
  const r = await runScript(many(3, "still_thin"), { MAX_ROWS: "3" });
  // Normal.
  assert.equal(r.code, 0, r.stdout);
  // A chain over rows nothing can fill would loop until the depth cap for nothing.
  assert.equal(r.outputs.redispatch, "false");
});

test("depth cap: the last link never re-dispatches, whatever the progress", async () => {
  // Full progress at the cap depth.
  const r = await runScript(many(3, "dropped"), { MAX_ROWS: "3", CHAIN_DEPTH: "8" });
  // Normal.
  assert.equal(r.code, 0, r.stdout);
  // The backstop holds.
  assert.equal(r.outputs.redispatch, "false");
});

test("carry would exceed the function's 200-id limit: no re-dispatch rather than a refused first call", async () => {
  // 180 carried ids plus 30 new thin-but-progressing mix would pass 200.
  const carried = Array.from({ length: 180 }, (_, i) => uuid(1000 + i)).join(",");
  // 29 still thin + 1 progress, cap 30.
  const r = await runScript([...many(29, "still_thin"), ...many(1, "dropped", 500)], { MAX_ROWS: "30", CARRY_SKIP_IDS: carried });
  // Normal run.
  assert.equal(r.code, 0, r.stdout);
  // 180 + 29 = 209 > 200: the next link would be refused by parseSkipIds, so it is not started.
  assert.equal(r.outputs.redispatch, "false");
});

test("carry under 200 but too big for the next link's own tries: no re-dispatch", async () => {
  // 150 carried ids plus 25 still thin + 5 progress, cap 30: carry 175 is under 200 on its own.
  const carried = Array.from({ length: 150 }, (_, i) => uuid(2000 + i)).join(",");
  // The run itself is normal.
  const r = await runScript([...many(25, "still_thin"), ...many(5, "dropped", 600)], { MAX_ROWS: "30", CARRY_SKIP_IDS: carried });
  // Normal run.
  assert.equal(r.code, 0, r.stdout);
  // The next link sends carry + up to 29 tried ids: 175 + 29 = 204 > 200, refused mid-run with HTTP 400.
  assert.equal(r.outputs.redispatch, "false");
});

test("row errors: the verdict is still written, then the run goes red", async () => {
  // Progress then an error, cap 2.
  const r = await runScript([...many(1, "dropped"), { kind: "error", id: uuid(2), extra: { message: "m" } }], { MAX_ROWS: "2" });
  // Red, so the error is seen.
  assert.equal(r.code, 1);
  // But the backlog still gets its next link (a row error is per-row, as apply-kit treats it).
  assert.equal(r.outputs.redispatch, "true");
});

test("malformed inputs are refused, never read as a default", async () => {
  // A non-uuid carried id.
  const bad = await runScript([], { CARRY_SKIP_IDS: "not-a-uuid" });
  // Refused.
  assert.equal(bad.code, 1);
  // A non-numeric depth.
  const badDepth = await runScript([], { CHAIN_DEPTH: "x" });
  // Refused.
  assert.equal(badDepth.code, 1);
});

test("triggers: three cron slots, workflow_run after the ATS scout by its exact name, and dispatch inputs", () => {
  // The `on:` block, comments dropped.
  const on = block(codeLines(YML), "on:");
  // Trigger names at two spaces.
  const keys = on.flatMap((l) => /^ {2}([a-z_]+):/.exec(l)?.[1] ?? []);
  // Exactly these three.
  assert.deepEqual(keys.sort(), ["schedule", "workflow_dispatch", "workflow_run"]);
  // The three slots.
  assert.ok(on.includes("    - cron: '7 5,13,21 * * *'"), "three daily slots");
  // scout.yml's real name, read from the file, so a rename there turns this red.
  const scoutName = /^name: (.+)$/m.exec(SCOUT)?.[1];
  // The anchor must exist.
  assert.ok(scoutName, "scout.yml has a name");
  // workflow_run matches by name.
  assert.ok(on.includes(`    workflows: ['${scoutName}']`), `workflow_run names ${scoutName}`);
  // The chain's two inputs exist.
  assert.ok(on.some((l) => l.trim() === "chain_depth:") && on.some((l) => l.trim() === "carry_skip_ids:"), "chain inputs");
});

test("permissions: actions: write ONLY on the redispatch job, which passes the verdict as data", () => {
  // Split at the redispatch job.
  const [head, job] = YML.split("\n  redispatch:\n");
  // The job must exist.
  assert.ok(job !== undefined, "redispatch job exists");
  // The top level and the refetch job never hold actions: write.
  assert.ok(!/^\s*actions: write/m.test(codeLines(head!).join("\n")), "no actions: write before the redispatch job");
  // The redispatch job does.
  assert.ok(/\n {4}permissions:\n(?: {6}#.*\n)* {6}actions: write\n/.test(job!), "actions: write on redispatch");
  // It reads the verdict exactly.
  assert.ok(job!.includes("if: ${{ !cancelled() && needs.refetch.outputs.redispatch == 'true' }}"), "verdict gate");
  // Inputs travel through env, never interpolated into the shell line.
  assert.ok(job!.includes('gh workflow run jd-refetch.yml --ref main --repo "$REPO" -f chain_depth="$NEXT_DEPTH" -f carry_skip_ids="$CARRY"'), "dispatch line");
  // The refetch job exposes the three outputs.
  for (const name of ["redispatch", "next_depth", "carry_skip_ids"]) assert.ok(head!.includes(`${name}: \${{ steps.refetch.outputs.${name} }}`), name);
});
