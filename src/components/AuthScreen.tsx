// ============================================================
// The first screen: sign in, register, forgot password, set a new password.
//
// It is deliberately the SAME visual language as the Projects home — the
// `studio` class brings the shell's buttons, the panel/border/accent tokens
// come from theme.css, and the field styling mirrors the new-project form.
// Nothing about the product's look is redesigned here; this is one more
// surface in it.
//
// FOUR VIEWS, ONE COMPONENT, because they share a form shell, an error line
// and a busy state, and splitting them into four files would mean four copies
// of all three. Which view is showing is local state, except `reset`, which is
// forced by the session being a recovery session — a person who followed a
// reset link must not be able to click past setting a new password.
// ============================================================
import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import {
  hasErrors,
  validateLogin,
  validateNewPassword,
  validateRegistration,
  validateEmail,
  type FieldErrors,
} from '../auth/validate';
import { Icon } from './icons';
import './AuthScreen.css';

type View = 'signin' | 'register' | 'forgot' | 'reset';

/** A labelled input that shows its own error underneath it. */
function Field({
  label,
  type,
  value,
  onChange,
  error,
  autoComplete,
  placeholder,
  testId,
  disabled,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  autoComplete?: string;
  placeholder?: string;
  testId: string;
  disabled?: boolean;
}) {
  return (
    <label className={`auth-field${error ? ' invalid' : ''}`}>
      <span className="auth-label">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        data-testid={testId}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
      />
      {error && (
        <span className="auth-field-error" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

export function AuthScreen() {
  const auth = useAuth();
  const [view, setView] = useState<View>('signin');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A recovery session outranks whatever the person was looking at.
  const recovery = auth.status === 'recovery';
  useEffect(() => {
    if (recovery) setView('reset');
  }, [recovery]);

  const go = (next: View) => {
    setView(next);
    setErrors({});
    setFormError(null);
    setNotice(null);
    setPassword('');
    setConfirmPassword('');
  };

  const title = useMemo(() => {
    switch (view) {
      case 'register':
        return 'Create your account';
      case 'forgot':
        return 'Reset your password';
      case 'reset':
        return 'Choose a new password';
      default:
        return 'Sign in';
    }
  }, [view]);

  const subtitle = useMemo(() => {
    switch (view) {
      case 'register':
        return 'One account holds your projects, drawings and schedules.';
      case 'forgot':
        return 'We will email you a link to set a new password.';
      case 'reset':
        return 'This link signed you in once. Set a password to keep the account.';
      default:
        return 'Your projects, drawings and bar bending schedules.';
    }
  }, [view]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setFormError(null);
    setNotice(null);

    if (view === 'signin') {
      const found = validateLogin({ email, password });
      setErrors(found);
      if (hasErrors(found)) return;
      setBusy(true);
      const result = await auth.signIn(email, password);
      setBusy(false);
      if (!result.ok) setFormError(result.message);
      return;
    }

    if (view === 'register') {
      const found = validateRegistration({ email, phone, password, confirmPassword, fullName });
      setErrors(found);
      if (hasErrors(found)) return;
      setBusy(true);
      const result = await auth.register({ email, phone, password, fullName });
      setBusy(false);
      if (!result.ok) {
        if (result.field) setErrors({ [result.field]: result.message });
        else setFormError(result.message);
        return;
      }
      if (result.needsEmailConfirmation) {
        // Not an error and not a success worth hiding: there is no session
        // yet, and saying nothing would look like the button did nothing.
        setNotice(
          `Account created. We sent a confirmation link to ${email.trim()} — open it, then sign in.`,
        );
        setView('signin');
        setPassword('');
        setConfirmPassword('');
      }
      return;
    }

    if (view === 'forgot') {
      const bad = validateEmail(email);
      setErrors(bad ? { email: bad } : {});
      if (bad) return;
      setBusy(true);
      const result = await auth.requestPasswordReset(email);
      setBusy(false);
      if (!result.ok) {
        setFormError(result.message);
        return;
      }
      // Worded so it is true whether or not the address has an account — the
      // form must not become a way to discover who is registered.
      setNotice(`If an account exists for ${email.trim()}, a reset link is on its way. The link expires in an hour.`);
      return;
    }

    // view === 'reset'
    const found = validateNewPassword(password, confirmPassword);
    setErrors(found);
    if (hasErrors(found)) return;
    setBusy(true);
    const result = await auth.updatePassword(password);
    setBusy(false);
    if (!result.ok) {
      if (result.field) setErrors({ [result.field]: result.message });
      else setFormError(result.message);
      return;
    }
    setNotice('Password changed. Opening your projects…');
  }

  const submitLabel = () => {
    if (busy) {
      return view === 'register' ? 'Creating…' : view === 'forgot' ? 'Sending…' : view === 'reset' ? 'Saving…' : 'Signing in…';
    }
    return view === 'register'
      ? 'Create account'
      : view === 'forgot'
        ? 'Send reset link'
        : view === 'reset'
          ? 'Set password'
          : 'Sign in';
  };

  return (
    <div className="studio auth-screen" data-testid="auth-screen">
      <div className="auth-bar">
        <span className="auth-logo">
          <Icon name="layers" size={16} />
        </span>
        <span className="auth-brand">BIMCAD Studio</span>
      </div>

      <div className="auth-body">
        <form className="auth-card" onSubmit={submit} noValidate data-testid={`auth-view-${view}`}>
          <h1>{title}</h1>
          <p className="auth-sub">{subtitle}</p>

          {notice && (
            <p className="auth-notice" role="status" data-testid="auth-notice">
              {notice}
            </p>
          )}
          {formError && (
            <p className="auth-error" role="alert" data-testid="auth-error">
              {formError}
            </p>
          )}

          {view !== 'reset' && (
            <Field
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              error={errors.email}
              autoComplete="email"
              placeholder="you@company.com"
              testId="auth-email"
              disabled={busy}
            />
          )}

          {view === 'register' && (
            <>
              <Field
                label="Phone"
                type="tel"
                value={phone}
                onChange={setPhone}
                error={errors.phone}
                autoComplete="tel"
                placeholder="+91 98765 43210"
                testId="auth-phone"
                disabled={busy}
              />
              <Field
                label="Full name (optional)"
                type="text"
                value={fullName}
                onChange={setFullName}
                autoComplete="name"
                testId="auth-fullname"
                disabled={busy}
              />
            </>
          )}

          {view !== 'forgot' && (
            <Field
              label={view === 'signin' ? 'Password' : 'New password'}
              type="password"
              value={password}
              onChange={setPassword}
              error={errors.password}
              autoComplete={view === 'signin' ? 'current-password' : 'new-password'}
              testId="auth-password"
              disabled={busy}
            />
          )}

          {(view === 'register' || view === 'reset') && (
            <Field
              label="Confirm password"
              type="password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              error={errors.confirmPassword}
              autoComplete="new-password"
              testId="auth-confirm"
              disabled={busy}
            />
          )}

          <button type="submit" className="btn primary auth-submit" disabled={busy} data-testid="auth-submit">
            {submitLabel()}
          </button>

          {view === 'signin' && (
            <div className="auth-links">
              <button type="button" className="auth-link" onClick={() => go('forgot')} data-testid="auth-goto-forgot">
                Forgot password?
              </button>
              <span className="auth-links-sep" />
              <span className="auth-alt">
                No account?{' '}
                <button type="button" className="auth-link" onClick={() => go('register')} data-testid="auth-goto-register">
                  Create one
                </button>
              </span>
            </div>
          )}

          {view === 'register' && (
            <div className="auth-links">
              <span className="auth-alt">
                Already registered?{' '}
                <button type="button" className="auth-link" onClick={() => go('signin')} data-testid="auth-goto-signin">
                  Sign in
                </button>
              </span>
            </div>
          )}

          {view === 'forgot' && (
            <div className="auth-links">
              <button type="button" className="auth-link" onClick={() => go('signin')} data-testid="auth-back-signin">
                Back to sign in
              </button>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
