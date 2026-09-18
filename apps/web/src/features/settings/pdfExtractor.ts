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

export { extractPdf } from '../profile/pdfExtractor.ts';
