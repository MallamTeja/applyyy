# Email tracker setup, and why we do NOT use the Gmail API

_Last verified against code: 2026-11-08 (2a9ac31)._

This guide covers the Gmail email tracker: a Google Apps Script that reads Teja's job mail
and sends it to the `email-tracker-intake` edge function. The canonical script is in the
repo: `supabase/functions/_shared/apps-script/email-tracker.gs`. The copy in Google's editor
is a deployment of that file, not the source of truth (`email-tracker.gs:4-8`).

---

## The decision first: no Gmail API

The Gmail API is the wrong tool here. This is written down so nobody rebuilds the broken
version later. The same reasons are in `email-tracker.gs:15-20` and `PROJECT_PLAN.md` §12.

1. **OAuth in "Testing" mode expires the refresh token every 7 days.** The tracker would
   work for a week, then stop **silently**. A board that quietly stopped updating is worse
   than no board.
2. **`gmail.readonly` is a restricted scope.** Moving the consent screen to production to
   fix (1) starts a verification review. That is too much for a personal tool.
3. **IMAP with an app password is closed for Workspace accounts since 14 March 2025.** This
   matters because `campushub@mlrit.ac.in` is a Workspace account.
4. **A Workspace admin can block third-party OAuth apps.** The college's IT could switch the
   tracker off.

### What we use instead: Google Apps Script

A short script bound to Teja's own Google account. It runs **as Teja**, inside his own
mailbox. No GCP project, no OAuth client, no consent screen, no refresh token to expire.
It runs on Google's servers for free.

> **The general lesson:** when a platform's official API is heavy, look for a
> **first-party scripting surface that already runs as you**. The same trick works for
> Sheets, Calendar and Drive. Use the API for someone else's data. Use the scripting
> surface for your own.

### Division of work: the script is a dumb pipe

```
Gmail (tejamallam00@gmail.com)
   |  Apps Script: hourly trigger (applyyInstallTrigger)
   |             + on-demand sync (doPost, called by gmail-sync, 60 s cooldown)
   |  sends: headers + plain body cut to 4096 chars
   v
Edge function email-tracker-intake
   |  deterministic classifier (_shared/email/classifier.ts), no LLM
   |  matches the email to an application, may advance its status
   v
Emails page (/emails) and the pipeline board
```

**All decisions live in the edge function, not the script.** The Apps Script editor is not
version-controlled, diffable, testable or reviewable. So the script does zero
classification (`email-tracker.gs:9-13`). The classifier is a normal unit under test
(`supabase/functions/_shared/email/classifier.ts`, `email-tracker-intake/decide.ts:13`).

---

## Mailbox: decided

**`tejamallam00@gmail.com`**, Teja's personal address. Decided 2026-09-09.

Not `campushub@mlrit.ac.in`: it is a Workspace account (reason 3), its admin can revoke
access (reason 4), and Teja loses it when he graduates, with every application's email
trail. `campushub@mlrit.ac.in` is only a Claude Code account identity here, never a
candidate mailbox.

## Ban risk: none

Apps Script reading your own inbox is a first-party feature doing what it was built for.
What **would** put the account at risk is automated outbound sending at volume. That is why
the referral agent only drafts, and Teja sends.

---

## How the script works

All names below are in `supabase/functions/_shared/apps-script/email-tracker.gs`.

### Searches

Each run makes **two** Gmail searches, then merges the threads and removes duplicates
(`applyySearchQueries_`, `applyySearchAll_`). Both searches share the same base:

```
newer_than:2d -label:applyy-ingested -category:social -category:forums { ...any of... }
```

| Search | Matches any of |
|---|---|
| Job lifecycle | mail **from** an ATS sender (`APPLYY_ATS_SENDERS`: Greenhouse, Lever, Ashby, Workday, SmartRecruiters and others), or a lifecycle phrase (`APPLYY_JOB_PHRASES`: "your application", "interview", "offer letter", ...) |
| Job boards and alerts (added 2026-11-05, commit `33df511`) | mail **from** a job board (`APPLYY_JOB_BOARD_SENDERS`: LinkedIn, Naukri, Indeed, Instahyre, Wellfound, Hirist, foundit, Cutshort, iimjobs), or alert wording (`APPLYY_ALERT_PHRASES`: "job alert", "jobs for you", ...) |

The sender lists must match `_shared/email/parser.ts`. `email-tracker.test.ts` fails if they
differ. The intake stores job-board mail as class `job_alert` (migration
`20261105124500_email_class_job_alert.sql`).

`APPLYY_MAX_THREADS` (200) caps the whole run, across both searches.

### Payload

For each message: `message_id`, `thread_id`, `from`, `to`, `subject`, `snippet`,
`received_at`, `label_ids` and `authentication_results`.

- `snippet` is the plain body, whitespace-collapsed and cut to 4096 characters
  (`APPLYY_SNIPPET_LIMIT`). Never the full body.
- `authentication_results` is Gmail's own topmost `Authentication-Results` header
  (`applyyTopAuthResults_`). It is used only to verify a receipt (see below).
- Messages are sent in batches of 50 (`APPLYY_BATCH_SIZE`).

### Sending and labels

- The script POSTs each batch to `email-tracker-intake` with the header
  `X-Applyy-Intake-Secret` (`applyyPostBatch_`; the intake reads it in
  `_shared/intake/auth.ts`).
- Only `202` counts as success. On 202 the script adds the Gmail label `applyy-ingested` to
  the threads. Nothing is marked read, archived or moved.
- A double run is harmless. The intake inserts with
  `onConflict: "user_id,provider_message_id"` and `ignoreDuplicates`
  (`email-tracker-intake/index.ts:410-412`).
- **Heartbeat:** when there is no new mail, the script still POSTs an empty batch
  (`applyyPostBatch_([], config)` in `applyyIngest`). The intake records every authorized
  call in `agent_runs` as agent `tracker` (`email-tracker-intake/index.ts:208`). So "no
  mail" and "tracker dead" look different.

### Running mode (Teja, 2026-10-23)

- **Hourly background trigger.** `applyyInstallTrigger` installs one time-driven
  `applyyIngest` trigger, every hour (`email-tracker.gs:601`). It removes older copies first,
  so running it twice is safe.
- **On-demand sync.** The `/emails` page calls the `gmail-sync` edge function with the
  user's JWT. `gmail-sync` POSTs to the script's Web App URL with its own secret in the body.
  The script runs at most once a minute. The cooldown is enforced **in the script**, with the
  Script Property `APPLYY_LAST_ONDEMAND_RUN` (`email-tracker.gs:743-767`), because a browser
  debounce is only advisory: two open tabs would both fire.
- `doGet` refuses every request (`email-tracker.gs:669`). A secret in a URL lands in Google's
  request logs, so only `doPost` with the secret in the JSON body is accepted (W16,
  2026-11-02).

The old route put the Web App URL with `?secret=` into `VITE_EMAIL_SYNC_WEBHOOK_URL`. A
`VITE_` variable compiles into the public bundle, so the browser carried the secret. That
route is gone. Remove any `VITE_EMAIL_SYNC_WEBHOOK_URL` from `.env.local`.

---

## Configuration

Names only. Never write a secret's value into a doc, the repo or a chat.

### Apps Script: Project Settings, then Script Properties

| Property | Value |
|---|---|
| `APPLYY_INTAKE_URL` | `https://xynqxekcqizwhtskzqrq.supabase.co/functions/v1/email-tracker-intake` |
| `APPLYY_INTAKE_SECRET` | the same value as the Supabase secret `EMAIL_INTAKE_SHARED_SECRET` |
| `APPLYY_SYNC_SECRET` | a **different** value, the same as the Supabase secret `APPLYY_GMAIL_SYNC_SECRET` |
| `APPLYY_LAST_ONDEMAND_RUN` | written by the script itself; do not set it |

An unset `APPLYY_SYNC_SECRET` fails closed: on-demand sync is refused.

The manifest is in the repo: `supabase/functions/_shared/apps-script/appsscript.json`
(time zone `Asia/Kolkata`, runtime V8, Web App executes as the deploying user).

### Supabase edge function secrets

| Secret | Used by | Purpose |
|---|---|---|
| `EMAIL_INTAKE_SHARED_SECRET` | `email-tracker-intake` | checks the `X-Applyy-Intake-Secret` header (`_shared/intake/auth.ts:20`) |
| `APPLYY_GMAIL_SYNC_URL` | `gmail-sync` | the script's Web App `/exec` URL, with no query string (`gmail-sync/index.ts:60`) |
| `APPLYY_GMAIL_SYNC_SECRET` | `gmail-sync` | sent in the POST body to the script (`gmail-sync/respond.ts:34`) |
| `APPLYY_APP_USER_EMAIL`, `APPLYY_APP_USER_PASSWORD` | `email-tracker-intake` (via `_shared/db/client.ts:55-57`) | the intake signs in as the app user so it writes under RLS |
| `APPLYY_AGENT_KEY` | `email-tracker-intake` (via `_shared/db/agent-key.ts:20`) | sent as the `x-applyy-agent-key` header; needed to advance statuses as agent `tracker` |

Until `APPLYY_GMAIL_SYNC_URL` and `APPLYY_GMAIL_SYNC_SECRET` are set, `gmail-sync` returns
`503 {"ok":false,"error":"gmail sync not configured"}` (`gmail-sync/respond.ts:68`). Nothing
else breaks.

**The agent key is fail-closed** (since migration `20261102210000`, CLAUDE.md §7). If the
key table is empty, every machine agent, including the tracker, is locked out. It is not
"not enforced". Check with `select count(*) from applyy_internal.agent_key` (expect 1).
`APPLYY_AGENT_KEY` must match in three places on rotation: Supabase secrets, GitHub secrets,
and Teja's Windows user env (CLAUDE.md §7).

---

## Receipt confirmation (added 2026-10-09, narrowed 2026-10-23)

A verified ATS receipt may move an application from `applying` to `applied` with no human
check. Teja ruled it on 2026-10-09 and narrowed it on 2026-10-23 to `applying` rows only.
`needs_verification` stays human-only: Greenhouse signs mail for every tenant, so a genuine
receipt does not prove that **this** submit landed (`email-tracker-intake/decide.ts:443`).

A Greenhouse "application received" email confirms an `applying` row only if **all** of
these hold (`verifyReceiptSender` at `decide.ts:753`, `receiptConfirmsApplied` at
`decide.ts:817`; migration `20261009235000_tracker_confirms_applied.sql`):

- the sender is on `greenhouse.io` or `greenhouse-mail.io`;
- Gmail's own topmost `Authentication-Results` header (authserv-id `mx.google.com`) shows
  `dkim=pass` or `spf=pass` for that same vendor domain; a missing header never confirms;
- the email arrived after the row's latest move into `applying`;
- exactly one loaded application matches the company;
- the email reads as an application receipt.

The status move carries the `email_events` id, Gmail's verdict and both timestamps in its
event detail, so a human can audit or reverse it.

**This runs on its own only while the hourly trigger is installed.** Without it, a receipt
waits until someone opens `/emails`.

---

## Shipping a script change

### The normal way: `scripts/push-apps-script.sh` (since 2026-11-05)

Before commit `6ed181e`, the script was pasted into the editor by hand, so nobody could say
which commit was live. Now a script ships it from a pinned commit with `clasp`:

```bash
# Dry run first: builds the push in a temp dir and prints the clasp commands, touches nothing
scripts/push-apps-script.sh <git-sha> "<why>" --dry-run
# Real push
scripts/push-apps-script.sh <git-sha> "<why>"
```

What it does (`scripts/push-apps-script.sh`):

1. Reads `email-tracker.gs` and `appsscript.json` with `git show <sha>:...`, never the working
   tree, which may hold a peer's unsaved edits.
2. Works in a throwaway temp dir, so no `.clasp.json` lands in the repo.
3. Runs `clasp push --force`, then `clasp create-version "<why>"`.
4. Points the **one existing** Web App deployment at that version with
   `clasp update-deployment`. It never creates a new deployment, because the deployment id
   is the Web App URL that `APPLYY_GMAIL_SYNC_URL` holds.
5. Checks that the result names the same deployment and version, and exits non-zero if not.

Needs: `clasp` installed and logged in (`~/.clasprc.json`, clasp's own login; the script never
reads it). The `<why>` text becomes the version description in Apps Script. To see which
commit is live, open the editor's **Deploy, then Manage deployments** and read the version
description.

Ship order: when a script change depends on a new intake or migration, the orchestrator
deploys the intake and migration **first**, then pushes the script.

### After a push: the one-time steps that clasp does not do

`clasp` ships code only. Triggers and Script Properties live in the Google project and stay
as they are. Do these only when they are missing or wrong:

1. Open https://script.google.com signed in as `tejamallam00@gmail.com`, then the applyy
   email-tracker project.
2. **Project Settings, then Script Properties:** check the table above.
3. Select `applyyTestConnection`, then **Run**. Approve the Google permission prompt if it
   appears. The log should show a 2xx from the intake. A 401 means `APPLYY_INTAKE_SECRET`
   does not match `EMAIL_INTAKE_SHARED_SECRET`; a 404 means the URL is wrong.
4. Select `applyyInstallTrigger`, then **Run**. **Triggers** (the clock icon) should then
   list exactly one `applyyIngest`, time-driven, every hour.
5. Select `applyyIngest`, then **Run** once. **Executions** should show `applyy: accepted ...`.

### Fallback: paste by hand

If `clasp` is not available: replace the whole of `Code.gs` with the repo file, **Save**,
then **Deploy, then Manage deployments, then Edit, then Version: New version, then Deploy**.
Never "New deployment": that makes a new `/exec` URL and breaks `gmail-sync`.

---

## Check that it is alive

The tracker's health is a measurement, not a fact. Re-check it each time:

```sql
-- newest email the intake stored
select count(*), max(received_at) from public.email_events;
-- newest tracker heartbeat or run
select max(started_at) from public.agent_runs where agent = 'tracker';
```

Run them with the MCP `execute_sql`, or
`env -u SUPABASE_ACCESS_TOKEN supabase db query --linked "<select>"` (CLAUDE.md §4).

The dashboard's **System Health** page shows a tracker row. It turns stale after 12 hours
without a run (`apps/web/src/data/agentFreshness.ts:151`, `staleAfterHours: 12`).

- What the stale warning **can** say: the script has not checked in. The trigger is dead, the
  script is broken, a secret is wrong, or the intake is down.
- What it **cannot** say: which one. **Apps Script, then Executions** is where you find out.

### When it stops working

Time-driven triggers fail quietly. Treat this like the other silent failures in this system
(Supabase pauses an idle project after a week; GitHub disables a scheduled workflow after
60 days without activity).

- **Apps Script, then Executions** shows every run and its errors. Look there first.
- Google disables a trigger after repeated failures. A burst of intake 500s can cost you the
  trigger, not only the messages. Re-run `applyyInstallTrigger` after you fix the cause.

---

## History

- **2026-09-11 17:51 IST, first live run:** 9 emails ingested, HTTP 202, 9 rows in
  `public.email_events`. Log line:
  `applyy: accepted {"accepted":9,"duplicates":0,"rejected":0,...}`.
- **2026-09-11 to 2026-10-23:** 0 emails arrived, and this read as a quiet inbox. It was a
  dead tracker. The heartbeat and the `agent_runs` row were added on 2026-10-23 so silence is
  visible.
- **2026-10-23:** hourly trigger plus on-demand sync through `gmail-sync`; the browser no
  longer holds the secret (commit `43cdaa8`).
- **2026-11-02 (W16):** each entry point got its own secret; `doGet` refuses (commit
  `7aa3c07`).
- **2026-11-05:** job-board and alert search (commit `33df511`); `push-apps-script.sh`
  (commit `6ed181e`).

To see what changed since: `git log --oneline -- supabase/functions/_shared/apps-script/ scripts/push-apps-script.sh`.

## Related

- [`../../PROJECT_PLAN.md`](../../PROJECT_PLAN.md) §12: the same decision in plan form.
- [`../decisions/2026-09-10-gmail-continuous-read-write-vs-zoho.md`](../decisions/2026-09-10-gmail-continuous-read-write-vs-zoho.md): the mailbox decision record.
- `supabase/functions/email-tracker-intake/`: the intake and its tests.
- `supabase/functions/gmail-sync/`: the on-demand sync proxy.
