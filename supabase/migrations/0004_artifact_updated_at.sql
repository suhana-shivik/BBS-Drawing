-- ============================================================
-- 0004 — an artifact can be CORRECTED without becoming a new document.
--
-- Editing a filed schedule to complete a blocked row is a correction to that
-- schedule, not a revision of it: the same drawing, the same version, the
-- same file name. Only a deliberate "save as new version" mints v2.
--
-- So `project_artifacts` needs to record WHEN it was last written, separately
-- from when it was created. The audit trail of what changed lives in the
-- artifact's own `history` and in `bbs_calculation_runs`, which keeps every
-- run's rows; this column is only the timestamp the register shows.
-- ============================================================

alter table public.project_artifacts
  add column if not exists updated_at timestamptz not null default now();

-- Backfill: an artifact never edited was last written when it was created.
update public.project_artifacts
   set updated_at = created_at
 where updated_at < created_at;

comment on column public.project_artifacts.updated_at is
  'Last write. Equal to created_at until the artifact is edited in place.';
