// ============================================================
// What a registration form is allowed to accept.
//
// PURE, so the rules can be tested without a browser or a network, and so the
// same rules can run on a keystroke and again on submit without drifting.
//
// The messages are written to be READ BY THE PERSON TYPING. "Invalid input"
// tells someone their attempt failed and nothing about what would succeed;
// every message here names the rule it is enforcing.
// ============================================================

export type AuthField = 'email' | 'phone' | 'password' | 'confirmPassword';

export type FieldErrors = Partial<Record<AuthField, string>>;

/**
 * Deliberately permissive: one @, something before it, a dotted domain after.
 * A stricter regex rejects addresses that are legal and in use (plus-tags,
 * long TLDs, unusual local parts), and the confirmation email is the real
 * check anyway — an address that does not exist never becomes an account.
 */
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** Everything a person might type as punctuation in a phone number. */
const PHONE_PUNCTUATION = /[\s()\-.]/g;

/** E.164 allows at most 15 digits; 7 is the shortest plausible national number. */
const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 15;

/**
 * bcrypt — which is what Supabase Auth hashes with — silently ignores
 * anything past 72 bytes. A password longer than that would appear to be
 * accepted and then not be the password that was set, so it is refused here
 * rather than truncated in silence.
 */
export const PASSWORD_MAX = 72;
export const PASSWORD_MIN = 8;

export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Digits, with a leading + kept when the person typed one. Stored normalised
 * so that "+91 98765 43210", "(+91) 98765-43210" and "+919876543210" are one
 * number rather than three.
 */
export function normalisePhone(raw: string): string {
  const trimmed = raw.trim().replace(PHONE_PUNCTUATION, '');
  const plus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  return digits.length === 0 ? '' : `${plus ? '+' : ''}${digits}`;
}

export function validateEmail(raw: string): string | null {
  const email = normaliseEmail(raw);
  if (!email) return 'Enter your email address.';
  if (!EMAIL.test(email)) return `"${raw.trim()}" is not an email address — check for a missing @ or domain.`;
  return null;
}

export function validatePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return 'Enter your phone number.';
  if (/[^\d\s()+\-.]/.test(trimmed)) {
    return 'A phone number can contain digits, spaces, brackets, + and hyphens only.';
  }
  const digits = normalisePhone(raw).replace(/\D/g, '');
  if (digits.length < PHONE_MIN_DIGITS) return `That is only ${digits.length} digits — a phone number needs at least ${PHONE_MIN_DIGITS}.`;
  if (digits.length > PHONE_MAX_DIGITS) return `That is ${digits.length} digits — a phone number has at most ${PHONE_MAX_DIGITS}.`;
  return null;
}

export function validatePassword(raw: string): string | null {
  if (!raw) return 'Choose a password.';
  if (raw.length < PASSWORD_MIN) return `A password needs at least ${PASSWORD_MIN} characters — that is ${raw.length}.`;
  if (raw.length > PASSWORD_MAX) return `A password can be at most ${PASSWORD_MAX} characters — that is ${raw.length}.`;
  if (!/[A-Za-z]/.test(raw)) return 'A password needs at least one letter.';
  if (!/\d/.test(raw)) return 'A password needs at least one number.';
  return null;
}

export function validateConfirmation(password: string, confirm: string): string | null {
  if (!confirm) return 'Type the password again to confirm it.';
  if (password !== confirm) return 'The two passwords do not match.';
  return null;
}

export interface RegistrationInput {
  email: string;
  phone: string;
  password: string;
  confirmPassword: string;
  fullName?: string;
}

/** Every problem at once — a form that reveals one error per submit is a form people abandon. */
export function validateRegistration(input: RegistrationInput): FieldErrors {
  const errors: FieldErrors = {};
  const email = validateEmail(input.email);
  if (email) errors.email = email;
  const phone = validatePhone(input.phone);
  if (phone) errors.phone = phone;
  const password = validatePassword(input.password);
  if (password) errors.password = password;
  const confirm = validateConfirmation(input.password, input.confirmPassword);
  if (confirm) errors.confirmPassword = confirm;
  return errors;
}

export function validateLogin(input: { email: string; password: string }): FieldErrors {
  const errors: FieldErrors = {};
  const email = validateEmail(input.email);
  if (email) errors.email = email;
  // No strength rules on sign-in: the rules may have changed since the account
  // was made, and telling someone their EXISTING password is too short is both
  // useless and a hint to anyone guessing.
  if (!input.password) errors.password = 'Enter your password.';
  return errors;
}

/** A new password being set from a recovery link — same rules as registration. */
export function validateNewPassword(password: string, confirm: string): FieldErrors {
  const errors: FieldErrors = {};
  const p = validatePassword(password);
  if (p) errors.password = p;
  const c = validateConfirmation(password, confirm);
  if (c) errors.confirmPassword = c;
  return errors;
}

export function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0;
}
