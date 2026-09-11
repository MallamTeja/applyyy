/* Operator authentication screen for the applyy console.
 *
 * WHY THIS PAGE EXISTS.
 * The console is a high-trust verification desk operating on personal job application
 * pipelines and sensitive master profile resumes. All database tables enforce
 * Postgres RLS scoped by `(select auth.uid()) = user_id`.
 * This screen authenticates the operator, establishes an active session JWT,
 * and passes user identity to Postgres so dynamic per-user data isolation is
 * enforced on all subsequent table operations.
 *
 * DESIGN DISCIPLINE.
 * Rendered using the Obsidian/Midnight design tokens:
 * - Surfaces: `--ground` desk with elevated `--sheet` card and `--panel` controls
 * - Ink: `--ink` high contrast text and `--ink-muted` secondary labels
 * - Accent: `--accent` interactive slate-blue focus rings and primary action button
 * - Security: quick-fill operator button pre-populating `tejamallam00@gmail.com`
 */

import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

import { DEFAULT_OPERATOR_EMAIL } from '../../data/useAuth';
import type { AuthState } from '../../data/useAuth';

import './LoginPage.css';

/* Properties passed to the LoginPage component from the gatekeeper shell. */
export interface LoginPageProps {
  /* Structured auth state actions provided by useAuth. */
  readonly auth: AuthState;
}

/* Authentication mode: Sign In for existing operators, Sign Up for fresh provisioning. */
export type AuthMode = 'sign_in' | 'sign_up';

export function LoginPage({ auth }: LoginPageProps): ReactElement {
  /* State for the email input field, initialized with the default operator email. */
  const [email, setEmail] = useState<string>(DEFAULT_OPERATOR_EMAIL);
  /* State for the secret password input field. */
  const [password, setPassword] = useState<string>('');
  /* Tracks submission in flight to disable buttons and prevent duplicate clicks. */
  const [submitting, setSubmitting] = useState<boolean>(false);
  /* Local error message, combining hook errors and form validation. */
  const [localError, setLocalError] = useState<string | null>(null);
  /* Toggle between sign in and sign up. Default to sign in. */
  const [mode, setMode] = useState<AuthMode>('sign_in');
  /* Feedback banner for sign up confirmation or instructions. */
  const [notice, setNotice] = useState<string | null>(null);

  /* Quick-fill helper to immediately restore the operator email if modified. */
  const handleQuickFill = () => {
    /* Set operator email */
    setEmail(DEFAULT_OPERATOR_EMAIL);
    /* Clear local errors */
    setLocalError(null);
  };

  /* Form submission handler executing sign in or sign up against Supabase Auth. */
  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    /* Prevent default browser form postback */
    event.preventDefault();
    /* Reset previous notices */
    setNotice(null);
    /* Reset previous errors */
    setLocalError(null);

    /* Validate non-empty email */
    const cleanEmail = email.trim();
    if (!cleanEmail) {
      setLocalError('Please enter a valid operator email address.');
      return;
    }

    /* Validate password length requirement */
    if (!password || password.length < 6) {
      setLocalError('Password must contain at least 6 characters.');
      return;
    }

    /* Lock form while network call is in flight */
    setSubmitting(true);

    try {
      if (mode === 'sign_in') {
        /* Attempt password authentication */
        const result = await auth.signIn(cleanEmail, password);
        if (result.error) {
          /* Surface Supabase auth error message */
          setLocalError(result.error.message);
        }
      } else {
        /* Attempt user registration */
        const result = await auth.signUp(cleanEmail, password);
        if (result.error) {
          /* Surface Supabase sign up error */
          setLocalError(result.error.message);
        } else {
          /* Inform user of successful registration */
          setNotice('Account created. If email verification is enabled, please verify your email or sign in.');
          /* Switch mode to sign in */
          setMode('sign_in');
        }
      }
    } finally {
      /* Re-enable form interactions */
      setSubmitting(false);
    }
  };

  /* Active error to display: either local form error or recent hook error. */
  const displayError = localError || auth.error;

  return (
    <div className="login-canvas">
      <div className="login-card" role="region" aria-label="Operator Authentication">
        {/* Brand identity header */}
        <div className="login-card__brand">
          <span className="login-card__name">applyy</span>
          <span className="login-card__tagline">operator authentication</span>
        </div>

        {/* Console mission and dynamic isolation explainer */}
        <p className="login-card__desc">
          Verification desk console. Access is strictly gated by Postgres Row Level Security (RLS)
          scoped to your authenticated user identity.
        </p>

        {/* Quick-fill shortcut for known operator account */}
        <div className="login-card__quickfill-row">
          <span className="login-card__quickfill-label">Operator:</span>
          <button
            type="button"
            className="login-card__quickfill-btn"
            onClick={handleQuickFill}
            title="Populate operator email"
          >
            {DEFAULT_OPERATOR_EMAIL}
          </button>
        </div>

        {/* Error notification banner */}
        {displayError ? (
          <div className="login-card__alert login-card__alert--error" role="alert">
            <span className="login-card__alert-icon" aria-hidden="true">!</span>
            <span className="login-card__alert-text">{displayError}</span>
          </div>
        ) : null}

        {/* Informational notice banner (e.g. registration success) */}
        {notice ? (
          <div className="login-card__alert login-card__alert--notice" role="status">
            <span className="login-card__alert-icon" aria-hidden="true">✓</span>
            <span className="login-card__alert-text">{notice}</span>
          </div>
        ) : null}

        {/* Authentication credentials form */}
        <form className="login-form" onSubmit={handleSubmit}>
          {/* Email input field */}
          <div className="login-form__group">
            <label className="login-form__label" htmlFor="operator-email">
              Operator Email
            </label>
            <input
              id="operator-email"
              type="email"
              name="email"
              autoComplete="email"
              required
              className="login-form__input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="operator@example.com"
              disabled={submitting}
            />
          </div>

          {/* Password input field */}
          <div className="login-form__group">
            <label className="login-form__label" htmlFor="operator-password">
              Password
            </label>
            <input
              id="operator-password"
              type="password"
              name="password"
              autoComplete={mode === 'sign_in' ? 'current-password' : 'new-password'}
              required
              className="login-form__input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              disabled={submitting}
            />
          </div>

          {/* Primary submission action */}
          <button
            type="submit"
            className="login-form__submit-btn"
            disabled={submitting}
          >
            {submitting
              ? 'Authenticating...'
              : mode === 'sign_in'
                ? 'Sign In to Console'
                : 'Create Operator Account'}
          </button>
        </form>

        {/* Mode switcher: toggle between Sign In and Sign Up */}
        <div className="login-card__footer">
          {mode === 'sign_in' ? (
            <p className="login-card__toggle-text">
              First-time operator setup?{' '}
              <button
                type="button"
                className="login-card__toggle-btn"
                onClick={() => {
                  setMode('sign_up');
                  setLocalError(null);
                  setNotice(null);
                }}
              >
                Create Account
              </button>
            </p>
          ) : (
            <p className="login-card__toggle-text">
              Already have an operator account?{' '}
              <button
                type="button"
                className="login-card__toggle-btn"
                onClick={() => {
                  setMode('sign_in');
                  setLocalError(null);
                  setNotice(null);
                }}
              >
                Sign In
              </button>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
