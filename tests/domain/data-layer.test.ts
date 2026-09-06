// The parts of the data layer that are pure, and that matter most when they
// are wrong: what a person is told when the database refuses them, and the
// shape of a storage path — which is the thing the bucket policy compares
// against `auth.uid()`, so its first segment is a security property, not a
// naming convention.
import { describe, expect, it } from 'vitest';
import type { PostgrestError } from '@supabase/supabase-js';
import { describeDbError } from '../../src/data/session';
import { sectionStoragePathFor, storagePathFor } from '../../src/data/drawings';
import { toStudioProject } from '../../src/data/projects';

const err = (over: Partial<PostgrestError>): PostgrestError =>
  ({ message: '', details: '', hint: '', code: '', ...over }) as PostgrestError;

describe('what a database refusal is turned into', () => {
  it('explains an RLS refusal in terms of ownership, not of policies', () => {
    const message = describeDbError(
      err({ code: '42501', message: 'new row violates row-level security policy for table "drawings"' }),
      'Filing the drawing',
    );
    expect(message).toMatch(/belongs to another account, or your session has ended/);
    expect(message).not.toMatch(/row-level security policy for table/);
  });

  it('names the migration when the schema was never installed', () => {
    const message = describeDbError(
      err({ code: '42P01', message: 'relation "public.projects" does not exist' }),
      'Loading your projects',
    );
    expect(message).toMatch(/schema is not installed/);
    expect(message).toMatch(/0001_bbs_platform\.sql/);
  });

  it('distinguishes a duplicate, a dangling reference and a dead network', () => {
    expect(describeDbError(err({ code: '23505' }), 'Creating the project')).toMatch(/already exists/);
    expect(describeDbError(err({ code: '23503' }), 'Filing the drawing')).toMatch(/no longer exists/);
    expect(describeDbError(err({ message: 'Failed to fetch' }), 'Saving')).toMatch(/could not reach the database/);
  });

  it('falls back to the provider’s own words rather than inventing a reason', () => {
    expect(describeDbError(err({ message: 'value too long for type character varying(10)' }), 'Saving')).toMatch(
      /value too long/,
    );
  });

  it('always says what was being attempted', () => {
    for (const code of ['42501', '23505', '23503', '42P01', '']) {
      expect(describeDbError(err({ code }), 'Filing the schedule')).toMatch(/Filing the schedule/);
    }
  });
});

describe('where a drawing file is put', () => {
  const user = '11111111-1111-1111-1111-111111111111';
  const project = '22222222-2222-2222-2222-222222222222';
  const drawing = '33333333-3333-3333-3333-333333333333';

  it('puts the OWNER first — the bucket policy compares that segment to auth.uid()', () => {
    const path = storagePathFor(user, project, drawing, 'GAMCO wall.dxf');
    expect(path.split('/')[0]).toBe(user);
    expect(path).toBe(`${user}/${project}/${drawing}/GAMCO_wall.dxf`);
  });

  it('cannot be talked out of that first segment by a hostile file name', () => {
    for (const name of ['../../etc/passwd', '..\\..\\secrets', '/absolute/path', 'a/b/c.dxf', '']) {
      const path = storagePathFor(user, project, drawing, name);
      expect(path.startsWith(`${user}/${project}/${drawing}/`)).toBe(true);
      // exactly four segments: no traversal, no nesting
      expect(path.split('/')).toHaveLength(4);
    }
  });

  it('keeps a usable name for ordinary files', () => {
    expect(storagePathFor(user, project, drawing, 'PCD-IND-B300-S-803_R0.dxf')).toMatch(
      /PCD-IND-B300-S-803_R0\.dxf$/,
    );
  });
});

describe('a project row, as the studio reads it', () => {
  it('turns timestamps into epoch ms and drops empty optionals', () => {
    const studio = toStudioProject({
      id: 'p1',
      user_id: 'u1',
      name: 'GAMCO Boundary Wall',
      client: null,
      project_number: null,
      description: null,
      status: 'ACTIVE',
      archived: false,
      created_at: '2026-09-01T10:00:00Z',
      updated_at: '2026-09-06T12:30:00Z',
    });
    expect(studio).toEqual({
      id: 'p1',
      name: 'GAMCO Boundary Wall',
      createdAt: Date.parse('2026-09-01T10:00:00Z'),
      modifiedAt: Date.parse('2026-09-06T12:30:00Z'),
    });
    expect('client' in studio).toBe(false);
    expect('archived' in studio).toBe(false);
  });

  it('carries client, number and the archived flag when they are set', () => {
    const studio = toStudioProject({
      id: 'p1',
      user_id: 'u1',
      name: 'Site B',
      client: 'GAMCO Infratech',
      project_number: '2026-014',
      description: null,
      status: 'ACTIVE',
      archived: true,
      created_at: '2026-09-01T10:00:00Z',
      updated_at: '2026-09-01T10:00:00Z',
    });
    expect(studio).toMatchObject({ client: 'GAMCO Infratech', projectNumber: '2026-014', archived: true });
  });
});

// ------------------------------------------------------------
// where a SECTION body is put
// ------------------------------------------------------------
//
// One level deeper than the sheet's own path, which the bucket policy does not
// mind — it compares `(storage.foldername(name))[1]` to `auth.uid()`, and that
// is the first segment however many follow it. The section key is generated
// (`REGION-01`), and a path that trusts generated input is a path that can be
// talked out of its own prefix, so it is sanitised exactly like a file name.
describe('where a section body is put', () => {
  const user = '11111111-1111-1111-1111-111111111111';
  const project = '22222222-2222-2222-2222-222222222222';
  const drawing = '33333333-3333-3333-3333-333333333333';

  it('nests under the drawing, still owner-first', () => {
    const path = sectionStoragePathFor(user, project, drawing, 'REGION-01', 'dxf');
    expect(path).toBe(`${user}/${project}/${drawing}/sections/REGION-01.dxf`);
    expect(path.split('/')[0]).toBe(user);
  });

  it('keeps the owner segment whatever the key claims to be', () => {
    for (const key of ['../../etc/passwd', '..\..\secrets', '/absolute', 'a/b', '']) {
      const path = sectionStoragePathFor(user, project, drawing, key, 'png');
      expect(path.startsWith(`${user}/${project}/${drawing}/sections/`)).toBe(true);
      expect(path.split('/')).toHaveLength(5);
    }
  });
});
