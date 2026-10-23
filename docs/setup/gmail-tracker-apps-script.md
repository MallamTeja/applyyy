# Email tracking setup — and why we do NOT use the Gmail API

**Phase 2.** Not blocking Phase 1. The human half is a ~10-minute task you can
do any time.

---

## The finding first

You asked how to get Gmail API access for the tracker. **The answer is that you
shouldn't use it.** All three conventional routes are closed or booby-trapped,
and the fourth is both easier and more robust. Recorded in full so nobody
relitigates this in three weeks and quietly rebuilds the broken version.

### Why the Gmail API is the wrong tool here

**1. OAuth in "Testing" mode expires your refresh token every 7 days.** Google
issues time-limited refresh tokens to apps whose consent screen is in Testing
status. The tracker would work for a week, **silently stop**, and need
re-authorising every Monday for as long as the project lives. Silent weekly
failure is worse than no feature — you'd trust a kanban that had quietly
stopped updating.

**2. `gmail.readonly` is a *restricted* scope.** So the fix for (1) — moving the
consent screen to production — triggers a verification review. That is a
sensible process for a real product and absurd overhead for a personal tool
reading your own inbox.

**3. IMAP with an app password has been closed since 14 March 2025.** Google
Workspace now requires OAuth for third-party Gmail access, which killed basic
auth over IMAP, SMTP and POP. Relevant because `campushub@mlrit.ac.in` **is** a
Workspace account.

**4. Even the working path sits on someone else's permission.** A Workspace
admin — your college's IT — can block third-party OAuth apps outright. Building
on that means your job tracker can be switched off by a stranger.

---

## What we use instead: Google Apps Script

A short script bound to **your own Google account**, on a time-driven trigger.
It runs *as you*, inside your own mailbox.

No GCP project. No OAuth client. No consent screen. No restricted-scope
verification. **No refresh token to expire.** It runs on Google's
infrastructure, free.

> **The transferable lesson, because this generalises:** when a platform's
> official integration path is heavy, check whether the platform has a
> **first-party scripting surface that sidesteps the auth problem entirely by
> already running as you.** The same trick works for Sheets, Calendar and
> Drive. Reach for the API when you need to act on *someone else's* data; reach
> for the scripting surface when you only need your own.

### Division of labour — Apps Script stays a dumb pipe

```
Gmail (yours)
   │  Apps Script: on-demand Web App call (doGet), or the optional 15-min trigger (applyyInstallTrigger)
   │  reads: from / subject / snippet  ── nothing else
   ▼
Supabase Edge Function  email-tracker-intake
   │  deterministic classifier (_shared/email/classifier.ts), no LLM
   │  matches to an application row, advances its status
   ▼
Pipeline kanban
```

**All intelligence lives in the Edge Function, not the script.** Deliberate: an
Apps Script lives in Google's web editor where it is not version-controlled, not
diffable, not testable and not reviewable. Anything that encodes a decision
belongs in the repo. The script's entire job is to move bytes.

Which also means the classifier is a normal unit under test — you can replay a
rejection email against it without owning a mailbox.

---

## Mailbox — decided

**`tejamallam00@gmail.com`**, the personal address. Confirmed 2026-09-09.

Not `campushub@mlrit.ac.in`, for three reasons: it's a Workspace account (see
closure 3 above), its admin can revoke access (closure 4), and **you lose it
when you graduate** — taking the email trail of every application with it.
Recruiters replying to a dead address is a real, quiet failure.

`campushub@mlrit.ac.in` appears in this project only as your Claude Code
account identity. It is not a candidate mailbox.

## Ban risk: none

Worth stating plainly since you asked. Apps Script reading your own inbox is a
first-party feature doing exactly what it was built for — there is no ToS
surface to fall foul of. Applying to ~35 jobs a day doesn't involve Google at
all.

What **would** put the account at risk is **automated outbound sending at
volume** — which is precisely why the referral outreach agent *drafts* and
**you** send. That wasn't an accident; it's the reason that feature is shaped
the way it is.

---

## Setup & Live Verification — verified 2026-09-11

> **End-to-end verified on 2026-09-11 — a measurement, not a standing property:** re-check liveness with `select count(*), max(received_at) from public.email_events;` (MCP `execute_sql`, or whichever route currently works). The wire contract and script are published in the repo:
> [`supabase/functions/_shared/apps-script/email-tracker.gs`](file:///c:/Users/tejam/OneDrive/myproj/applyyy/supabase/functions/_shared/apps-script/email-tracker.gs).
> On 2026-09-11 17:51 IST, a live execution ingested 9 emails, returned HTTP 202 Accepted,
> and verified 9 rows stored in `public.email_events` via the Supabase CLI.

### Configuration

1. **Google Apps Script Project**:
   - Location: [script.google.com](https://script.google.com), signed in as **`tejamallam00@gmail.com`**.
   - Code: Copied verbatim from [`supabase/functions/_shared/apps-script/email-tracker.gs`](file:///c:/Users/tejam/OneDrive/myproj/applyyy/supabase/functions/_shared/apps-script/email-tracker.gs).
   - **Project Settings → Script Properties**:
     - `APPLYY_INTAKE_URL`: `https://xynqxekcqizwhtskzqrq.supabase.co/functions/v1/email-tracker-intake`
     - `APPLYY_INTAKE_SECRET`: `<EMAIL_INTAKE_SHARED_SECRET>`

2. **Supabase Secrets & Auth (Required for RLS storage)**:
   - `EMAIL_INTAKE_SHARED_SECRET`: Shared secret used for header authentication (`X-Applyy-Intake-Secret`).
   - `APPLYY_APP_USER_EMAIL`: `tejamallam00@gmail.com`
   - `APPLYY_APP_USER_PASSWORD`: Configured password
   - `APPLYY_AGENT_KEY`: the machine-agent key. The intake advances statuses as agent `tracker`, and migration `20261008160000` makes `advance_application_status` refuse non-`human` agents without the `x-applyy-agent-key` header once a hash is seeded. Check enforcement with `select count(*) from applyy_internal.agent_key;` (0 = not enforced yet).
   - Auth user: Provisioned in `auth.users` so the Edge Function signs in and writes rows under RLS.

3. **How It Works**:
   - **Search query**: `newer_than:2d -label:applyy-ingested`, max 200 threads.
   - **Payload**: Extracts `message_id`, `thread_id`, `from`, `to`, `subject`, `snippet` (plain body truncated to 4096 chars — never full body), `received_at`, `label_ids`, and (since 2026-10-09) `authentication_results`: Gmail's own topmost `Authentication-Results` header, read from `getRawContent()`, used only to verify a receipt's DKIM/SPF (see "Receipt confirmation" below). Batched into chunks of 50.
   - **Post**: Sent to `POST /functions/v1/email-tracker-intake`.
   - **Idempotency & Labeling**: Upon receiving `202 Accepted`, the script applies Gmail label `applyy-ingested`. Any trigger double-fire is absorbed harmlessly at Postgres via `ON CONFLICT (user_id, provider_message_id) DO NOTHING`.
   - **On-Demand Trigger (No 15-Min Cron)**:
     - The continuous 15-minute background polling trigger has been replaced with **on-demand Web App monitoring**.
     - In the Apps Script editor, run `applyyRemoveTriggers()` to delete any active scheduled triggers.
     - Deploy as a Web App: Click **Deploy → New deployment → Type: Web app**.
       - **Execute as**: `Me (tejamallam00@gmail.com)`
       - **Who has access**: `Anyone`
     - Copy the Web App URL (e.g. `https://script.google.com/macros/s/.../exec`).
     - Append your secret query parameter: `?secret=<APPLYY_INTAKE_SECRET>`.
     - Set this in `apps/web/.env.local` as `VITE_EMAIL_SYNC_WEBHOOK_URL` or paste it into the **Sync Settings** drawer on `/emails`. **Never set it in Vercel's env:** every `VITE_` variable is compiled into the public bundle, and this URL carries the intake secret.
     - Whenever you navigate to `/emails` or click the **"Refresh Interviews"** button, the web console triggers this Web App to immediately ingest new recruiter emails from Gmail without any 15-minute lag!

4. **Live Verification Record (2026-09-11 17:51 IST)**:
   - **Apps Script Execution Log**:
     ```text
     applyy: accepted {"accepted":9,"duplicates":0,"rejected":0,"rejected_detail":[],"batch_id":"39b94b74-59d3-4e74-9582-d64ff4768339"}
     ```
   - **Supabase Query Verification**:
     `npx supabase db query --linked "SELECT count(*) FROM email_events;"` returned `{ "count": 9 }`.
     Rows stored with `classification = 'unclassified'` and `processed_at = null`.

### What to check when it stops working

Time-driven triggers fail quietly, so this needs the same treatment as the two
other silent deaths in this system (Supabase's 1-week idle pause and GitHub's
60-day scheduled-workflow disable):

- **Apps Script → Executions** shows every run and its failures. First place to
  look, and nothing tells you to look there.
- Google quietly disables triggers on repeated failure — so a burst of Edge
  Function 500s can cost you the trigger, not just the messages.
- The **System Health** dashboard's tracker row now works (built 2026-10-23, after a
  month of silence — 0 emails since 2026-09-11 — read as a quiet inbox). Two halves:
  the script POSTs an **empty batch as a heartbeat** when there is no new mail
  (`applyyIngest`'s zero paths call `applyyPostBatch_([], config)`), and the intake
  records **every authorized call in `agent_runs`** (agent `tracker`; a heartbeat is a
  succeeded run with `rows_in` 0). The existing `AgentFreshnessPanel` cadence
  (`agentFreshness.ts`, `staleAfterHours: 12`) then flags silence. What the warning CAN
  assert: the script hasn't checked in (trigger dead, script broken, secret wrong, or
  intake down). What it CANNOT assert: which of those it is — **Apps Script →
  Executions** stays the place that says why. In on-demand Web App mode the heartbeat
  only fires when a sync is requested, so staleness then means "nobody synced", not
  "tracker broken" — the 15-minute trigger is what makes the signal trustworthy.

## Receipt confirmation — added 2026-10-09

Teja ruled (2026-10-09 23:24 IST) that a verified ATS receipt may mark a submitted
application `applied` with no human check — **narrowed 2026-10-23 10:44 IST to `applying`
rows only**: `needs_verification` is human-only again (Greenhouse signs for every tenant,
so a genuine receipt is not proof THIS submit landed). A Greenhouse "application
received" email confirms an `applying` row, but ONLY if ALL of these hold
(`supabase/functions/email-tracker-intake/decide.ts`, `verifyReceiptSender` and
`receiptConfirmsApplied`; migration `20261009235000_tracker_confirms_applied.sql`):

- the sender is on `greenhouse.io` / `greenhouse-mail.io`;
- Gmail's own (topmost, authserv-id `mx.google.com`) `Authentication-Results` header shows
  `dkim=pass` (or `spf=pass`) for that same vendor domain. A missing header never confirms.
- it arrived after the row's latest entry into `applying`;
- exactly one loaded application matches the company;
- and it reads as an application receipt.

The move carries the `email_events` id, Gmail's verdict and both timestamps in its event
detail, so a human can audit or reverse it.

**This only runs automatically while the 15-minute trigger is installed.** The on-demand
Web App (above) fires only when someone opens `/emails`, so a receipt would wait until then.
Re-enabling polling reverses the earlier "on-demand only" choice; automatic confirmation
needs it.

### Re-enable after a script change (Teja, in Gmail)

> **Pending re-paste (2026-10-23):** the repo's `email-tracker.gs` now sends the
> zero-mail heartbeat (see "What to check when it stops working"). The deployed copy
> predates it, so the health row stays dark until this section is done once for the
> whole batch of script changes.

1. Open [script.google.com](https://script.google.com), signed in as `tejamallam00@gmail.com`,
   and open the applyy email-tracker project.
2. Replace the whole of `Code.gs` with the repo's
   `supabase/functions/_shared/apps-script/email-tracker.gs`, then **Save**.
3. **Project Settings → Script Properties**: confirm `APPLYY_INTAKE_URL` is
   `https://xynqxekcqizwhtskzqrq.supabase.co/functions/v1/email-tracker-intake` and that
   `APPLYY_INTAKE_SECRET` equals the Supabase secret `EMAIL_INTAKE_SHARED_SECRET`.
4. Select `applyyTestConnection` → **Run**. Approve the Google permission prompt if shown.
   The log should show a 2xx from the intake.
5. Select `applyyInstallTrigger` → **Run**. This installs the 15-minute `applyyIngest`
   trigger (it removes any older copy first). **Triggers** (clock icon) should then list
   exactly one `applyyIngest`, time-driven, every 15 minutes.
6. If the on-demand Web App is in use: **Deploy → Manage deployments → Edit → Version:
   New version → Deploy**, so the Web App runs the new code too.
7. Select `applyyIngest` → **Run** once, then check **Executions** for `applyy: accepted ...`.
8. Verify in Supabase: `select count(*), max(received_at) from public.email_events;` and the
   newest `received_at` should be recent.

---

## Related

- [`../../PROJECT_PLAN.md`](../../PROJECT_PLAN.md) §12 — the same decision in
  plan form
- [`../PROGRESS.md`](../PROGRESS.md) — live status, including what is still
  waiting on you
