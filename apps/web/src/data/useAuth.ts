/* Authentication hook for the applyy operator console.
 *
 * ZERO DATA SHARING & DYNAMIC PER-USER DATA ISOLATION.
 * All Supabase tables in this project (applications, master_profiles,
 * system_settings, email_events) enforce Postgres Row Level Security (RLS)
 * via `(select auth.uid()) = user_id`.
 * When signed in, the Supabase client automatically attaches the user's
 * session JWT to every request header. Postgres extracts `auth.uid()` from the
 * cryptographically verified JWT claim, ensuring that no user ever reads or
 * mutates another user's rows.
 *
 * WHY THIS HOOK WRAPS SUPABASE AUTH.
 * 1. Reactive session updates: listens to onAuthStateChange so session refreshes
 *    or token expiries immediately update React components without a page reload.
 * 2. Unconfigured resilience: if Supabase environment variables are missing
 *    (`supabase === null`), the hook safely transitions to loading=false and user=null
 *    rather than throwing an unhandled exception at render time.
 * 3. Consistent error handling: errors returned from auth methods are surfaced
 *    as human-readable strings to avoid leaking low-level network or JWT errors.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AuthError, Session, SupabaseClient, User } from '@supabase/supabase-js';

import { supabase } from './supabase.ts';

/* The default operator email configured for rapid console verification.
 * Stored as a constant so the login form and tests share the exact same address. */
export const DEFAULT_OPERATOR_EMAIL = 'tejamallam00@gmail.com';

/* State contract exposed by useAuth hook to callers across the console. */
export interface AuthState {
  /* Current authenticated user object containing id, email, and metadata. */
  readonly user: User | null;
  /* Active session containing the JWT access token passed to Postgres for RLS. */
  readonly session: Session | null;
  /* True while initial session retrieval from localStorage is pending. */
  readonly loading: boolean;
  /* Any recent authentication error message, or null if clear. */
  readonly error: string | null;
  /* Sign in with email and password. */
  readonly signIn: (email: string, password: string) => Promise<{ error: AuthError | null }>;
  /* Sign up a new operator account with email and password. */
  readonly signUp: (email: string, password: string) => Promise<{ error: AuthError | null }>;
  /* Terminate active session and purge local token storage. */
  readonly signOut: () => Promise<{ error: AuthError | null }>;
}

/* Pure helper: formats raw error objects into human-readable messages.
 * Tested independently to guarantee safe error display under node:test. */
export function formatAuthError(error: unknown): string {
  /* Return generic message if error is null or undefined */
  if (error === null || error === undefined) {
    return 'An unknown authentication error occurred.';
  }
  /* Extract message if error conforms to standard Error or AuthError interface */
  if (typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  /* Fallback stringification for unexpected primitives */
  return String(error);
}

/* Pure helper: verifies if a session is valid and unexpired based on current timestamp.
 * Used for deterministic state checks before sending authenticated requests. */
export function isSessionValid(session: Session | null, currentTimeSeconds: number = Math.floor(Date.now() / 1000)): boolean {
  /* Absence of session is trivially invalid */
  if (!session) return false;
  /* Absence of user or id is invalid */
  if (!session.user || !session.user.id) return false;
  /* Check expiry if expires_at is present on the session */
  if (typeof session.expires_at === 'number' && session.expires_at <= currentTimeSeconds) {
    return false;
  }
  /* Session possesses valid token and active expiration window */
  return true;
}

/* Subscribable auth client seam for pure testing without an active network. */
export type AuthClientSubset = Pick<SupabaseClient['auth'], 'getSession' | 'onAuthStateChange' | 'signInWithPassword' | 'signUp' | 'signOut'>;

/* Primary authentication hook for managing operator session state. */
export function useAuth(client: AuthClientSubset | null = supabase?.auth ?? null): AuthState {
  /* Holds the authenticated user object or null when logged out. */
  const [user, setUser] = useState<User | null>(null);
  /* Holds active session containing user credentials and JWT access token. */
  const [session, setSession] = useState<Session | null>(null);
  /* Tracks initial session hydration; prevents unauthenticated flashes. */
  const [loading, setLoading] = useState<boolean>(true);
  /* Surfaces actionable error message to the login UI. */
  const [error, setError] = useState<string | null>(null);

  /* Effect: hydrates session on mount and registers state change listener. */
  useEffect(() => {
    /* If no client is available (e.g., unconfigured environment), finish loading immediately. */
    if (!client) {
      /* Reset user to null */
      setUser(null);
      /* Reset session to null */
      setSession(null);
      /* Mark loading as complete */
      setLoading(false);
      /* Exit early without subscribing */
      return;
    }

    /* Mount flag prevents updating state if component unmounts mid-request. */
    let isMounted = true;

    /* Fetch current session stored in localStorage or memory. */
    void client.getSession().then(({ data, error: sessionError }) => {
      /* Abort if component unmounted while awaiting promise */
      if (!isMounted) return;
      /* If retrieval failed, record the error */
      if (sessionError) {
        /* Set formatted error string */
        setError(formatAuthError(sessionError));
        /* Reset session */
        setSession(null);
        /* Reset user */
        setUser(null);
      } else {
        /* Populate session state */
        setSession(data.session);
        /* Derive and populate user state */
        setUser(data.session?.user ?? null);
      }
      /* Loading resolves once initial session read finishes */
      setLoading(false);
    });

    /* Subscribe to subsequent auth events (sign in, token refresh, sign out). */
    const { data: listener } = client.onAuthStateChange((_event, currentSession) => {
      /* Abort if component unmounted */
      if (!isMounted) return;
      /* Synchronize current session */
      setSession(currentSession);
      /* Synchronize current user */
      setUser(currentSession?.user ?? null);
      /* Clear any previous authentication errors on successful state transition */
      setError(null);
      /* Ensure loading is marked false */
      setLoading(false);
    });

    /* Cleanup: unsubscribe listener and mark unmounted flag. */
    return () => {
      /* Invalidate mount guard */
      isMounted = false;
      /* Unsubscribe auth listener to prevent memory leaks */
      listener.subscription.unsubscribe();
    };
  }, [client]);

  /* Method: authenticate existing user via email and password credentials. */
  const signIn = useCallback(async (email: string, password: string) => {
    /* Guard against invocations when client is unconfigured */
    if (!client) {
      /* Construct error for missing backend configuration */
      const configError = { name: 'AuthError', message: 'Authentication is unavailable: Supabase client is unconfigured.' } as AuthError;
      /* Record error in state */
      setError(configError.message);
      /* Return error result */
      return { error: configError };
    }
    /* Clear previous error before initiating request */
    setError(null);
    /* Perform password authentication */
    const { data, error: signInError } = await client.signInWithPassword({ email, password });
    /* If an error occurred, record it in state */
    if (signInError) {
      /* Set error state */
      setError(formatAuthError(signInError));
      /* Return error */
      return { error: signInError };
    }
    /* Update session state directly */
    setSession(data.session);
    /* Update user state directly */
    setUser(data.user);
    /* Return success with null error */
    return { error: null };
  }, [client]);

  /* Method: register a new operator account via email and password credentials. */
  const signUp = useCallback(async (email: string, password: string) => {
    /* Guard against invocations when client is unconfigured */
    if (!client) {
      /* Construct error for missing backend configuration */
      const configError = { name: 'AuthError', message: 'Authentication is unavailable: Supabase client is unconfigured.' } as AuthError;
      /* Record error in state */
      setError(configError.message);
      /* Return error result */
      return { error: configError };
    }
    /* Clear previous error before initiating request */
    setError(null);
    /* Perform user creation request */
    const { data, error: signUpError } = await client.signUp({ email, password });
    /* If an error occurred, record it in state */
    if (signUpError) {
      /* Set error state */
      setError(formatAuthError(signUpError));
      /* Return error */
      return { error: signUpError };
    }
    /* Update session if returned immediately (e.g. auto-confirm enabled) */
    if (data.session) {
      /* Set session */
      setSession(data.session);
      /* Set user */
      setUser(data.user);
    }
    /* Return success with null error */
    return { error: null };
  }, [client]);

  /* Method: sign out and purge session credentials. */
  const signOut = useCallback(async () => {
    /* Guard against invocations when client is unconfigured */
    if (!client) {
      /* Reset local state anyway */
      setSession(null);
      /* Reset local user */
      setUser(null);
      /* Return success */
      return { error: null };
    }
    /* Clear previous error */
    setError(null);
    /* Call Supabase signOut */
    const { error: signOutError } = await client.signOut();
    /* If an error occurred, record it in state */
    if (signOutError) {
      /* Set error state */
      setError(formatAuthError(signOutError));
      /* Return error */
      return { error: signOutError };
    }
    /* Clear local session */
    setSession(null);
    /* Clear local user */
    setUser(null);
    /* Return success with null error */
    return { error: null };
  }, [client]);

  /* Return structured auth state and actions */
  return {
    user,
    session,
    loading,
    error,
    signIn,
    signUp,
    signOut,
  };
}
