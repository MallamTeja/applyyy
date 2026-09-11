/* Interactive target company suggestions modal with ATS auto-discovery & cooldowns.
 *
 * WHAT THIS MODAL DOES:
 *   Solves the biggest friction point in populating the Scout watchlist:
 *   Instead of manually researching whether a company uses Greenhouse, Lever,
 *   or Ashby, finding their board slug, and guessing their cooldown policy, the
 *   operator can browse curated verified target employers (GCCs, Mid-Scale MNCs,
 *   Startups/Unicorns) and 1-click add them directly to Supabase.
 *
 * ATS AUTO-DISCOVERY WITH GEMINI:
 *   If the operator wants companies outside the curated list (e.g. niche AI infra,
 *   specialised fintech, or new unicorns), the modal can query Gemini 1.5 Flash
 *   for real-time discovery of ATS tokens and cooldown rules with structured validation.
 *
 * COOLDOWN TRANSPARENCY:
 *   Every card clearly displays interview and resume screening cooldown windows
 *   to avoid burning Scout applications during active recruiter lockout periods.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';

import type { CompanyWatchlistRow } from '../../data/contract';
import {
  CURATED_COMPANIES,
  discoverCompaniesWithGemini,
  filterCompanies,
} from './companyCatalog';
import type {
  CompanyCategory,
  SuggestedCompany,
  SupportedAtsProvider,
} from './companyCatalog';

export interface CompanySuggestionsModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly existingRows: readonly CompanyWatchlistRow[];
  readonly onAddCompany: (company: SuggestedCompany) => Promise<boolean>;
}

export function CompanySuggestionsModal({
  isOpen,
  onClose,
  existingRows,
  onAddCompany,
}: CompanySuggestionsModalProps): ReactElement | null {
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<CompanyCategory | 'all'>('all');
  const [selectedAts, setSelectedAts] = useState<SupportedAtsProvider | 'all'>('all');

  // AI discovery state
  const [aiQuery, setAiQuery] = useState<string>('');
  const [isDiscovering, setIsDiscovering] = useState<boolean>(false);
  const [aiCompanies, setAiCompanies] = useState<readonly SuggestedCompany[] | null>(null);
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string>(() => {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem('gemini_api_key') || '';
    }
    return '';
  });
  const [showApiKeyInput, setShowApiKeyInput] = useState<boolean>(false);

  // Per-company add loading state & locally added slugs
  const [addingIdentifier, setAddingIdentifier] = useState<string | null>(null);
  const [localAddedSlugs, setLocalAddedSlugs] = useState<Set<string>>(() => new Set());
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Check if a company is already in watchlist
  const isCompanyAdded = useCallback(
    (company: SuggestedCompany): boolean => {
      const key = `${company.atsProvider}:${company.atsIdentifier.toLowerCase()}`;
      if (localAddedSlugs.has(key)) return true;

      return (
        existingRows.some(
          (r) =>
            r.ats_provider === company.atsProvider &&
            r.board_token.toLowerCase() === company.atsIdentifier.toLowerCase(),
        ) ||
        existingRows.some(
          (r) => r.company_name.toLowerCase() === company.name.toLowerCase(),
        )
      );
    },
    [existingRows, localAddedSlugs],
  );

  // Active pool of companies: AI discovered if active, otherwise curated
  const baseCompanies = useMemo(() => {
    return aiCompanies !== null ? aiCompanies : CURATED_COMPANIES;
  }, [aiCompanies]);

  // Filtered companies based on search, category, and ATS
  const displayedCompanies = useMemo(() => {
    return filterCompanies(baseCompanies, {
      search: searchTerm,
      category: selectedCategory,
      atsProvider: selectedAts,
    });
  }, [baseCompanies, searchTerm, selectedCategory, selectedAts]);

  // Category counts for quick-filter tabs
  const categoryCounts = useMemo(() => {
    return {
      all: baseCompanies.length,
      gcc: baseCompanies.filter((c) => c.category === 'GCC').length,
      mnc: baseCompanies.filter((c) => c.category === 'Mid-Scale MNC').length,
      startup: baseCompanies.filter((c) => c.category === 'Startup / Unicorn').length,
    };
  }, [baseCompanies]);

  // Handle 1-click Add
  const handleAdd = async (company: SuggestedCompany): Promise<void> => {
    const key = `${company.atsProvider}:${company.atsIdentifier.toLowerCase()}`;
    setAddingIdentifier(key);
    setActionFeedback(null);

    try {
      const success = await onAddCompany(company);
      if (success) {
        setLocalAddedSlugs((prev) => new Set(prev).add(key));
        setActionFeedback(`✓ Added ${company.name} (${company.atsProvider}) to Watchlist.`);
      }
    } finally {
      setAddingIdentifier(null);
    }
  };

  // Trigger Gemini AI Discovery
  const handleAiDiscover = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const query = aiQuery.trim();
    if (!query) return;

    setIsDiscovering(true);
    setAiMessage(null);

    try {
      const discovered = await discoverCompaniesWithGemini(query, apiKey);
      setAiCompanies(discovered);
      setAiMessage(`Discovered ${discovered.length} companies matching "${query}".`);
    } catch (err) {
      setAiMessage(`Discovery failed: ${String(err)}`);
    } finally {
      setIsDiscovering(false);
    }
  };

  // Reset AI Discovery back to Curated Catalog
  const handleResetToCurated = (): void => {
    setAiCompanies(null);
    setAiQuery('');
    setAiMessage(null);
  };

  // Save API Key locally
  const handleSaveApiKey = (newKey: string): void => {
    setApiKey(newKey);
    if (typeof window !== 'undefined' && window.localStorage) {
      if (newKey.trim()) {
        window.localStorage.setItem('gemini_api_key', newKey.trim());
      } else {
        window.localStorage.removeItem('gemini_api_key');
      }
    }
  };

  if (!isOpen) return null;

  return (
    <div className="suggestions-overlay" onClick={onClose} role="presentation">
      <div
        className="suggestions-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="suggestions-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="suggestions-header">
          <div className="suggestions-header__info">
            <div className="suggestions-header__title-row">
              <span className="suggestions-header__sparkle">✨</span>
              <h2 id="suggestions-modal-title" className="suggestions-header__title">
                Target Company Directory & ATS Auto-Discovery
              </h2>
            </div>
            <p className="suggestions-header__desc">
              Browse curated GCCs, Mid-Scale MNCs, and Startups for Internship & FTE roles.
              1-click adds verified ATS providers and tokens straight to your Scout watchlist.
            </p>
          </div>
          <button
            type="button"
            className="suggestions-close"
            onClick={onClose}
            aria-label="Close suggestions modal"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        {/* Global Feedback Banner */}
        {actionFeedback && (
          <div className="suggestions-banner suggestions-banner--success">
            {actionFeedback}
          </div>
        )}

        {/* AI Discovery Toolbar */}
        <section className="suggestions-ai-bar">
          <form onSubmit={handleAiDiscover} className="suggestions-ai-form">
            <div className="suggestions-ai-input-wrap">
              <span className="suggestions-ai-icon">🤖</span>
              <input
                type="text"
                className="suggestions-ai-input"
                placeholder="Ask Gemini: e.g. Bangalore AI startups, US Tech GCCs, Fintech Unicorns..."
                value={aiQuery}
                onChange={(e) => setAiQuery(e.target.value)}
                disabled={isDiscovering}
              />
            </div>
            <button
              type="submit"
              className="button button--ai-discover"
              disabled={isDiscovering || !aiQuery.trim()}
            >
              {isDiscovering ? 'Discovering...' : '✨ Discover with Gemini'}
            </button>
            {aiCompanies !== null && (
              <button
                type="button"
                className="button button--ai-reset"
                onClick={handleResetToCurated}
                title="Reset to default curated list"
              >
                Reset to Curated
              </button>
            )}
            <button
              type="button"
              className="button--text-toggle"
              onClick={() => setShowApiKeyInput((prev) => !prev)}
            >
              {showApiKeyInput ? 'Hide API Key' : 'Gemini Key ⚙'}
            </button>
          </form>

          {showApiKeyInput && (
            <div className="suggestions-api-key-box">
              <label className="field" style={{ margin: 0 }}>
                <span className="field__label">Gemini API Key (stored in local browser session)</span>
                <input
                  type="password"
                  className="field__control identifier"
                  placeholder="AIzaSy... (leave blank to use VITE_GEMINI_API_KEY if configured)"
                  value={apiKey}
                  onChange={(e) => handleSaveApiKey(e.target.value)}
                />
              </label>
              <span className="field__help">
                Optional: If not set, uses curated directory matching and safe sector fallbacks.
              </span>
            </div>
          )}

          {aiMessage && (
            <div className="suggestions-ai-status">
              <span>{aiMessage}</span>
            </div>
          )}
        </section>

        {/* Filters and Search Strip */}
        <div className="suggestions-controls">
          <div className="suggestions-search-wrap">
            <input
              type="search"
              className="suggestions-search-input"
              placeholder="Search companies, tech domains, or board tokens..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>

          <div className="suggestions-tabs">
            <button
              type="button"
              className={`suggestions-tab ${selectedCategory === 'all' ? 'suggestions-tab--active' : ''}`}
              onClick={() => setSelectedCategory('all')}
            >
              All ({categoryCounts.all})
            </button>
            <button
              type="button"
              className={`suggestions-tab ${selectedCategory === 'GCC' ? 'suggestions-tab--active' : ''}`}
              onClick={() => setSelectedCategory('GCC')}
            >
              GCCs ({categoryCounts.gcc})
            </button>
            <button
              type="button"
              className={`suggestions-tab ${selectedCategory === 'Mid-Scale MNC' ? 'suggestions-tab--active' : ''}`}
              onClick={() => setSelectedCategory('Mid-Scale MNC')}
            >
              Mid-Scale MNCs ({categoryCounts.mnc})
            </button>
            <button
              type="button"
              className={`suggestions-tab ${selectedCategory === 'Startup / Unicorn' ? 'suggestions-tab--active' : ''}`}
              onClick={() => setSelectedCategory('Startup / Unicorn')}
            >
              Startups ({categoryCounts.startup})
            </button>
          </div>

          <div className="suggestions-ats-filter">
            <select
              className="field__control suggestions-select"
              value={selectedAts}
              onChange={(e) => setSelectedAts(e.target.value as SupportedAtsProvider | 'all')}
              aria-label="Filter by ATS Provider"
            >
              <option value="all">All ATS Providers</option>
              <option value="greenhouse">Greenhouse</option>
              <option value="lever">Lever</option>
              <option value="ashby">Ashby</option>
            </select>
          </div>
        </div>

        {/* Company Cards Grid */}
        <div className="suggestions-body">
          {displayedCompanies.length === 0 ? (
            <div className="suggestions-empty">
              <p className="suggestions-empty__title">No matching companies found</p>
              <p className="suggestions-empty__note">
                Try refining your keyword search or use the Gemini AI discovery bar above to
                find new target companies.
              </p>
            </div>
          ) : (
            <div className="suggestions-grid">
              {displayedCompanies.map((company) => {
                const isAdded = isCompanyAdded(company);
                const key = `${company.atsProvider}:${company.atsIdentifier.toLowerCase()}`;
                const isAdding = addingIdentifier === key;

                return (
                  <article key={key} className="company-card">
                    <div className="company-card__header">
                      <div>
                        <h3 className="company-card__name">{company.name}</h3>
                        <div className="company-card__domain">{company.domain}</div>
                      </div>

                      <div className="company-card__badges">
                        <span className={`badge-cat badge-cat--${company.category.replace(/[^a-zA-Z]/g, '').toLowerCase()}`}>
                          {company.category}
                        </span>
                        <span className="badge-ats">
                          {company.atsProvider}: {company.atsIdentifier}
                        </span>
                      </div>
                    </div>

                    {/* Cooldown Section */}
                    <div className="company-card__cooldown">
                      <div className="cooldown-item">
                        <span className="cooldown-icon">🕒</span>
                        <span className="cooldown-label">Interview Cool-off:</span>
                        <span className="cooldown-val">{company.cooldown.interview}</span>
                      </div>
                      <div className="cooldown-item">
                        <span className="cooldown-icon">📋</span>
                        <span className="cooldown-label">Screening Cool-off:</span>
                        <span className="cooldown-val">{company.cooldown.screening}</span>
                      </div>
                      {company.cooldown.notes && (
                        <div className="cooldown-notes">{company.cooldown.notes}</div>
                      )}
                    </div>

                    {/* 1-Click Action Footer */}
                    <div className="company-card__footer">
                      <div className="company-card__ats-detail">
                        <span className="identifier" style={{ fontSize: '0.75rem', color: 'var(--ink-muted)' }}>
                          board: {company.atsIdentifier}
                        </span>
                      </div>

                      {isAdded ? (
                        <button
                          type="button"
                          className="button button--company-added"
                          disabled
                          title="Already registered in your Scout watchlist"
                        >
                          Added ✓
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="button button--company-add"
                          onClick={() => handleAdd(company)}
                          disabled={isAdding}
                        >
                          {isAdding ? 'Adding...' : '+ Add to Watchlist'}
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="suggestions-footer">
          <span className="suggestions-footer__note">
            Adding a company immediately registers its direct careers API endpoint with the Scout.
          </span>
          <button type="button" className="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
