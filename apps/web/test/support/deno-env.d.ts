/* The slice of the Deno global that edge-function files reached by web tests touch (W36, 2026-11-10).
   WHY: aiEditContract.test.ts imports supabase/functions/resume-assist/assist.ts, which reaches
   _shared/gemini/pool.ts; its `denoKeyReader` calls Deno.env.get. Node never runs that line (the
   tests pass their own key reader), but tsc checks the whole file. This declares the REAL signature
   (Deno.env.get returns string | undefined), not `any`, so a misuse there still fails to compile.
   Only reached by tsconfig.test.json (which includes `test`); the app's tsconfig.json roots only
   `src`, so browser code that wrongly touched `Deno` still fails the app's own tsc step. */
declare const Deno: {
  // Read-only view of the process environment; an unset variable is undefined, never "".
  readonly env: { get(key: string): string | undefined };
};
