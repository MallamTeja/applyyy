/* Reading the `role` claim out of a Supabase key.
 *
 * WHY THIS IS ITS OWN MODULE, and it is not for tidiness. The check it feeds -
 * `supabase.ts` refusing to construct a client unless the key's role reads
 * "anon" - is the single line standing between a pasted service-role key and a
 * bundle Vercel serves. That line is worth testing directly, and it could not
 * be:
 *
 *   - `readRoleClaim` was module-private inside `supabase.ts`, and
 *   - `supabase.ts` throws AT IMPORT TIME when the key is missing or wrong.
 *
 * So a test could not import the function without first satisfying the very
 * guard it was trying to test. A guard whose test requires the guard to pass is
 * not a tested guard.
 *
 * Naming the pattern: SEPARATE THE PURE DECISION FROM THE SIDE EFFECT. The
 * decision - "what role does this token claim?" - is a total function of its
 * input with no environment, no I/O and no throwing. The side effect - refusing
 * to boot - stays in `supabase.ts` where it belongs. The seam is what makes the
 * decision testable, and the decision is the part that can be subtly wrong.
 *
 * The related trap this avoids: redundant defences make each other untestable.
 * If the role check and some later RLS failure both happened to block a bad
 * key, a test could pass while the check it was named after did nothing. There
 * is exactly one gate here, it lives in one place, and the tests below feed it
 * inputs that only it can catch.
 *
 * NO VERIFICATION HAPPENS HERE, deliberately. Verifying a JWT signature needs
 * the issuer's secret, which the browser must never hold, and it is not the
 * question being asked. The question is "did the operator paste the wrong one
 * of their own two keys", and the issuer's own unverified claim answers that
 * completely. An attacker who could forge this claim already has the key.
 */

/* What a token claims to be.
 *
 * `null` is a real answer rather than an error case: it means the role could
 * not be read at all, and the caller must treat that as a FAILURE rather than
 * as permission. Returning a string like 'unknown' would invite a comparison
 * that accidentally succeeds. */
export type KeyRole = string | null;

/* The role claim carried by a Supabase key, or null if it cannot be read.
 *
 * Total: never throws, for any input, including the empty string. The caller is
 * a boot-time guard, and a guard that can itself throw an unexpected error is a
 * guard with a second, undocumented failure mode. */
export function readRoleClaim(token: string): KeyRole {
  /* A JWT is three base64url segments joined by dots; the middle one is the
     payload. Anything with a different shape is not a Supabase key at all, and
     saying so early keeps the decode below from having to be defensive. */
  const segments = token.split('.');
  if (segments.length !== 3) return null;

  /* `noUncheckedIndexedAccess` types this as possibly-undefined, which is
     correct - the compiler cannot connect the length check above to this index,
     so the guard is real rather than ceremonial. */
  const payloadSegment = segments[1];
  if (payloadSegment === undefined) return null;

  try {
    /* base64url differs from base64 in exactly two characters and `atob` only
       understands the latter, so translate before decoding. */
    const base64 = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
    const decoded: unknown = JSON.parse(atob(base64));

    /* The decoded payload is untrusted JSON - it is whatever was in the file
       the operator pasted - so narrow it rather than casting to a shape we have
       merely assumed. A cast here would turn a malformed key into a runtime
       type error instead of a clean configuration failure. */
    if (typeof decoded !== 'object' || decoded === null) return null;
    const role = (decoded as Record<string, unknown>)['role'];
    /* A non-string `role` (a number, an object, null) is unreadable, not
       acceptable. Same reasoning as the shape check above. */
    return typeof role === 'string' ? role : null;
  } catch {
    /* Malformed base64, or payload that is not JSON. FAILS CLOSED: null routes
       into the caller's refusal path, exactly like a service-role key would.
       This is the case most likely to be got wrong, because the tempting
       shortcut is to ignore an unparseable key and carry on - which would let a
       key through precisely when we understand it least. */
    return null;
  }
}

/* Is this key safe for the browser to hold?
 *
 * A NAMED PREDICATE rather than a `=== 'anon'` comparison at the call site, for
 * the reason the `humanLanes.ts` bug taught this codebase: a set or a test whose
 * name does not state its predicate invites two readers to assume different
 * ones. The name says what is being asked, and the answer is false for both a
 * wrong role and an unreadable one - so a caller cannot accidentally treat
 * "could not tell" as "fine". */
export function isBrowserSafeKey(token: string): boolean {
  /* Only the anon key. `service_role` bypasses RLS entirely, so a bundle
     carrying one would hand every visitor of the deployed URL full read and
     write access to a database holding a resume, CTC figures and personal
     answers. */
  return readRoleClaim(token) === 'anon';
}
