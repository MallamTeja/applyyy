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
   │  Apps Script time trigger, every 15 min
   │  reads: from / subject / snippet  ── nothing else
   ▼
Supabase Edge Function  (owned by applyyy-d0)
   │  Gemini classifies: rejected / OA invite / interview / offer
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

## Setup — the human half

> ⏸️ **Do not paste a script yet.** The wire contract — exact JSON field names,
> the shared-secret header, expected status codes — is owned by **`applyyy-d0`**
> and has not been published. A script written against a guessed contract would
> fail silently at the one place we cannot observe it: inside Google's
> infrastructure, with no logs you'd think to check.
>
> The script body will live in **d0's tree, version-controlled**, not in this
> document. Copying it here would create a second home for it, and the two
> copies would drift.

When d0 publishes it, the steps are:

1. Open [script.google.com](https://script.google.com) **signed in as
   `tejamallam00@gmail.com`** — the binding is to whichever account you're in,
   so this is the step that actually matters.
2. New project; name it `applyy-mail-tracker`.
3. Paste the published script. Set the Supabase function URL and shared secret
   in **Project Settings → Script properties**, never inline in the source.
4. Run it once manually to trigger the auth prompt, and grant it.
   *You will see an "unverified app" style warning — that is expected and it is
   your own script asking for access to your own mailbox.*
5. **Triggers → Add trigger** → time-driven → every 15 minutes.
6. Confirm one row lands in `email_events`, then check the pipeline advanced.

### What to check when it stops working

Time-driven triggers fail quietly, so this needs the same treatment as the two
other silent deaths in this system (Supabase's 1-week idle pause and GitHub's
60-day scheduled-workflow disable):

- **Apps Script → Executions** shows every run and its failures. First place to
  look, and nothing tells you to look there.
- Google quietly disables triggers on repeated failure — so a burst of Edge
  Function 500s can cost you the trigger, not just the messages.
- The **System Health** dashboard page must surface "no `email_events` in N
  hours" as a warning. A tracker that stopped looks identical to a quiet inbox,
  and you'd read silence as "no rejections yet."

---

## Related

- [`../../PROJECT_PLAN.md`](../../PROJECT_PLAN.md) §12 — the same decision in
  plan form
- [`../PROGRESS.md`](../PROGRESS.md) — live status, including what is still
  waiting on you
