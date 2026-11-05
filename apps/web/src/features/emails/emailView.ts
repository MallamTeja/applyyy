/* The Emails page's view rules (2026-11-05): what each stored class is called, which emails a filter
 * keeps and in what order, how that state lives in the URL, the unread count, which emails may be added
 * to Applied, and the slug that route sends. Pure, so test/emailsView.test.ts pins exactly what renders.
 *
 * WHY A CLOSED LABEL MAP: the page used to print "Interview Invite" on every row, whatever the email was.
 * Now each row shows its STORED class through this map, and anything the map does not know reads
 * "Unclassified": a label is never guessed (CLAUDE.md section 6). */

// Type only: the stored row.
import type { EmailEventRow } from './emailSync.ts';
// Type only: the class union, from the shared contract (enums.ts EMAIL_CLASSIFICATIONS).
import type { EmailClassification } from '../../data/contract.ts';

/* Every class's label. A Record over the union, so a new class without a label fails to compile. */
const CLASS_LABELS: Readonly<Record<EmailClassification, string>> = {
  // An ATS or employer receipt.
  application_received: 'Application received',
  // A no.
  rejection: 'Rejection',
  // An online assessment.
  oa_invite: 'Assessment invite',
  // An interview.
  interview_invite: 'Interview invite',
  // An offer.
  offer: 'Offer',
  // A recruiter writing first.
  recruiter_outreach: 'Recruiter',
  // Out-of-office and similar notices.
  other: 'Other',
  // The classifier read nothing in it.
  unclassified: 'Unclassified',
  // A board's alert or recommendation (migration 20261105124500).
  job_alert: 'Job alert',
};

/* The label for a stored class; anything unknown or malformed is "Unclassified". */
export function classLabel(classification: unknown): string {
  // Own keys only, so 'toString' or '__proto__' can never pass as a class.
  return typeof classification === 'string' && Object.hasOwn(CLASS_LABELS, classification) ? CLASS_LABELS[classification as EmailClassification] : CLASS_LABELS.unclassified;
}

/* Each class's badge colour, from the page's existing badge set. A Record, so every class has one. */
const CLASS_TONES: Readonly<Record<EmailClassification, 'interview' | 'rejection' | 'acknowledgement' | 'unclassified'>> = {
  // Good news, in the success colour.
  interview_invite: 'interview',
  // An offer is good news too.
  offer: 'interview',
  // Bad news.
  rejection: 'rejection',
  // Steps and notices about a job.
  application_received: 'acknowledgement',
  // An assessment is a step, not an outcome.
  oa_invite: 'acknowledgement',
  // A recruiter's first message.
  recruiter_outreach: 'acknowledgement',
  // A board's listing.
  job_alert: 'acknowledgement',
  // No reading.
  other: 'unclassified',
  // The classifier's default.
  unclassified: 'unclassified',
};

/* The badge colour for a stored class; unknown reads as unclassified, like its label. */
export function classBadgeTone(classification: unknown): string {
  // Same own-key rule as classLabel.
  return typeof classification === 'string' && Object.hasOwn(CLASS_TONES, classification) ? CLASS_TONES[classification as EmailClassification] : CLASS_TONES.unclassified;
}

/* The Type filter's choices: job mail (default), everything, then each class by its label. */
export const CLASS_FILTER_OPTIONS: ReadonlyArray<{ readonly value: EmailFilters['cls']; readonly label: string }> = [
  // The default view.
  { value: 'job', label: 'All job mail' },
  // Unclassified and other included.
  { value: 'all', label: 'Everything' },
  // One per class, in the label map's order.
  ...(Object.keys(CLASS_LABELS) as EmailClassification[]).map((c) => ({ value: c, label: CLASS_LABELS[c] })),
];

/* The classes the default view shows: job mail. Notices and unread-by-the-classifier mail stay out unless asked for. */
const NOT_JOB_MAIL: ReadonlySet<string> = new Set(['other', 'unclassified']);

/* The classes track_email_as_applied accepts: mail ABOUT an application. Mirrors the RPC's refusal list
   (unclassified, other, job_alert), so the page never offers a button the database refuses. */
const TRACKABLE: ReadonlySet<string> = new Set(['application_received', 'rejection', 'oa_invite', 'interview_invite', 'offer', 'recruiter_outreach']);

/* Can this email become a tracked Applied job? Unmatched, and about an application. */
export function isTrackable(event: EmailEventRow): boolean {
  // Both conditions, as the RPC checks them.
  return event.matched_application_id === null && TRACKABLE.has(event.classification);
}

/* The page's filter state, every field a closed set or a checked shape. */
export interface EmailFilters {
  // 'job' = all job mail (the default), 'all' = everything stored, or one class.
  readonly cls: 'job' | 'all' | EmailClassification;
  // Tracked = linked to an application; untracked = the "Not tracked" list.
  readonly track: 'all' | 'tracked' | 'untracked';
  // Free text over sender and subject.
  readonly q: string;
  // Inclusive local-day bounds, YYYY-MM-DD, or '' for open.
  readonly from: string;
  // The end of the range, same shape.
  readonly to: string;
  // Newest first (default), oldest first, or sender A to Z.
  readonly sort: 'newest' | 'oldest' | 'sender';
}

/* The state of a clean URL. */
export const DEFAULT_EMAIL_FILTERS: EmailFilters = { cls: 'job', track: 'all', q: '', from: '', to: '', sort: 'newest' };

// A calendar day exactly; Date.parse alone would accept '-5' as year -5.
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/* The filter state from the URL; each junk value falls back to its default instead of becoming a state. */
export function parseEmailFilters(params: URLSearchParams): EmailFilters {
  // Each raw value, possibly absent.
  const cls = params.get('cls');
  // Tracked or not.
  const track = params.get('track');
  // The order.
  const sort = params.get('sort');
  // The day bounds, '' when absent.
  const from = params.get('from') ?? '';
  // Same for the end.
  const to = params.get('to') ?? '';
  // Each field proven, else its default.
  return {
    // A class only when the label map knows it.
    cls: cls === 'all' || (cls !== null && Object.hasOwn(CLASS_LABELS, cls)) ? (cls as EmailFilters['cls']) : DEFAULT_EMAIL_FILTERS.cls,
    // The two narrowings, else all.
    track: track === 'tracked' || track === 'untracked' ? track : DEFAULT_EMAIL_FILTERS.track,
    // Text as typed, bounded so a pasted novel cannot stall the filter.
    q: (params.get('q') ?? '').slice(0, 200),
    // A real day or open.
    from: DAY.test(from) ? from : '',
    // Same rule for the end.
    to: DAY.test(to) ? to : '',
    // The two other orders, else newest.
    sort: sort === 'oldest' || sort === 'sender' ? sort : DEFAULT_EMAIL_FILTERS.sort,
  };
}

/* The URL for a filter state; defaults are left out, so the plain page has a plain URL. */
export function filtersToParams(filters: EmailFilters): URLSearchParams {
  // Built key by key in a fixed order, so equal states give equal URLs.
  const params = new URLSearchParams();
  // Every field, in the same order every time.
  for (const key of ['cls', 'track', 'q', 'from', 'to', 'sort'] as const) {
    // Only what differs from the clean page.
    if (filters[key] !== DEFAULT_EMAIL_FILTERS[key]) params.set(key, filters[key]);
  }
  // Ready for setSearchParams.
  return params;
}

/* The sender's display name, else its address: what "sender A to Z" sorts by and the text filter reads. */
function senderOf(fromAddress: string): string {
  // "Name <x@y>" -> "Name"; quotes dropped; a bare address stays itself.
  const name = fromAddress.replace(/<[^>]*>?/, '').replace(/"/g, '').trim();
  // Never empty.
  return name !== '' ? name : fromAddress.trim();
}

/* The emails a filter state keeps, in its order. */
export function applyEmailFilters(events: readonly EmailEventRow[], filters: EmailFilters): EmailEventRow[] {
  // Lowercased once.
  const q = filters.q.trim().toLowerCase();
  // Local-day bounds as instants; open ends never exclude.
  const fromMs = filters.from !== '' ? new Date(`${filters.from}T00:00:00`).getTime() : -Infinity;
  // The end of the last day, inclusive.
  const toMs = filters.to !== '' ? new Date(`${filters.to}T23:59:59.999`).getTime() : Infinity;
  // Every narrowing in one pass.
  const kept = events.filter((e) => {
    // Class: job mail, everything, or exactly one.
    if (filters.cls === 'job' ? NOT_JOB_MAIL.has(e.classification) : filters.cls !== 'all' && e.classification !== filters.cls) return false;
    // Tracked or not.
    if (filters.track === 'tracked' && e.matched_application_id === null) return false;
    // The "Not tracked" list: no application.
    if (filters.track === 'untracked' && e.matched_application_id !== null) return false;
    // Text over sender and subject.
    if (q !== '' && !`${e.from_address} ${e.subject}`.toLowerCase().includes(q)) return false;
    // Day range; an unparseable stamp is kept rather than silently dropped.
    const at = Date.parse(e.received_at);
    // Inside the range, inclusive at both ends.
    return !Number.isFinite(at) || (at >= fromMs && at <= toMs);
  });
  // Order: by time either way, or by sender with newest first inside one sender.
  const time = (e: EmailEventRow) => Date.parse(e.received_at) || 0;
  // kept is a fresh array from filter(), so sorting it in place changes nothing the caller holds.
  return kept.sort((a, b) =>
    // Oldest first.
    filters.sort === 'oldest' ? time(a) - time(b)
    // Sender A to Z, case-insensitive; newest first within one sender.
    : filters.sort === 'sender' ? senderOf(a.from_address).localeCompare(senderOf(b.from_address), undefined, { sensitivity: 'base' }) || time(b) - time(a)
    // Newest first, the default.
    : time(b) - time(a));
}

/* How many of these are unread in the app. */
export function unreadCount(events: readonly EmailEventRow[]): number {
  // read_at is the app's own mark; Gmail's read state is never read or written.
  return events.filter((e) => e.read_at === null).length;
}

/* The company slug sent to track_email_as_applied. THE rule, the same as scout-web slugFromToken:
   lowercase, every run of non-alphanumerics to one "-", no leading or trailing "-". The SQL only checks
   the shape, so this is the one implementation. '' means no usable slug; the page then refuses. */
export function companySlugOf(company: string): string {
  // The three steps of slugFromToken, in order.
  return company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Words a sender's display name adds after the company ("Acme Recruiting", "Globex Careers Team").
const SENDER_SUFFIX = /\s+(?:recruiting|recruitment|careers?|talent(?:\s+acquisition)?|hiring(?:\s+team)?|hr|jobs|team|notifications?)(?:\s+team)?$/i;

/* The Add to Applied form's starting values. Only a guess to edit: Teja confirms both before the call. */
export function prefillOf(event: EmailEventRow): { readonly company: string; readonly title: string } {
  // The display name without its recruiting suffix.
  const name = event.from_address.includes('<') ? senderOf(event.from_address).replace(SENDER_SUFFIX, '').trim() : '';
  // No name: the sender domain's main label, capitalised (careers@globex.com -> Globex).
  const domain = /@([^>\s]+)/.exec(event.from_address)?.[1] ?? '';
  // The label before the public suffix.
  const label = domain.split('.').slice(-2, -1)[0] ?? '';
  // Name first, then the domain label.
  const company = name !== '' ? name : label.charAt(0).toUpperCase() + label.slice(1);
  // The subject as the title, bounded to what the RPC accepts.
  return { company: company.slice(0, 200), title: event.subject.trim().slice(0, 200) };
}
