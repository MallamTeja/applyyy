# Third-party integrations, APIs and CI/CD — snapshot 2026-11-05

**Dated record — never edited.** Code at `00ecabb`. GitHub state was read with `gh` the same
night: repo `MallamTeja/applyyy`, **private**, default branch `main`. Secrets are listed by
name only.

## Third-party integrations: 17 external services

| # | Service | Used for | Used by | Auth | State |
|---|---|---|---|---|---|
| 1 | **Supabase** | Postgres 17, Auth (password grant, signup disabled), Storage, 17 edge functions | every component | `SUPABASE_URL`, `SUPABASE_ANON_KEY` + app-user email/password | live |
| 2 | **Vercel** | static SPA hosting + one Node function | `apps/web`, `api/` | Git integration (`vercel[bot]`) | auto-deploys `main` to Production |
| 3 | **GitHub Actions** | CI and the only scheduler | `.github/workflows` | 6 repo secrets | free plan, private repo (minute budget noted in the `apply.yml` header) |
| 4 | **Google Gemini** | LLM `generateContent` | 9 edge functions | `GEMINI_API_KEY_NN`, `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL` | live; key pool in `gemini_key_state` |
| 5 | Gemini Google Search grounding | web job discovery | `scout-web` | Gemini keys | live |
| 6 | **Greenhouse** board API | job polling + apply forms | scout, worker `form-url.ts` | none (public) | ON |
| 7 | **Lever** postings API | polling | scout | none | ON |
| 8 | **Ashby** posting API | polling | scout | none | ON |
| 9 | **Workday** CXS API | polling (applying routes to a human) | scout, worker guard | none | ON |
| 10 | SmartRecruiters API | polling | scout | none | **OFF**: robots.txt `Disallow: /`, boards disabled 2026-11-01 |
| 11 | RemoteOK · Jobicy · Arbeitnow | remote job feeds | worker `scout-remote.ts` | none | ON (daily) |
| 12 | LinkedIn guest jobs API | reading a pasted LinkedIn link | `job-link-intake` | none | ON |
| 13 | X (Twitter) oEmbed | reading a pasted X post | `job-link-intake` | none | ON |
| 14 | **Google Apps Script + Gmail** | email tracking (receipts, interviews, rejections) | `email-tracker.gs` → `email-tracker-intake`; `gmail-sync` | `X-Applyy-Intake-Secret` (= `EMAIL_INTAKE_SHARED_SECRET`); sync secret | hourly trigger |
| 15 | `@sparticuz/chromium` | headless Chromium in a serverless function | `api/render-job-page.ts` | caller's Supabase JWT | ON |
| 16 | Google Fonts | Inter, IBM Plex Mono/Serif | `apps/web/index.html` | none | ON (allowed in CSP) |
| 17 | Gmail / LinkedIn deep links | compose, open message, people search (links only, no API) | follow-up, emails, referral pages | none | ON |

Written but not wired: **Workable** (adapter, not registered), **Adzuna** and **Jooble**
(adapters + env names `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, `JOOBLE_API_KEY`, no importer).

Not used: no payment, analytics, error-tracking (Sentry etc.) or email-sending service. The
system sends no email. It only drafts.

## APIs consumed (outbound)

| Host / path | Purpose | Caller |
|---|---|---|
| `generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | LLM (key in `x-goog-api-key` header) | `_shared/gemini/client.ts` |
| `vertexaisearch.cloud.google.com/grounding-api-redirect/…` | resolve grounding redirects | `scout-web` |
| `boards-api.greenhouse.io/v1/boards/{token}/jobs`, `job-boards.greenhouse.io` | board + form | scout, worker |
| `api.lever.co/v0/postings/{token}` | board | scout |
| `api.ashbyhq.com/posting-api/job-board/{token}` | board | scout |
| `{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` | board | scout |
| `api.smartrecruiters.com/v1/companies/{token}/postings` | board (data-disabled) | scout |
| `remoteok.com/api`, `jobicy.com/api/v2/remote-jobs`, `www.arbeitnow.com/api/job-board-api` | feeds | worker |
| `www.linkedin.com/jobs-guest/jobs/api/jobPosting/{id}`, `publish.x.com/oembed` | pasted links | `job-link-intake` |
| any employer apply page + its `/robots.txt` | form fill + robots gate | worker applier |
| `applyyy.vercel.app/api/render-job-page` | JS-only page render | `job-link-intake` |
| Apps Script web app `/exec` (`APPLYY_GMAIL_SYNC_URL`) | on-demand Gmail sync | `gmail-sync` |
| `api.adzuna.com`, `jooble.org/api`, `apply.workable.com` | — | unwired adapters |

## APIs exposed (inbound)

| Surface | Endpoints | Auth |
|---|---|---|
| Supabase edge functions | `https://xynqxekcqizwhtskzqrq.supabase.co/functions/v1/{slug}` × 17 | gateway JWT on 12. The 5 with `verify_jwt=false` (email-tracker-intake, normalizer, screener, auditor, scout-ats) authenticate in code |
| PostgREST RPCs (`authenticated` only) | `advance_application_status`, `application_status_counts`, `bootstrap_user_defaults`, `claim_applications`, `claim_gemini_key`, `pacific_today`, `release_application_claim`, `report_gemini_result`, `sweep_stale_claims` | user JWT + agent key for machine paths |
| PostgREST tables | 20 `public` tables under RLS (`authenticated` only) | user JWT |
| Supabase Auth | `/auth/v1/token?grant_type=password` | signup disabled |
| Vercel | `POST /api/render-job-page` `{url}` | `Bearer <Supabase JWT>` of `APP_USER_ID`; SSRF layers, 45 s budget, 5 redirects |
| Apps Script | `doPost` sync web app (`doGet` refuses) | shared secret |

## CI/CD: 12 workflows

All 39 `uses:` lines are pinned to a 40-char SHA. They cover 5 actions: `actions/checkout`,
`actions/setup-node`, `actions/cache`, `pnpm/action-setup`, `denoland/setup-deno`. The repo
setting `sha_pinning_required` is `false`, so this is convention, not enforcement.

| Workflow | Trigger (UTC → IST) | What runs | Last result (last 40 runs) |
|---|---|---|---|
| `ci.yml` | push + PR to `main` | 6 jobs: deno-check (v2.9.6), edge-tests, shared-types-tests, package-tests, web (tsc + vite build + e2e build + tests + `api/` check), worker (tsc + vitest) | success 11-04 (3 failures earlier that day) |
| `scout.yml` | `17 0,12 * * *` → 05:47 + 17:47 | worker `scout` | success |
| `scout-remote.yml` | `30 1 * * *` → 07:00 | worker `scout:remote` | success |
| `apply.yml` | `30 2 * * *` → 08:00 (really starts ~7 h late) | worker `apply`, cap 3. **Dry on schedule**: `APPLYY_CRON_LIVE` is unset | success |
| `apply-kit.yml` | `0 12 * * *` → 17:30 + `workflow_run` after apply | worker `apply-kit` | success |
| `satellites.yml` | `23 13 * * *` → 18:53 | 5 satellite functions (gated by `APPLYY_SATELLITES_LIVE=true`) | success |
| `keepalive.yml` | `15 6 */3 * *` → 11:45 every 3rd day | DB query + push to `automation-keepalive` (the only `contents: write`) | success |
| `run-one.yml` | dispatch (`application_id`) | matcher → tailor → auditor for one row | success |
| `ingest-links.yml` | dispatch (`list`, `dry_run`) | POSTs links to `job-link-intake` | not in window |
| `prescreen-drain.yml` | dispatch | normalizer → screener | not in window |
| `postscreen-drain.yml` | dispatch (`from_stage`) | matcher → tailor → auditor | **failure** 11-02 |
| `pregate-sweep.yml` | dispatch | `matcher?mode=pregate_only` | success |

**Repo secrets (6):** `APPLYY_AGENT_KEY`, `APPLYY_APP_USER_EMAIL`, `APPLYY_APP_USER_PASSWORD`,
`STORAGE_STATE_ENC_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_URL`. **Variables (1):**
`APPLYY_SATELLITES_LIVE=true`. The environments `Production`, `Preview` and `copilot` are empty.
No `dependabot.yml`, CODEOWNERS or Renovate config is tracked. Dependabot alerts are on
(repo setting) without a config file.

Regenerate: `ls .github/workflows`, `grep -n "cron:" .github/workflows/*.yml`,
`gh secret list`, `gh variable list`, `gh run list --limit 40`.

## Hosting configuration

**`vercel.json`:**
- `outputDirectory: apps/web/dist`, an SPA rewrite to `/index.html`.
- `ignoreCommand`: skip the build unless `apps/web`, `packages`, `supabase/functions/_shared`, `api` or a root manifest changed.
- `functions["api/render-job-page.ts"]`: `maxDuration 60`, `includeFiles` the Chromium binary.
- Headers: `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`.
- CSP: `script-src 'self'` + 2 hashes, `frame-ancestors 'none'`, `object-src 'none'`.
- **No Vercel crons.**

The CSP `connect-src` still allows `script.google.com` and `script.googleusercontent.com`.
Nothing in `apps/web/src` calls them: the browser stopped calling Apps Script on 2026-10-23,
when `gmail-sync` took over. Removing them would tighten the CSP. This is listed in the
vulnerability doc.

**`supabase/config.toml`:** API schema `public` only, `max_rows 1000`, Postgres 17,
`jwt_expiry 3600`, refresh-token rotation on, `enable_signup = false`, no external OAuth
providers, per-function `verify_jwt`. `gmail-sync` has no block, so it gets the default (`true`).
