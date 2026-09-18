/* Interactive target company suggestions modal with location switching,
 * refreshable batches, grouped categories, and direct search discovery.
 *
 * WHAT THIS MODAL DOES:
 *   Eliminates manual ATS hunting. Displays verified target employers grouped across:
 *     1. GCCs (Global Capability Centers)
 *     2. Mid-Scale Product MNCs
 *     3. High-Growth Startups & Unicorns
 *     4. Service-Based & Consulting Leaders
 *
 * LOCATION SWITCHING & REFRESH:
 *   - Allows filtering by major tech hubs (Bengaluru, Hyderabad, Pune, Delhi NCR, Mumbai, Remote).
 *   - "Refresh Companies" dynamically rotates to a fresh batch of companies on each click.
 *   - Search bar with dedicated [Search] button resolves any company name and its ATS token.
 *   - 1-Click adds straight to Supabase watchlist with enabled = true.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

import type { AtsProvider, CompanyWatchlistRow } from '../../data/contract';
import {
  AVAILABLE_LOCATIONS,
  CURATED_COMPANIES,
  filterCompanies,
  getRefreshedCompaniesBatch,
  searchOrDiscoverCompany,
} from './companyCatalog';
import type {
  AvailableLocation,
  CompanyCategory,
  SuggestedCompany,
} from './companyCatalog';
import './settings.css';

export interface CompanySuggestionsModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly existingRows: readonly CompanyWatchlistRow[];
  readonly onAddCompany: (company: SuggestedCompany) => Promise<boolean>;
}

const CATEGORY_DEFINITIONS: readonly {
  readonly id: CompanyCategory;
  readonly label: string;
  readonly icon: string;
}[] = [
  { id: 'GCC', label: 'Global Capability Centers (GCCs)', icon: '🏢' },
  { id: 'Mid-Scale MNC', label: 'Mid-Scale Product MNCs', icon: '🌐' },
  { id: 'Startup / Unicorn', label: 'High-Growth Startups & Unicorns', icon: '🚀' },
  { id: 'Service-Based', label: 'Service-Based & Consulting Leaders', icon: '🛠️' },
];

export function CompanySuggestionsModal({
  isOpen,
  onClose,
  existingRows,
  onAddCompany,
}: CompanySuggestionsModalProps): ReactElement | null {
  const [selectedLocation, setSelectedLocation] = useState<AvailableLocation>('All Locations');
  const [selectedCategory, setSelectedCategory] = useState<CompanyCategory | 'all'>('all');
  const [selectedAts, setSelectedAts] = useState<AtsProvider | 'all'>('all');
  const [searchInput, setSearchInput] = useState<string>('');
  const [activeSearchQuery, setActiveSearchQuery] = useState<string>('');
  const [refreshSeed, setRefreshSeed] = useState<number>(() => Date.now());

  // Adding state and toast feedback
  const [addingKey, setAddingKey] = useState<string | null>(null);
  const [localAddedKeys, setLocalAddedKeys] = useState<Set<string>>(() => new Set());
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Auto-dismiss transient toast after 2.5s
  useEffect(() => {
    if (!toastMessage) return;
    const timer = setTimeout(() => setToastMessage(null), 2500);
    return () => clearTimeout(timer);
  }, [toastMessage]);

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
      if (localAddedKeys.has(key)) return true;

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
    [existingRows, localAddedKeys],
  );

  // Refresh batch button handler: picks new companies
  const handleRefreshBatch = (): void => {
    setActiveSearchQuery('');
    setSearchInput('');
    setRefreshSeed(Date.now() + Math.floor(Math.random() * 10000));
  };

  // Search submit handler
  const handleSearchSubmit = (e: FormEvent): void => {
    e.preventDefault();
    setActiveSearchQuery(searchInput.trim());
  };

  // Clear search handler
  const handleClearSearch = (): void => {
    setSearchInput('');
    setActiveSearchQuery('');
  };

  // Companies pool based on search or refreshed batch
  const currentPool = useMemo(() => {
    if (activeSearchQuery) {
      return searchOrDiscoverCompany(activeSearchQuery, selectedLocation);
    }
    return getRefreshedCompaniesBatch({
      location: selectedLocation,
      category: selectedCategory,
      seed: refreshSeed,
      countPerCategory: 5,
    });
  }, [activeSearchQuery, selectedLocation, selectedCategory, refreshSeed]);

  // Filter pool by ATS and Category
  const displayedCompanies = useMemo(() => {
    return filterCompanies(currentPool, {
      category: selectedCategory,
      location: selectedLocation,
      atsProvider: selectedAts,
    });
  }, [currentPool, selectedCategory, selectedLocation, selectedAts]);

  // Category counts based on full curated dataset at the selected location
  const categoryCounts = useMemo(() => {
    const locMatches = filterCompanies(CURATED_COMPANIES, { location: selectedLocation });
    return {
      all: locMatches.length,
      gcc: locMatches.filter((c) => c.category === 'GCC').length,
      mnc: locMatches.filter((c) => c.category === 'Mid-Scale MNC').length,
      startup: locMatches.filter((c) => c.category === 'Startup / Unicorn').length,
      service: locMatches.filter((c) => c.category === 'Service-Based').length,
    };
  }, [selectedLocation]);

  // Handle 1-click Add
  const handleAdd = async (company: SuggestedCompany): Promise<void> => {
    const key = `${company.atsProvider}:${company.atsIdentifier.toLowerCase()}`;
    setAddingKey(key);

    try {
      const success = await onAddCompany(company);
      if (success) {
        setLocalAddedKeys((prev) => new Set(prev).add(key));
        setToastMessage(`✓ Added ${company.name} to Watchlist`);
      }
    } finally {
      setAddingKey(null);
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
        {/* Modal Header with close ✕ button */}
        <div className="suggestions-header">
          <div className="suggestions-header__info">
            <h2 id="suggestions-modal-title" className="suggestions-header__title">
              Target Company Directory & ATS Discovery
            </h2>
            <p className="suggestions-header__desc">
              Browse target employers with verified ATS slugs and cooldown rules.
              Click &quot;+ Add to Watchlist&quot; to auto-register any careers board with the Scout.
            </p>
          </div>
          <button
            type="button"
            className="suggestions-close-btn"
            onClick={onClose}
            aria-label="Close dialog"
            title="Close dialog (Esc)"
          >
            ✕
          </button>
        </div>

        {/* Action Controls: Location Selector + Search + Refresh */}
        <section className="suggestions-action-bar">
          {/* Location Selector */}
          <div className="suggestions-location-select-wrap">
            <label htmlFor="suggestions-location-select" className="suggestions-label">
              Location:
            </label>
            <select
              id="suggestions-location-select"
              className="field__control suggestions-location-select"
              value={selectedLocation}
              onChange={(e) => {
                setSelectedLocation(e.target.value as AvailableLocation);
                setRefreshSeed(Date.now());
              }}
            >
              {AVAILABLE_LOCATIONS.map((loc) => (
                <option key={loc} value={loc}>
                  {loc === 'All Locations' ? '📍 All Locations' : loc}
                </option>
              ))}
            </select>
          </div>

          {/* Search Input & Button */}
          <form onSubmit={handleSearchSubmit} className="suggestions-search-form">
            <div className="suggestions-search-field-wrap">
              <input
                type="text"
                className="suggestions-search-input"
                placeholder="Search any company, domain, or slug..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
              {searchInput && (
                <button
                  type="button"
                  className="suggestions-search-clear"
                  onClick={handleClearSearch}
                  title="Clear search"
                >
                  Clear
                </button>
              )}
            </div>
            <button type="submit" className="button button--search">
              Search
            </button>
          </form>

          {/* Refresh Batch Button */}
          <button
            type="button"
            className="button button--refresh-batch"
            onClick={handleRefreshBatch}
            title="Load a new set of companies"
          >
            🔄 Refresh Companies
          </button>
        </section>

        {/* Category Pills & ATS Filter */}
        <div className="suggestions-controls">
          <div className="suggestions-tabs">
            <button
              type="button"
              className={`suggestions-tab ${selectedCategory === 'all' ? 'suggestions-tab--active' : ''}`}
              onClick={() => setSelectedCategory('all')}
            >
              All Grouped ({categoryCounts.all})
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
            <button
              type="button"
              className={`suggestions-tab ${selectedCategory === 'Service-Based' ? 'suggestions-tab--active' : ''}`}
              onClick={() => setSelectedCategory('Service-Based')}
            >
              Service-Based ({categoryCounts.service})
            </button>
          </div>

          <div className="suggestions-ats-filter">
            <select
              className="field__control suggestions-select"
              value={selectedAts}
              onChange={(e) => setSelectedAts(e.target.value as AtsProvider | 'all')}
              aria-label="Filter by ATS Provider"
            >
              <option value="all">All ATS</option>
              <option value="greenhouse">Greenhouse</option>
              <option value="lever">Lever</option>
              <option value="ashby">Ashby</option>
              <option value="smartrecruiters">SmartRecruiters</option>
              <option value="workable">Workable</option>
            </select>
          </div>
        </div>

        {/* Modal Scrollable Body: Grouped Sections */}
        <div className="suggestions-body">
          {displayedCompanies.length === 0 ? (
            <div className="suggestions-empty">
              <p className="suggestions-empty__title">No matching companies found</p>
              <p className="suggestions-empty__note">
                Try clearing your filters, changing the location, or clicking &quot;Refresh Companies&quot; above.
              </p>
            </div>
          ) : selectedCategory === 'all' && !activeSearchQuery ? (
            /* Grouped View across all categories */
            <div className="suggestions-grouped-sections">
              {CATEGORY_DEFINITIONS.map((catDef) => {
                const groupCompanies = displayedCompanies.filter(
                  (c) => c.category === catDef.id,
                );
                if (groupCompanies.length === 0) return null;

                return (
                  <section key={catDef.id} className="suggestions-group-section">
                    <div className="suggestions-group-header">
                      <span className="suggestions-group-icon">{catDef.icon}</span>
                      <h3 className="suggestions-group-title">{catDef.label}</h3>
                      <span className="suggestions-group-count">
                        ({groupCompanies.length})
                      </span>
                    </div>

                    <div className="suggestions-grid">
                      {groupCompanies.map((company) => (
                        <CompanyCard
                          key={`${company.atsProvider}:${company.atsIdentifier}`}
                          company={company}
                          isAdded={isCompanyAdded(company)}
                          isAdding={
                            addingKey ===
                            `${company.atsProvider}:${company.atsIdentifier.toLowerCase()}`
                          }
                          onAdd={handleAdd}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          ) : (
            /* Direct Grid View (when filtered by specific category or searching) */
            <div className="suggestions-grid">
              {displayedCompanies.map((company) => (
                <CompanyCard
                  key={`${company.atsProvider}:${company.atsIdentifier}`}
                  company={company}
                  isAdded={isCompanyAdded(company)}
                  isAdding={
                    addingKey ===
                    `${company.atsProvider}:${company.atsIdentifier.toLowerCase()}`
                  }
                  onAdd={handleAdd}
                />
              ))}
            </div>
          )}
        </div>

        {/* Transient Toast Notification */}
        {toastMessage && (
          <div className="suggestions-toast-container">
            <div className="suggestions-toast">{toastMessage}</div>
          </div>
        )}

        {/* Modal Footer with Done Button */}
        <div className="suggestions-footer">
          <span className="suggestions-footer__note">
            The Scout directly polls public JSON API endpoints for each added board token.
          </span>
          <button type="button" className="button button--primary button--done" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Individual Company Card component
 */
interface CompanyCardProps {
  readonly company: SuggestedCompany;
  readonly isAdded: boolean;
  readonly isAdding: boolean;
  readonly onAdd: (company: SuggestedCompany) => void;
}

function CompanyCard({ company, isAdded, isAdding, onAdd }: CompanyCardProps): ReactElement {
  const catClass = company.category.replace(/[^a-zA-Z]/g, '').toLowerCase();

  return (
    <article className="company-card">
      <div className="company-card__header">
        <div className="company-card__title-group">
          <div className="company-card__title-row">
            <h3 className="company-card__name">{company.name}</h3>
            {company.location && (
              <span className="badge-location" title={`Tech Hub: ${company.location}`}>
                📍 {company.location}
              </span>
            )}
          </div>
          <div className="company-card__domain">{company.domain}</div>
        </div>

        <div className="company-card__badges">
          <span className={`badge-cat badge-cat--${catClass}`}>
            {company.category}
          </span>
          <span
            className="badge-ats"
            title={`ATS Provider: ${company.atsProvider} | Board Token: ${company.atsIdentifier}`}
          >
            <span className="badge-ats__provider">{company.atsProvider}</span>
            <span className="badge-ats__sep">:</span>
            <span className="badge-ats__id">{company.atsIdentifier}</span>
          </span>
        </div>
      </div>

      {/* Cooldown Section */}
      <div className="company-card__cooldown">
        <div className="cooldown-item">
          <span className="cooldown-icon" aria-hidden="true">⏱️</span>
          <span className="cooldown-label">Interview Cooldown:</span>
          <span className="cooldown-val">{company.cooldown.interview}</span>
        </div>
        <div className="cooldown-item">
          <span className="cooldown-icon" aria-hidden="true">🛡️</span>
          <span className="cooldown-label">Screening Cooldown:</span>
          <span className="cooldown-val">{company.cooldown.screening}</span>
        </div>
        {company.cooldown.notes && (
          <div className="cooldown-notes">{company.cooldown.notes}</div>
        )}
      </div>

      {/* Action Footer */}
      <div className="company-card__footer">
        <div className="company-card__slug-badge" title={`Scout identifier: ${company.atsIdentifier}`}>
          <span className="company-card__slug-label">slug:</span>
          <code className="company-card__slug-code">{company.atsIdentifier}</code>
        </div>

        {isAdded ? (
          <button
            type="button"
            className="company-card__btn company-card__btn--added button button--company-added"
            disabled
            title="Already added to your Scout watchlist"
          >
            <span className="btn-added-check" aria-hidden="true">✓</span>
            <span>Added</span>
          </button>
        ) : (
          <button
            type="button"
            className="company-card__btn company-card__btn--add button button--company-add"
            onClick={() => onAdd(company)}
            disabled={isAdding}
            title={`Add ${company.name} (${company.atsIdentifier}) to your Scout watchlist`}
          >
            {isAdding ? (
              <>
                <span className="btn-spinner" aria-hidden="true" />
                <span>Adding...</span>
              </>
            ) : (
              <>
                <span className="btn-add-plus" aria-hidden="true">+</span>
                <span>Add to Watchlist</span>
              </>
            )}
          </button>
        )}
      </div>
    </article>
  );
}
