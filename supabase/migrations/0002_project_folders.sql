-- ============================================================
-- 0002 — project_folders: the folders a person makes by hand
-- ============================================================
--
-- The built-in folders are DERIVED — a drawing is in "Structural" because its
-- discipline says so — and they need no storage: re-deriving them from the
-- drawings is the whole point of them.
--
-- A folder someone MAKES is the opposite. "WH-4 package", "Issued to Sharma",
-- "Priced" — no rule infers those, nothing else in the schema records them,
-- and until this table they lived in one browser's `localStorage` under
-- `bimcad.register.folders`. That meant the filing was invisible on a second
-- machine and gone the moment site data was cleared, while the drawings it
-- organised sat safely in `public.drawings`. A person who spent an afternoon
-- filing a hundred sheets had nothing to show for it anywhere but that one
-- browser profile.
--
-- MEMBERSHIP IS A COLUMN, NOT A TABLE. A folder holds tens of drawings, is
-- always read whole (the Files tree needs every membership at once to draw
-- itself), and is always written whole. A join table would add a query and a
-- cascade for a list that is never queried on its own. The ids in it are
-- `drawings.id`, but deliberately WITHOUT a foreign key: a stale id in a
-- label is harmless — the tree resolves ids to drawings and skips what it
-- cannot find — whereas a cascade would make deleting one drawing rewrite
-- every folder row that ever mentioned it.

create table if not exists public.project_folders (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  -- The browser's own id for this folder (`uf_…`), kept so a folder made
  -- offline and filed later stays the same folder rather than becoming a
  -- duplicate of itself.
  local_id   text not null,
  name       text not null,
  members    jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Upserts match on this, which is also what stops the same folder being filed
-- twice by two tabs.
create unique index if not exists project_folders_local_idx
  on public.project_folders (project_id, local_id);

create index if not exists project_folders_project_idx
  on public.project_folders (project_id, created_at);

alter table public.project_folders enable row level security;

drop policy if exists "folders read own" on public.project_folders;
create policy "folders read own" on public.project_folders
  for select using (auth.uid() = user_id);

-- As everywhere else in this schema, the parent check is the important half:
-- claiming the row is not enough, the project it is filed under must be the
-- caller's too.
drop policy if exists "folders write own" on public.project_folders;
create policy "folders write own" on public.project_folders
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid())
  );

drop policy if exists "folders update own" on public.project_folders;
create policy "folders update own" on public.project_folders
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "folders delete own" on public.project_folders;
create policy "folders delete own" on public.project_folders
  for delete using (auth.uid() = user_id);

drop trigger if exists project_folders_touch on public.project_folders;
create trigger project_folders_touch before update on public.project_folders
  for each row execute function public.touch_updated_at();

-- 0001 granted on ALL TABLES as they stood then; a table added afterwards is
-- not covered by that statement, so it is granted here.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update, delete on public.project_folders to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.project_folders from anon;
  end if;
end
$$;
