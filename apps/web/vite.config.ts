// Vite config for the applyy operator console.
import { defineConfig } from 'vite';
// The React plugin supplies Fast Refresh in dev and the automatic JSX runtime.
import react from '@vitejs/plugin-react';

export default defineConfig({
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
});
