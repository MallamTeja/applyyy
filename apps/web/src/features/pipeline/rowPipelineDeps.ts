/* The REAL dependencies for the per-row pipeline engine (rowPipeline.ts), built 2026-10-08 for the
   Pipeline drawer's "Send through pipeline" button.

   Its own file, not the card's, because pipelineRunner.ts (for describeInvokeError) and
   supabase.ts both have import-time weight; DrawerAppCard.tsx stays importable with no client,
   which is why it was split out of the drawer in the first place.

   What this file may do is deliberately narrow: INVOKE an edge function and READ one status.
   It never writes a status. Commit 75a75a0 deleted a browser button that forged six transitions;
   every transition here is made by the deployed agent itself, and the database re-read is the
   only thing the UI believes. */

/* Type only: the contract this file implements, owned by rowPipeline.ts (another worker's file). */
import type { InvokeResult, PipelineStep, RowPipelineDeps } from './rowPipeline.ts';
/* Reused, not rewritten: it already reads the function's own `{error, detail}` out of the
   Response, so the user sees the agent's words rather than supabase-js's "non-2xx". */
import { describeInvokeError } from '../../data/pipelineRunner.ts';
/* Type only: the invoke half of the client, already declared for the batch runner. */
import type { FunctionsInvoker } from '../../data/pipelineRunner.ts';
/* The app's one client, or null when the machine has no Supabase env. */
import { supabase } from '../../data/supabase.ts';

/* The two client calls this file makes, and nothing else, so a test can hand in a fake with
   exactly these methods. The status read is a function rather than the from().select() chain:
   asking tsc to match SupabaseClient against a structural copy of that chain fails with TS2589
   ("excessively deep"), and a cast would hide a real mismatch. So the chain is written once,
   against the real typed client, in liveRowPipelineDeps below. */
export interface RowPipelineClient extends FunctionsInvoker {
  /* applications.status for one id; maybeSingle-shaped so "no row" is data:null, not an error.
     PromiseLike, because PostgREST builders are thenables, not Promises. */
  readStatusRow(applicationId: string): PromiseLike<{ data: unknown; error: unknown }>;
}

/* Builds the engine's deps over a client. Both methods NEVER throw: the engine has exactly one
   failure channel per call (ok:false / null), and a throw would skip its stop classification. */
export function makeRowPipelineDeps(client: RowPipelineClient): RowPipelineDeps {
  /* Returned as a plain object: no state, so a fresh one per render costs nothing. */
  return {
    /* One function call for one row. */
    async invoke(step: PipelineStep, applicationId: string): Promise<InvokeResult> {
      /* Everything inside can throw (a stub, a future SDK, a network fault), so all of it is wrapped. */
      try {
        /* The id rides in the query string, the same way pipelineRunner.ts:208 passes `limit`:
           functions-js builds `${url}/${functionName}`, so the suffix survives. Encoded because
           this is a URL; for a uuid the encoding is the identity. */
        const result = await client.functions.invoke(`${step}?application_id=${encodeURIComponent(applicationId)}`);
        /* supabase-js reports HTTP failures in `error`, not as a throw. */
        if (result.error) {
          /* Present on FunctionsHttpError/RelayError only; a fetch error has no Response. */
          const context = (result.error as { context?: unknown }).context;
          /* The function's own reason, so the UI can quote it instead of "non-2xx". */
          const described = await describeInvokeError(result.error);
          /* httpStatus null when no response arrived, so "offline" and "403" stay distinct. */
          return { ok: false, httpStatus: context instanceof Response ? context.status : null, body: { error: described.message } };
        }
        /* Newer supabase-js also returns the raw Response; read its status when present rather
           than inventing a 200 the SDK never told us. */
        const response = (result as { response?: unknown }).response;
        /* The parsed body goes to the engine, which checks it for halts and per-row failures. */
        return { ok: true, httpStatus: response instanceof Response ? response.status : null, body: result.data };
      } catch (err) {
        /* A throw is a failed call with no response; never let it escape into the engine. */
        return { ok: false, httpStatus: null, body: { error: err instanceof Error ? err.message : String(err) } };
      }
    },
    /* The database is the source of truth for where the row went; this is the only read. */
    async readStatus(applicationId: string): Promise<string | null> {
      /* A thrown read is "could not read", the same as an error result. */
      try {
        /* RLS scopes this to the signed-in user's own rows. */
        const { data, error } = await client.readStatusRow(applicationId);
        /* An error (RLS, network) is unreadable, never a guess. */
        if (error) return null;
        /* Loose view of the row; data is null when no row matched. */
        const status = (data as { status?: unknown } | null)?.status;
        /* Only a string is a status; anything else must not be read as one (repo CLAUDE.md §5). */
        return typeof status === 'string' ? status : null;
      } catch {
        /* Same channel as an error result, so the engine stops with status_unreadable. */
        return null;
      }
    },
  };
}

/* The live deps, or null on an unconfigured machine so the card can disable its button with a
   reason instead of failing on click. Built once at import: the client is a singleton. */
export const liveRowPipelineDeps: RowPipelineDeps | null =
  supabase === null
    ? null
    : makeRowPipelineDeps({
        /* The real functions client; its wider invoke signature is assignable to FunctionsInvoker. */
        functions: supabase.functions,
        /* The only query, delegated to liveRead so it is typed by the real SDK. */
        readStatusRow: (applicationId) => liveRead(applicationId),
      });

/* The one read against the real client. A function declaration, not inline, because TypeScript
   does not carry the "supabase is not null" narrowing into a closure over a module const. */
function liveRead(applicationId: string): PromiseLike<{ data: unknown; error: unknown }> {
  /* Unreachable when null (liveRowPipelineDeps is null then), but checked so this never throws. */
  if (supabase === null) return Promise.resolve({ data: null, error: new Error('Supabase is not configured') });
  /* Only the status column, only this row; RLS keeps it to the signed-in user's rows. */
  return supabase.from('applications').select('status').eq('id', applicationId).maybeSingle();
}
