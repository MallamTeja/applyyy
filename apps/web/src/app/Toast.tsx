import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import './Toast.css';

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastItem {
  readonly id: string;
  readonly message: string;
  readonly kind: ToastKind;
}

interface ToastContextValue {
  readonly success: (message: string) => void;
  readonly error: (message: string) => void;
  readonly info: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback((message: string, kind: ToastKind) => {
    const id = crypto.randomUUID();
    const item: ToastItem = { id, message, kind };
    setToasts((prev) => [...prev.slice(-3), item]); // keep maximum 4 toasts
    setTimeout(() => {
      removeToast(id);
    }, 3200);
  }, [removeToast]);

  const success = useCallback((msg: string) => addToast(msg, 'success'), [addToast]);
  const error = useCallback((msg: string) => addToast(msg, 'error'), [addToast]);
  const info = useCallback((msg: string) => addToast(msg, 'info'), [addToast]);

  const value = useMemo(() => ({ success, error, info }), [success, error, info]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-container" aria-live="polite" role="status">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.kind}`}>
            <div className="toast__body">
              <span className="toast__icon" aria-hidden="true">
                {/* Plain marks, never emoji: they take the toast's text colour (noEmoji.test.ts). */}
                {toast.kind === 'success' ? '✓' : toast.kind === 'error' ? '!' : 'i'}
              </span>
              <span className="toast__message">{toast.message}</span>
            </div>
            <button
              type="button"
              className="toast__close"
              onClick={() => removeToast(toast.id)}
              aria-label="Dismiss notice"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    // Fallback if rendered outside provider
    return {
      success: (msg: string) => console.log('[Toast Success]', msg),
      error: (msg: string) => console.error('[Toast Error]', msg),
      info: (msg: string) => console.info('[Toast Info]', msg),
    };
  }
  return context;
}
