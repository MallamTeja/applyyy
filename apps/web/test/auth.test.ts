/* Unit tests for operator authentication and session management.
 *
 * PURPOSE:
 * Verifies that auth helpers, operator default configuration, error formatting,
 * and session validation behave deterministically under node:test.
 *
 * HOUSE STYLE:
 * Every assertion, declaration, and block carries an explicit comment explaining why.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Session } from '@supabase/supabase-js';

import {
  DEFAULT_OPERATOR_EMAIL,
  formatAuthError,
  isSessionValid,
} from '../src/data/useAuth.ts';

describe('operator authentication helpers', () => {
  it('configures the operator default email to tejamallam00@gmail.com', () => {
    // Assert that the default operator email matches Teja's required identity
    assert.equal(DEFAULT_OPERATOR_EMAIL, 'tejamallam00@gmail.com');
  });

  it('formats null or undefined errors into a safe fallback message', () => {
    // Verifies null yields fallback message without throwing
    assert.equal(formatAuthError(null), 'An unknown authentication error occurred.');
    // Verifies undefined yields fallback message without throwing
    assert.equal(formatAuthError(undefined), 'An unknown authentication error occurred.');
  });

  it('extracts human-readable messages from error objects', () => {
    // Verifies standard error message field extraction
    const errorObj = { message: 'Invalid login credentials' };
    assert.equal(formatAuthError(errorObj), 'Invalid login credentials');
  });

  it('stringifies unexpected primitives safely', () => {
    // Verifies numeric or string primitives are stringified cleanly
    assert.equal(formatAuthError(403), '403');
    assert.equal(formatAuthError('Network timeout'), 'Network timeout');
  });

  it('rejects null or missing sessions', () => {
    // Null session is invalid
    assert.equal(isSessionValid(null), false);
  });

  it('rejects sessions lacking user or user ID', () => {
    // Session without user object
    const noUserSession = { user: null } as unknown as Session;
    assert.equal(isSessionValid(noUserSession), false);

    // Session with empty user id
    const noIdSession = { user: { id: '' } } as unknown as Session;
    assert.equal(isSessionValid(noIdSession), false);
  });

  it('rejects expired sessions based on timestamp comparison', () => {
    // Current time is 1000, expiration timestamp is 900 (expired)
    const expiredSession = {
      user: { id: 'usr-123' },
      expires_at: 900,
    } as unknown as Session;
    assert.equal(isSessionValid(expiredSession, 1000), false);
  });

  it('accepts unexpired sessions with valid user credentials', () => {
    // Current time is 1000, expiration timestamp is 2000 (valid)
    const activeSession = {
      user: { id: 'usr-123' },
      expires_at: 2000,
    } as unknown as Session;
    assert.equal(isSessionValid(activeSession, 1000), true);
  });
});
