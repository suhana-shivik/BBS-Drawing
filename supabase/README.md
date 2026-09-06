# Supabase — accounts, projects and the BBS record

The app is multi-user. Identity is Supabase Auth; everything a project owns is
a row in Postgres behind Row Level Security. The browser keeps caches, but a
project, its drawings, its facts and its schedules exist in the database.

## 1. Credentials

`.env` at the repository root already carries:

| Variable | Reaches the browser? | What it is |
|---|---|---|
| `SUPABASE_URL` | yes | the project's API URL |
| `SUPABASE_PUBLISHABLE_KEY` | yes | the browser key, protected by RLS |
| `SUPABASE_SECRET_KEY` | **never** | bypasses RLS — server/CLI only |
| `SUPABASE_JWKS_URL` | no | for verifying tokens server-side |

Only the first two are published, by an allowlist in
`vite-plugins/publicEnv.ts`. That allowlist is enforced by
`tests/domain/public-env.test.ts`, which fails the build if it ever grows a
name that looks like a secret. Nothing is hardcoded: the values are read from
`.env` at build time.

## 2. Install the schema

The API keys talk to PostgREST, which runs queries but not DDL, so creating
tables needs a database connection. Add **one** of these to `.env`:

```
SUPABASE_DB_URL=postgresql://…        # Dashboard → Project Settings → Database → Connection string
SUPABASE_DB_PASSWORD=…                # the database password; the URL is derived from SUPABASE_URL
```

On an IPv4-only network (most home and office networks) copy the **session
pooler** connection string, not the direct one — current projects serve
`db.<ref>.supabase.co` over IPv6 only, and a direct connection just times out.

Then:

```
npm run db:migrate      # apply supabase/migrations/*.sql
npm run db:check        # list what is installed
```

No database password to hand? Open the dashboard's **SQL editor** and paste
the migrations in order — `0001_bbs_platform.sql`, `0002_project_folders.sql`,
`0003_split_manifest.sql`. They are plain, idempotent SQL and do the same
thing.

> Already running an older install? `0002` is what makes hand-made folders
> survive a browser; without it every folder write is refused and the folder
> lives only in `localStorage`. `0003` adds `drawings.split_manifest`; without
> it a split files its sections but not the summary and coverage that say
> whether they account for the sheet.

## 3. Verify it

```
npm run db:verify
```

This creates two real accounts, signs both in, has user A create a project, a
drawing, facts and a schedule, and then tries to read every one of them **as
user B with B's own token**. It also checks that an anonymous request sees
nothing, that the storage bucket is private, that a path is not a capability,
and that deleting a project cascades. It cleans up after itself (`--keep`
leaves the data in place).

## 4. Authentication settings to check in the dashboard

- **Authentication → Providers → Email** must be enabled. It is.
- **Email confirmation** is ON for this project, so a new account has no
  session until the link is opened. The registration screen says so.
- **Authentication → URL Configuration → Redirect URLs** must list the app's
  origin, e.g. `http://localhost:5174`, or the password-reset and confirmation
  links will refuse to come back. The app always sends its live
  `window.location.origin`, never a hardcoded address.
- Phone auth is **off**, which is why the phone number collected at
  registration is profile data (`profiles.phone`, via a database trigger) and
  not a sign-in factor.

## 5. What is where

| Table | Holds |
|---|---|
| `profiles` | the public half of an account — email, phone, name. No credentials. |
| `projects` | one row per project, owned by a user |
| `drawings` | a register entry AND its uploaded file's metadata; revisions are rows, superseded not overwritten |
| `drawing_sections` | what the reader cut the sheet into — the INDEX per section (key, label, kind, bounds, entity count, callouts, hash); the section DXF and PNG bodies stay in the browser package, and `storage_path_dxf`/`storage_path_png` are null until they are uploaded too |
| `drawing_readings` | About Drawing / the structured memory, per drawing hash |
| `data_facts` | **every BBS input**, one row per ledger ENTRY, append-only with its supersede chain |
| `bbs_calculation_runs` | one schedule build: drawing hash, fact versions, row dependencies, snapshot, reconciliation |
| `bbs_rows` | one bar mark with its full trace — stage, missing fact, reason, action, source handles |
| `project_artifacts` | filed outputs (BBS json, About Drawing, sections index), versioned |
| `interview_logs` | what was asked, beside what was answered |
| `project_folders` | folders a person made by hand ("WH-4 package"), with their membership |

Storage: one private bucket, `drawings`. The sheet itself is at
`<user_id>/<project_id>/<drawing_id>/<file>`, and each of its sections at
`<user_id>/<project_id>/<drawing_id>/sections/<section_key>.{dxf,png}`. The
FIRST path segment is the owner, and the bucket policy compares it to
`auth.uid()` — which is why nesting deeper is free and why a path built from a
generated key still sanitises that key.

## 6. What the browser keeps

IndexedDB (`bimcad`) is a **cache**, not a second record. Every store in it is
written to Postgres or to the bucket first, and is refetched on a miss:

| Store | Home |
|---|---|
| `projects` | `public.projects` |
| `drawingRegisters` | `public.drawings` |
| `projectArtifacts` | `public.project_artifacts` |
| `projectFacts` | `public.data_facts` |
| `interviewLogs` | `public.interview_logs` |
| `drawingUnderstanding` | `public.drawing_sections` + `drawings.split_manifest` + the bucket |
| `cadSources` | the `drawings` bucket |
| `cadDocuments` | **derived** — re-parsed from the stored source on a miss |

`cadDocuments` is the one store with no home, on purpose: a parsed document is
derived from the source bytes, and uploading the parse beside the file it came
from would be a second copy of the same drawing that can disagree with the
first. `hydrateMissing` in `src/cad/import.ts` re-derives it.

Because the stores are keyed by project rather than by user, **sign-out clears
the whole cache** (`clearCache` in `src/cad/store.ts`) — otherwise the next
person to sign in on that browser would open the last person's drawings
straight out of it.

`data_facts.fact_key` is `<member>.<parameter>` exactly as the ledger writes
it — `F8.length` on a footing sheet, `PB03.span` on a beam sheet,
`settings.cover` for the project. No table, column or constraint names a
member type; a drawing nobody has seen yet stores the same way.

`data_facts.drawing_id` and `data_facts.section_id` are resolved PER FACT, not
per ledger: a reading takes them from its own `source` (`documentId`,
`sectionId`), and an answer — which carries no `source`, because an answer is
not a reading of the sheet — takes the drawing that was open when it was
given. A fact belonging to no drawing (`settings.cover`, recorded with nothing
open) records null rather than being attributed to whatever happened to be on
screen. `section_id` is never inferred: a document is not a section.
