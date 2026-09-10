// PROJECT_PLAN.md §17.2 — the ATS parse simulator.
//
// After the PDF is generated, run it back through a REAL text extractor and
// record what an ATS actually reads. This catches the single most common silent
// fresher killer: a nicely-designed two-column resume that parses into
// interleaved gibberish, so the machine never sees the skills and a human never
// sees the resume.
//
// It runs in the worker, so it validates EVERY resume that goes out rather than
// hoping. And it is deliberately separate from the template's own structural
// tests: those assert no columns, no tables and real `<ul>` elements, which is
// a PROXY for parseability. The proxy is satisfiable by a document that still
// extracts wrongly — CSS can column a single `<div>`, absolute positioning can
// reorder text with no table in sight. **The extractor is the truth.**
import type { AgentName } from '@applyy/shared-types';

/** What a naive ATS sees: text fragments in PDF content-stream order. */
export interface ExtractedPdfText {
  // Fragment order as the extractor emitted it. THE ORDER IS THE SIGNAL —
  // a two-column layout scrambles it while every individual word survives, so
  // a checker that only looks at the joined string cannot see the bug.
  readonly items: readonly string[];
  // The same fragments joined, for phrase presence.
  readonly text: string;
}

/** What this resume is expected to say, and in what order. */
export interface AtsExpectations {
  // Phrases that must survive into the text layer — typically the tailored
  // skills, which are the whole point of tailoring.
  readonly mustContain: readonly string[];
  // Section markers in the order a human reads them. Checked as a subsequence.
  readonly inOrder: readonly string[];
}

/** One thing an ATS would get wrong. */
export interface AtsReadabilityFinding {
  // Kept as three distinct kinds because the REMEDIES are unrelated: a missing
  // phrase is a content or font problem, out-of-order is a layout problem, and
  // no text layer means the document is opaque to every ATS on the market.
  readonly kind: 'no_text_layer' | 'missing_phrase' | 'out_of_order';
  readonly detail: string;
}

export interface AtsReadabilityReport {
  readonly readable: boolean;
  readonly findings: readonly AtsReadabilityFinding[];
}

/** The agent identity this check reports under, for `application_events`. */
export const ATS_CHECK_AGENT: AgentName = 'applier';

/**
 * Compare what the extractor read against what the resume was supposed to say.
 *
 * Pure, so it is testable without a browser or a PDF — the expensive part
 * (rendering and extracting) is separated from the part with the logic in it.
 */
export function checkAtsReadability(
  extracted: ExtractedPdfText,
  expectations: AtsExpectations,
): AtsReadabilityReport {
  const findings: AtsReadabilityFinding[] = [];

  // Non-empty fragments only: extractors emit whitespace-only items freely, and
  // counting them would make an image-only PDF look like it had a text layer.
  const fragments = extracted.items.filter((item) => item.trim().length > 0);

  // CASE 1 — nothing extractable at all. Reported first and on its own, because
  // every other finding would be a redundant consequence of it and burying the
  // real problem under twenty "missing phrase" lines helps nobody.
  if (fragments.length === 0) {
    return {
      readable: false,
      findings: [
        {
          kind: 'no_text_layer',
          detail:
            'the PDF has no extractable text. Every ATS will read this as an empty ' +
            'document — the resume is an image, not a document.',
        },
      ],
    };
  }

  // CASE 2 — phrases that never reached the text layer. Case-insensitive
  // because ATS keyword matching is, and a case-sensitive miss here would be a
  // false alarm rather than a real defect.
  const haystack = extracted.text.toLowerCase();
  for (const phrase of expectations.mustContain) {
    if (!haystack.includes(phrase.toLowerCase())) {
      findings.push({
        kind: 'missing_phrase',
        detail:
          `"${phrase}" does not appear in the extracted text. The resume was tailored ` +
          'to claim it, so an ATS keyword match will score zero on it.',
      });
    }
  }

  // CASE 3 — reading order. Checked as a SUBSEQUENCE over the fragment list
  // rather than by comparing string indices, because a two-column layout can
  // place both markers in the joined text while emitting them in the wrong
  // sequence — which is exactly the bug and exactly what a substring check
  // cannot see.
  //
  // Markers that are absent are skipped rather than failed: an absent heading
  // is a missing_phrase problem, and reporting it as a layout problem too would
  // send the reader hunting for a bug that is not there. A checker that cries
  // wolf about layout is one that stops being read.
  const present = expectations.inOrder.filter((marker) =>
    fragments.some((fragment) => fragment.includes(marker)),
  );

  // Walk the fragments once, advancing through the expected markers. If we run
  // out of fragments before matching them all, the order is wrong.
  let markerIndex = 0;
  for (const fragment of fragments) {
    if (markerIndex >= present.length) break;
    if (fragment.includes(present[markerIndex]!)) markerIndex += 1;
  }

  if (markerIndex < present.length) {
    findings.push({
      kind: 'out_of_order',
      detail:
        `sections do not extract in reading order — stopped at "${present[markerIndex]}". ` +
        'This is the two-column interleaving signature: the words are all present ' +
        'but the document reads as nonsense to a parser.',
    });
  }

  return { readable: findings.length === 0, findings };
}

/**
 * Extract a PDF's text layer the way a naive ATS would.
 *
 * Uses pdf.js's `getTextContent()`, which returns items in CONTENT-STREAM
 * order — not in visual order, and not re-flowed. That is deliberate: it is
 * what a cheap parser sees, and the whole value of this check is reproducing
 * the cheap parser rather than a clever one. A smarter extractor that repaired
 * column order would hide the exact bug we are looking for.
 */
export async function extractPdfText(pdfBytes: Uint8Array): Promise<ExtractedPdfText> {
  // Dynamic import through a variable specifier, matching the composition-root
  // pattern used in cli/apply.ts: pdfjs is a check-time dependency, and loading
  // it lazily keeps it off the applier's hot path.
  const specifier = 'pdfjs-dist/legacy/build/pdf.mjs';
  const pdfjs = (await import(specifier)) as {
    getDocument(src: unknown): { promise: Promise<PdfDocumentLike> };
  };

  // The LEGACY build, and `useSystemFonts`, because this runs in Node with no
  // DOM and no canvas. The modern build assumes browser globals and fails at
  // import time on a runner — a failure that would look like a broken resume.
  const document = await pdfjs.getDocument({ data: pdfBytes, useSystemFonts: true }).promise;

  const items: string[] = [];
  // Every page: a resume that spills onto page two must be checked there too,
  // and page two is where an overflowing layout usually breaks first.
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    for (const item of content.items) {
      // Marked-content items carry no `str`; skipping them keeps the fragment
      // list to actual text rather than structural noise.
      if (typeof item.str === 'string') items.push(item.str);
    }
  }

  return { items, text: items.join(' ') };
}

/** The slice of pdf.js's document API this module uses. */
interface PdfDocumentLike {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<{
    getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
  }>;
}
