// PROJECT_PLAN.md §17.2 — the ATS parse simulator.
//
// THE FAILURE THIS CATCHES IS THE COMMONEST SILENT FRESHER KILLER: a
// nicely-designed two-column resume that parses into interleaved gibberish, so
// the machine never sees the skills and a human never sees the resume. Nothing
// errors. The PDF looks perfect to the person who made it, and the rejection is
// indistinguishable from an ordinary rejection.
//
// WHY THESE TESTS EXIST RATHER THAN STRUCTURAL ASSERTIONS. The resume template
// currently asserts §17.2 compliance structurally — no columns, no tables, real
// `<ul>` elements. Those are a PROXY for parseability, and the proxy can be
// satisfied by a document that still extracts wrongly: CSS can column a single
// `<div>`, absolute positioning can reorder text without any table, and a
// float-based layout has neither columns nor tables in the markup. **The
// extractor is the truth; the structure is a guess about the extractor.**
import { describe, expect, it } from 'vitest';
import { checkAtsReadability, type ExtractedPdfText } from '../src/ats-parse-check.ts';

/** Build an extraction result from the fragments an extractor would emit. */
function extracted(items: string[]): ExtractedPdfText {
  return { items, text: items.join(' ') };
}

describe('checkAtsReadability', () => {
  it('accepts a single-column resume whose sections extract in order', () => {
    // The good case: headings come out in the order a reader sees them, and
    // every skill the tailoring claimed is present in the text layer.
    const result = checkAtsReadability(
      extracted(['EXPERIENCE', 'Built a REST API', 'SKILLS', 'Node.js', 'Express']),
      { mustContain: ['Node.js', 'Express'], inOrder: ['EXPERIENCE', 'SKILLS'] },
    );

    expect(result.readable).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it('detects interleaved columns by section order, not by appearance', () => {
    // THE TWO-COLUMN KILLER. A left column holding EXPERIENCE beside a right
    // column holding SKILLS extracts ROW BY ROW ACROSS THE PAGE, so headings
    // arrive first and their bodies afterwards. Every individual word is
    // present — a "does the text contain Node.js" check passes happily — but
    // the document reads as nonsense and section membership is destroyed.
    //
    // THE EXPECTATION MUST ALTERNATE HEADING AND BODY, and this is the subtlety
    // that makes or breaks the check. My first version of this test expected
    // ['EXPERIENCE', 'Built a REST API'], which SURVIVES interleaving intact —
    // the heading still precedes its own bullet even when the columns are
    // scrambled — so the test passed against interleaved input and proved
    // nothing. Only a sequence that requires section one's BODY to precede
    // section two's HEADING can catch it. Documented here because anyone
    // writing new expectations will reach for the weaker form first.
    const result = checkAtsReadability(
      // Row-by-row extraction across two columns: both headings, then both bodies.
      extracted(['EXPERIENCE', 'SKILLS', 'Built a REST API', 'Node.js', 'Express']),
      {
        mustContain: ['Node.js'],
        inOrder: ['EXPERIENCE', 'Built a REST API', 'SKILLS', 'Node.js'],
      },
    );

    expect(result.readable).toBe(false);
    expect(result.findings.map((finding) => finding.kind)).toContain('out_of_order');
  });

  it('accepts the same content when it extracts one column at a time', () => {
    // NON-VACUITY GUARD for the test above. The identical fragments and the
    // identical expectation, differing ONLY in emission order, must pass — or
    // the previous test would be satisfied by a checker that rejects
    // everything, and "detects interleaving" would mean nothing.
    const result = checkAtsReadability(
      extracted(['EXPERIENCE', 'Built a REST API', 'SKILLS', 'Node.js', 'Express']),
      {
        mustContain: ['Node.js'],
        inOrder: ['EXPERIENCE', 'Built a REST API', 'SKILLS', 'Node.js'],
      },
    );

    expect(result.readable).toBe(true);
  });

  it('reports a skill that never reached the text layer', () => {
    // The other silent killer: text rendered as an image, or drawn in a font
    // with no usable encoding, extracts as nothing. The resume looks complete
    // and the ATS keyword match scores zero on the skill it was tailored for.
    const result = checkAtsReadability(extracted(['EXPERIENCE', 'Built a REST API']), {
      mustContain: ['Node.js'],
      inOrder: [],
    });

    expect(result.readable).toBe(false);
    const missing = result.findings.find((finding) => finding.kind === 'missing_phrase');
    // The finding must name the phrase, or the report tells Teja something is
    // wrong without telling him what to fix.
    expect(missing?.detail).toContain('Node.js');
  });

  it('reports a PDF with no text layer at all', () => {
    // A scanned or fully image-rendered PDF. Distinguished from "missing
    // phrase" because the remedy is completely different — this is not a
    // wording problem, the document is opaque to every ATS on the market.
    const result = checkAtsReadability(extracted([]), {
      mustContain: ['Node.js'],
      inOrder: ['EXPERIENCE'],
    });

    expect(result.readable).toBe(false);
    expect(result.findings.map((finding) => finding.kind)).toContain('no_text_layer');
  });

  it('does not report out_of_order when a marker is simply absent', () => {
    // Precision matters: an absent heading is a missing_phrase problem, and
    // reporting it ALSO as an ordering problem would send the reader hunting
    // for a layout bug that does not exist. A checker that cries wolf about
    // layout is one Teja stops reading, which costs more than it saves.
    const result = checkAtsReadability(extracted(['SKILLS', 'Node.js']), {
      mustContain: [],
      inOrder: ['EXPERIENCE', 'SKILLS'],
    });

    expect(result.findings.map((finding) => finding.kind)).not.toContain('out_of_order');
  });
});
