import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { ALL_ROUTES } from './routes';
import { useToast } from './Toast';

import './CommandPalette.css';

interface CommandItem {
  readonly id: string;
  readonly label: string;
  readonly lede: string;
  readonly category: 'Operations' | 'Configuration' | 'Action';
  readonly onSelect: () => void;
  readonly shortcut?: string;
}

export function CommandPalette({
  isOpen,
  onClose,
}: {
  readonly isOpen: boolean;
  readonly onClose: () => void;
}): ReactElement | null {
  const navigate = useNavigate();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Build command items list
  const commands: readonly CommandItem[] = useMemo(() => {
    const routeCommands: CommandItem[] = ALL_ROUTES.map((route) => {
      const isOp = ['approvals', 'pipeline', 'discovered', 'health', 'emails'].includes(route.path);
      return {
        id: `route-${route.path}`,
        label: route.label,
        lede: route.lede,
        category: isOp ? 'Operations' : 'Configuration',
        onSelect: () => {
          navigate('/' + route.path);
          onClose();
        },
      };
    });

    const actionCommands: CommandItem[] = [
      {
        id: 'action-sync-email',
        label: 'Trigger Email Sync',
        lede: 'On-demand sync with connected Gmail account to detect interviews',
        category: 'Action',
        onSelect: () => {
          navigate('/emails');
          onClose();
          toast.info('Navigated to Email Monitoring to trigger sync.');
        },
      },
      {
        id: 'action-add-block',
        label: 'Block a Company',
        lede: 'Add a new recruitment firm or company to the exclusion blocklist',
        category: 'Action',
        onSelect: () => {
          navigate('/blocklist');
          onClose();
        },
      },
      {
        id: 'action-watchlist-modal',
        label: 'Browse Watchlist Suggestions',
        lede: 'Discover and add target company career boards to watchlist',
        category: 'Action',
        onSelect: () => {
          navigate('/watchlist');
          onClose();
        },
      },
    ];

    return [...routeCommands, ...actionCommands];
  }, [navigate, onClose, toast]);

  // Filter commands by query
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.lede.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q),
    );
  }, [commands, query]);

  // Keep selection in bounds
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // The latest onClose, for the Escape listener below. Read through a ref so the open effect does
  // not depend on it: AppShell passes a new arrow on every render, and a dependency on it re-ran
  // the reset (setQuery('')) on each shell re-render, wiping what the user had typed (2026-10-25).
  const onCloseRef = useRef(onClose);
  // Synced after every commit, so Escape (always pressed after a commit) calls the current callback.
  useEffect(() => {
    // The one write; nothing renders from a ref.
    onCloseRef.current = onClose;
  });

  // Auto-focus input and bind Escape on open. Depends on isOpen ONLY, so the reset runs on the
  // closed -> open transition and never again while the palette stays open.
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);

      const handleGlobalKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          // Through the ref: the listener was bound at open, so a captured onClose could be stale.
          onCloseRef.current();
        }
      };
      window.addEventListener('keydown', handleGlobalKeyDown);
      return () => window.removeEventListener('keydown', handleGlobalKeyDown);
    }
  }, [isOpen]);

  // Keyboard navigation: ArrowDown, ArrowUp, Enter
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (filtered.length > 0 ? (prev + 1) % filtered.length : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (filtered.length > 0 ? (prev - 1 + filtered.length) % filtered.length : 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const selected = filtered[selectedIndex];
        if (selected) {
          selected.onSelect();
        }
      }
    },
    [filtered, selectedIndex, onClose],
  );

  if (!isOpen) return null;

  return (
    <div
      className="palette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Command Palette"
    >
      <div className="palette-modal" onKeyDown={handleKeyDown}>
        <div className="palette-input-wrap">
          <input
            ref={inputRef}
            type="text"
            className="palette-input"
            placeholder="Type a screen name or action..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="palette-kbd-hint">ESC to close</span>
        </div>

        {filtered.length > 0 ? (
          <ul className="palette-list" role="listbox">
            {filtered.map((item, idx) => (
              <li
                key={item.id}
                role="option"
                aria-selected={idx === selectedIndex}
                className={`palette-item ${idx === selectedIndex ? 'palette-item--selected' : ''}`}
                onClick={() => item.onSelect()}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                <div className="palette-item__main">
                  <div className="palette-item__label-row">
                    <span className="palette-item__label">{item.label}</span>
                    <span className="palette-item__category">{item.category}</span>
                  </div>
                  <span className="palette-item__lede">{item.lede}</span>
                </div>
                {idx === selectedIndex && <span className="palette-item__kbd">↵ Select</span>}
              </li>
            ))}
          </ul>
        ) : (
          <div className="palette-empty">No matching screens or actions found.</div>
        )}

        <div className="palette-footer">
          <div className="palette-footer__shortcuts">
            <span><strong>↑↓</strong> Navigate</span>
            <span><strong>↵</strong> Select</span>
            <span><strong>ESC</strong> Dismiss</span>
          </div>
          <span>applyy console</span>
        </div>
      </div>
    </div>
  );
}
