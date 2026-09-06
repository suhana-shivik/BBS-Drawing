// THE SECRET KEY MUST NEVER REACH A BROWSER.
//
// `.env` holds both the publishable key (safe, RLS-protected) and the secret
// key (bypasses RLS entirely). The build reads the whole file, so the only
// thing standing between the secret and the client bundle is the allowlist in
// vite-plugins/publicEnv.ts. This test is that allowlist's alarm: it fails if
// the list ever grows something secret-shaped, and it proves the define map
// carries the two names and nothing else.
import { describe, expect, it } from 'vitest';
import {
  assertPublishable,
  publicEnvDefine,
  PUBLIC_ENV_KEYS,
} from '../../vite-plugins/publicEnv';

const REALISTIC_ENV = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abc123',
  SUPABASE_SECRET_KEY: 'sb_secret_do_not_ship',
  SUPABASE_JWKS_URL: 'https://project.supabase.co/auth/v1/.well-known/jwks.json',
  DATABASE_URL: 'postgresql://postgres:hunter2@db.project.supabase.co:5432/postgres',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  SESSION_SECRET: 'session-secret',
  SMTP_PASS: 'smtp-password',
  VITE_OPENROUTER_API_KEY: 'sk-or-v1-openrouter',
};

describe('what the browser bundle is allowed to know', () => {
  it('publishes exactly the two public Supabase values', () => {
    const define = publicEnvDefine(REALISTIC_ENV);
    expect(Object.keys(define).sort()).toEqual([
      'import.meta.env.SUPABASE_PUBLISHABLE_KEY',
      'import.meta.env.SUPABASE_URL',
    ]);
    expect(define['import.meta.env.SUPABASE_URL']).toBe('"https://project.supabase.co"');
    expect(define['import.meta.env.SUPABASE_PUBLISHABLE_KEY']).toBe('"sb_publishable_abc123"');
  });

  it('carries no secret anywhere in what it emits', () => {
    const emitted = JSON.stringify(publicEnvDefine(REALISTIC_ENV));
    for (const secret of [
      REALISTIC_ENV.SUPABASE_SECRET_KEY,
      REALISTIC_ENV.DATABASE_URL,
      REALISTIC_ENV.AWS_SECRET_ACCESS_KEY,
      REALISTIC_ENV.SESSION_SECRET,
      REALISTIC_ENV.SMTP_PASS,
      'hunter2',
    ]) {
      expect(emitted).not.toContain(secret);
    }
  });

  it('a missing value becomes an empty string, so the app can say "not configured"', () => {
    const define = publicEnvDefine({});
    expect(define['import.meta.env.SUPABASE_URL']).toBe('""');
    expect(define['import.meta.env.SUPABASE_PUBLISHABLE_KEY']).toBe('""');
  });

  it('refuses a secret-shaped name if the allowlist is ever widened', () => {
    for (const bad of [
      'SUPABASE_SECRET_KEY',
      'SERVICE_ROLE_KEY',
      'DB_PASSWORD',
      'PRIVATE_SIGNING_KEY',
      'GITHUB_TOKEN',
      'AWS_CREDENTIALS',
    ]) {
      expect(() => assertPublishable(bad)).toThrow(/named like a secret/);
    }
  });

  it('the publishable key is the one "KEY" that is allowed through', () => {
    expect(() => assertPublishable('SUPABASE_PUBLISHABLE_KEY')).not.toThrow();
    expect(PUBLIC_ENV_KEYS).toContain('SUPABASE_PUBLISHABLE_KEY');
    expect(PUBLIC_ENV_KEYS).not.toContain('SUPABASE_SECRET_KEY' as never);
  });

  it('every name on the allowlist survives its own guard', () => {
    for (const name of PUBLIC_ENV_KEYS) expect(() => assertPublishable(name)).not.toThrow();
  });
});
