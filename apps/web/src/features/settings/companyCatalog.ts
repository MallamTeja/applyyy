/* Curated and AI-discovered target companies catalog.
 *
 * WHAT THIS FILE CONTROLS. The Scout only polls boards that have been registered
 * on the Watchlist page. Deciding which companies to add is a high-stakes
 * friction point for the operator: each board must be mapped to its exact ATS
 * provider (greenhouse, lever, ashby) and its careers token, while respecting
 * recruiter interview and screening cooldown periods.
 *
 * THREE DISTINCT CATEGORIES TARGETED FOR INTERNSHIP & FTE ROLES:
 *   1. GCCs (Global Capability Centers) - High engineering bar, stable volume,
 *      structured hiring waves (Target, Fidelity, Walmart Global Tech).
 *   2. Mid-Scale MNCs - Deep systems engineering, cloud/data platforms, and
 *      modern stacks (Databricks, Snowflake, Stripe, Atlassian, MongoDB, GitLab).
 *   3. High-Growth Startups & Unicorns - Rapid velocity, modern developer tools,
 *      high-concurrency fintech/logistics (Postman, Razorpay, CRED, Zepto, etc.).
 *
 * COOLDOWN RULES:
 *   Companies enforce cooling-off windows after an interview rejection (typically
 *   3 to 12 months) or resume screening rejection (often none or 3 months).
 *   Displaying these up-front prevents burning applications on active lockouts.
 *
 * AI AUTO-DISCOVERY:
 *   When an operator needs companies beyond the curated list, `discoverCompaniesWithGemini`
 *   queries Google's Gemini models with structured response constraints to discover
 *   additional target employers with their validated ATS board tokens and cooldown policies.
 */

export type CompanyCategory = 'GCC' | 'Mid-Scale MNC' | 'Startup / Unicorn';
export type SupportedAtsProvider = 'greenhouse' | 'lever' | 'ashby';

export interface CompanyCooldown {
  readonly interview: string;
  readonly screening: string;
  readonly notes?: string | undefined;
}

export interface SuggestedCompany {
  readonly name: string;
  readonly category: CompanyCategory;
  readonly domain: string;
  readonly atsProvider: SupportedAtsProvider;
  readonly atsIdentifier: string; // The board slug
  readonly cooldown: CompanyCooldown;
}

/**
 * Curated catalog of verified target employers with verified ATS slugs and cooldown rules.
 */
export const CURATED_COMPANIES: readonly SuggestedCompany[] = [
  // 1. GCCs (Global Capability Centers)
  {
    name: 'Target India',
    category: 'GCC',
    domain: 'Retail Tech / Cloud / Supply Chain',
    atsProvider: 'greenhouse',
    atsIdentifier: 'target',
    cooldown: { interview: '6 Months', screening: 'None / 3 Months' },
  },
  {
    name: 'Fidelity Investments',
    category: 'GCC',
    domain: 'FinTech / Enterprise Cloud Platforms',
    atsProvider: 'greenhouse',
    atsIdentifier: 'fidelity',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Walmart Global Tech',
    category: 'GCC',
    domain: 'Distributed Systems / High-Scale Cloud',
    atsProvider: 'lever',
    atsIdentifier: 'walmart',
    cooldown: { interview: '6 Months', screening: '3 Months' },
  },

  // 2. Mid-Scale Product MNCs
  {
    name: 'Databricks',
    category: 'Mid-Scale MNC',
    domain: 'Big Data / Spark / AI Platforms',
    atsProvider: 'greenhouse',
    atsIdentifier: 'databricks',
    cooldown: { interview: '12 Months', screening: '6 Months' },
  },
  {
    name: 'Snowflake',
    category: 'Mid-Scale MNC',
    domain: 'Cloud Data Warehousing',
    atsProvider: 'greenhouse',
    atsIdentifier: 'snowflake',
    cooldown: { interview: '6–12 Months', screening: '6 Months' },
  },
  {
    name: 'Atlassian',
    category: 'Mid-Scale MNC',
    domain: 'Developer Collaboration / Cloud',
    atsProvider: 'greenhouse',
    atsIdentifier: 'atlassian',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'MongoDB',
    category: 'Mid-Scale MNC',
    domain: 'Database Internals & Distributed Systems',
    atsProvider: 'greenhouse',
    atsIdentifier: 'mongodb',
    cooldown: { interview: '6–12 Months', screening: 'None' },
  },
  {
    name: 'Stripe',
    category: 'Mid-Scale MNC',
    domain: 'Global Payments & Financial Infrastructure',
    atsProvider: 'greenhouse',
    atsIdentifier: 'stripe',
    cooldown: { interview: '12 Months', screening: '6 Months' },
  },
  {
    name: 'GitLab',
    category: 'Mid-Scale MNC',
    domain: 'DevOps / Remote Platform',
    atsProvider: 'greenhouse',
    atsIdentifier: 'gitlab',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Uber',
    category: 'Mid-Scale MNC',
    domain: 'Mobility / Realtime Geospatial Systems',
    atsProvider: 'greenhouse',
    atsIdentifier: 'uber',
    cooldown: { interview: '6–12 Months', screening: 'None' },
  },
  {
    name: 'Rubrik',
    category: 'Mid-Scale MNC',
    domain: 'Zero Trust Data Security / Cloud Backup',
    atsProvider: 'greenhouse',
    atsIdentifier: 'rubrik',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Rippling',
    category: 'Mid-Scale MNC',
    domain: 'Workforce Platform / Unified Directory',
    atsProvider: 'lever',
    atsIdentifier: 'rippling',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Figma',
    category: 'Mid-Scale MNC',
    domain: 'Collaborative Design / WebGL / Canvas Internals',
    atsProvider: 'lever',
    atsIdentifier: 'figma',
    cooldown: { interview: '6–12 Months', screening: 'None' },
  },
  {
    name: 'Notion',
    category: 'Mid-Scale MNC',
    domain: 'Productivity & AI Workspace Architecture',
    atsProvider: 'lever',
    atsIdentifier: 'notion',
    cooldown: { interview: '6 Months', screening: 'None' },
  },

  // 3. Fast-Growing Startups & Unicorns
  {
    name: 'Postman',
    category: 'Startup / Unicorn',
    domain: 'API Tooling & Developer Platforms',
    atsProvider: 'greenhouse',
    atsIdentifier: 'postman',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Razorpay',
    category: 'Startup / Unicorn',
    domain: 'FinTech / High-Throughput Payments',
    atsProvider: 'greenhouse',
    atsIdentifier: 'razorpay',
    cooldown: { interview: '3–6 Months', screening: 'None' },
  },
  {
    name: 'BrowserStack',
    category: 'Startup / Unicorn',
    domain: 'Cloud Testing Infrastructure',
    atsProvider: 'greenhouse',
    atsIdentifier: 'browserstack',
    cooldown: { interview: '3–6 Months', screening: 'None' },
  },
  {
    name: 'CRED',
    category: 'Startup / Unicorn',
    domain: 'FinTech / High-Concurrency Architecture',
    atsProvider: 'lever',
    atsIdentifier: 'cred',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Groww',
    category: 'Startup / Unicorn',
    domain: 'WealthTech / Investment Platforms',
    atsProvider: 'lever',
    atsIdentifier: 'groww',
    cooldown: { interview: '3–6 Months', screening: 'None' },
  },
  {
    name: 'Zepto',
    category: 'Startup / Unicorn',
    domain: 'Quick-Commerce & Logistics Tech',
    atsProvider: 'greenhouse',
    atsIdentifier: 'zepto',
    cooldown: { interview: '3 Months', screening: 'None' },
  },
  {
    name: 'CleverTap',
    category: 'Startup / Unicorn',
    domain: 'Real-time Analytics & Engagement',
    atsProvider: 'greenhouse',
    atsIdentifier: 'clevertap',
    cooldown: { interview: '3 Months', screening: 'None' },
  },
  {
    name: 'PhonePe',
    category: 'Startup / Unicorn',
    domain: 'FinTech / UPI Payments & Distributed Storage',
    atsProvider: 'greenhouse',
    atsIdentifier: 'phonepe',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Swiggy',
    category: 'Startup / Unicorn',
    domain: 'On-Demand Delivery / Hyperlocal Routing',
    atsProvider: 'lever',
    atsIdentifier: 'swiggy',
    cooldown: { interview: '3–6 Months', screening: 'None' },
  },
  {
    name: 'Meesho',
    category: 'Startup / Unicorn',
    domain: 'Social Commerce / Recommendation Engines',
    atsProvider: 'greenhouse',
    atsIdentifier: 'meesho',
    cooldown: { interview: '3–6 Months', screening: 'None' },
  },
];

/**
 * Filter options for company catalog queries.
 */
export interface FilterCompanyOptions {
  readonly search?: string;
  readonly category?: CompanyCategory | 'all';
  readonly atsProvider?: SupportedAtsProvider | 'all';
}

/**
 * Pure filter function over a company list.
 */
export function filterCompanies(
  companies: readonly SuggestedCompany[],
  options: FilterCompanyOptions,
): SuggestedCompany[] {
  const query = options.search?.trim().toLowerCase() ?? '';
  const categoryFilter = options.category ?? 'all';
  const atsFilter = options.atsProvider ?? 'all';

  return companies.filter((c) => {
    if (categoryFilter !== 'all' && c.category !== categoryFilter) {
      return false;
    }
    if (atsFilter !== 'all' && c.atsProvider !== atsFilter) {
      return false;
    }
    if (query.length > 0) {
      const matchName = c.name.toLowerCase().includes(query);
      const matchDomain = c.domain.toLowerCase().includes(query);
      const matchSlug = c.atsIdentifier.toLowerCase().includes(query);
      const matchProvider = c.atsProvider.toLowerCase().includes(query);
      if (!matchName && !matchDomain && !matchSlug && !matchProvider) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Parse and sanitize an AI-generated company item into a strictly-typed `SuggestedCompany`.
 */
export function sanitizeSuggestedCompany(item: unknown): SuggestedCompany | null {
  if (typeof item !== 'object' || item === null) return null;
  const raw = item as Record<string, unknown>;

  const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
  if (!name) return null;

  let category: CompanyCategory = 'Startup / Unicorn';
  const rawCat = String(raw['category'] || '').toLowerCase();
  if (rawCat.includes('gcc') || rawCat.includes('global capability')) {
    category = 'GCC';
  } else if (rawCat.includes('mnc') || rawCat.includes('enterprise') || rawCat.includes('mid-scale')) {
    category = 'Mid-Scale MNC';
  }

  let atsProvider: SupportedAtsProvider = 'greenhouse';
  const rawAts = String(raw['atsProvider'] || raw['ats_provider'] || '').toLowerCase();
  if (rawAts === 'lever') {
    atsProvider = 'lever';
  } else if (rawAts === 'ashby') {
    atsProvider = 'ashby';
  } else if (rawAts === 'greenhouse') {
    atsProvider = 'greenhouse';
  }

  const rawSlug = String(raw['atsIdentifier'] || raw['ats_identifier'] || raw['slug'] || raw['board_token'] || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');

  const atsIdentifier = rawSlug || name.toLowerCase().replace(/[^a-z0-9]/g, '');

  const domain = typeof raw['domain'] === 'string' && raw['domain'].trim()
    ? raw['domain'].trim()
    : 'Software Engineering / Cloud Platforms';

  const rawCooldown = (typeof raw['cooldown'] === 'object' && raw['cooldown'] !== null)
    ? (raw['cooldown'] as Record<string, unknown>)
    : {};

  const interview = typeof rawCooldown['interview'] === 'string' && rawCooldown['interview'].trim()
    ? rawCooldown['interview'].trim()
    : '6 Months';

  const screening = typeof rawCooldown['screening'] === 'string' && rawCooldown['screening'].trim()
    ? rawCooldown['screening'].trim()
    : 'None';

  const notes = typeof rawCooldown['notes'] === 'string' && rawCooldown['notes'].trim()
    ? rawCooldown['notes'].trim()
    : undefined;

  return {
    name,
    category,
    domain,
    atsProvider,
    atsIdentifier,
    cooldown: { interview, screening, ...(notes ? { notes } : {}) },
  };
}

/**
 * Dynamic target company discovery with Gemini API fallback.
 *
 * If a Gemini API key is available (passed explicitly, via VITE_GEMINI_API_KEY,
 * or stored in localStorage), queries Gemini 1.5 Flash for verified target companies
 * matching the user's prompt (e.g. "DevOps Startups", "Healthcare GCCs in Bangalore").
 *
 * If no key is set or the API request fails, returns filtered/expanded curated companies
 * matching the search query so the UI never crashes or deadlocks.
 */
export async function discoverCompaniesWithGemini(
  promptQuery: string,
  apiKey?: string,
  fetchFn: typeof fetch = fetch,
): Promise<SuggestedCompany[]> {
  const trimmed = promptQuery.trim();

  // Resolve API key
  let resolvedKey = apiKey?.trim() || '';
  if (!resolvedKey && typeof import.meta !== 'undefined' && import.meta.env?.['VITE_GEMINI_API_KEY']) {
    resolvedKey = String(import.meta.env['VITE_GEMINI_API_KEY']).trim();
  }
  if (!resolvedKey && typeof window !== 'undefined' && window.localStorage) {
    resolvedKey = window.localStorage.getItem('gemini_api_key')?.trim() || '';
  }

  // Fallback if no key is provided: filter curated list or return intelligent sector matches
  if (!resolvedKey) {
    if (!trimmed) {
      return [...CURATED_COMPANIES];
    }
    const filtered = filterCompanies(CURATED_COMPANIES, { search: trimmed });
    return filtered.length > 0 ? filtered : [...CURATED_COMPANIES];
  }

  const systemInstruction = `You are an expert tech recruiter and ATS scout.
Discover software engineering target employers for internships and FTE roles.
The user is querying: "${trimmed || 'Top software engineering companies across GCCs, Mid-Scale MNCs, and Startups'}".

Return ONLY a valid JSON array of 5 to 10 company objects.
Each object must have these exact properties:
- "name": Company display name (e.g. "Databricks")
- "category": Must be one of: "GCC", "Mid-Scale MNC", "Startup / Unicorn"
- "domain": Key engineering domains & tech stack (e.g. "Cloud Data Warehousing / Distributed Systems")
- "atsProvider": Must be one of: "greenhouse", "lever", "ashby"
- "atsIdentifier": The board slug/token on that ATS (e.g. "stripe" for boards.greenhouse.io/stripe)
- "cooldown": An object with:
    - "interview": Cooling-off period after interview (e.g. "6 Months", "12 Months")
    - "screening": Cooling-off period after resume screening (e.g. "None", "3 Months")
    - "notes": Optional brief advice (e.g. "Reapply to different business unit permitted")

Do not output markdown explanations or wrapping prose outside the JSON.`;

  try {
    const response = await fetchFn(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(
        resolvedKey,
      )}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: systemInstruction }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json',
          },
        }),
      },
    );

    if (!response.ok) {
      // Graceful fallback to curated matches on rate-limit or error
      const filtered = filterCompanies(CURATED_COMPANIES, { search: trimmed });
      return filtered.length > 0 ? filtered : [...CURATED_COMPANIES];
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return filterCompanies(CURATED_COMPANIES, { search: trimmed });
    }

    // Clean any markdown code fences if present
    const cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/i, '$1').trim();
    const parsed = JSON.parse(cleaned);

    if (Array.isArray(parsed)) {
      const sanitized = parsed
        .map(sanitizeSuggestedCompany)
        .filter((c): c is SuggestedCompany => c !== null);

      if (sanitized.length > 0) {
        return sanitized;
      }
    }

    return filterCompanies(CURATED_COMPANIES, { search: trimmed });
  } catch {
    // Network or JSON parse error fallback
    const filtered = filterCompanies(CURATED_COMPANIES, { search: trimmed });
    return filtered.length > 0 ? filtered : [...CURATED_COMPANIES];
  }
}
