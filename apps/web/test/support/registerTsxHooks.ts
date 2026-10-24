/* Side-effect module: lets node --test import .tsx components and extensionless relative imports.
 *
 * WHY A SHARED FILE (2026-10-24). The same 30-line hook was copied into each rendering test
 * (healthRuleWarnings, filtersNotEnforced, needsYouQueues). Import this FIRST in a test file
 * (`import './support/registerTsxHooks.ts';`); ES module imports run in order, so the hooks are in
 * place before any component is imported. Not a *.test.ts file, so the test glob never runs it alone. */

import { registerHooks, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

registerHooks({
  // Extensionless RELATIVE imports only: try the original, then .tsx, then .ts.
  resolve(specifier, context, nextResolve) {
    // Packages and already-extended paths resolve normally.
    if (!specifier.startsWith('.') || /\.[cm]?[jt]sx?$|\.css$/.test(specifier)) return nextResolve(specifier, context);
    // First the way Vite would write it.
    try { return nextResolve(specifier, context); } catch { /* fall through to TS extensions */ }
    // A component is the usual case.
    try { return nextResolve(`${specifier}.tsx`, context); } catch { /* then a plain module */ }
    // Last resort; a genuine miss throws with the .ts path named.
    return nextResolve(`${specifier}.ts`, context);
  },
  // .css becomes empty, .tsx is transpiled with apps/web's own typescript.
  load(url, context, nextLoad) {
    // Stylesheets have no runtime meaning in Node.
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    // Everything else but .tsx loads normally.
    if (!url.endsWith('.tsx')) return nextLoad(url, context);
    // No new dependency: the typescript apps/web already has.
    const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
    // nextLoad refuses .tsx, so read it directly.
    const source = readFileSync(fileURLToPath(url), 'utf8');
    // react-jsx matches tsconfig.
    const out = ts.transpileModule(source, {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    // Plain ESM for Node.
    return { format: 'module', source: out.outputText, shortCircuit: true };
  },
});
