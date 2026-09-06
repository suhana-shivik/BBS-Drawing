// The signed-in account, and the way out of it.
//
// One component, used in both places a person can be standing: the Projects
// home bar and the studio title bar. Whoever is signed in is NAMED — an app
// holding one client's drawings should never leave you guessing which account
// you are looking at, particularly on a shared machine.

import React from 'react';
import { useOptionalAuth } from '../auth/AuthProvider';
import { Icon } from './icons';
import { Menu, useMenuAnchor, type MenuEntry } from './Menu';
import { toast } from './Toasts';
import './AccountMenu.css';

/** "abhishek@shivik.in" → "AB" — a stable two-letter badge, never an avatar we do not have. */
function initialsOf(email: string | null, fullName: string | null): string {
  const name = fullName?.trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    const letters = parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : parts[0].slice(0, 2);
    return letters.toUpperCase();
  }
  const local = (email ?? '').split('@')[0];
  return (local.slice(0, 2) || '?').toUpperCase();
}

export function AccountMenu({ compact = false }: { compact?: boolean }) {
  // Chrome, not a gate: rendered outside a session (the shell's own tests
  // mount the title bar on its own) there is simply no account to show.
  const auth = useOptionalAuth();
  const menu = useMenuAnchor();
  if (!auth?.user) return null;

  const { email, phone, fullName } = auth.user;

  const items: MenuEntry[] = [
    { kind: 'title', label: fullName || email || 'Signed in' },
    ...(fullName && email ? [{ kind: 'note', label: email } as MenuEntry] : []),
    ...(phone ? [{ kind: 'note', label: phone } as MenuEntry] : []),
    { kind: 'divider' },
    {
      label: 'Sign out',
      icon: 'back',
      danger: true,
      onSelect: () => {
        void auth.signOut().then((result) => {
          if (!result.ok) toast(result.message, 'warn');
        });
      },
    },
  ];

  return (
    <span className={`account${compact ? ' compact' : ''}`}>
      <button
        type="button"
        className="account-btn"
        data-testid="account-menu"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        title={email ?? 'Account'}
        onClick={menu.toggle}
      >
        <span className="account-badge" aria-hidden="true">
          {initialsOf(email, fullName)}
        </span>
        {!compact && <span className="account-email">{email}</span>}
        <Icon name="chevronDown" size={11} />
      </button>
      {menu.open && menu.anchor && (
        <Menu anchor={menu.anchor} onClose={menu.close} align="right" items={items} />
      )}
    </span>
  );
}
