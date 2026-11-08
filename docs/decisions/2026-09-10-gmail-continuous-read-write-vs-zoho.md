# Gmail continuous read *and write*, and whether Zoho is a better base

> **Status 2026-11-08:** Current. The decision stands: Gmail through Apps Script, read and label only. `supabase/functions/_shared/apps-script/email-tracker.gs` reads with `GmailApp.search` (:198), writes a label (:302-305), installs an hourly trigger (:601), and has no send call; mail is ingested by `supabase/functions/email-tracker-intake/`. Referral drafts are `application_events` rows written by `supabase/functions/referral/index.ts`, not Gmail drafts. Operating doc: [`docs/setup/gmail-tracker-apps-script.md`](../setup/gmail-tracker-apps-script.md).
> The body below is the original record, unedited.

**Date:** 2026-09-10 · **Status:** adopted — see the 2026-10-23 status update at the end (original line read "recommendation, not yet ratified by Teja")
**Question asked:** can the system read Gmail continuously *and write back*, and
would Zoho Mail be a better foundation than Gmail?

**Answer in one line:** stay on Gmail via Apps Script. Read, label-writing and
draft-creation are all safe, free and already available; only automated
**sending at volume** is the account risk, and the design already routes around
it. Zoho's one genuine advantage solves a problem Apps Script has already
removed.

---

## 1. The distinction that decides it, and it is written down nowhere

`PROJECT_PLAN.md` §12 records only *why the Gmail API was rejected*. It never
separates the three operations, and the whole answer turns on that split:

| Operation | Via Apps Script | Risk | Already in the design? |
|---|---|---|---|
| **Read** mail (subject, from, snippet) | `GmailApp.search()` | **None.** First-party feature reading your own mailbox | Yes — §12's tracker |
| **Write labels** — mark processed, move, archive | `thread.addLabel()`, `.moveToArchive()` | **None.** Same authority as read | Partly — the intake uses a dedicated label |
| **Create drafts** | `GmailApp.createDraft()` | **None.** A draft sends nothing | **Yes — §17.1's referral agent** |
| **Send** automatically, at volume | `GmailApp.sendEmail()` | **THE REAL RISK.** Bulk automated outbound is what gets accounts limited or suspended | **Deliberately excluded** |

**"Write" is not one capability.** Lumping label-writing and draft-creation in
with sending is what makes the question look hard. Three of the four rows are
free; the fourth is the only one anybody should hesitate over, and §17.1 already
resolved it — *the referral agent **drafts** and Teja sends.* That was framed as
sidestepping the LinkedIn automation ban; it turns out to be the correct answer
for Gmail too, for an unrelated reason.

So: **continuous read *and* write is already available and already safe.** The
capability Teja is asking for mostly exists; what is missing is that nothing
records why it is safe, so the question keeps getting re-asked.

**The general shape, worth naming:** when a platform's terms look hostile, split
the verb before accepting the answer. "Can I write to Gmail?" has no useful
answer. "Can I add a label / create a draft / send 200 messages?" has three
different ones, and only the last is a problem.

---

## 2. What is genuinely NOT available, so this isn't one-sided

- **No push.** Apps Script time triggers are polling, minimum ~1 minute and
  realistically 5–15. True push needs the Gmail API's `watch` + Pub/Sub, which
  reintroduces every §12 objection. For tracking recruiter replies, minutes of
  latency is irrelevant.
- **Triggers double-fire.** Already handled: `message_id` is the dedupe key and
  idempotency is load-bearing in `email-tracker-intake`.
- **Quotas are real but generous** for one mailbox at this volume. Consumer
  accounts get a daily `UrlFetchApp` and mail-read allowance far above what a
  15-minute poll of one inbox consumes. *Not re-verified against Google's
  current published quota table — see §5.*
- **Body text is deliberately not sent.** The intake receives subject and
  snippet only. That is a privacy choice, not a limitation, and it should stay.

---

## 3. Zoho — evaluated on its one real merit

Zoho Mail's genuine edge is **IMAP with an app password**: a plain, portable,
vendor-neutral protocol, which is exactly the door §12 records Google as having
closed.

**And that is why it loses.** Apps Script's advantage is not that its auth is
*easier* — it is that there is **no credential at all**. The script runs as
Teja, inside his own mailbox, with no OAuth app, no consent screen, no
verification review, no refresh token to expire, and nothing to leak. Moving to
Zoho would trade *"no credential"* for *"one long-lived password that must be
stored, rotated and kept out of git"* — in a repo whose `.gitignore` opens with
"Secrets: the whole point of this file."

**That is a downgrade dressed as a simplification.** IMAP looks simpler than
OAuth, so the comparison feels favourable — but the incumbent isn't OAuth. It's
*nothing*.

Costs Zoho would add, none of which Gmail has:

- **A mailbox migration**, and recruiters replying to an address Teja no longer
  watches is a silent, unrecoverable failure — the same reasoning that already
  ruled out `campushub@mlrit.ac.in` for surviving graduation.
- **A new secret** in Supabase and in the worker.
- **A rewrite** of the working `email-tracker.gs` plus its
  `applyyTestConnection` no-op probe.
- **A deliverability reset** on a fresh domain, if outbound ever matters.

**Where Zoho would genuinely win, for the record:** if Teja ever wants a
custom-domain professional address (`teja@…`) on his applications, or if bulk
*sending* became a requirement — a transactional provider then beats both, but
that is a different product decision and §17.1 says sending stays manual.

---

## 4. A premise defect in §12, found while writing this

§12 rejects IMAP with: *"Since 14 March 2025 Google Workspace requires OAuth for
third-party Gmail access. `campushub@mlrit.ac.in` is a Workspace account, so
that door is closed."*

**That reasoning does not apply to the mailbox actually chosen.** §12 itself
decides, three paragraphs later, that the tracker mailbox is
**`tejamallam00@gmail.com`** — a personal consumer account, explicitly *not*
Workspace. So the recorded reason for closing the IMAP door is about an account
this system does not use.

**The decision is unaffected; the justification is wrong.** Apps Script still
wins, and it wins on §3's argument — no credential beats a stored one — which
holds regardless of whether IMAP is technically reachable.

Recorded rather than quietly fixed because **a correct conclusion resting on an
inapplicable premise is more dangerous than a wrong conclusion.** Someone will
eventually discover that app-password IMAP does work on a personal Gmail with
2FA enabled, conclude §12 was sloppy, and reopen a settled decision on the
strength of catching us out. Better that we caught it.

Same family as §17.2 (two-column resumes "parse into gibberish" — true of
Word/LaTeX, false of a browser print) and §2's Actions-minutes arithmetic:
**advice inherited from a different context can be exactly correct there and
exactly wrong here.** That is now the third instance in this repo.

---

## 5. ⚠️ What in this document is NOT verified

Stated plainly, because the rest of it reads as settled and these parts are not:

- **Every Zoho free-tier claim is from training data, not from Zoho's live plan
  page.** Zoho has changed free-plan IMAP/POP availability before, and it is
  exactly the kind of term that moves. **Do not quote any Zoho figure from this
  document as current.** If the recommendation is ever revisited, re-check the
  plan page first — but note the §3 argument does not depend on Zoho's pricing,
  so a change there would not flip the conclusion.
- **Google's current Apps Script quota numbers** were not re-read.
- **Gmail's exact sending thresholds** before rate-limiting are not published
  precisely and are not guessed at here. "Bulk automated outbound is the risk" is
  the durable claim; any specific number would be invented.

---

## 6. Recommendation

1. **Stay on Gmail + Apps Script.** No migration, no new secret, no rewrite.
2. **Record the read/label/draft/send split in `PROJECT_PLAN.md` §12**, so the
   question stops being re-asked. It is the actual answer and it is currently
   nowhere.
3. **Correct §12's IMAP premise** to cite the personal-account reasoning rather
   than the Workspace rule that does not apply to the chosen mailbox.
4. **Add label-writing to the tracker** if not already there — marking a thread
   processed is free, and it is what makes the dedupe robust to the
   double-firing triggers rather than dependent on `message_id` alone.
5. **Revisit only if** Teja wants a custom-domain address on applications. That
   is a branding decision, not an infrastructure one, and it should be argued on
   those terms.

**Not adopted, and the reason is the keeper:** the incumbent's advantage is the
absence of a credential, not the simplicity of one. Any replacement has to beat
*nothing*, which is a very high bar.

---

## 7. Status update — 2026-10-23: adopted, in production

The recommendation was adopted in practice: the Gmail + Apps Script route is
**live as of 2026-10-23** — the deployed tracker script feeds
`email-tracker-intake` (message ingestion), receipt confirmation, and the
zero-mail heartbeat that checks in to `agent_runs` so a dead trigger stops
looking like a quiet inbox. The operating document is
[`docs/setup/gmail-tracker-apps-script.md`](../setup/gmail-tracker-apps-script.md);
consult it, not this analysis, for how the tracker runs today.

**Mode ruling (Teja, 2026-10-23):** the tracker runs on an **hourly time
trigger plus on-demand sync when the `/emails` page is opened** — superseding
the 15-minute-polling assumption in §2 (the "minutes of latency is irrelevant"
argument holds all the more at an hour, since page-open sync covers the
moments anyone is actually watching).

The analysis above is kept as written, §5's unverified-claims warning included.
