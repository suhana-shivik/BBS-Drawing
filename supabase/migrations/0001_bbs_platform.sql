-- ============================================================
-- BIMCAD Studio — the multi-user BBS platform schema.
--
-- ONE RULE RUNS THROUGH ALL OF IT: a row is reachable only by the user who
-- owns it, and ownership is decided by `auth.uid()` on the server — never by
-- a user_id the client sends. Every table carries `user_id`, every table has
-- RLS enabled, and every INSERT policy checks BOTH that the row claims the
-- caller AND that its parent belongs to the caller. Without that second half
-- a user could attach a drawing to someone else's project by guessing an id.
--
-- NOTHING HERE IS DRAWING-SPECIFIC. There is no footing table, no beam table,
-- no column for "F8". A member is a text mark, a parameter is a text name,
-- and a fact is (member, parameter, value, unit) with its provenance. The same
-- schema holds a foundation schedule, a beam schedule, a slab or a detail
-- nobody has drawn yet.
--
-- Idempotent: safe to run more than once.
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- updated_at, kept honest by the database rather than by callers
-- ------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
-- 1. profiles — the public half of an account
-- ============================================================
--
-- Authentication identity lives in `auth.users` and stays there. This table
-- holds only what the product needs to show and contact: no password, no
-- hash, no token. Supabase Auth owns credentials; duplicating them here would
-- be inventing a second, worse password store.
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  phone       text,
  full_name   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles are self-service" on public.profiles;
create policy "profiles are self-service" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- The profile row is created BY THE DATABASE when the account is created, not
-- by the client. A client-side insert after sign-up is a request that can fail
-- or never be made — an unconfirmed sign-up would then leave an account with
-- no profile and no phone number. This trigger cannot be skipped.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, phone, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'phone', new.phone),
    new.raw_user_meta_data ->> 'full_name'
  )
  on conflict (id) do update
    set email     = excluded.email,
        phone     = coalesce(excluded.phone, public.profiles.phone),
        full_name = coalesce(excluded.full_name, public.profiles.full_name);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- A trigger only fires for accounts created AFTER it exists. Anyone who
-- registered before this schema was installed — or during any window where the
-- trigger was missing — would have an account and no profile, which shows up
-- much later as a blank name and a lost phone number. This backfills them.
--
-- Idempotent, and deliberately non-destructive: a profile that already carries
-- a phone or a name keeps it, because the person may have corrected it since
-- and the sign-up metadata is the older claim.
insert into public.profiles (id, email, phone, full_name)
select
  u.id,
  u.email,
  coalesce(u.raw_user_meta_data ->> 'phone', u.phone),
  u.raw_user_meta_data ->> 'full_name'
from auth.users u
on conflict (id) do update
  set email     = excluded.email,
      phone     = coalesce(public.profiles.phone, excluded.phone),
      full_name = coalesce(public.profiles.full_name, excluded.full_name);

-- ============================================================
-- 2. projects
-- ============================================================
create table if not exists public.projects (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  name           text not null,
  client         text,
  project_number text,
  description    text,
  status         text not null default 'ACTIVE',
  archived       boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists projects_user_idx on public.projects (user_id, updated_at desc);

alter table public.projects enable row level security;

drop policy if exists "projects are private" on public.projects;
create policy "projects are private" on public.projects
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop trigger if exists projects_touch on public.projects;
create trigger projects_touch before update on public.projects
  for each row execute function public.touch_updated_at();

-- ============================================================
-- 3. drawings — the register entry AND the uploaded file's metadata
-- ============================================================
--
-- One row per uploaded drawing revision. A revision does not overwrite its
-- predecessor: the older row stays, `revision_state` becomes 'superseded' and
-- `superseded_by` points forward, so a schedule computed last month can still
-- name the exact sheet it was computed from.
create table if not exists public.drawings (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.projects (id) on delete cascade,
  user_id            uuid not null references auth.users (id) on delete cascade,

  -- identity as the register reads it off the title block
  document_id        text,
  asset_id           text,
  original_file_name text not null,
  display_name       text,
  drawing_number     text,
  identity_key       text,
  title              text,
  revision           text,
  revision_rank      integer,
  issue_date         text,
  discipline         text,
  health             text,
  revision_state     text not null default 'current'
                     check (revision_state in ('current', 'superseded', 'review')),

  -- the file itself
  file_type          text,
  file_size_bytes    bigint,
  storage_path       text,
  content_hash       text,
  drawing_hash       text,

  -- lifecycle
  status             text not null default 'UPLOADED'
                     check (status in ('UPLOADED', 'READING', 'READ', 'NEEDS_REVIEW', 'FAILED', 'SUPERSEDED')),
  split_status       text,
  package_hash       text,
  version_no         integer not null default 1,
  version_count      integer not null default 1,
  superseded_by      uuid references public.drawings (id) on delete set null,

  warnings           jsonb not null default '[]'::jsonb,
  evidence           jsonb not null default '{}'::jsonb,

  imported_at        timestamptz not null default now(),
  reuploaded_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists drawings_project_idx on public.drawings (project_id, imported_at desc);
create index if not exists drawings_user_idx on public.drawings (user_id);
create index if not exists drawings_hash_idx on public.drawings (project_id, drawing_hash);

alter table public.drawings enable row level security;

drop policy if exists "drawings read own" on public.drawings;
create policy "drawings read own" on public.drawings
  for select using (auth.uid() = user_id);

-- The parent check is the important half: claiming the row is not enough, the
-- project it is filed under must be the caller's too.
drop policy if exists "drawings write own" on public.drawings;
create policy "drawings write own" on public.drawings
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid())
  );

drop policy if exists "drawings update own" on public.drawings;
create policy "drawings update own" on public.drawings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "drawings delete own" on public.drawings;
create policy "drawings delete own" on public.drawings
  for delete using (auth.uid() = user_id);

drop trigger if exists drawings_touch on public.drawings;
create trigger drawings_touch before update on public.drawings
  for each row execute function public.touch_updated_at();

-- ============================================================
-- 4. drawing_sections — what the reader cut the sheet into
-- ============================================================
create table if not exists public.drawing_sections (
  id            uuid primary key default gen_random_uuid(),
  drawing_id    uuid not null references public.drawings (id) on delete cascade,
  project_id    uuid not null references public.projects (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  section_key   text not null,
  label         text,
  kind          text,
  bounds        jsonb,
  entity_count  integer,
  note          text,
  callouts      jsonb not null default '[]'::jsonb,
  storage_path_dxf text,
  storage_path_png text,
  drawing_hash  text,
  created_at    timestamptz not null default now()
);

create index if not exists sections_drawing_idx on public.drawing_sections (drawing_id);

alter table public.drawing_sections enable row level security;

drop policy if exists "sections read own" on public.drawing_sections;
create policy "sections read own" on public.drawing_sections
  for select using (auth.uid() = user_id);

drop policy if exists "sections write own" on public.drawing_sections;
create policy "sections write own" on public.drawing_sections
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.drawings d where d.id = drawing_id and d.user_id = auth.uid())
  );

drop policy if exists "sections update own" on public.drawing_sections;
create policy "sections update own" on public.drawing_sections
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "sections delete own" on public.drawing_sections;
create policy "sections delete own" on public.drawing_sections
  for delete using (auth.uid() = user_id);

-- ============================================================
-- 5. drawing_readings — About Drawing / the structured memory
-- ============================================================
create table if not exists public.drawing_readings (
  id            uuid primary key default gen_random_uuid(),
  drawing_id    uuid not null references public.drawings (id) on delete cascade,
  project_id    uuid not null references public.projects (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  drawing_hash  text,
  understanding text,
  note          text,
  conclusions   jsonb not null default '[]'::jsonb,
  section_notes jsonb not null default '[]'::jsonb,
  unresolved    jsonb not null default '[]'::jsonb,
  escalations   jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists readings_drawing_idx on public.drawing_readings (drawing_id, created_at desc);

alter table public.drawing_readings enable row level security;

drop policy if exists "readings read own" on public.drawing_readings;
create policy "readings read own" on public.drawing_readings
  for select using (auth.uid() = user_id);

drop policy if exists "readings write own" on public.drawing_readings;
create policy "readings write own" on public.drawing_readings
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.drawings d where d.id = drawing_id and d.user_id = auth.uid())
  );

drop policy if exists "readings update own" on public.drawing_readings;
create policy "readings update own" on public.drawing_readings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "readings delete own" on public.drawing_readings;
create policy "readings delete own" on public.drawing_readings
  for delete using (auth.uid() = user_id);

-- ============================================================
-- 6. data_facts — every BBS input, whatever the drawing
-- ============================================================
--
-- `fact_key` is "<member>.<parameter>" as the ledger writes it: "F8.length",
-- "PB03.span", "C12.tie_spacing", "settings.cover". The schema does not know
-- any of those names and never will — member_id and parameter are text, split
-- from the key, so a drawing type nobody has seen yet stores the same way.
--
-- Append-only. A corrected value is a NEW row with a higher `version`; the
-- old row keeps its provenance and is marked superseded. That is what lets a
-- schedule say which version of which fact it was computed from.
create table if not exists public.data_facts (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references public.projects (id) on delete cascade,
  drawing_id            uuid references public.drawings (id) on delete cascade,
  section_id            uuid references public.drawing_sections (id) on delete set null,
  user_id               uuid not null references auth.users (id) on delete cascade,

  fact_key              text not null,
  member_id             text,
  parameter             text not null,

  value                 jsonb,
  unit                  text,
  semantic_type         text,

  source_type           text not null
                        check (source_type in ('DRAWING_READ', 'USER_INPUT', 'DERIVED', 'ASSUMED', 'MISSING', 'UNREADABLE')),
  source_text           text,
  source_entity_handles text[] not null default '{}',
  -- Which sheet and revision the reading came off, as the register names them
  -- (drawing number, revision, document id, handles). Kept whole because a
  -- provenance split across columns cannot be handed back to the reader
  -- unchanged, and `source_text`/`source_entity_handles` above are the
  -- flattened, queryable projection of it.
  source                jsonb,
  drawing_hash          text,
  confidence            numeric,
  status                text not null default 'VALID'
                        check (status in ('VALID', 'MISSING', 'UNREADABLE', 'STALE', 'SUPERSEDED')),
  ask                   text,
  needed_for            text[] not null default '{}',
  looked_in             text[] not null default '{}',
  said_as               text,
  supplied_by           text,

  -- The ledger's own bookkeeping, in columns rather than an opaque blob, so a
  -- superseded claim keeps its reason and a contradicted one keeps its rivals.
  -- These are what let the ledger be rebuilt EXACTLY as it was written: a
  -- history that loses why a value was replaced cannot be audited.
  entry_seq             integer not null,
  evidence              text[] not null default '{}',
  method                text,
  basis                 text,
  depends_on            text[] not null default '{}',
  read_on               text,
  state                 text,
  contradicts           text,
  contradicted_by       text[] not null default '{}',
  contradicted          boolean not null default false,
  disputed_because      text,
  stale                 boolean not null default false,
  superseded_ref        text,
  superseded_reason     text,
  superseded_at         timestamptz,
  recorded_at           timestamptz,

  version               integer not null default 1,
  superseded_by         uuid references public.data_facts (id) on delete set null,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (project_id, fact_key, version)
);

create index if not exists facts_project_idx on public.data_facts (project_id, fact_key, version desc);
create index if not exists facts_current_idx on public.data_facts (project_id) where superseded_by is null;
create index if not exists facts_drawing_idx on public.data_facts (drawing_id);

alter table public.data_facts enable row level security;

drop policy if exists "facts read own" on public.data_facts;
create policy "facts read own" on public.data_facts
  for select using (auth.uid() = user_id);

drop policy if exists "facts write own" on public.data_facts;
create policy "facts write own" on public.data_facts
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid())
  );

drop policy if exists "facts update own" on public.data_facts;
create policy "facts update own" on public.data_facts
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "facts delete own" on public.data_facts;
create policy "facts delete own" on public.data_facts
  for delete using (auth.uid() = user_id);

drop trigger if exists facts_touch on public.data_facts;
create trigger facts_touch before update on public.data_facts
  for each row execute function public.touch_updated_at();

-- ============================================================
-- 7. bbs_calculation_runs — one schedule build
-- ============================================================
create table if not exists public.bbs_calculation_runs (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id) on delete cascade,
  drawing_id      uuid references public.drawings (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,

  drawing_hash    text,
  engine_version  text,
  status          text not null default 'DRAFT'
                  check (status in ('DRAFT', 'STALE', 'REBUILDING', 'CALCULATED', 'VALIDATING', 'FINAL', 'BLOCKED', 'FAILED')),
  is_current      boolean not null default true,

  -- what it was computed from, and what it came to
  fact_versions   jsonb not null default '{}'::jsonb,
  row_deps        jsonb not null default '[]'::jsonb,
  settings        jsonb not null default '{}'::jsonb,
  snapshot        text[] not null default '{}',
  totals          jsonb not null default '{}'::jsonb,
  steel_summary   jsonb not null default '[]'::jsonb,
  reconciled      boolean,
  reconciliation  jsonb,
  stale_fact_ids  text[] not null default '{}',

  total_rows      integer not null default 0,
  calculated_rows integer not null default 0,
  blocked_rows    integer not null default 0,

  -- the full artifact, for audit and for re-export without recomputing
  result          jsonb,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists runs_project_idx on public.bbs_calculation_runs (project_id, created_at desc);
create index if not exists runs_current_idx on public.bbs_calculation_runs (drawing_id) where is_current;

alter table public.bbs_calculation_runs enable row level security;

drop policy if exists "runs read own" on public.bbs_calculation_runs;
create policy "runs read own" on public.bbs_calculation_runs
  for select using (auth.uid() = user_id);

drop policy if exists "runs write own" on public.bbs_calculation_runs;
create policy "runs write own" on public.bbs_calculation_runs
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid())
  );

drop policy if exists "runs update own" on public.bbs_calculation_runs;
create policy "runs update own" on public.bbs_calculation_runs
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "runs delete own" on public.bbs_calculation_runs;
create policy "runs delete own" on public.bbs_calculation_runs
  for delete using (auth.uid() = user_id);

drop trigger if exists runs_touch on public.bbs_calculation_runs;
create trigger runs_touch before update on public.bbs_calculation_runs
  for each row execute function public.touch_updated_at();

-- ============================================================
-- 8. bbs_rows — one bar mark, with the trace that produced it
-- ============================================================
--
-- Enough to audit the figure without rerunning anything: which facts it read,
-- which stage it reached, what stopped it, the substituted arithmetic, and the
-- drawing entity the callout was read from.
create table if not exists public.bbs_rows (
  id                     uuid primary key default gen_random_uuid(),
  run_id                 uuid not null references public.bbs_calculation_runs (id) on delete cascade,
  project_id             uuid not null references public.projects (id) on delete cascade,
  drawing_id             uuid references public.drawings (id) on delete cascade,
  user_id                uuid not null references auth.users (id) on delete cascade,

  row_index              integer not null default 0,
  member_id              text,
  bar_mark               text not null,
  bar_type               text,
  description            text,
  shape_code             text,

  dia_mm                 numeric,
  spacing_mm             numeric,
  cover_mm               numeric,
  cover_status           text,

  bars_per_member        numeric,
  member_count           numeric,
  total_bars             numeric,
  cutting_length_mm      numeric,
  total_length_m         numeric,
  unit_weight_kg_per_m   numeric,
  weight_kg              numeric,
  weight_with_wastage_kg numeric,

  -- how each figure was arrived at
  length_source          text,
  quantity_method        text,
  unit_weight_method     text,
  formula                text,
  working                text[] not null default '{}',

  -- where it came from, and what it is waiting on
  source_text            text,
  source_entity_handles  text[] not null default '{}',
  fact_ids               text[] not null default '{}',
  stage                  text,
  failed_stage           text,
  missing_fact           text,
  reason                 text,
  action                 text,
  status                 text not null default 'CALCULATED',
  drawing_hash           text,

  created_at             timestamptz not null default now()
);

create index if not exists bbs_rows_run_idx on public.bbs_rows (run_id, row_index);
create index if not exists bbs_rows_project_idx on public.bbs_rows (project_id);

alter table public.bbs_rows enable row level security;

drop policy if exists "bbs rows read own" on public.bbs_rows;
create policy "bbs rows read own" on public.bbs_rows
  for select using (auth.uid() = user_id);

drop policy if exists "bbs rows write own" on public.bbs_rows;
create policy "bbs rows write own" on public.bbs_rows
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.bbs_calculation_runs r where r.id = run_id and r.user_id = auth.uid())
  );

drop policy if exists "bbs rows update own" on public.bbs_rows;
create policy "bbs rows update own" on public.bbs_rows
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "bbs rows delete own" on public.bbs_rows;
create policy "bbs rows delete own" on public.bbs_rows
  for delete using (auth.uid() = user_id);

-- ============================================================
-- 9. project_artifacts — filed outputs (BBS json, About Drawing, sections)
-- ============================================================
create table if not exists public.project_artifacts (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  drawing_id     uuid references public.drawings (id) on delete cascade,
  user_id        uuid not null references auth.users (id) on delete cascade,
  document_id    text,
  kind           text not null check (kind in ('quantity', 'bbs', 'sections', 'about')),
  file_name      text,
  drawing_name   text,
  drawing_number text,
  revision       text,
  version        integer not null default 1,
  mime_type      text not null default 'application/json',
  content        text,
  created_at     timestamptz not null default now()
);

create index if not exists artifacts_project_idx on public.project_artifacts (project_id, created_at desc);

alter table public.project_artifacts enable row level security;

drop policy if exists "artifacts read own" on public.project_artifacts;
create policy "artifacts read own" on public.project_artifacts
  for select using (auth.uid() = user_id);

drop policy if exists "artifacts write own" on public.project_artifacts;
create policy "artifacts write own" on public.project_artifacts
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid())
  );

drop policy if exists "artifacts update own" on public.project_artifacts;
create policy "artifacts update own" on public.project_artifacts
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "artifacts delete own" on public.project_artifacts;
create policy "artifacts delete own" on public.project_artifacts
  for delete using (auth.uid() = user_id);

-- ============================================================
-- 10. interview_logs — what was ASKED, beside what was answered
-- ============================================================
create table if not exists public.interview_logs (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id) on delete cascade,
  drawing_id      uuid references public.drawings (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  drawing_name    text,
  artifact_id     text,
  stopped_because text,
  log             jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists interview_logs_project_idx on public.interview_logs (project_id, created_at desc);

alter table public.interview_logs enable row level security;

drop policy if exists "interview logs read own" on public.interview_logs;
create policy "interview logs read own" on public.interview_logs
  for select using (auth.uid() = user_id);

drop policy if exists "interview logs write own" on public.interview_logs;
create policy "interview logs write own" on public.interview_logs
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid())
  );

drop policy if exists "interview logs delete own" on public.interview_logs;
create policy "interview logs delete own" on public.interview_logs
  for delete using (auth.uid() = user_id);

-- ============================================================
-- 11. Storage — drawing files, private
-- ============================================================
--
-- Path convention: <user_id>/<project_id>/<drawing_id>/<file>
-- The FIRST path segment is the owner, which is what the policies below
-- compare against `auth.uid()`. A private bucket plus these policies means a
-- storage path is not a capability: knowing someone else's path gets you a
-- 403, and download URLs are short-lived signed URLs rather than public ones.
insert into storage.buckets (id, name, public)
values ('drawings', 'drawings', false)
on conflict (id) do nothing;

drop policy if exists "drawing files are private" on storage.objects;
create policy "drawing files are private" on storage.objects
  for all
  using (
    bucket_id = 'drawings'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'drawings'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ============================================================
-- 12. Privileges
-- ============================================================
--
-- RLS decides WHICH ROWS a caller may touch; a GRANT decides whether the role
-- may touch the table at all. Both are needed, and relying on the project's
-- default privileges to supply the second is relying on a setting this
-- migration cannot see. So it is stated here.
--
-- `authenticated` gets table access, and every row it can reach is then
-- narrowed by the policies above. `anon` — an unauthenticated visitor — gets
-- NOTHING: there is no row in this schema a signed-out person has any business
-- reading, so the refusal happens a step earlier than RLS.
--
-- Wrapped in a guard because these roles exist on Supabase and not on a plain
-- Postgres, where this file is validated before it is ever run for real.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant usage on schema public to authenticated;
    grant select, insert, update, delete on all tables in schema public to authenticated;
    grant usage, select on all sequences in schema public to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant usage on schema public to anon;
    revoke all on all tables in schema public from anon;
  end if;
end
$$;
