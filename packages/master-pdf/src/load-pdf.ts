/* The one impure function in this package: PDF bytes in, plain snapshot out.
 *
 * WHY THIS PACKAGE DECLARES NO DEPENDENCY ON pdfjs-dist, which looks like an
 * omission and is a decision. Three reasons, in descending order of how much
 * they would have cost:
 *
 *   1. `pnpm-lock.yaml` is a SINGLE-OWNER file in this repo, with five sessions
 *      sharing one working tree. Adding a dependency here rewrites it from a
 *      session that does not own it. The library is already installed (it is a
 *      devDependency of `worker/`, used in the OPPOSITE direction - reading back
 *      a PDF this system generated, to check ATS readability), so the caller
 *      can hand us the module it already has.
 *   2. The parse runs browser-side, and a browser, a Deno Edge Function and the
 *      Node test runner each load and configure pdfjs differently - worker
 *      source, font data, eval policy. Those are all the CALLER's environment,
 *      not this package's business.
 *   3. Everything except this file stays testable without a PDF at all.
 *
 * The structural type below is the mechanism: TypeScript checks the shape of
 * whatever module is passed in, so we get type safety against pdfjs's real API
 * without importing pdfjs's types. If pdfjs changes that shape, this stops
 * compiling at the call site - which is the same protection a real import would
 * have given, minus the lockfile write.
 */

import type { LinkAnnotation, PageSnapshot, PdfSnapshot, TextItem } from './snapshot.ts';

/* The slice of pdfjs's surface this package actually uses.
 *
 * Deliberately minimal. A wider structural type would be more faithful to
 * pdfjs and would also break on pdfjs changes this package does not care
 * about. */
export interface PdfjsLike {
  getDocument(parameters: { data: Uint8Array }): {
    readonly promise: Promise<PdfDocumentLike>;
  };
}

interface PdfDocumentLike {
  readonly numPages: number;
  getMetadata(): Promise<{ readonly info?: { readonly Producer?: string } }>;
  getPage(pageNumber: number): Promise<PdfPageLike>;
}

interface PdfPageLike {
  getViewport(parameters: { scale: number }): { readonly height: number };
  getTextContent(): Promise<{ readonly items: readonly unknown[] }>;
  getAnnotations(): Promise<readonly unknown[]>;
}

/* pdfjs types its text items as a union of real items and "marked content"
   markers, distinguished only by whether `str` is present. Narrowing
   structurally rather than by a type import keeps the seam intact. */
function toTextItem(raw: unknown): TextItem | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const candidate = raw as {
    str?: unknown;
    width?: unknown;
    height?: unknown;
    fontName?: unknown;
    transform?: unknown;
  };
  /* A marked-content marker has no `str`. Skipping it here rather than
     downstream means nothing else in the package has to know these exist. */
  if (typeof candidate.str !== 'string' || !Array.isArray(candidate.transform)) {
    return null;
  }
  /* pdfjs reports position as a 6-element affine transform [a,b,c,d,e,f]; e and
     f are the translation, i.e. the item's x and y. Reading indices 4 and 5 is
     the documented way to get a text item's position - there is no x/y field. */
  const x = candidate.transform[4];
  const y = candidate.transform[5];
  if (typeof x !== 'number' || typeof y !== 'number') {
    return null;
  }
  return {
    str: candidate.str,
    x,
    y,
    width: typeof candidate.width === 'number' ? candidate.width : 0,
    height: typeof candidate.height === 'number' ? candidate.height : 0,
    fontName: typeof candidate.fontName === 'string' ? candidate.fontName : '',
  };
}

/* Annotations come back as a mixed list - widgets, popups, links. Only Link
   subtypes carrying a url are of interest.
 *
 * `unsafeUrl` is pdfjs's name for the url as written in the file, before its
 * own sanitisation; `url` is the sanitised one. Preferring `url` and falling
 * back means a link pdfjs declined to sanitise still reaches the report as an
 * unanchored or anchored row rather than vanishing - the reviewer should be the
 * one deciding a strange URL is not wanted. */
function toLinkAnnotation(raw: unknown): LinkAnnotation | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const candidate = raw as { subtype?: unknown; url?: unknown; unsafeUrl?: unknown; rect?: unknown };
  if (candidate.subtype !== 'Link') {
    return null;
  }
  const url =
    typeof candidate.url === 'string'
      ? candidate.url
      : typeof candidate.unsafeUrl === 'string'
        ? candidate.unsafeUrl
        : null;
  /* An internal link - a table-of-contents jump - has a destination but no url.
     It is not a loss, so it is dropped here rather than reported. */
  if (url === null || !Array.isArray(candidate.rect) || candidate.rect.length !== 4) {
    return null;
  }
  const [x1, y1, x2, y2] = candidate.rect as readonly unknown[];
  if (
    typeof x1 !== 'number' ||
    typeof y1 !== 'number' ||
    typeof x2 !== 'number' ||
    typeof y2 !== 'number'
  ) {
    return null;
  }
  /* Normalise the rectangle so x1,y1 is always the lower-left corner. The PDF
     spec permits either diagonal, and a reversed rect would make every
     containment test silently false - producing "no links found" on a document
     full of links. */
  return {
    url,
    rect: [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)],
  };
}

/* Read a PDF into the plain snapshot the rest of this package operates on.
 *
 * `pdfjs` is injected rather than imported - see the file header. The caller
 * passes whatever pdfjs build suits its runtime, already configured.
 */
export async function loadPdfSnapshot(pdfjs: PdfjsLike, data: Uint8Array): Promise<PdfSnapshot> {
  const document = await pdfjs.getDocument({ data }).promise;
  const metadata = await document.getMetadata();

  const pages: PageSnapshot[] = [];
  /* Sequential rather than Promise.all: pdfjs holds per-document state and
     page reads are cheap on a one-page resume, so concurrency buys nothing and
     costs determinism in the order errors surface. */
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const pdfPage = await document.getPage(pageNumber);
    const textContent = await pdfPage.getTextContent();
    /* BOTH calls, always. getTextContent alone is the silent-loss bug this
       package exists to prevent - it returns text and only text, and every URL
       in a hyperref document lives here instead. */
    const annotations = await pdfPage.getAnnotations();

    pages.push({
      pageNumber,
      height: pdfPage.getViewport({ scale: 1 }).height,
      items: textContent.items
        .map(toTextItem)
        .filter((candidate): candidate is TextItem => candidate !== null),
      links: annotations
        .map(toLinkAnnotation)
        .filter((candidate): candidate is LinkAnnotation => candidate !== null),
    });
  }

  return {
    producer: metadata.info?.Producer ?? null,
    pages,
  };
}
