#!/usr/bin/env bash
# scripts/push-apps-script.sh — ship the Gmail email-tracker Apps Script at a PINNED git SHA.
#
# Usage: scripts/push-apps-script.sh <git-sha> "<why>" [--dry-run]
#
# WHY THIS EXISTS: the tracker used to be pasted into the Apps Script editor by hand, so
# nobody could say which commit was live. This builds the push from `git show <sha>:...`
# (never the working tree, which can hold a peer's unsaved edits), cuts an immutable
# version, and points the ONE existing web-app deployment at it. The Web App URL is
# baked into the intake path, so we always UPDATE that deployment and never create one.
#
# Safety: credentials stay in ~/.clasprc.json (clasp's own login); this script never
# reads, copies or prints it. All work happens in a throwaway temp dir, never the repo,
# so no .clasp.json can land in git. --dry-run stops before anything touches Google.

# Fail on any error, unset variable or failed pipe stage: a half-run deploy is worse than none.
set -euo pipefail

# The Apps Script project that holds the tracker (from the editor's Project Settings).
SCRIPT_ID='10uX0idYUjZkVQs6MFDxczrdsLZooV8DwQNdeU4ak6dLD_5P_yfp9XTQg'
# The live web-app deployment: its ID IS the Web App URL, so it must never change.
DEPLOYMENT_ID='AKfycbyH5ifSeEf-i_EQCtrLUVbQHcUb5oMNZJBcU4jH8h23gxp4HGSj5vv7OaNRgvmdXzVuYQ'
# Repo path of the tracker source; Apps Script stores it as Code.js on the server.
GS_PATH='supabase/functions/_shared/apps-script/email-tracker.gs'
# Repo path of the manifest (timeZone, webapp access) pulled from the live project.
MANIFEST_PATH='supabase/functions/_shared/apps-script/appsscript.json'

# First arg is the commit to ship; default empty so `set -u` gives our message, not bash's.
SHA_ARG="${1:-}"
# Second arg is the reason; it becomes the version and deployment description in Apps Script.
WHY="${2:-}"
# Third arg is the only optional flag; anything else is a typo we must not guess about.
MODE="${3:-}"

# No SHA means we cannot pin the source, so refuse rather than ship the working tree.
if [ -z "$SHA_ARG" ]; then
  # Print usage to stderr so a caller's stdout capture stays clean.
  echo "usage: $0 <git-sha> \"<why>\" [--dry-run]" >&2
  # Non-zero exit so a chained caller stops.
  exit 2
fi
# An empty reason leaves an anonymous version in Apps Script history; refuse it.
if [ -z "${WHY// /}" ]; then
  # Say exactly what is missing so the fix is obvious.
  echo "refused: <why> is empty; every version must say why it was cut" >&2
  # Distinct from a SHA error so scripts can tell them apart.
  exit 2
fi
# Accept only the one known flag: a mistyped --dryrun must not fall through to a REAL push.
if [ -n "$MODE" ] && [ "$MODE" != '--dry-run' ]; then
  # Name the bad flag so the typo is visible.
  echo "refused: unknown option '$MODE' (only --dry-run is accepted)" >&2
  # Stop before any side effect.
  exit 2
fi

# Run git from the repo root so the script works from any cwd inside the repo.
REPO_ROOT="$(git rev-parse --show-toplevel)"
# Resolve the arg to a full commit SHA; ^{commit} rejects trees, blobs and garbage.
if ! SHA="$(git -C "$REPO_ROOT" rev-parse --verify --quiet "${SHA_ARG}^{commit}")"; then
  # A bad SHA must never fall back to HEAD or the working tree.
  echo "refused: '$SHA_ARG' is not a commit in this repo" >&2
  # Exit before creating any temp dir.
  exit 2
fi

# Throwaway build dir: clasp pushes EVERY file in rootDir, so it must hold only our two files.
WORK="$(mktemp -d)"
# Remove it on any exit (success, failure or Ctrl-C) so no .clasp.json is left lying around.
trap 'rm -rf "$WORK"' EXIT

# MSYS_NO_PATHCONV stops Git Bash rewriting "<sha>:<path>" as a Windows path (known trap).
MSYS_NO_PATHCONV=1 git -C "$REPO_ROOT" show "$SHA:$GS_PATH" > "$WORK/Code.js"
# The manifest comes from the same pinned commit, so code and webapp settings ship as a pair.
MSYS_NO_PATHCONV=1 git -C "$REPO_ROOT" show "$SHA:$MANIFEST_PATH" > "$WORK/appsscript.json"
# Point clasp at the project; rootDir "." keeps it inside the temp dir.
printf '{"scriptId":"%s","rootDir":"."}\n' "$SCRIPT_ID" > "$WORK/.clasp.json"

# Hash what will ship, so the run log ties the live code to exact bytes.
CODE_SHA256="$(sha256sum "$WORK/Code.js" | cut -d' ' -f1)"
# Echo the pin first: it is the one fact a later reader needs from the log.
echo "commit:      $SHA"
# The byte fingerprint of Code.js, comparable to a later `clasp pull`.
echo "Code.js sha256: $CODE_SHA256"

# Dry run: show the plan and stop before anything talks to Google.
if [ "$MODE" = '--dry-run' ]; then
  # List the build dir so a stray extra file (which clasp would push) is visible.
  echo "files in $WORK:"
  # -A shows the dotfile .clasp.json too.
  ls -lA "$WORK"
  # The exact commands a real run issues, in order.
  echo "WOULD RUN (cwd $WORK):"
  # --force skips clasp's interactive "overwrite manifest?" prompt, which would hang here.
  echo "  clasp push --force"
  # --json makes the version number machine-readable instead of scraped from prose.
  echo "  clasp --json create-version \"$WHY\""
  # <n> is the number parsed from the previous step; nothing is guessed.
  echo "  clasp --json update-deployment $DEPLOYMENT_ID -V <n> -d \"$WHY\""
  # A dry run that reached here succeeded.
  exit 0
fi

# Every clasp call runs inside the temp dir so it reads that .clasp.json, not anything in the repo.
cd "$WORK"
# Upload Code.js + manifest; --force answers the manifest prompt non-interactively.
clasp push --force
# Cut an immutable version; --json prints {"versionNumber": N} on stdout.
VERSION_JSON="$(clasp --json create-version "$WHY")"
# Parse with node, never grep: accept only a positive integer, else print nothing.
VERSION="$(printf '%s' "$VERSION_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const n=JSON.parse(s).versionNumber;if(Number.isInteger(n)&&n>0)process.stdout.write(String(n))}catch{}})')"
# FAIL CLOSED: without -V, update-deployment would point the web app at @HEAD, an unversioned guess.
if [ -z "$VERSION" ]; then
  # Show what clasp said so the failure can be diagnosed.
  echo "refused to deploy: no version number in create-version output: $VERSION_JSON" >&2
  # Code is pushed but the live deployment is untouched; rerunning is safe.
  exit 1
fi
# Report the version before deploying it so a failed deploy still names it.
echo "created version: $VERSION"
# Repoint the ONE existing deployment at the new version; the Web App URL stays the same.
DEPLOY_JSON="$(clasp --json update-deployment "$DEPLOYMENT_ID" -V "$VERSION" -d "$WHY")"
# Confirm Google reports the deployment we asked for at the version we asked for.
if ! printf '%s' "$DEPLOY_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);process.exit(o.deploymentId===process.argv[1]&&String(o.versionNumber)===process.argv[2]?0:1)}catch{process.exit(1)}})' "$DEPLOYMENT_ID" "$VERSION"; then
  # The call returned but the result does not match: say so loudly rather than claim success.
  echo "deploy result does not match (want $DEPLOYMENT_ID @$VERSION): $DEPLOY_JSON" >&2
  # Non-zero so the caller checks the Apps Script UI.
  exit 1
fi
# One closing line with every fact a run log needs.
echo "deployed $DEPLOYMENT_ID @$VERSION from $SHA ($WHY)"
