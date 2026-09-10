// Vite config for the applyy operator console.
import { defineConfig, loadEnv } from 'vite';
// The React plugin supplies Fast Refresh in dev and the automatic JSX runtime.
import react from '@vitejs/plugin-react';

// The role decision, shared with the runtime guard rather than reimplemented.
// Two copies of a security check is how one of them ends up subtly wrong and
// nobody notices which one is live.
import { resolveSupabaseConfig } from './src/data/supabaseConfig.ts';

/**
 * REFUSE TO BUILD when the configured key is not an anon key.
 *
 * WHY THIS EXISTS ON TOP OF THE RUNTIME GUARD, which already throws at import
 * time. Because the runtime guard prevents the wrong thing. It stops the
 * console from OPERATING with a bad key - it does not stop the key from being
 * SHIPPED. Verified by experiment, not assumed: with a service-role key in
 * .env.local, `vite build` exited 0 and the token was embedded verbatim in
 * dist/assets/index-*.js. The runtime check then fired in the browser - but by
 * then the bundle had already been served to whoever loaded the page.
 *
 * On a developer's machine that distinction does not matter much: you paste the
 * wrong key, you open the page, you see the error, nothing was published. On a
 * DEPLOY it matters completely. `vercel deploy` would succeed, the URL would go
 * live carrying a key that bypasses RLS, and the guard would announce the
 * problem in the console of the first person to visit - which is far too late,
 * because a key that has been served is a key that must be rotated.
 *
 * So the build is the right place to catch it: nothing is published, and the
 * failure lands on whoever ran the build. Prevention at the last moment where
 * prevention is still possible.
 *
 * Note this is deliberately NOT symmetrical with the runtime guard. A MISSING
 * key must not fail the build - a preview built with no Supabase env is inert
 * but perfectly legitimate, and the console is designed to open unconfigured.
 * Only a key that is present and wrong stops the build.
 */
function assertNoServiceRoleKey(mode: string): void {
  // '' as the prefix loads every variable, not just VITE_-prefixed ones, so a
  // SUPABASE_SERVICE_ROLE_KEY sitting in the same .env file is visible to the
  // check below even though Vite would never expose it to the bundle.
  const env = loadEnv(mode, process.cwd(), '');

  // The same function the runtime uses, fed the same two values.
  const config = resolveSupabaseConfig(
    env['VITE_SUPABASE_URL'],
    env['VITE_SUPABASE_ANON_KEY'],
  );

  // 'unconfigured' is fine and builds normally - see the note above about
  // asymmetry. Only an actively wrong key is fatal.
  if (config.kind === 'refused') {
    throw new Error(
      'applyy build refused: VITE_SUPABASE_ANON_KEY has role "' +
        (config.role ?? 'unreadable') +
        '", not "anon". This key would have been embedded verbatim in the ' +
        'bundle. A service-role key bypasses RLS entirely, and a key that has ' +
        'been served must be rotated - so the build stops here rather than ' +
        'producing a publishable artifact. If an operation needs the ' +
        'service-role key, that operation belongs in a Supabase Edge Function. ' +
        'Do not weaken this to make a build or a deploy succeed.',
    );
  }

  // A second, independent check on a DIFFERENT variable: a service-role key
  // that has been given a VITE_ prefix would be exposed to the bundle by Vite's
  // own rules, and the check above only inspects the anon-key variable. This
  // catches `VITE_SUPABASE_SERVICE_ROLE_KEY=...` and anything like it.
  for (const name of Object.keys(env)) {
    // Only VITE_-prefixed names can reach the bundle, so a non-prefixed
    // service-role key in .env is not this check's business.
    if (!name.startsWith('VITE_')) continue;
    const value = env[name];
    if (value === undefined || value === '') continue;
    // Read the role rather than pattern-matching the NAME: a variable called
    // VITE_SUPABASE_KEY_2 holding a service-role token would pass any
    // name-based check, and the role claim is the fact that actually matters.
    const probe = resolveSupabaseConfig('https://placeholder.invalid', value);
    if (probe.kind === 'refused' && probe.role !== null) {
      throw new Error(
        'applyy build refused: ' +
          name +
          ' is a VITE_-prefixed variable holding a token whose role is "' +
          probe.role +
          '". Anything VITE_-prefixed is exposed to the browser bundle. Only ' +
          'an anon key may ever be exposed.',
      );
    }
  }
}

export default defineConfig(({ mode }) => {
  // Runs before any bundling, so a refusal produces no artifact at all rather
  // than one that has to be remembered not to publish.
  assertNoServiceRoleKey(mode);

  return {
    // Only plugin in the stack. Nothing here may pull in a server runtime:
    // constraint #6 keeps all browser automation out of serverless, and this app
    // is a pure static bundle so there is no serverless surface to misuse.
    plugins: [react()],
    build: {
    // Vercel serves this directory as static files; naming it explicitly rather
    // than relying on the default keeps the Vercel project setting readable.
    outDir: 'dist',
    // Source maps are safe here and make a production bug reproducible, because
    // the bundle contains no secrets — the anon key is public by design (§10.4).
    sourcemap: true,
    // Fail the build if a chunk crosses this, as an early warning that someone
    // has imported a heavyweight dependency into a dashboard that must stay a
    // cheap static asset.
    chunkSizeWarningLimit: 600,
    },
    server: {
    // A fixed port so the peer sessions and any screenshot tooling agree on one
    // URL instead of guessing which port Vite picked today.
    port: 5173,
    // Fail loudly rather than silently sliding to 5174, which is how two dev
    // servers end up running and one of them serving stale code.
      strictPort: true,
    },
  };
});
