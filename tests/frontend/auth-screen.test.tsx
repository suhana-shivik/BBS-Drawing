// The first screen — sign in, register, forgot, reset — and the gate in front
// of the app. Driven against a test double, so none of this needs a live
// Supabase project.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import App from '../../src/App';
import { AuthProvider } from '../../src/auth/AuthProvider';
import { AuthScreen } from '../../src/components/AuthScreen';
import { fakeAuthAdapter, signedInAdapter, TEST_USER, type FakeAuthAdapter } from '../helpers/auth';
import { resetStudioProjectsForTest } from '../../src/studio/projects';

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  resetStudioProjectsForTest();
});

function renderAuth(adapter: FakeAuthAdapter) {
  render(
    <AuthProvider adapter={adapter}>
      <AuthScreen />
    </AuthProvider>,
  );
  return adapter;
}

const type = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });

const submit = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('auth-submit'));
  });
};

describe('the gate', () => {
  it('shows the sign-in screen, and no project data, when nobody is signed in', async () => {
    render(<App authAdapter={fakeAuthAdapter()} />);
    await waitFor(() => expect(screen.getByTestId('auth-screen')).toBeTruthy());
    expect(screen.queryByTestId('projects-home')).toBeNull();
    expect(screen.queryByTestId('workbench')).toBeNull();
  });

  it('opens the app once a session exists', async () => {
    render(<App authAdapter={signedInAdapter()} />);
    await waitFor(() => expect(screen.getByTestId('projects-home')).toBeTruthy());
    expect(screen.queryByTestId('auth-screen')).toBeNull();
  });

  it('a recovery link does NOT open the app — it must set a password first', async () => {
    const adapter = fakeAuthAdapter({ status: 'recovery', user: TEST_USER });
    render(<App authAdapter={adapter} />);
    await waitFor(() => expect(screen.getByTestId('auth-view-reset')).toBeTruthy());
    expect(screen.queryByTestId('projects-home')).toBeNull();
  });

  it('losing the session returns to sign-in and takes the app off screen', async () => {
    const adapter = signedInAdapter();
    render(<App authAdapter={adapter} />);
    await waitFor(() => expect(screen.getByTestId('projects-home')).toBeTruthy());
    await act(async () => {
      adapter.emit({ status: 'signed-out', user: null });
    });
    await waitFor(() => expect(screen.getByTestId('auth-screen')).toBeTruthy());
    expect(screen.queryByTestId('projects-home')).toBeNull();
  });
});

describe('signing in', () => {
  it('will not call the provider with an empty form, and says what is missing', async () => {
    const adapter = renderAuth(fakeAuthAdapter());
    await submit();
    expect(adapter.calls.signIn).toHaveLength(0);
    expect(screen.getByText(/Enter your email address/)).toBeTruthy();
    expect(screen.getByText(/Enter your password/)).toBeTruthy();
  });

  it('passes the credentials through once they are well formed', async () => {
    const adapter = renderAuth(fakeAuthAdapter());
    type('auth-email', ' Site@Contractor.IN ');
    type('auth-password', 'concrete1');
    await submit();
    // An <input type="email"> applies the HTML value sanitisation algorithm and
    // strips the surrounding whitespace before React ever sees it; the adapter
    // lower-cases what is left.
    expect(adapter.calls.signIn).toEqual([{ email: 'Site@Contractor.IN', password: 'concrete1' }]);
  });

  it('shows the provider’s refusal instead of swallowing it', async () => {
    const adapter = fakeAuthAdapter();
    adapter.results.signIn = { ok: false, message: 'That email and password do not match an account.' };
    renderAuth(adapter);
    type('auth-email', 'site@contractor.in');
    type('auth-password', 'wrong-one1');
    await submit();
    expect(screen.getByTestId('auth-error').textContent).toMatch(/do not match an account/);
  });
});

describe('registering', () => {
  it('asks for email, phone and a confirmed password', async () => {
    const adapter = renderAuth(fakeAuthAdapter());
    fireEvent.click(screen.getByTestId('auth-goto-register'));
    expect(screen.getByTestId('auth-phone')).toBeTruthy();
    expect(screen.getByTestId('auth-confirm')).toBeTruthy();
    await submit();
    expect(adapter.calls.register).toHaveLength(0);
    expect(screen.getByText(/Enter your phone number/)).toBeTruthy();
  });

  it('refuses a mismatched confirmation before any request is made', async () => {
    const adapter = renderAuth(fakeAuthAdapter());
    fireEvent.click(screen.getByTestId('auth-goto-register'));
    type('auth-email', 'site@contractor.in');
    type('auth-phone', '+91 98765 43210');
    type('auth-password', 'concrete1');
    type('auth-confirm', 'concrete2');
    await submit();
    expect(adapter.calls.register).toHaveLength(0);
    expect(screen.getByText(/do not match/)).toBeTruthy();
  });

  it('sends the account and then says to check the inbox — not a silent success', async () => {
    const adapter = fakeAuthAdapter();
    adapter.results.register = { ok: true, needsEmailConfirmation: true };
    renderAuth(adapter);
    fireEvent.click(screen.getByTestId('auth-goto-register'));
    type('auth-email', 'site@contractor.in');
    type('auth-phone', '+91 98765 43210');
    type('auth-password', 'concrete1');
    type('auth-confirm', 'concrete1');
    await submit();

    expect(adapter.calls.register).toEqual([
      { email: 'site@contractor.in', phone: '+91 98765 43210', password: 'concrete1', fullName: '' },
    ]);
    expect(screen.getByTestId('auth-notice').textContent).toMatch(/confirmation link to site@contractor.in/);
    // and it lands back on sign-in, because there is no session yet
    expect(screen.getByTestId('auth-view-signin')).toBeTruthy();
  });

  it('puts a duplicate-account refusal against the email field', async () => {
    const adapter = fakeAuthAdapter();
    adapter.results.register = { ok: false, field: 'email', message: 'An account already exists for that email.' };
    renderAuth(adapter);
    fireEvent.click(screen.getByTestId('auth-goto-register'));
    type('auth-email', 'taken@contractor.in');
    type('auth-phone', '9876543210');
    type('auth-password', 'concrete1');
    type('auth-confirm', 'concrete1');
    await submit();
    expect(screen.getByText(/already exists for that email/)).toBeTruthy();
  });
});

describe('forgot password', () => {
  it('sends the reset and answers without revealing whether the account exists', async () => {
    const adapter = renderAuth(fakeAuthAdapter());
    fireEvent.click(screen.getByTestId('auth-goto-forgot'));
    type('auth-email', 'site@contractor.in');
    await submit();
    expect(adapter.calls.reset).toHaveLength(1);
    expect(adapter.calls.reset[0].email).toBe('site@contractor.in');
    // the redirect must come back to this app
    expect(adapter.calls.reset[0].redirectTo).toBe(window.location.origin);
    expect(screen.getByTestId('auth-notice').textContent).toMatch(/If an account exists/);
  });

  it('checks the address before spending a request', async () => {
    const adapter = renderAuth(fakeAuthAdapter());
    fireEvent.click(screen.getByTestId('auth-goto-forgot'));
    type('auth-email', 'not-an-address');
    await submit();
    expect(adapter.calls.reset).toHaveLength(0);
  });
});

describe('setting a new password from the link', () => {
  it('applies the rules and then changes the password', async () => {
    const adapter = fakeAuthAdapter({ status: 'recovery', user: TEST_USER });
    renderAuth(adapter);
    // the session resolves a tick after mount, then the view switches
    await waitFor(() => expect(screen.getByTestId('auth-view-reset')).toBeTruthy());
    // no email field here — the link already established who this is
    expect(screen.queryByTestId('auth-email')).toBeNull();

    type('auth-password', 'weak');
    type('auth-confirm', 'weak');
    await submit();
    expect(adapter.calls.updatePassword).toHaveLength(0);

    type('auth-password', 'newconcrete1');
    type('auth-confirm', 'newconcrete1');
    await submit();
    expect(adapter.calls.updatePassword).toEqual(['newconcrete1']);
  });

  it('reports an expired link rather than appearing to succeed', async () => {
    const adapter = fakeAuthAdapter({ status: 'recovery', user: TEST_USER });
    adapter.results.updatePassword = { ok: false, message: 'That link has expired or has already been used.' };
    renderAuth(adapter);
    await waitFor(() => expect(screen.getByTestId('auth-view-reset')).toBeTruthy());
    type('auth-password', 'newconcrete1');
    type('auth-confirm', 'newconcrete1');
    await submit();
    expect(screen.getByTestId('auth-error').textContent).toMatch(/expired/);
  });
});

describe('the account menu', () => {
  it('names the signed-in account and signs out', async () => {
    const adapter = signedInAdapter();
    render(<App authAdapter={adapter} />);
    await waitFor(() => expect(screen.getByTestId('projects-home')).toBeTruthy());

    fireEvent.click(screen.getByTestId('account-menu'));
    await waitFor(() => expect(screen.getByText('Sign out')).toBeTruthy());
    expect(screen.getAllByText(TEST_USER.email!).length).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.click(screen.getByText('Sign out'));
    });
    expect(adapter.calls.signOut).toBe(1);
    await waitFor(() => expect(screen.getByTestId('auth-screen')).toBeTruthy());
  });

  it('signing out clears the account-scoped local caches but keeps device chrome', async () => {
    localStorage.setItem('studio.boot.v1', JSON.stringify({ lastProjectId: 'p1', lastFolderPath: [] }));
    localStorage.setItem('bimcad.ai.transcript', '{"GA-01.dxf":[]}');
    localStorage.setItem('facts-ledger:p1', '{"version":1,"entries":[]}');
    localStorage.setItem('studio.ui.v1', '{"theme":"dark"}');
    localStorage.setItem('bimcad.openrouter.key', 'sk-or-mine');

    const adapter = signedInAdapter();
    render(<App authAdapter={adapter} />);
    await waitFor(() => expect(screen.getByTestId('projects-home')).toBeTruthy());
    fireEvent.click(screen.getByTestId('account-menu'));
    await waitFor(() => screen.getByText('Sign out'));
    await act(async () => {
      fireEvent.click(screen.getByText('Sign out'));
    });

    expect(localStorage.getItem('studio.boot.v1')).toBeNull();
    expect(localStorage.getItem('bimcad.ai.transcript')).toBeNull();
    expect(localStorage.getItem('facts-ledger:p1')).toBeNull();
    // the device's own settings are not the account's data
    expect(localStorage.getItem('studio.ui.v1')).toBe('{"theme":"dark"}');
    expect(localStorage.getItem('bimcad.openrouter.key')).toBe('sk-or-mine');
  });
});
