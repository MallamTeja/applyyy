// The agent-key header: how a machine agent proves it is one.
//
// WHY. Every edge function, the worker and the browser sign in as the SAME auth user, so
// the database cannot tell the auditor from a browser tab by JWT. Migration 20261008160000
// makes advance_application_status refuse any p_agent other than 'human' unless the request
// carries this header with the secret whose SHA-256 is seeded in applyy_internal.agent_key.
// The secret lives only in Supabase function secrets and GitHub Actions secrets, never in
// the repo or the browser bundle.
//
// One builder for both runtimes (Deno edge functions import it directly, the worker by
// relative path), so the header name and the trimming rule cannot drift apart.

// Lowercase on purpose: PostgREST lowercases header names in `request.headers`, which is
// what the SQL helper reads. A capitalised name here would still work over HTTP, but
// matching the SQL literally removes one thing to reason about.
export const AGENT_KEY_HEADER = "x-applyy-agent-key";

// The environment variable both runtimes read. Named once so the runbook, the edge secret
// and the GitHub secret all point at the same string.
export const AGENT_KEY_ENV_VAR = "APPLYY_AGENT_KEY";

/** Headers to attach to a machine agent's Supabase client: the key, or nothing at all. */
export function agentKeyHeaders(key: string | null | undefined): Record<string, string> {
  // Trimmed, because a pasted secret with a trailing newline would hash differently from
  // the seeded value and lock every agent out once enforcement is on.
  const trimmed = (key ?? "").trim();
  // Unset or blank: send NO header. Before the secret is set this keeps clients exactly as
  // they were, and an empty header would only turn "missing" into a confusing "invalid".
  if (trimmed.length === 0) return {};
  // The one header the database checks.
  return { [AGENT_KEY_HEADER]: trimmed };
}
