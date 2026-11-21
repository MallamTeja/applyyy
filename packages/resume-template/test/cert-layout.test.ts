/**
 * Certifications / achievements layout (tailor pending #4, render-qa D1-D3, 2026-11-21).
 *
 * The 2026-11-18 render QA of three live tailored resumes (ElevenLabs, LSEG, Point72) found:
 *   D1  the run-in achievement line stays 9pt on every fit rung while every other size shrinks,
 *       so at the dense rungs an achievement prints LARGER than the cert names beside it, and the
 *       page-fit model (which DOES shrink it) under-counts the real height: a fail-open.
 *   D2  a certification prints all-bold, and with one link the WHOLE "Name (Issuer)" is the anchor,
 *       so 2 of 5 cert lines are blue and underlined end to end beside 3 black bold ones.
 *   D3  a wrapped cert or achievement line restarts flush-left under its own first word, so the
 *       eye cannot find where one entry ends and the next begins.
 * Each test below names the defect it pins, so a red test says which ruling it breaks.
 */

// node:test, the package's runner: no dependency, runs .ts directly.
import { describe, it } from 'node:test';
// Strict mode: deepEqual and friends compare without coercion.
import assert from 'node:assert/strict';

// The contract types for the hand-built fixture copies below.
import type { MasterLink, ResolvedResume } from '@applyy/shared-types';

// Every subject through the package's public surface, so a test cannot pass on a private path.
import { articleOf, flowOf, renderResumeHtml, RESUME_STYLESHEET, stepStylesheet, TYPOGRAPHY_LADDER } from '../src/index.ts';
// The shared fixture: cert_meta_backend has issuer 'Coursera', cert_nptel_dbms has none.
import { zomatoBackendIntern } from './fixtures/zomato-backend-intern.ts';
// The extractor stand-in the ATS tests use, so "one line" means what a parser reads.
import { naiveTextExtract } from './naive-text-extract.ts';

// A plain-data copy with a link on certifications[0] (cert_meta_backend), the shape a jsonb read gives.
function withCertLink(link: MasterLink): ResolvedResume {
  // Untyped clone: the test writes a key the fixture entry declares without.
  const clone = JSON.parse(JSON.stringify(zomatoBackendIntern)) as Record<string, any>;
  // The one credential link, so renderUndatedEntry takes its linked-title path.
  clone['certifications'][0]['links'] = [link];
  // Back to the contract type for the call under test.
  return clone as unknown as ResolvedResume;
}

// One entry's markup, from its data-ref to the next entry, so an assertion cannot be met by a neighbour.
function entryHtml(html: string, ref: string): string {
  // This entry's anchor attribute.
  const start = html.indexOf(`data-ref="${ref}"`);
  // A missing ref would make every assertion below vacuous: fail here instead.
  assert.ok(start >= 0, `entry ${ref} not rendered; the slice would be vacuous`);
  // Everything after the opening attribute.
  const rest = html.slice(start + 1);
  // The next entry or the section end, whichever comes first.
  const ends = [rest.indexOf('data-ref="'), rest.indexOf('</section>')].filter((i) => i >= 0);
  // The entry body alone.
  return html.slice(start, start + 1 + Math.min(...ends));
}

// Every `selector { ... }` rule of a stylesheet, whitespace collapsed, as [selector, body] pairs.
function rules(css: string): Array<[string, string]> {
  // Comments first: a `{` inside prose would otherwise open a fake rule.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // Flat rules only: this template has no nested at-rule blocks besides @page, which is flat too.
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1]!.replace(/\s+/g, ' ').trim(), m[2]!.replace(/\s+/g, ' ').trim()]);
}

describe('D2: a certification bolds and links only its NAME', () => {
  // The fixture with one credential link on the Meta cert.
  const html = renderResumeHtml(withCertLink({ id: 'lnk_meta', label: 'Credential', url: 'https://coursera.org/verify/ABC123' }));

  it('wraps only the cert name in the anchor; the issuer sits outside it in its own span', () => {
    // The Meta cert's markup alone.
    const cert = entryHtml(html, 'cert_meta_backend');
    // Positive shape: anchor closes after the name, then the regular-weight issuer span.
    assert.ok(
      cert.includes('<h3 class="resume__entry-title"><a href="https://coursera.org/verify/ABC123">Meta Back-End Developer Professional Certificate</a> <span class="resume__cert-issuer">(Coursera)</span></h3>'),
      `the cert title is not "<a>Name</a> <span issuer>": ${cert}`,
    );
  });

  it('prints an unlinked cert the same way: name, then the issuer span', () => {
    // The default fixture: no links on any cert.
    const cert = entryHtml(renderResumeHtml(zomatoBackendIntern), 'cert_meta_backend');
    // Same split, no anchor.
    assert.ok(
      cert.includes('<h3 class="resume__entry-title">Meta Back-End Developer Professional Certificate <span class="resume__cert-issuer">(Coursera)</span></h3>'),
      `the unlinked cert title is not "Name <span issuer>": ${cert}`,
    );
  });

  it('sets the issuer span in regular weight', () => {
    // The stylesheet's rule for the issuer, found by its exact selector.
    const rule = rules(RESUME_STYLESHEET).find(([selector]) => selector === '.resume__cert-issuer');
    // A missing rule leaves it inheriting the h3's bold: the defect itself.
    assert.ok(rule !== undefined, 'no .resume__cert-issuer rule: the issuer inherits the bold title weight');
    // Regular weight, stated as the number the rest of the sheet uses.
    assert.match(rule[1], /font-weight: 400;/);
  });

  it('still extracts as ONE "Name (Issuer)" line for a parser', () => {
    // What a text extractor reads from the linked render.
    const lines = naiveTextExtract(html);
    // The inline span must not break the line: the 2026-11-10 one-line-per-cert height saving depends on it.
    assert.ok(lines.includes('Meta Back-End Developer Professional Certificate (Coursera)'), 'the cert no longer extracts as one "Name (Issuer)" line');
  });
});

describe('D3: wrapped cert and achievement lines hang under the first line', () => {
  // The base sheet's rules, parsed once.
  const base = rules(RESUME_STYLESHEET);

  // A hanging indent is padding-left N plus text-indent -N on the same rule.
  for (const selector of ['.resume__split .resume__entry-title', '.resume__runin']) {
    it(`gives ${selector} a hanging indent`, () => {
      // Every rule whose selector LIST names this selector (the split title has more than one rule).
      const bodies = base.filter(([s]) => s.split(/\s*,\s*/).includes(selector)).map(([, body]) => body).join(' ');
      // The left padding in mm.
      const pad = /padding-left: ([0-9.]+)mm;/.exec(bodies)?.[1];
      // The negative first-line indent in mm.
      const indent = /text-indent: -([0-9.]+)mm;/.exec(bodies)?.[1];
      // Both present, and equal, or the first line does not start at the column edge.
      assert.ok(pad !== undefined && indent !== undefined, `${selector} has no padding-left + negative text-indent pair`);
      assert.equal(pad, indent, `${selector}: padding-left ${pad}mm and text-indent -${indent}mm do not cancel on line 1`);
    });
  }
});

describe('D1: every font size the base sheet sets is scaled by every fit rung', () => {
  // Selectors that set a font-size in the base sheet (the @page and * rules set none).
  const sized = rules(RESUME_STYLESHEET).filter(([, body]) => /font-size:/.test(body)).map(([selector]) => selector);

  it('finds the sized selectors (a vacuous list would pass every rung)', () => {
    // The run-in rule is the one this defect is about; it must be in the list for the test to mean anything.
    assert.ok(sized.includes('.resume__runin'), `the base sheet no longer sizes .resume__runin: ${sized.join(' | ')}`);
  });

  // Rung 0 adds no CSS by design; every later rung must re-size every sized selector.
  for (let index = 1; index < TYPOGRAPHY_LADDER.length; index += 1) {
    it(`rung ${index} re-sizes every selector the base sheet sizes`, () => {
      // The rung's override rules that set a font-size.
      const scaled = new Set(rules(stepStylesheet(index)).filter(([, body]) => /font-size:/.test(body)).map(([selector]) => selector));
      // Any base size the rung leaves alone prints unscaled while the model scales it.
      const missing = sized.filter((selector) => !scaled.has(selector));
      assert.deepEqual(missing, [], `rung ${index} leaves these at their rung-0 size`);
    });
  }

  it('scales the split entry gap too (the model scales it; the CSS used to keep 1.2mm)', () => {
    // The densest rung, where the gap matters most.
    const last = TYPOGRAPHY_LADDER.length - 1;
    // The override for the split's entry gap.
    const rule = rules(stepStylesheet(last)).find(([selector]) => selector === '.resume__split .resume__entry');
    // Without it the base rule's two-class selector beats the step's one-class .resume__entry rule.
    assert.ok(rule !== undefined, 'no .resume__split .resume__entry override: the 1.2mm split gap never shrinks');
    // 1.2mm times the rung's gap scale, to the same two decimals the step CSS writes.
    assert.match(rule[1], new RegExp(`margin-bottom: ${(1.2 * TYPOGRAPHY_LADDER[last]!.gapScale).toFixed(2)}mm;`));
  });
});

describe('page-fit models the hanging indent (never narrower in CSS than in the model)', () => {
  // The fixture's article flow, split row included (flowOf reads the <article>, as renderResumeHtml does).
  const flow = flowOf(articleOf(renderResumeHtml(zomatoBackendIntern)));
  // The split row's columns, flattened.
  const columns = flow.flatMap((item) => (item.kind === 'columns' ? item.columns.flat() : []));

  it('reads a split row at all (a missing row would make the checks below vacuous)', () => {
    // The fixture has both sections, so the renderer emits the split.
    assert.ok(columns.length > 0, 'the fixture flow has no split row');
  });

  it('narrows every split title by the hang', () => {
    // The cert/achievement heads inside the split.
    const heads = columns.filter((item) => item.kind === 'head');
    // At least one, or the check is vacuous.
    assert.ok(heads.length > 0, 'no split heads in the fixture flow');
    // Each carries the hang in mm, so its wrapped lines are measured at the narrower width.
    for (const head of heads) assert.ok(head.kind === 'head' && (head.hangMm ?? 0) > 0, `split head "${head.kind === 'head' ? head.title : ''}" is measured without the hang`);
  });

  it('narrows a run-in achievement line by the hang', () => {
    // The exact markup renderAchievement emits for a run-in, parsed alone (the fixture may hold none).
    const runin = flowOf('<div class="resume__runin"><strong class="resume__runin-label">X</strong>: <span data-ref="b">y</span></div>', true);
    // The one text box it yields.
    const box = runin.find((item) => item.kind === 'text');
    // Measured indented, so its wrapped lines are never wider in the model than on paper.
    assert.ok(box !== undefined && box.kind === 'text' && box.indentMm > 0, 'the run-in line is measured at full column width');
  });
});
