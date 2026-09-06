// Registration and sign-in rules. Pure functions, so these are the cheapest
// tests in the suite and the ones that stop a form accepting something the
// provider will reject a round-trip later.
import { describe, expect, it } from 'vitest';
import {
  hasErrors,
  normaliseEmail,
  normalisePhone,
  validateConfirmation,
  validateEmail,
  validateLogin,
  validateNewPassword,
  validatePassword,
  validatePhone,
  validateRegistration,
  PASSWORD_MAX,
} from '../../src/auth/validate';

describe('email', () => {
  it('accepts ordinary and plus-tagged addresses, and trims and lower-cases them', () => {
    expect(validateEmail('  Someone@Example.COM ')).toBeNull();
    expect(validateEmail('a.b+bbs@sub.domain.co.in')).toBeNull();
    expect(normaliseEmail('  Someone@Example.COM ')).toBe('someone@example.com');
  });

  it('names what is wrong rather than saying "invalid"', () => {
    expect(validateEmail('')).toMatch(/Enter your email/);
    expect(validateEmail('someone')).toMatch(/missing @ or domain/);
    expect(validateEmail('someone@localhost')).toMatch(/missing @ or domain/);
    expect(validateEmail('a b@c.com')).toBeTruthy();
  });
});

describe('phone', () => {
  it('takes the punctuation people actually type and normalises it', () => {
    expect(validatePhone('+91 98765 43210')).toBeNull();
    expect(validatePhone('(+91) 98765-43210')).toBeNull();
    expect(validatePhone('9876543210')).toBeNull();
    expect(normalisePhone('(+91) 98765-43210')).toBe('+919876543210');
    expect(normalisePhone('+91 98765 43210')).toBe('+919876543210');
    expect(normalisePhone('9876543210')).toBe('9876543210');
  });

  it('refuses letters, and says how many digits it did find', () => {
    expect(validatePhone('')).toMatch(/Enter your phone/);
    expect(validatePhone('call me')).toMatch(/digits, spaces, brackets/);
    expect(validatePhone('12345')).toMatch(/only 5 digits/);
    expect(validatePhone('1234567890123456')).toMatch(/at most 15/);
  });
});

describe('password', () => {
  it('requires length, a letter and a number', () => {
    expect(validatePassword('concrete1')).toBeNull();
    expect(validatePassword('')).toMatch(/Choose a password/);
    expect(validatePassword('short1')).toMatch(/at least 8 characters — that is 6/);
    expect(validatePassword('allletters')).toMatch(/at least one number/);
    expect(validatePassword('12345678')).toMatch(/at least one letter/);
  });

  it('refuses past the bcrypt limit rather than letting it be silently truncated', () => {
    const long = `a1${'x'.repeat(PASSWORD_MAX)}`;
    expect(validatePassword(long)).toMatch(/at most 72 characters/);
  });

  it('confirmation must match', () => {
    expect(validateConfirmation('concrete1', 'concrete1')).toBeNull();
    expect(validateConfirmation('concrete1', '')).toMatch(/Type the password again/);
    expect(validateConfirmation('concrete1', 'concrete2')).toMatch(/do not match/);
  });
});

describe('whole forms', () => {
  it('registration reports every problem at once', () => {
    const errors = validateRegistration({
      email: 'nope',
      phone: '12',
      password: 'short',
      confirmPassword: 'different',
    });
    expect(Object.keys(errors).sort()).toEqual(['confirmPassword', 'email', 'password', 'phone']);
    expect(hasErrors(errors)).toBe(true);
  });

  it('a good registration has nothing to say', () => {
    const errors = validateRegistration({
      email: 'site@contractor.in',
      phone: '+91 98765 43210',
      password: 'concrete1',
      confirmPassword: 'concrete1',
    });
    expect(errors).toEqual({});
    expect(hasErrors(errors)).toBe(false);
  });

  it('sign-in does NOT apply strength rules to an existing password', () => {
    // The rules may have tightened since the account was made, and telling
    // someone their real password is "too short" is both useless and a hint.
    expect(validateLogin({ email: 'site@contractor.in', password: 'old' })).toEqual({});
    expect(validateLogin({ email: 'site@contractor.in', password: '' }).password).toMatch(/Enter your password/);
  });

  it('a new password from a recovery link is held to the registration rules', () => {
    expect(validateNewPassword('concrete1', 'concrete1')).toEqual({});
    expect(validateNewPassword('weak', 'weak').password).toBeTruthy();
  });
});
