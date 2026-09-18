/* Browser-side resume PDF extraction.
 *
 * WHAT THIS MODULE DOES:
 * Takes PDF bytes directly from a browser <input type="file" accept=".pdf">
 * and returns a typed MasterProfile.
 *
 * INVARIANT: Zero server upload of unapproved PDFs.
 * Parsing occurs strictly browser-side on the client machine before
 * any candidate data touches Supabase.
 */

import { extractPdf as extractPdfFromMaster } from '@applyy/master-pdf';
import type { MasterProfile } from '../../data/contract.ts';

export async function extractPdf(pdfBytes: Uint8Array): Promise<MasterProfile> {
  return extractPdfFromMaster(pdfBytes);
}
