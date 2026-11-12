/* The Emails page's analytics (Teja, 2026-11-12 12:41 IST: "i need more anyticks , numbers abt my mails to uderstand
 * more abt them"). Pure: every figure the Insights panel draws is computed here from the stored rows, so
 * test/emailStats.test.ts pins what is on screen.
 *
 * OWNER MAIL IS NEVER EMPLOYER MAIL. Teja's own replies and forwards used to be stored as rejections (5 "rejections"
 * were 1 real one, 2026-11-12). ffa32af keeps them unclassified at intake, but the reason (signal owner_sent) is not
 * stored, so the page recognises them itself by sender address and keeps them out of every employer figure. */

// Type only: the stored row.
import type { EmailEventRow } from './emailSync.ts';
// Type only: the class union.
import type { EmailClassification } from '../../data/contract.ts';
// The one label map, so a class reads the same in the panel as on its badge.
import { classLabel } from './emailView.ts';

/* Classes that are not job mail: the default list hides them, and so do the employer figures. */
const NOT_JOB_MAIL: ReadonlySet<string> = new Set(['other', 'unclassified']);
/* Good outcomes: a step forward from an employer. */
const POSITIVE: ReadonlySet<string> = new Set(['interview_invite', 'oa_invite', 'offer']);
// IST is UTC+05:30 all year (no daylight saving), so a fixed offset is the exact calendar.
const IST_OFFSET_MS = 330 * 60 * 1000;
// One day in ms.
const DAY_MS = 24 * 60 * 60 * 1000;

/* The bare address of a From header: inside <...> when bracketed, else the whole value; lowercased and trimmed. */
function addressOf(from: string): string {
  // The bracketed address when there is one (the LAST bracket pair: a display name may quote an address).
  const bracketed = /<([^<>]+)>\s*$/.exec(from)?.[1];
  // Bracketed, else the whole header.
  return (bracketed ?? from).trim().toLowerCase();
}

/* True when the owner sent this mail: the WHOLE sender address equals the owner's, case-insensitively. A substring
   test would let "x.tejamallam00@gmail.com" or a display name quoting the owner pass. No owner known = never. */
export function isOwnerSent(from: string, ownerEmail: string): boolean {
  // Signed out or not loaded: nothing can be proven owner-sent.
  if (ownerEmail.trim() === '') return false;
  // Exact address equality.
  return addressOf(from) === ownerEmail.trim().toLowerCase();
}

// Applicant-tracking hosts: their sender domain is the vendor, never the employer.
const ATS_DOMAIN = /(?:greenhouse|ashbyhq|lever|workday|myworkday|smartrecruiters|icims|jobvite|recruitee|workable|bamboohr|usepylon)/i;
// Subject phrasings that name the employer ("applying to TrueFoundry", "interest in HackerRank || AI Intern").
const SUBJECT_COMPANY = /(?:applying (?:to|at|for)|application to|interest in|joining)\s+(?:the\s+)?([A-Z][\w.&'-]*(?:\s+[A-Z][\w.&'-]*){0,3})/;
// Words a sender's display name adds after the company ("Supabase Hiring Team", "Acme Recruiting").
const SENDER_SUFFIX = /\s+(?:recruiting|recruitment|careers?|talent(?:\s+(?:acquisition|team))?|hiring(?:\s+team)?|hr|jobs|team|notifications?)(?:\s+team)?$/i;

/* The employer an email is from, or null when nothing names it honestly. In order of trust: the tracked application's
   company, the subject's "applying to <Company>", the sender's display name (minus recruiting words), then the sender
   domain unless it is an applicant-tracking vendor's. Never guessed past that. */
export function companyOf(event: EmailEventRow, companyByApplication: ReadonlyMap<string, string>): string | null {
  // 1. A linked application knows its company for certain.
  const tracked = event.matched_application_id !== null ? companyByApplication.get(event.matched_application_id) : undefined;
  if (tracked !== undefined && tracked.trim() !== '') return tracked.trim();
  // 2. The subject names it.
  const fromSubject = SUBJECT_COMPANY.exec(event.subject)?.[1];
  if (fromSubject !== undefined) return fromSubject.trim();
  // 3. The display name, when there is one and it is not just an address.
  const display = /^\s*"?([^"<]+?)"?\s*</.exec(event.from_address)?.[1]?.replace(SENDER_SUFFIX, '').trim();
  if (display !== undefined && display !== '' && !display.includes('@')) return display;
  // 4. The domain's main label, unless it is an ATS vendor's.
  const domain = /@([^>\s]+)/.exec(event.from_address)?.[1] ?? '';
  // The label before the public suffix (careers@globex.com -> globex).
  const label = domain.split('.').slice(-2, -1)[0] ?? '';
  // A vendor domain, or nothing usable: no company claimed.
  if (label === '' || ATS_DOMAIN.test(domain)) return null;
  // Capitalised.
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/* The Monday (YYYY-MM-DD) of the IST calendar week a moment falls in. */
export function istWeekStart(at: Date): string {
  // The IST wall clock, read through UTC getters.
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  // Days since Monday (getUTCDay: Sunday 0).
  const sinceMonday = (ist.getUTCDay() + 6) % 7;
  // Back to that Monday.
  const monday = new Date(ist.getTime() - sinceMonday * DAY_MS);
  // Its date.
  return monday.toISOString().slice(0, 10);
}

/* Every figure the Insights panel draws. */
export interface EmailStats {
  // Every stored email loaded.
  readonly total: number;
  // Employer job mail: classified, not owner-sent.
  readonly jobMail: number;
  // Mail the owner sent (replies, forwards).
  readonly fromYou: number;
  // Job mail not yet read in the app.
  readonly unread: number;
  // Job mail linked to an application.
  readonly tracked: number;
  // Job mail not linked.
  readonly untracked: number;
  // Interviews, assessments and offers.
  readonly positive: number;
  // Rejections.
  readonly rejections: number;
  // Job mail by class, biggest first, zero classes left out.
  readonly byType: readonly { readonly cls: EmailClassification; readonly label: string; readonly count: number }[];
  // Distinct employers heard from.
  readonly companyCount: number;
  // The top employers by job mail, biggest first (first-seen breaks ties).
  readonly companies: readonly { readonly name: string; readonly count: number }[];
  // Job mail per IST week, oldest first, empty weeks included.
  readonly weekly: readonly { readonly weekStart: string; readonly count: number }[];
}

/* The figures for these rows. `weeks` is how many IST weeks the trend shows, ending with the week of `now`. */
export function computeEmailStats(
  events: readonly EmailEventRow[],
  opts: { readonly ownerEmail: string; readonly now: Date; readonly companyByApplication: ReadonlyMap<string, string>; readonly weeks: number; readonly topCompanies?: number },
): EmailStats {
  // Owner mail, counted on its own.
  const fromYou = events.filter((e) => isOwnerSent(e.from_address, opts.ownerEmail));
  // Employer job mail: the set every other figure is over.
  const job = events.filter((e) => !NOT_JOB_MAIL.has(e.classification) && !isOwnerSent(e.from_address, opts.ownerEmail));
  // Count per class, in first-seen order (the sort below is stable).
  const perClass = new Map<EmailClassification, number>();
  // Tallied.
  for (const e of job) perClass.set(e.classification, (perClass.get(e.classification) ?? 0) + 1);
  // Count per employer, first-seen order kept for ties; job mail is newest first, so walk it oldest first.
  const perCompany = new Map<string, number>();
  // Oldest first, so a tie ranks the employer heard from first.
  for (const e of [...job].sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at) || 0)) {
    // Its employer, or none.
    const name = companyOf(e, opts.companyByApplication);
    // Only a named employer is counted.
    if (name !== null) perCompany.set(name, (perCompany.get(name) ?? 0) + 1);
  }
  // The trend's weeks, oldest first: the week of `now` and the weeks before it.
  const lastWeek = Date.parse(`${istWeekStart(opts.now)}T00:00:00Z`);
  // One bucket per week.
  const weekly = Array.from({ length: Math.max(0, opts.weeks) }, (_, i) => new Date(lastWeek - (opts.weeks - 1 - i) * 7 * DAY_MS).toISOString().slice(0, 10)).map((weekStart) => ({ weekStart, count: 0 }));
  // Bucket index by week start.
  const index = new Map(weekly.map((w, i) => [w.weekStart, i]));
  // Each job email into its week, when that week is shown.
  for (const e of job) {
    // Its received time; an unparseable one is skipped, never bucketed as 1970.
    const at = Date.parse(e.received_at);
    if (Number.isNaN(at)) continue;
    // Its bucket.
    const i = index.get(istWeekStart(new Date(at)));
    // Inside the window: counted.
    if (i !== undefined) weekly[i] = { weekStart: weekly[i]!.weekStart, count: weekly[i]!.count + 1 };
  }
  // The figures.
  return {
    // Everything loaded.
    total: events.length,
    // Employer job mail.
    jobMail: job.length,
    // The owner's own.
    fromYou: fromYou.length,
    // Unread job mail.
    unread: job.filter((e) => e.read_at === null).length,
    // Linked.
    tracked: job.filter((e) => e.matched_application_id !== null).length,
    // Not linked.
    untracked: job.filter((e) => e.matched_application_id === null).length,
    // Steps forward.
    positive: job.filter((e) => POSITIVE.has(e.classification)).length,
    // No's.
    rejections: job.filter((e) => e.classification === 'rejection').length,
    // By class, biggest first.
    byType: [...perClass].sort((a, b) => b[1] - a[1]).map(([cls, count]) => ({ cls, label: classLabel(cls), count })),
    // Distinct employers.
    companyCount: perCompany.size,
    // The top ones.
    companies: [...perCompany].sort((a, b) => b[1] - a[1]).slice(0, opts.topCompanies ?? 6).map(([name, count]) => ({ name, count })),
    // The trend.
    weekly,
  };
}
