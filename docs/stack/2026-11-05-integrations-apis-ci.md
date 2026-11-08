# Third-party integrations, APIs and CI/CD

_Last verified against code: 2026-11-08 (2a9ac31)._

Repo `MallamTeja/applyyy`, **private**, default branch `main`. Secrets are named here, never
their values. GitHub state (secrets, variables) was read with `gh` on 2026-11-08.

## Third-party integrations

| Service | Used for | Used by | Auth | State |
|---|---|---|---|---|
| **Supabase** | Postgres 17, Auth (password grant, signup disabled), Storage, edge functions | every component | `SUPABASE_URL`, `SUPABASE_ANON_KEY` + app-user email/password | live |
| **Vercel** | static SPA hosting + one Node function | `apps/web`, `api/` | Git integration | auto-deploys `main` to Production; no deploys for the `automation-keepalive` branch (`vercel.json` `git.deploymentEnabled`) |
| **GitHub Actions** | CI and the only scheduler | `.github/workflows/` | repo secrets (below) | free plan, private repo |
| **GitHub REST API** | start `apply.yml` / `apply-kit.yml` on approve | edge `dispatch-apply` | Supabase function secret `GITHUB_APPLY_DISPATCH_TOKEN` (fine-grained PAT, this repo only) | live; the live drain is behind `auto_apply_on_approve` |
| **Google Gemini** | LLM `generateContent` | 9 edge functions | `GEMINI_API_KEY_NN`, `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL` | live; key pool in `gemini_key_state` |
| Gemini Google Search grounding | web job discovery | `scout-web` | Gemini keys | live |
| **Greenhouse** board API | job polling + apply forms | scout, worker `form-url.ts` | none (public) | ON |
| **Lever** postings API | polling | scout | none | ON |
| **Ashby** posting API | polling | scout | none | ON |
| **Workday** CXS API | polling (applying routes to a human) | scout, worker `workday.ts` guard | none | ON |
| SmartRecruiters API | — | — | — | **removed**: robots.txt `Disallow: /`; adapter deleted (commit `2fe0264`) |
| RemoteOK · Jobicy · Arbeitnow | remote job feeds | `worker/src/scout/remote-feeds.ts` | none | ON (daily) |
| LinkedIn guest jobs API | reading a pasted LinkedIn link | `job-link-intake/page-readers.ts` | none | ON |
| X (Twitter) oEmbed | reading a pasted X post | `job-link-intake/page-readers.ts` | none | ON |
| **Google Apps Script + Gmail** | email tracking (receipts, interviews, rejections, job alerts) | `email-tracker.gs` → `email-tracker-intake`; `gmail-sync` | `EMAIL_INTAKE_SHARED_SECRET` (intake); `APPLYY_GMAIL_SYNC_URL` + `APPLYY_GMAIL_SYNC_SECRET` (sync) | hourly trigger |
| `@sparticuz/chromium` | headless Chromium in a serverless function | `api/render-job-page.ts` | caller's Supabase JWT | ON |
| Google Fonts | web fonts | `apps/web/index.html` | none | ON (allowed in CSP) |
| Gmail / LinkedIn deep links | compose, open message, people search (links only, no API) | follow-up, emails, referral pages | none | ON |

Written but not wired: **Workable**, **Adzuna** and **Jooble** adapters in
`supabase/functions/_shared/scout/adapters/`. Nothing registers or imports them.

Not used: no payment, analytics, error-tracking (Sentry etc.) or email-sending service. The
system sends no email. It only drafts.

## APIs consumed (outbound)

| Host / path | Purpose | Caller |
|---|---|---|
| `generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | LLM (key in the `x-goog-api-key` header) | `_shared/gemini/client.ts` |
| `vertexaisearch.cloud.google.com/grounding-api-redirect/…` | resolve grounding redirects | `scout-web` |
| `boards-api.greenhouse.io/v1/boards/{token}/jobs`, `job-boards.greenhouse.io` | board + form | scout, worker |
| `api.lever.co/v0/postings/{token}` | board | scout |
| `api.ashbyhq.com/posting-api/job-board/{token}` | board | scout |
| `{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` | board | scout |
| `remoteok.com/api`, `jobicy.com/api/v2/remote-jobs`, `www.arbeitnow.com/api/job-board-api` | feeds | worker |
| `www.linkedin.com/jobs-guest/jobs/api/jobPosting/{id}`, `publish.x.com/oembed` | pasted links | `job-link-intake` |
| a posting's own page | liveness probe: retire a row whose page answers 404/410 | `scout-ats` (`_shared/scout/feed-liveness.ts`, through the SSRF guard) |
| any employer apply page + its `/robots.txt` | form fill + robots gate | worker applier |
| `applyyy.vercel.app/api/render-job-page` | render a JS-only page | `job-link-intake` |
| Apps Script web app `/exec` (`APPLYY_GMAIL_SYNC_URL`) | on-demand Gmail sync | `gmail-sync` |
| `api.github.com/repos/MallamTeja/applyyy/actions/workflows/{apply,apply-kit}.yml/dispatches` | start workflows | `dispatch-apply/handler.ts` |

Regenerate the host list:
`git grep -hoE "https://[a-z0-9.-]+" -- supabase/functions worker/src apps/web/src api packages | sort | uniq -c`
(test fixtures such as `example.com` appear too; ignore them).

## APIs exposed (inbound)

| Surface | Endpoints | Auth |
|---|---|---|
| Supabase edge functions | `https://xynqxekcqizwhtskzqrq.supabase.co/functions/v1/{slug}` | gateway JWT, except the five with `verify_jwt = false` (`email-tracker-intake`, `normalizer`, `screener`, `auditor`, `scout-ats`), which authenticate in code. Every function now has a `[functions.*]` block in `supabase/config.toml` |
| CORS | browser calls | only `https://applyyy.vercel.app` and `http://localhost:5173` get an `Access-Control-Allow-Origin` (`supabase/functions/_shared/cors.ts` `ALLOWED_ORIGINS`) |
| PostgREST RPCs (`authenticated` only) | see [database](2026-11-05-database.md#functions) | user JWT + agent key for machine paths |
| PostgREST tables | `public` tables under RLS (`authenticated` only) | user JWT |
| Supabase Auth | `/auth/v1/token?grant_type=password` | signup disabled |
| Vercel | `POST /api/render-job-page` `{url}` | `Bearer <Supabase JWT>` of the app user; SSRF checks (`api/render-job-page.ts`) |
| Apps Script | `doPost` sync web app (`doGet` refuses) | shared secret |

JWT posture regenerate:
`awk '/^\[functions\./{f=$0} /^verify_jwt/{print f, $0}' supabase/config.toml`.

## CI/CD workflows

13 workflows as of 2026-11-08 (`ls .github/workflows`). Every `uses:` line is pinned to a
40-character commit SHA. Check with
`git grep -hE "uses: " -- .github/workflows | grep -vcE "@[0-9a-f]{40}"` (expect 0). The
repo does not enforce SHA pinning; it is a convention.

| Workflow | Trigger (UTC → IST) | What runs |
|---|---|---|
| `ci.yml` | push + PR to `main` (not docs-only pushes: `paths-ignore`) | one job: deno check (v2.9.6, with a file-count assertion), edge tests, shared-types tests, package tests, web tsc + vite build + e2e build + tests, render-function check, worker tsc + vitest, **gitleaks** over the pushed commits |
| `scout.yml` | `17 0,12 * * *` and `17 4 * * *` → 05:47, 17:47 and 09:47 | worker `scout` |
| `scout-remote.yml` | `30 1 * * *` → 07:00 | worker `scout:remote` |
| `apply.yml` | `30 2 * * *` → 08:00 (GitHub often starts it hours late) + dispatch | worker `apply`. **Dry on schedule** unless the repo variable `APPLYY_CRON_LIVE` is `true`. A live dispatch needs `apply_only_id` or `drain_approved=true` |
| `apply-kit.yml` | `0 12 * * *` → 17:30, `workflow_run` after apply, and dispatch (from `dispatch-apply`) | worker `apply-kit` |
| `satellites.yml` | `23 13 * * *` → 18:53 | 5 satellite functions (only when `APPLYY_SATELLITES_LIVE=true`) |
| `keepalive.yml` | `15 6 */3 * *` → 11:45 every 3rd day | DB ping + push to `automation-keepalive` |
| `jobs-tombstone.yml` | `45 6 * * 0` → Sunday 12:15 | `tombstone_dropped_jobs` RPC in batches |
| `run-one.yml` | dispatch (`application_id`) | matcher → tailor → auditor for one row |
| `ingest-links.yml` | dispatch (`list`, `dry_run`) | POSTs links to `job-link-intake` |
| `prescreen-drain.yml` | dispatch | normalizer → screener |
| `postscreen-drain.yml` | dispatch (`from_stage`) | matcher → tailor → auditor |
| `pregate-sweep.yml` | dispatch | `matcher?mode=pregate_only` |

GitHub cron is best effort. Read real start times with `gh run list`.

**Repo secrets** (as of 2026-11-08, `gh secret list`): `APPLYY_AGENT_KEY`,
`APPLYY_APP_USER_EMAIL`, `APPLYY_APP_USER_PASSWORD`, `STORAGE_STATE_ENC_KEY`,
`SUPABASE_ANON_KEY`, `SUPABASE_URL`. **Variables** (`gh variable list`):
`APPLYY_SATELLITES_LIVE`. `APPLYY_CRON_LIVE` is not set. No `dependabot.yml`, CODEOWNERS or
Renovate config is tracked.

Edge-function secrets live in Supabase, not GitHub. List their names with
`supabase secrets list` (names only; never copy a value or digest into a doc).

## Hosting configuration

**`vercel.json`:**
- `outputDirectory: apps/web/dist`, an SPA rewrite to `/index.html`.
- `ignoreCommand`: skip the build unless `apps/web`, `packages`, `supabase/functions/_shared`,
  `api`, `vercel.json` or a root manifest changed.
- `git.deploymentEnabled`: no deploys for the `automation-keepalive` branch.
- `functions["api/render-job-page.ts"]`: `maxDuration 60`, `includeFiles` the Chromium binary.
- Headers: `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`.
- CSP: `script-src 'self'` + 2 hashes; `connect-src` only `'self'` and the Supabase project
  (https + wss); `frame-ancestors 'none'`, `object-src 'none'`. The Apps Script hosts were
  removed: the browser no longer calls Apps Script (`gmail-sync` does).
- **No Vercel crons.**

**`supabase/config.toml`:** API schema `public` only, `max_rows = 1000`, Postgres 17,
`jwt_expiry = 3600`, refresh-token rotation on, `enable_signup = false`, per-function
`verify_jwt`.
