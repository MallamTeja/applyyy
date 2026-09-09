// Vitest is the single test runner for this package, driving the `playwright`
// library directly rather than adding @playwright/test. Playwright is already a
// production dependency here — it IS the applier — so using it from Vitest adds
// no new dependency, and one runner keeps the root `pnpm -r run test` uniform.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node environment, not jsdom: the DOM under test is a REAL browser page
    // driven by Playwright against a real fixture server. A simulated DOM would
    // defeat the entire point of saving real ATS markup (PROJECT_PLAN.md §19).
    environment: 'node',
    // Launching Chromium and loading a form costs seconds, so the default 5s
    // timeout would flake. Kept tight enough that a genuine hang still fails
    // fast rather than burning GitHub Actions minutes (§2 budget).
    testTimeout: 30_000,
    // Browser tests bind real localhost ports. Running files sequentially
    // avoids port races and keeps peak memory low on a 2-core Actions runner.
    fileParallelism: false,
    // Only this package's own tests; fixtures are data, never test files.
    include: ['test/**/*.test.ts'],
  },
});
