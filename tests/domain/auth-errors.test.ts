// What a person is told when the provider says no.
//
// These messages are the entire failure surface of signing in. A provider
// error is written for a developer reading a log; shown unedited to someone
// trying to get into their account it is at best useless and at worst sends
// them to retry the one thing that cannot work.
import { describe, expect, it } from 'vitest';
import type { AuthError } from '@supabase/supabase-js';
import { describeAuthError } from '../../src/auth/supabaseAdapter';

const err = (over: Partial<AuthError> & { code?: string }): AuthError =>
  ({ name: 'AuthApiError', message: '', status: 400, ...over }) as AuthError;

describe('sign-in failures', () => {
  it('does not blame the email when the pair is simply wrong', () => {
    const message = describeAuthError(err({ code: 'invalid_credentials' }), 'fallback');
    expect(message).toMatch(/do not match an account/);
    expect(message).toMatch(/Forgot password/);
  });

  it('says what to do about an unconfirmed account', () => {
    expect(describeAuthError(err({ code: 'email_not_confirmed' }), 'fallback')).toMatch(
      /Open the link in the confirmation email/,
    );
  });
});

describe('the two rate limits are different problems', () => {
  // This is the one that bit for real: with email confirmation on, every
  // sign-up sends a message, the built-in mailer allows only a few an hour,
  // and the old wording told people to "wait a minute and try again" — which
  // fails again, for an hour.
  it('an email-send limit explains the email, and offers signing in instead', () => {
    const message = describeAuthError(err({ code: 'over_email_send_rate_limit' }), 'fallback');
    expect(message).toMatch(/confirmation email could not be sent/);
    expect(message).toMatch(/hourly email limit/);
    expect(message).toMatch(/sign in instead/);
    expect(message).not.toMatch(/Wait a minute/);
  });

  it('an ordinary request limit still says to wait a moment', () => {
    const message = describeAuthError(err({ code: 'over_request_rate_limit' }), 'fallback');
    expect(message).toMatch(/Wait a minute and try again/);
    expect(message).not.toMatch(/email/i);
  });
});

describe('registration failures', () => {
  it('points a duplicate at signing in rather than at trying again', () => {
    expect(describeAuthError(err({ code: 'user_already_exists' }), 'fallback')).toMatch(
      /already exists for that email\. Sign in instead/,
    );
  });

  it('names the rule when a password is refused', () => {
    expect(describeAuthError(err({ code: 'weak_password' }), 'fallback')).toMatch(/8 characters with a letter and a number/);
  });

  it('says where to look when sign-ups are switched off for the project', () => {
    expect(describeAuthError(err({ code: 'signup_disabled' }), 'fallback')).toMatch(
      /Authentication → Providers/,
    );
  });
});

describe('links and infrastructure', () => {
  it('treats an expired recovery link as expired, not as a mystery', () => {
    expect(describeAuthError(err({ message: 'Auth session missing!' }), 'fallback')).toMatch(
      /expired or has already been used/,
    );
  });

  it('names the setting when the project cannot be reached at all', () => {
    expect(describeAuthError(err({ message: 'Failed to fetch' }), 'fallback')).toMatch(/SUPABASE_URL/);
  });

  it('falls back to the provider’s own words rather than inventing a reason', () => {
    expect(describeAuthError(err({ message: 'Database error saving new user' }), 'fallback')).toBe(
      'Database error saving new user',
    );
  });

  it('uses the caller’s fallback when there is no error at all', () => {
    expect(describeAuthError(null, 'The account could not be created.')).toBe('The account could not be created.');
  });
});
