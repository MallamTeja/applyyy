/* Vercel's Ignored Build Step must not skip a web change that is not the LAST commit of a push.
 *
 * WHY (2026-11-01 wiring audit, W11). The old command was `git diff --quiet HEAD^ HEAD -- <web paths>`,
 * so it looked at the push's final commit only. Push head 78e5126 touched no web path and was
 * "Canceled by Ignored Build Step" while it carried 681b78e (the Manual apply page); push head
 * 90e005f did the same to a vite security bump. The skip shows green, so nothing flagged it.
 *
 * WHAT THIS RUNS. The real command, read out of vercel.json, inside a throwaway git repo shaped like
 * that push: an old deployed commit, a web commit, then a docs-only head. Vercel's contract
 * (docs: "Ignored Build Step"): exit 0 = skip the build, any other exit = build. Running the command
 * itself, not matching its text, is what makes this red on a revert to `HEAD^`. */

import assert from 'node:assert/strict';
// spawnSync: the command is a shell line, and each case needs its exit code, not its output.
import { spawnSync } from 'node:child_process';
// A temp dir per run, removed after, so no fixture lands in the repo.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
// The OS temp root; never the working tree four sessions share.
import { tmpdir } from 'node:os';
// join for paths inside the fixture repo.
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

// The command Vercel runs, straight from the root config (the only vercel.json since 2026-10-24).
const ignoreCommand = (JSON.parse(readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8')) as { ignoreCommand?: unknown }).ignoreCommand;

// The fixture repo; set in before(), removed in after().
let repo = '';
// The three commits, named for their role in the 78e5126 push.
let deployed = '';
// The web commit that the old command skipped.
let webCommit = '';
// The docs-only push head.
let head = '';

// Environment for every git call: no user or system config, so a global hook, signing setting
// or template on this machine cannot change what the fixture contains.
const hermetic = (): NodeJS.ProcessEnv => ({
  // Keep PATH and the rest, so `git` and `sh` resolve.
  ...process.env,
  // An empty file in the fixture dir stands in for ~/.gitconfig.
  GIT_CONFIG_GLOBAL: join(repo, '..', 'empty-gitconfig'),
  // And /etc/gitconfig is skipped.
  GIT_CONFIG_NOSYSTEM: '1',
});

// Runs git in the fixture and returns trimmed stdout; throws on failure so setup errors are loud.
function git(...args: string[]): string {
  // Identity passed per call: the hermetic env has no user config to supply one.
  const result = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: repo, env: hermetic(), encoding: 'utf8' });
  // A failed setup step would make every case below meaningless.
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  // The SHA for rev-parse; ignored elsewhere.
  return result.stdout.trim();
}

// Writes one file and commits it, returning the new commit's SHA.
function commitFile(path: string, content: string): string {
  // Nested dirs (apps/web/src) must exist before the write.
  mkdirSync(join(repo, path, '..'), { recursive: true });
  // The change itself.
  writeFileSync(join(repo, path), content);
  // Stage exactly this file.
  git('add', '--', path);
  // One commit per call, so each SHA has one role.
  git('commit', '-q', '-m', `touch ${path}`);
  // The SHA Vercel would see.
  return git('rev-parse', 'HEAD');
}

// Exit code of the ignore command at HEAD, with VERCEL_GIT_PREVIOUS_SHA set (or absent for undefined).
function runIgnore(previousSha: string | undefined): number | null {
  // Fresh env copy, so deleting the variable never leaks into another case.
  const env = hermetic();
  // Unset is a real case: a branch's first deployment has no previous SHA.
  if (previousSha === undefined) delete env['VERCEL_GIT_PREVIOUS_SHA'];
  // Otherwise the SHA Vercel would inject.
  else env['VERCEL_GIT_PREVIOUS_SHA'] = previousSha;
  // `sh -c`: Vercel runs the command through a shell, so its quoting and && behave the same here.
  return spawnSync('sh', ['-c', ignoreCommand as string], { cwd: repo, env, encoding: 'utf8' }).status;
}

describe('vercel.json ignoreCommand (W11)', () => {
  before(() => {
    // A unique dir under the OS temp root.
    const root = mkdtempSync(join(tmpdir(), 'applyyy-ignore-'));
    // The repo lives one level down so the empty gitconfig can sit beside it.
    repo = join(root, 'repo');
    // Created before any git call.
    mkdirSync(repo);
    // The stand-in for ~/.gitconfig, empty on purpose.
    writeFileSync(join(root, 'empty-gitconfig'), '');
    // A plain repo; the default branch name is irrelevant here.
    git('init', '-q');
    // The last commit Vercel built: what VERCEL_GIT_PREVIOUS_SHA points at.
    deployed = commitFile('apps/web/src/page.ts', 'v1\n');
    // The web change in the middle of the push (681b78e's role).
    webCommit = commitFile('apps/web/src/page.ts', 'v2\n');
    // The docs-only push head (78e5126's role).
    head = commitFile('docs/note.md', 'notes\n');
  });

  after(() => {
    // repo is <root>/repo; remove the whole root, gitconfig included.
    if (repo !== '') rmSync(join(repo, '..'), { recursive: true, force: true });
  });

  it('is a shell string in vercel.json', () => {
    // Every other case runs it; a missing or non-string value would make them test nothing.
    assert.equal(typeof ignoreCommand, 'string', 'vercel.json must carry ignoreCommand as a string');
  });

  it('BUILDS a push whose last commit is docs-only but which carries a web commit', () => {
    // The 78e5126 push: previous deploy, then a web commit, then a docs head. Must not be 0 (skip).
    assert.notEqual(runIgnore(deployed), 0, 'a web change earlier in the push was skipped (the W11 bug)');
  });

  it('SKIPS a push that touched no build input since the last deploy', () => {
    // Non-vacuity: a command that always builds would pass every other case. Since webCommit was
    // deployed, only docs changed, so this must be exactly 0.
    assert.equal(runIgnore(webCommit), 0, 'a docs-only push must still skip the build');
  });

  it('BUILDS when VERCEL_GIT_PREVIOUS_SHA is unset (a branch\'s first deployment)', () => {
    // No baseline to compare against: building is the only safe answer.
    assert.notEqual(runIgnore(undefined), 0, 'an unset previous SHA must build');
  });

  it('BUILDS when the previous SHA is not in the clone (Vercel clones shallow)', () => {
    // git diff on an unknown object exits 128, which Vercel reads as "build": fail-safe.
    assert.notEqual(runIgnore('0'.repeat(40)), 0, 'an unknown previous SHA must build');
    // The head commit still exists, so the case above failed on the SHA, not on a broken fixture.
    assert.equal(git('cat-file', '-t', head), 'commit');
  });
});
