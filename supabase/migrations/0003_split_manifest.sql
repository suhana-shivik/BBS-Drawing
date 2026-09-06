-- ============================================================
-- 0003 — the split package's manifest
-- ============================================================
--
-- `drawing_sections` holds the SECTIONS a sheet was cut into. A split package
-- is more than its sections: it also carries the orchestrator's closing
-- summary, the coverage figure (what fraction of the sheet's geometry ended up
-- in any section), the relationships between sections, the verbatim record of
-- what the model asked the platform to cut, the areas it could not account
-- for, and the second pass over the leftovers.
--
-- None of that had a column anywhere, so a project opened on a second machine
-- could list a drawing's sections and still not know whether they accounted
-- for the sheet — which is exactly the question `coverage` exists to answer.
--
-- ONE JSONB COLUMN, NOT SIX TABLES. Every field here is read together, written
-- together, and read as a whole document by the code that consumes it; none of
-- them is queried on its own. Splitting them into relations would buy nothing
-- and cost a join per open. The section BODIES are the opposite case and are
-- not in here: they are megabytes and they live in the storage bucket, with
-- `drawing_sections.storage_path_dxf`/`_png` pointing at them.
--
-- Nullable, and stays null for a drawing that has never been split.

alter table public.drawings
  add column if not exists split_manifest jsonb;

comment on column public.drawings.split_manifest is
  'The split package without its sections: summary, coverage, relationships, '
  'requests, unresolved areas and the second pass. Sections are rows in '
  'drawing_sections; their DXF/PNG bodies are objects in the drawings bucket.';
