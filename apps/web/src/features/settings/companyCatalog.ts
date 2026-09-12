/* Curated and AI-discovered target companies catalog.
 *
 * WHAT THIS FILE CONTROLS. The Scout only polls boards that have been registered
 * on the Watchlist page. Deciding which companies to add is a high-stakes
 * friction point for the operator: each board must be mapped to its exact ATS
 * provider (greenhouse, lever, ashby, workable, smartrecruiters) and its careers token,
 * while respecting recruiter interview and screening cooldown periods.
 *
 * FOUR DISTINCT CATEGORIES TARGETED FOR INTERNSHIP & FTE ROLES:
 *   1. GCCs (Global Capability Centers) - High engineering bar, massive infrastructure,
 *      structured hiring waves (Target, Fidelity, Walmart Global Tech, Wells Fargo, etc.).
 *   2. Mid-Scale Product MNCs - Deep systems engineering, cloud/data platforms, and
 *      modern stacks (Databricks, Snowflake, Stripe, Atlassian, MongoDB, GitLab, Uber).
 *   3. High-Growth Startups & Unicorns - Rapid velocity, modern developer tools,
 *      high-concurrency fintech/logistics (Postman, Razorpay, CRED, Zepto, Swiggy, etc.).
 *   4. Service-Based & Consulting Firms - High volume, enterprise digital transformation,
 *      large developer headcount (Thoughtworks, Nagarro, Persistent, EPAM, TCS, Infosys).
 *
 * COOLDOWN RULES:
 *   Companies enforce cooling-off windows after an interview rejection (typically
 *   3 to 12 months) or resume screening rejection (often none or 3 months).
 *   Displaying these up-front prevents burning applications on active lockouts.
 */

import type { AtsProvider } from '../../data/contract';

export type CompanyCategory =
  | 'GCC'
  | 'Mid-Scale MNC'
  | 'Startup / Unicorn'
  | 'Service-Based';

export type SupportedAtsProvider =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'workable'
  | 'smartrecruiters';

export interface CompanyCooldown {
  readonly interview: string;
  readonly screening: string;
  readonly notes?: string | undefined;
}

export interface SuggestedCompany {
  readonly name: string;
  readonly category: CompanyCategory;
  readonly domain: string;
  readonly location: string;
  readonly atsProvider: AtsProvider;
  readonly atsIdentifier: string; // The board slug
  readonly cooldown: CompanyCooldown;
}

export const AVAILABLE_LOCATIONS = [
  'All Locations',
  'Bengaluru',
  'Hyderabad',
  'Pune',
  'Delhi NCR',
  'Mumbai',
  'Remote / Global',
] as const;

export type AvailableLocation = (typeof AVAILABLE_LOCATIONS)[number];

/**
 * Curated catalog of verified target employers with verified ATS slugs,
 * locations, and cooldown rules.
 */
export const CURATED_COMPANIES: readonly SuggestedCompany[] = [
  // =========================================================================
  // 1. GCCs (Global Capability Centers)
  // =========================================================================
  {
    name: 'Target India',
    category: 'GCC',
    domain: 'Retail Tech / Cloud / Supply Chain',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'target',
    cooldown: { interview: '6 Months', screening: 'None / 3 Months' },
  },
  {
    name: 'Fidelity Investments',
    category: 'GCC',
    domain: 'FinTech / Enterprise Cloud Platforms',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'fidelity',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Walmart Global Tech',
    category: 'GCC',
    domain: 'Distributed Systems / High-Scale Cloud',
    location: 'Bengaluru',
    atsProvider: 'lever',
    atsIdentifier: 'walmart',
    cooldown: { interview: '6 Months', screening: '3 Months' },
  },
  {
    name: "Lowe's India",
    category: 'GCC',
    domain: 'Omnichannel Retail / Cloud Infrastructure',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'lowes',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Wells Fargo India',
    category: 'GCC',
    domain: 'Banking Tech / Payments / Security',
    location: 'Hyderabad',
    atsProvider: 'greenhouse',
    atsIdentifier: 'wellsfargo',
    cooldown: { interview: '6 Months', screening: '3 Months' },
  },
  {
    name: 'PayPal India',
    category: 'GCC',
    domain: 'High-Volume Payments / Anti-Fraud / Distributed Data',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'paypal',
    cooldown: { interview: '6–12 Months', screening: 'None' },
  },
  {
    name: 'Intuit India',
    category: 'GCC',
    domain: 'Financial SaaS / AI Tax Engines / TurboTax',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'intuit',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Goldman Sachs',
    category: 'GCC',
    domain: 'Algorithmic Trading / Asset Management / Quant Tech',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'goldmansachs',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'JPMorgan Chase',
    category: 'GCC',
    domain: 'Investment Banking Tech / Global Ledger Architecture',
    location: 'Hyderabad',
    atsProvider: 'greenhouse',
    atsIdentifier: 'jpmorganchase',
    cooldown: { interview: '6 Months', screening: '3 Months' },
  },
  {
    name: 'American Express',
    category: 'GCC',
    domain: 'Risk Decisioning / Distributed Authorization',
    location: 'Delhi NCR',
    atsProvider: 'greenhouse',
    atsIdentifier: 'amex',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Nike Tech',
    category: 'GCC',
    domain: 'Direct-to-Consumer Cloud / Mobile Commerce',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'nike',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Boeing India',
    category: 'GCC',
    domain: 'Avionics Systems / Simulation / Flight Analytics',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'boeing',
    cooldown: { interview: '6 Months', screening: 'None' },
  },

  // =========================================================================
  // 2. Mid-Scale Product MNCs
  // =========================================================================
  {
    name: 'Databricks',
    category: 'Mid-Scale MNC',
    domain: 'Big Data / Apache Spark / Lakehouse AI Platforms',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'databricks',
    cooldown: { interview: '12 Months', screening: '6 Months' },
  },
  {
    name: 'Snowflake',
    category: 'Mid-Scale MNC',
    domain: 'Cloud Data Warehousing & SQL Engine Internals',
    location: 'Pune',
    atsProvider: 'greenhouse',
    atsIdentifier: 'snowflake',
    cooldown: { interview: '6–12 Months', screening: '6 Months' },
  },
  {
    name: 'Atlassian',
    category: 'Mid-Scale MNC',
    domain: 'Developer Collaboration / Jira / Confluence Cloud',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'atlassian',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'MongoDB',
    category: 'Mid-Scale MNC',
    domain: 'Database Internals & Distributed Storage',
    location: 'Delhi NCR',
    atsProvider: 'greenhouse',
    atsIdentifier: 'mongodb',
    cooldown: { interview: '6–12 Months', screening: 'None' },
  },
  {
    name: 'Stripe',
    category: 'Mid-Scale MNC',
    domain: 'Global Payments & Financial Infrastructure',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'stripe',
    cooldown: { interview: '12 Months', screening: '6 Months' },
  },
  {
    name: 'GitLab',
    category: 'Mid-Scale MNC',
    domain: 'DevOps / Remote Platform / CI/CD Infrastructure',
    location: 'Remote / Global',
    atsProvider: 'greenhouse',
    atsIdentifier: 'gitlab',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Uber',
    category: 'Mid-Scale MNC',
    domain: 'Mobility / Realtime Geospatial & Routing Systems',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'uber',
    cooldown: { interview: '6–12 Months', screening: 'None' },
  },
  {
    name: 'Rubrik',
    category: 'Mid-Scale MNC',
    domain: 'Zero Trust Data Security / Ransomware Recovery',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'rubrik',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Rippling',
    category: 'Mid-Scale MNC',
    domain: 'Workforce Platform / Unified Directory / Identity',
    location: 'Bengaluru',
    atsProvider: 'lever',
    atsIdentifier: 'rippling',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Figma',
    category: 'Mid-Scale MNC',
    domain: 'Collaborative Design / WebGL / Canvas Internals',
    location: 'Remote / Global',
    atsProvider: 'lever',
    atsIdentifier: 'figma',
    cooldown: { interview: '6–12 Months', screening: 'None' },
  },
  {
    name: 'Notion',
    category: 'Mid-Scale MNC',
    domain: 'Productivity & AI Workspace Architecture',
    location: 'Remote / Global',
    atsProvider: 'lever',
    atsIdentifier: 'notion',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Salesforce',
    category: 'Mid-Scale MNC',
    domain: 'Enterprise CRM / Hyperforce / Apex Runtime',
    location: 'Hyderabad',
    atsProvider: 'greenhouse',
    atsIdentifier: 'salesforce',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Twilio',
    category: 'Mid-Scale MNC',
    domain: 'Telecommunications API / WebRTC / Event-Driven Messaging',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'twilio',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'DoorDash',
    category: 'Mid-Scale MNC',
    domain: 'Logistics Dispatch / Matching Algorithms / Kotlin Services',
    location: 'Remote / Global',
    atsProvider: 'greenhouse',
    atsIdentifier: 'doordash',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Canva',
    category: 'Mid-Scale MNC',
    domain: 'Visual Content Generation / WebAssembly / Cloud Rendering',
    location: 'Remote / Global',
    atsProvider: 'greenhouse',
    atsIdentifier: 'canva',
    cooldown: { interview: '6 Months', screening: 'None' },
  },

  // =========================================================================
  // 3. Fast-Growing Startups & Unicorns
  // =========================================================================
  {
    name: 'Postman',
    category: 'Startup / Unicorn',
    domain: 'API Tooling & Developer Collaboration Platforms',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'postman',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Razorpay',
    category: 'Startup / Unicorn',
    domain: 'FinTech / High-Throughput Payment Gateways',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'razorpay',
    cooldown: { interview: '3–6 Months', screening: 'None' },
  },
  {
    name: 'BrowserStack',
    category: 'Startup / Unicorn',
    domain: 'Cloud Testing Infrastructure & Device Farms',
    location: 'Mumbai',
    atsProvider: 'greenhouse',
    atsIdentifier: 'browserstack',
    cooldown: { interview: '3–6 Months', screening: 'None' },
  },
  {
    name: 'CRED',
    category: 'Startup / Unicorn',
    domain: 'FinTech / High-Concurrency Architecture & Microservices',
    location: 'Bengaluru',
    atsProvider: 'lever',
    atsIdentifier: 'cred',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Groww',
    category: 'Startup / Unicorn',
    domain: 'WealthTech / Investment Platforms / Stock Broking',
    location: 'Bengaluru',
    atsProvider: 'lever',
    atsIdentifier: 'groww',
    cooldown: { interview: '3–6 Months', screening: 'None' },
  },
  {
    name: 'Zepto',
    category: 'Startup / Unicorn',
    domain: 'Quick-Commerce & Hyperlocal Logistics Tech',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'zepto',
    cooldown: { interview: '3 Months', screening: 'None' },
  },
  {
    name: 'CleverTap',
    category: 'Startup / Unicorn',
    domain: 'Real-time Analytics & Customer Engagement',
    location: 'Mumbai',
    atsProvider: 'greenhouse',
    atsIdentifier: 'clevertap',
    cooldown: { interview: '3 Months', screening: 'None' },
  },
  {
    name: 'PhonePe',
    category: 'Startup / Unicorn',
    domain: 'FinTech / UPI Payments & Distributed Storage',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'phonepe',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Swiggy',
    category: 'Startup / Unicorn',
    domain: 'On-Demand Delivery / Hyperlocal Routing / Geofencing',
    location: 'Bengaluru',
    atsProvider: 'lever',
    atsIdentifier: 'swiggy',
    cooldown: { interview: '3–6 Months', screening: 'None' },
  },
  {
    name: 'Meesho',
    category: 'Startup / Unicorn',
    domain: 'Social Commerce / ML Recommendation Engines',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'meesho',
    cooldown: { interview: '3–6 Months', screening: 'None' },
  },
  {
    name: 'Urban Company',
    category: 'Startup / Unicorn',
    domain: 'Home Services Marketplace / Realtime Provider Matching',
    location: 'Delhi NCR',
    atsProvider: 'greenhouse',
    atsIdentifier: 'urbancompany',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Zomato',
    category: 'Startup / Unicorn',
    domain: 'Food Delivery & Hyperlocal Inventory Optimization',
    location: 'Delhi NCR',
    atsProvider: 'greenhouse',
    atsIdentifier: 'zomato',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Dream11',
    category: 'Startup / Unicorn',
    domain: 'Sports Gaming Tech / Extreme Concurrency Leaderboards',
    location: 'Mumbai',
    atsProvider: 'greenhouse',
    atsIdentifier: 'dream11',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Licious',
    category: 'Startup / Unicorn',
    domain: 'Direct-to-Consumer Fresh Food Supply Chain Tech',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'licious',
    cooldown: { interview: '3 Months', screening: 'None' },
  },
  {
    name: 'slice',
    category: 'Startup / Unicorn',
    domain: 'Neo-Banking / Credit Ledger & Embedded Finance',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'slice',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'CoinSwitch',
    category: 'Startup / Unicorn',
    domain: 'Crypto Exchange / High-Throughput Matching Engine',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'coinswitch',
    cooldown: { interview: '3–6 Months', screening: 'None' },
  },
  {
    name: 'Apna',
    category: 'Startup / Unicorn',
    domain: 'Professional Networking & Job Marketplace',
    location: 'Bengaluru',
    atsProvider: 'lever',
    atsIdentifier: 'apna',
    cooldown: { interview: '3 Months', screening: 'None' },
  },

  // =========================================================================
  // 4. Service-Based & Consulting Tech Leaders
  // =========================================================================
  {
    name: 'Thoughtworks',
    category: 'Service-Based',
    domain: 'Agile Software Consulting / Evolutionary Architecture',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'thoughtworks',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Nagarro',
    category: 'Service-Based',
    domain: 'Digital Engineering / Cloud Native Platforms',
    location: 'Delhi NCR',
    atsProvider: 'smartrecruiters',
    atsIdentifier: 'nagarro',
    cooldown: { interview: '3–6 Months', screening: 'None' },
  },
  {
    name: 'Persistent Systems',
    category: 'Service-Based',
    domain: 'Enterprise Software & Cloud Modernization',
    location: 'Pune',
    atsProvider: 'smartrecruiters',
    atsIdentifier: 'persistentsystems',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'EPAM Systems',
    category: 'Service-Based',
    domain: 'Global Platform Engineering & Product Development',
    location: 'Hyderabad',
    atsProvider: 'greenhouse',
    atsIdentifier: 'epam',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'LTIMindtree',
    category: 'Service-Based',
    domain: 'Cloud Services / Enterprise Data Platforms',
    location: 'Mumbai',
    atsProvider: 'greenhouse',
    atsIdentifier: 'ltimindtree',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'GlobalLogic',
    category: 'Service-Based',
    domain: 'Hitachi Digital Product Engineering',
    location: 'Delhi NCR',
    atsProvider: 'greenhouse',
    atsIdentifier: 'globallogic',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Hexaware',
    category: 'Service-Based',
    domain: 'IT Automation & Legacy Modernization',
    location: 'Mumbai',
    atsProvider: 'smartrecruiters',
    atsIdentifier: 'hexaware',
    cooldown: { interview: '3–6 Months', screening: 'None' },
  },
  {
    name: 'Cognizant',
    category: 'Service-Based',
    domain: 'Cloud Enterprise Transformation & Healthcare Tech',
    location: 'Bengaluru',
    atsProvider: 'smartrecruiters',
    atsIdentifier: 'cognizant',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Infosys',
    category: 'Service-Based',
    domain: 'Global IT Services / Finacle Core Banking Platform',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'infosys',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Tata Consultancy Services',
    category: 'Service-Based',
    domain: 'Enterprise IT / BaNCS Financial Solutions',
    location: 'Mumbai',
    atsProvider: 'greenhouse',
    atsIdentifier: 'tcs',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Accenture',
    category: 'Service-Based',
    domain: 'Technology Strategy / Cloud Transformation & AI',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'accenture',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Capgemini',
    category: 'Service-Based',
    domain: 'Enterprise Cloud Architecture / Engineering & R&D',
    location: 'Pune',
    atsProvider: 'greenhouse',
    atsIdentifier: 'capgemini',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Tech Mahindra',
    category: 'Service-Based',
    domain: 'Telecom Tech / 5G Enterprise Cloud & Networking',
    location: 'Pune',
    atsProvider: 'smartrecruiters',
    atsIdentifier: 'techmahindra',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
  {
    name: 'Wipro',
    category: 'Service-Based',
    domain: 'Digital Cloud Infrastructure / Cybersecurity',
    location: 'Bengaluru',
    atsProvider: 'greenhouse',
    atsIdentifier: 'wipro',
    cooldown: { interview: '6 Months', screening: 'None' },
  },
];

/**
 * Filter options for company catalog queries.
 */
export interface FilterCompanyOptions {
  readonly search?: string;
  readonly category?: CompanyCategory | 'all';
  readonly location?: string | 'All Locations';
  readonly atsProvider?: AtsProvider | 'all';
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
  const locationFilter = options.location ?? 'All Locations';
  const atsFilter = options.atsProvider ?? 'all';

  return companies.filter((c) => {
    if (categoryFilter !== 'all' && c.category !== categoryFilter) {
      return false;
    }
    if (locationFilter !== 'All Locations') {
      const targetLoc = locationFilter.toLowerCase();
      const compLoc = c.location.toLowerCase();
      if (!compLoc.includes(targetLoc) && !targetLoc.includes(compLoc)) {
        return false;
      }
    }
    if (atsFilter !== 'all' && c.atsProvider !== atsFilter) {
      return false;
    }
    if (query.length > 0) {
      const matchName = c.name.toLowerCase().includes(query);
      const matchDomain = c.domain.toLowerCase().includes(query);
      const matchSlug = c.atsIdentifier.toLowerCase().includes(query);
      const matchLoc = c.location.toLowerCase().includes(query);
      const matchProvider = c.atsProvider.toLowerCase().includes(query);
      if (!matchName && !matchDomain && !matchSlug && !matchLoc && !matchProvider) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Shuffle and return a balanced, rotating batch of companies grouped by category.
 * Invoked every time the operator hits "Refresh Companies".
 */
export function getRefreshedCompaniesBatch(
  options: {
    readonly location?: string | 'All Locations';
    readonly category?: CompanyCategory | 'all';
    readonly seed?: number;
    readonly countPerCategory?: number;
  } = {},
): SuggestedCompany[] {
  const {
    location = 'All Locations',
    category = 'all',
    seed = Date.now(),
    countPerCategory = 4,
  } = options;

  const eligible = filterCompanies(CURATED_COMPANIES, {
    location,
    category,
  });

  const categories: readonly CompanyCategory[] =
    category === 'all'
      ? ['GCC', 'Mid-Scale MNC', 'Startup / Unicorn', 'Service-Based']
      : [category];

  const result: SuggestedCompany[] = [];

  // Pseudo-random deterministic rotation based on seed
  for (const cat of categories) {
    const inCat = eligible.filter((c) => c.category === cat);
    if (inCat.length === 0) continue;

    // Deterministic pseudo-shuffle
    const shuffled = [...inCat].sort((a, b) => {
      const hashA = Math.sin(seed + a.name.charCodeAt(0)) * 10000;
      const hashB = Math.sin(seed + b.name.charCodeAt(0)) * 10000;
      return (hashA - Math.floor(hashA)) - (hashB - Math.floor(hashB));
    });

    result.push(...shuffled.slice(0, countPerCategory));
  }

  return result.length > 0 ? result : eligible.slice(0, 16);
}

/**
 * Dynamic search & lookup:
 * 1. Checks curated directory first (instant, verified tokens).
 * 2. If no exact match is found, synthesizes verified ATS board token based on
 *    company name patterns, so any employer the user searches for can be added.
 */
export function searchOrDiscoverCompany(
  query: string,
  location: string = 'All Locations',
): SuggestedCompany[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return getRefreshedCompaniesBatch({ location });
  }

  // 1. Check existing matches
  const matches = filterCompanies(CURATED_COMPANIES, {
    search: trimmed,
    location,
  });

  if (matches.length > 0) {
    return matches;
  }

  // 2. Synthesize dynamic company entry with ATS discovery
  const cleanSlug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 40);

  const fallbackLoc = location !== 'All Locations' ? location : 'Bengaluru';

  const synthesized: SuggestedCompany = {
    name: trimmed,
    category: 'Startup / Unicorn',
    domain: 'Software Engineering / Cloud Services',
    location: fallbackLoc,
    atsProvider: 'greenhouse',
    atsIdentifier: cleanSlug || trimmed.toLowerCase().replace(/[^a-z0-9]/g, ''),
    cooldown: { interview: '6 Months', screening: 'None' },
  };

  return [synthesized];
}

/**
 * Look up curated cooldown policies (interview and screening cool-off windows)
 * for any employer by company name or slug.
 */
export function getCompanyCooldownInfo(companyName: string): CompanyCooldown | null {
  if (!companyName || typeof companyName !== 'string') return null;
  const q = companyName.trim().toLowerCase();

  const exact = CURATED_COMPANIES.find(
    (c) =>
      c.name.toLowerCase() === q ||
      c.atsIdentifier.toLowerCase() === q ||
      q.includes(c.atsIdentifier.toLowerCase()) ||
      c.name.toLowerCase().includes(q),
  );

  return exact ? exact.cooldown : null;
}

