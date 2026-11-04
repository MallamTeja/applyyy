# Referral outreach — research before building (2026-11-02)

**Status:** research only; nothing built. Teja (2026-11-02 20:58 IST): "lets research first about the feature, later lets build that."
**Update 2026-11-05:** drafting shipped in `30283d3` (drafts for `awaiting_approval` / `approved` jobs only). Automatic SENDING, the email channel below, is still unbuilt, and this doc is its research. Teja chose to keep it.
**Already ruled:** referral drafts only for jobs at `awaiting_approval` / `approved` (parcel G, 2026-11-02 ~20:50 IST).

## The idea (Teja's words, condensed)

Do not open with "please refer me". Start the **same default conversation** with every contact,
continue it by hand, and only later ask for the referral, by pasting a message the system wrote.
The system should send email itself, and LinkedIn messages too if possible, with X as an extra
channel where the person has an account. Everything must run on free tiers (Gemini spend is fine).

## What each channel allows (researched 2026-11-02; vendor blogs flagged where used)

| Channel | Can the system SEND? | Can the system FIND people? | Free-tier limit | Verdict |
|---|---|---|---|---|
| **Email (Teja's Gmail)** | **Yes.** Apps Script `MailApp`/`GmailApp` (already used by `email-tracker.gs`) or the Gmail API. | Partly: email finders (below) or a pattern guess plus a check. | Apps Script: **100 recipients/day** on a consumer account (official quota table); `MailApp.getRemainingDailyQuota()` reports what is left. Third-party guides say 500/day for Gmail itself; the Apps Script number is the binding one. | System sends, with a click to approve each send. Replies are caught by the existing Gmail tracker. |
| **LinkedIn** | **No.** The User Agreement bans "bots or other unauthorized automated methods" for messaging, connecting and scraping. The Messages API is restricted to approved partners and has no public application path. | **No** (scraping is banned). Teja searches; the system can only build a search URL for him to open. | About 100 invitations a week on a free account (not an official number). Invitations with a personal note are much tighter on free accounts (sources disagree: about 5 a week or a month). | **Drafts only.** Teja sends by copy-paste. Automating it risks a ban on the account his job search depends on. |
| **X (Twitter)** | **Not on a free tier.** The free API tier ended for new developers on 2026-02-06 (pay-per-use). DMs need the highest permission level and are priced separately (price unconfirmed). | No free search. | Paid only. | **Drafts only**, copy-paste, and only when the person is active on X. |

**Finding emails (free):** Hunter.io's free plan is about 50 credits a month (most 2026 sources; older pages say 25 searches).
Apollo's free plan is reported anywhere from 100 to 10,000 credits a month; the sources conflict, so verify on Apollo's own page.

## Recommended flow (proposal, for review before building)

1. **Pick the job.** Only `awaiting_approval` / `approved` rows (ruled).
2. **Find people (semi-manual).** The system suggests 2–3 target roles at the company (e.g. "engineering manager, platform team, India").
   It builds the LinkedIn and X people-search URLs; **Teja opens them and picks a person**, then pastes their profile URL, name and role into the app.
   Optionally the system spends one Hunter credit to look up that person's work email.
3. **Stage 1, opener (the same default conversation for everyone).** Gemini personalises one fixed template
   (name, company, team, one specific detail Teja pastes). The opener contains no ask.
   Email: the system sends it after Teja approves. LinkedIn/X: the system shows the text with a copy button, and Teja sends it.
4. **Stage 2, conversation.** When the person replies (email: the tracker detects it; LinkedIn/X: Teja clicks "they replied" and pastes the reply),
   Gemini drafts a natural next message. Teja edits and sends.
5. **Stage 3, the ask.** Only after a real exchange: a short referral request with the job link, a two-line pitch and the resume link. Copy-paste or a system send, as above.
6. **Track it.** Each contact has a stage: `opener_drafted → opener_sent → replied → conversing → asked → referred | declined | no_reply`.
   One follow-up at most after silence (default 5–7 days); then it closes as `no_reply`.

## Rules the system should enforce (etiquette and risk)

- Volume caps: email ≤ 20/day (well under the 100/day quota, which also protects deliverability). Suggest ≤ 10 LinkedIn openers a day for Teja to send (the invitation cap is about 100 a week).
- No mass identical blast: every opener carries one personal detail, or it is not sent.
- One follow-up maximum. Honest sender identity. Every cold email carries a "no worries if not" line and an easy way to say no.
- Store as little personal data about contacts as possible (name, role, profile URL, email), with a delete action. **Not researched:** whether India's DPDP Act, CAN-SPAM or GDPR apply to one-to-one job-seeker outreach. Verify before sending at volume.

## Open questions for the build

- Email transport: Apps Script (already authorised for the tracker; 100/day) or the Gmail API (OAuth; more control). Recommendation: Apps Script first, since it is already wired.
- Data model: likely `outreach_contacts` and `outreach_messages` (append-only, linked to `applications`). The current referral drafts live as `application_events` notes and would move to this model.
- Whether Hunter is worth wiring for 50 credits a month, or Teja pastes emails himself.

## Sources

- LinkedIn prohibited software help page: https://www.linkedin.com/help/linkedin/answer/a1341387
- LinkedIn User Agreement, scraping and automation clause (summary): https://conductatlas.com/platform/linkedin/linkedin-user-agreement/prohibition-on-scraping-and-automated-data-collection/
- LinkedIn Messages API (restricted to approved partners): https://learn.microsoft.com/en-us/linkedin/shared/integrations/communications/messages
- LinkedIn invitation limits (vendor; unofficial): https://www.hublead.io/linkedin-invitation-limit
- X API pricing 2026 (vendor): https://zernio.com/blog/twitter-api-pricing , https://www.postproxy.dev/blog/x-api-pricing-2026/
- Apps Script quotas (official): https://developers.google.com/apps-script/guides/services/quotas
- Gmail API limits (vendor): https://www.usecarly.com/blog/gmail-api-limits/
- Hunter.io pricing (vendor): https://www.saleshandy.com/blog/hunter-io-pricing/
- Apollo free plan (vendor): https://www.costbench.com/software/ai-sales-tools/apollo/free-plan/
