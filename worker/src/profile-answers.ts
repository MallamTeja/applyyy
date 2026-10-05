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
type ProfileField = 'email' | 'phone' | 'linkedin' | 'github' | 'website' | 'country';

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
