/* A render-crash boundary for one page.
 *
 * Without it, an exception thrown while rendering ANY page (a renamed column read as
 * `.map` on undefined, an identifier left behind mid-edit) unmounts the whole React
 * tree and the operator gets a blank white window, nav included. App.tsx wraps each
 * routed page in its own boundary, so a crash costs that page only and the nav rail
 * survives to take the operator somewhere else.
 *
 * A CLASS COMPONENT because React 18 has no hook for this: only a class can define
 * getDerivedStateFromError / componentDidCatch. */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

// The fallback's styles, kept beside the only component that uses them.
import './ErrorBoundary.css';

// The wrapped page; nothing else is configurable because nothing else needs to be.
interface ErrorBoundaryProps {
  // The page whose render failures this boundary contains.
  readonly children: ReactNode;
}

// Null while healthy; the caught error once a render has thrown.
interface ErrorBoundaryState {
  // Kept so the message can be shown — a crash with no words is undiagnosable.
  readonly error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  // Healthy until a descendant throws.
  override state: ErrorBoundaryState = { error: null };

  // React calls this during render when a child throws; switching state shows the fallback.
  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    // Non-Error throws (strings, objects) still deserve a readable message.
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  // Logging lives here, not in render: this runs once per crash with the component stack.
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is where a developer will look; the stack names the failing component.
    console.error('Page render crashed:', error, info.componentStack);
  }

  // Clears the error so the page re-renders; enough when the crash was a transient state.
  private readonly retry = (): void => {
    // Back to healthy; if the bug is deterministic, the boundary simply catches again.
    this.setState({ error: null });
  };

  override render(): ReactNode {
    // Healthy: render the page untouched.
    if (this.state.error === null) return this.props.children;
    // Crashed: a recoverable message in the page's own frame, not a blank screen.
    return (
      <div className="page">
        {/* role=alert so assistive tech announces the failure. Danger tokens, no hex. */}
        <div className="error-boundary" role="alert">
          {/* States what happened in plain words, and that the rest of the app is fine. */}
          <h2 className="error-boundary__title">This page failed to render</h2>
          {/* The real message, so a bug report carries the cause. */}
          <p className="error-boundary__message">{this.state.error.message}</p>
          {/* Two ways out: retry in place, or a full reload for a stale bundle. */}
          <div className="error-boundary__actions">
            {/* Cheap first: re-render without losing the rest of the app's state. */}
            <button type="button" className="button button--secondary" onClick={this.retry}>
              Try again
            </button>
            {/* A full reload fetches a fresh bundle, which fixes a crash from a deploy mid-session. */}
            <button type="button" className="button button--primary" onClick={() => window.location.reload()}>
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
