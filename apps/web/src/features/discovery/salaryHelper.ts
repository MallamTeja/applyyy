// Salary & Package Extraction Helper for Discovery Job Cards
//
// ENFORCES USER REQUIREMENT:
// Displays package/salary numbers in job cards IF AND ONLY IF the job listing or apply page details explicitly mention it.
//
// Priority:
// 1. Structured database fields: `salary_min`, `salary_max`, `salary_currency`.
// 2. Extracted salary regex patterns from `description_raw` (e.g., "$120,000 - $160,000", "12-18 LPA", "₹15,000,000", "$50/hr").
// 3. Extracted compensation section headers ("Salary: ...", "Pay Range: ...", "Compensation: ...").

import type { JobRow } from '../../data/contract.ts';

// Returns formatted salary string if present in job record or description; returns null if unstated.
export function extractSalaryInfo(job: JobRow): string | null {
  // 1. Check structured database salary fields first
  const hasMin = job.salary_min !== null && job.salary_min !== undefined && Number(job.salary_min) > 0;
  const hasMax = job.salary_max !== null && job.salary_max !== undefined && Number(job.salary_max) > 0;
  const currency = job.salary_currency?.trim() || '$';

  if (hasMin || hasMax) {
    if (hasMin && hasMax) {
      return `${currency}${Number(job.salary_min).toLocaleString()} – ${currency}${Number(job.salary_max).toLocaleString()}`;
    }
    if (hasMin) {
      return `${currency}${Number(job.salary_min).toLocaleString()}+`;
    }
    if (hasMax) {
      return `Up to ${currency}${Number(job.salary_max).toLocaleString()}`;
    }
  }

  // 2. Scan `description_raw` for explicit salary / package patterns if structured fields were null
  const description = job.description_raw;
  if (!description || description.trim().length === 0) {
    return null;
  }

  // Regex patterns matching common currency/salary formats:
  // - USD/EUR/GBP ranges: $120,000 - $160,000 | $120k - $160k | $50/hr - $80/hr | $100,000/year
  // - INR / Indian Rupee LPA ranges: 12-18 LPA | 15 LPA | ₹15,000,000 | ₹12L - ₹20L | Rs. 15,000,000
  // - Labeled sections: "Salary: $140,000", "Compensation: 18-24 LPA", "Pay Range: $110k - $150k"

  const salaryRegexes: RegExp[] = [
    // Labeled lines: Salary / Pay Range / Compensation / Package
    /(?:salary|compensation|pay range|base pay|package):\s*([$₹€£]\s*[\d,]+(?:\s*[-–to]+\s*[$₹€£]?\s*[\d,]+)?(?:\s*(?:k|lpa|lakhs?|\/hr|\/yr|per year|annually))?)/i,
    /(?:salary|compensation|pay range|base pay|package):\s*([\d,]+\s*[-–to]+\s*[\d,]+\s*(?:lpa|lakhs?|k|usd|inr))/i,

    // Currency ranges with $, ₹, €, £ (e.g., $120,000 - $180,000 or $120k - $180k)
    /([$₹€£]\s*[\d]{2,3}(?:,\d{3})+|\b[$₹€£]\s*\d{2,3}k)\s*[-–to]+\s*([$₹€£]?\s*[\d]{2,3}(?:,\d{3})+|\b[$₹€£]?\s*\d{2,3}k)/i,

    // Hourly rate ranges (e.g., $50/hr - $85/hr or $60 - $90 per hour)
    /([$₹€£]\d{2,3}(?:\.\d{2})?\s*(?:\/hr|per hour)\s*[-–to]+\s*[$₹€£]?\d{2,3}(?:\.\d{2})?\s*(?:\/hr|per hour)?)/i,

    // Indian Rupee LPA formats (e.g., 12-18 LPA, 15.5 LPA, ₹12 - ₹18 Lakhs)
    /(\b\d{1,2}(?:\.\d{1,2})?\s*[-–to]+\s*\d{1,2}(?:\.\d{1,2})?\s*LPA\b)/i,
    /(\b\d{1,2}(?:\.\d{1,2})?\s*LPA\b)/i,
    /([₹]\s*\d{1,2}(?:\.\d{1,2})?\s*[-–to]+\s*[₹]?\s*\d{1,2}(?:\.\d{1,2})?\s*(?:L|Lakhs?)\b)/i,
  ];

  for (const regex of salaryRegexes) {
    const match = description.match(regex);
    if (match && match[0]) {
      const cleaned = match[0].trim().replace(/\s+/g, ' ');
      // Truncate if match is too long
      if (cleaned.length <= 40) {
        return cleaned;
      }
    }
  }

  // No salary mentioned in description
  return null;
}
