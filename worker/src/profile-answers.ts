// Answers a form question from the master profile, or declines. Pure.
//
// WHY A CLOSED TABLE: the profile may only answer questions whose meaning is
// unambiguous and whose answer is a plain fact Teja already stored. An exact match on a
// normalised label against a fixed synonym list cannot over-reach; substring or fuzzy
// matching ("phone" inside "emergency contact phone") would type Teja's own number into a
// question about someone else. Declining (null) is always the safe answer here.
// Type-only imports: erased at runtime, so this module stays pure and dependency-free.
import type { MasterProfile } from '@applyy/shared-types';
// FormField supplies the label to match and the kind/options that gate the country rule.
import type { FormField } from './extract-fields.ts';

/**
 * Reduce a label or a stored key to a comparable form. Lives here (re-exported by
 * plan-fill.ts) so there is exactly one definition and no import cycle.
 *
 * ATS labels vary cosmetically ("First Name", "first name*", "First  Name:") while the
 * answer bank stores one normalised key; without this every form would miss on punctuation.
 */
export function normaliseKey(text: string): string {
  return (
    text
      // Case differences are cosmetic, so fold them away before comparing.
      .toLowerCase()
      // Any run of non-alphanumerics becomes one underscore so spaces, colons and asterisks collapse alike.
      .replace(/[^a-z0-9]+/g, '_')
      // Trim the underscores those substitutions leave at the ends so "email*" equals "email".
      .replace(/^_+|_+$/g, '')
  );
}

// Which profile value a label resolves to; a closed union so a typo cannot add a new kind.
// full_name, city, location and company join the original six; each is a plain stored fact.
type ProfileField =
  | 'email' | 'phone' | 'linkedin' | 'github' | 'website' | 'country'
  | 'full_name' | 'city' | 'location' | 'company';

// The closed synonym table: normalised label -> profile field. Exact keys only, by design.
// A Map (not an object literal) because a label like "constructor" or "__proto__" would hit
// Object.prototype on a plain object and return a function, crashing the caller.
const SYNONYMS: ReadonlyMap<string, ProfileField> = new Map<string, ProfileField>([
  // Email.
  ['email', 'email'],
  ['email_address', 'email'],
  // Phone.
  ['phone', 'phone'],
  ['phone_number', 'phone'],
  ['mobile', 'phone'],
  ['mobile_number', 'phone'],
  // More phrasings of the same single stored number (mobile, contact, abbreviated, formal).
  // None overlaps a denylist fragment, so none can route a legal question to the phone value.
  ['mobile_phone', 'phone'],
  ['contact_number', 'phone'],
  ['contact_phone', 'phone'],
  ['phone_no', 'phone'],
  ['telephone', 'phone'],
  // Full name, copied as-is. "legal_name" is deliberately absent: it can differ from the profile name.
  // The canonical label.
  ['full_name', 'full_name'],
  // The second-person phrasing of the same label.
  ['your_full_name', 'full_name'],
  // Bare Name; no denylist fragment contains it, so it reaches the table.
  ['name', 'full_name'],
  // City, derived from the first location segment. Only ever a city label, never "location".
  // The canonical city label.
  ['city', 'city'],
  // Same question, stated as current.
  ['current_city', 'city'],
  // Same question, stated as residence.
  ['city_of_residence', 'city'],
  // Free-text location, copied whole. "where_are_you_located" is absent: it overlaps the located_in denylist.
  // Explicit free-text location label.
  ['current_location', 'location'],
  // Bare Location; distinct from the denylisted located_in phrasing.
  ['location', 'location'],
  // Employer of the single role explicitly marked "Present". "company_name" is absent: too ambiguous.
  // The canonical employer label.
  ['current_company', 'company'],
  // Synonym for the same fact.
  ['current_employer', 'company'],
  // LinkedIn.
  ['linkedin', 'linkedin'],
  ['linkedin_profile', 'linkedin'],
  ['linkedin_url', 'linkedin'],
  ['linkedin_profile_url', 'linkedin'],
  // GitHub.
  ['github', 'github'],
  ['github_profile', 'github'],
  ['github_url', 'github'],
  // Website / portfolio.
  ['website', 'website'],
  ['portfolio', 'website'],
  ['personal_website', 'website'],
  ['portfolio_url', 'website'],
  // Country of residence (factual, unlike work-authorisation questions).
  ['what_is_your_current_country_of_residence', 'country'],
  ['country_of_residence', 'country'],
  ['country', 'country'],
]);

// Which normalised link labels satisfy each link-typed field. Link objects carry
// {id, label, url} only (profile-nodes.ts MasterLink): the label is the sole classifier.
const LINK_LABELS: Readonly<Record<'linkedin' | 'github' | 'website', readonly string[]>> = {
  // Only an explicit LinkedIn label counts; a URL host is not inspected (no guessing).
  linkedin: ['linkedin'],
  // Same for GitHub.
  github: ['github'],
  // Portfolio and website are interchangeable on application forms.
  website: ['portfolio', 'website', 'personal_website'],
};

/** A stored value counts only if it is a non-empty string; blank must never become an answer. */
function nonEmpty(value: string | null | undefined): string | null {
  // typeof guard because the profile is jsonb and may not match its declared type at runtime.
  if (typeof value !== 'string') return null;
  // Whitespace-only is as good as missing, so trim before testing.
  const trimmed = value.trim();
  // Empty collapses to null so callers have one "no value" shape to check.
  return trimmed === '' ? null : trimmed;
}

/**
 * The country from a "City, Region, Country" location, or null when it cannot be told.
 * Requires at least two non-empty segments: a lone "Hyderabad" is a city, and treating the
 * last segment as the country would type a city into a country field.
 */
function countryOf(location: string | null | undefined): string | null {
  // Missing or blank location has no country.
  const text = nonEmpty(location);
  // No location text means no country, and nothing to parse.
  if (text === null) return null;
  // Drop empty segments so "Hyderabad, , " does not count as three parts.
  const parts = text.split(',').map((part) => part.trim()).filter((part) => part !== '');
  // One segment is ambiguous (city? country?), so refuse rather than guess.
  if (parts.length < 2) return null;
  // Convention is most-specific first, so the last segment is the country.
  return parts[parts.length - 1] ?? null;
}

/**
 * The city from a "City, Region, Country" location, or null when it cannot be told.
 * Same two-segment floor as countryOf: a lone "Hyderabad" could be a city or a country, so
 * it is refused here rather than typed into a city field on a guess.
 */
function cityOf(location: string | null | undefined): string | null {
  // Missing or blank location has no city.
  const text = nonEmpty(location);
  // Nothing to parse.
  if (text === null) return null;
  // Drop empty segments so "Hyderabad, , " does not count as three parts.
  const parts = text.split(',').map((part) => part.trim()).filter((part) => part !== '');
  // One segment is ambiguous (city? country?), so refuse rather than guess.
  if (parts.length < 2) return null;
  // Convention is most-specific first, so the first segment is the city.
  return parts[0] ?? null;
}

/**
 * The employer of the one experience entry whose end_display is the literal "Present"
 * (the documented current-role marker, profile-nodes.ts:175), or null.
 * A null end_date is NOT used: it can mean "current" or "never entered", and treating it as
 * current would turn missing data into an answer. Zero or several markers also give null.
 */
function currentCompanyOf(experience: unknown): string | null {
  // jsonb may not be an array at runtime; anything else has no current role.
  if (!Array.isArray(experience)) return null;
  // Collect every entry carrying the explicit marker, tolerating malformed entries.
  const current = experience.filter(
    (entry) =>
      // Skip junk entries rather than throwing on jsonb of unknown shape.
      entry !== null && typeof entry === 'object' &&
      // The marker is compared normalised so "Present" and "present" both count, nothing else does.
      typeof entry.end_display === 'string' && normaliseKey(entry.end_display) === 'present',
  );
  // Two concurrent current roles make "the" employer ambiguous, so refuse.
  if (current.length !== 1) return null;
  // The one marked entry's employer, blank-safe.
  return nonEmpty(current[0].company);
}

/**
 * The value the master profile holds for this field's label, or null when the label is not
 * in the table, the profile lacks the value, or (country) the control would not accept it.
 */
export function resolveProfileAnswer(field: FormField, profile: MasterProfile | null): string | null {
  // No profile (not fetched, or none exists) means nothing can be copied.
  if (profile === null || profile.identity === undefined || profile.identity === null) return null;
  // Exact lookup; an unknown label is deliberately not guessed at.
  const target = SYNONYMS.get(normaliseKey(field.label));
  // Not in the closed table: this resolver has no business answering it.
  if (target === undefined) return null;
  // Local alias, since every branch below reads from identity.
  const identity = profile.identity;

  // Plain facts copy straight across; nonEmpty keeps blanks from becoming answers.
  if (target === 'email') return nonEmpty(identity.email);
  // Phone is a stored fact like email; a blank one stays unanswered.
  if (target === 'phone') return nonEmpty(identity.phone);

  // Full name is stored whole and copied whole; never split (family-name-first risk).
  if (target === 'full_name') return nonEmpty(identity.full_name);
  // Location is free text copied verbatim; no parsing, so nothing to get wrong.
  if (target === 'location') return nonEmpty(identity.location);
  // City is derived, so it carries cityOf's two-segment guard.
  if (target === 'city') return cityOf(identity.location);
  // Company comes from the experience list, never from identity.
  if (target === 'company') return currentCompanyOf(profile.experience);

  // Country is the one DERIVED value, so it gets the extra guards below.
  if (target === 'country') {
    // Free-text and other kinds would receive a PARSED GUESS with nothing to validate it,
    // so only controls that check the value exactly are eligible.
    if (field.kind !== 'native_select' && field.kind !== 'combobox') return null;
    // Parse the country; null when the location is too thin to tell.
    const country = countryOf(identity.location);
    // Too thin to tell: leave it for the human rather than guess.
    if (country === null) return null;
    // A native select must offer this exact string; a combobox has no options here and is
    // validated exactly by the filler at fill time.
    if (field.kind === 'native_select' && !(field.options ?? []).includes(country)) return null;
    // Every guard passed: the value is safe to hand over.
    return country;
  }

  // Link fields: find the first link whose label classifies as the wanted kind.
  const wanted = LINK_LABELS[target];
  // jsonb may not be an array at runtime; treat anything else as no links.
  const links = Array.isArray(identity.links) ? identity.links : [];
  // Walk in profile order so the first matching link is the one Teja listed first.
  for (const link of links) {
    // Skip malformed entries rather than throwing on jsonb of unknown shape.
    if (link === null || typeof link !== 'object' || typeof link.label !== 'string') continue;
    // First match wins; the label alone classifies the link.
    if (wanted.includes(normaliseKey(link.label))) return nonEmpty(link.url);
  }
  // No link carried the wanted label.
  return null;
}
