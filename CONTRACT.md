# Build contract — Drawing Register (BIMCAD Studio rebuild)

This repo is a clean rebuild of the prototype at
`C:\Users\abhis\Documents\projects\BIM+3js` (the SOURCE repo). The design brain:

- `SOURCE/STUDIO_DESIGN.md` — the workspace design (shell, register, schedule, chat).
  Its working prototype is `SOURCE/design/studio.html` — the UI is built to match it.
- `SOURCE/HOW_TO_BUILD_IT.md` — the pipeline: split → transcribe → **project fact
  ledger** → demand-driven multi-drawing resolution → compute with BLOCKED rows.

## The two rules nothing may break

1. **The model assigns meaning. Code computes every number.** No schema the model
   fills may contain a field a dimension, count, pitch, level or length could be
   typed into. The model points (evidence ids, handles, column refs); the engine
   reads values off the drawing and computes with IS 456 / IS 2502 / IS 1786.
2. **A quantity is only computed when every fact it depends on is
   MEASURED / DECLARED / SUPPLIED / DERIVED.** A MISSING dependency emits a
   formula with a named hole — never an invented number.

## Porting rules

- Proven deterministic modules are **ported from SOURCE, not rewritten**. Keep the
  same relative paths under `src/` so internal imports survive verbatim.
- Ported code keeps its file-header comments and behaviour. Fix imports only.
- The legacy experimental generations are **NOT ported**: `src/cad/bbs/interpret.ts`
  one-shot path, `agent.ts`, `drive.ts`, `passes.ts`, `passClient.ts`,
  `freehand.ts`, the old `orchestrator.ts` task-DAG. The **orchestrated path**
  (`orchestrate.ts` + `tasks.ts` + `tools.ts` + `judge.ts`) is the only model loop.
- Every ported module brings its domain tests from `SOURCE/tests/domain/` when they
  test only ported/new modules. Tests referencing non-ported legacy modules are skipped.
- No Express server / auth / image library in v1. Local-first: IndexedDB + localStorage.
- `three` is used by the viewer only. `pdfjs-dist` is the only new heavy dep.

## Conventions

- Model space: x east, y north, z up; **all lengths in mm**; storey heights relative.
- UI theme tokens in `src/styles/theme.css` (already copied). Light default; dark by
  token redefinition only. Drawing viewports are permanently `#101216` in both themes.
- Type: IBM Plex Sans / Sans Condensed / Mono (loaded in index.html). Tabular
  figures on every digit column.
- Selection amber marks the current selection only — never emphasis or state.
- Ids: evidence ids are stable and semantic (`DIM-017`, `CALL-032`, `MARK-C1-004`,
  `PANEL-3`). Facts in the ledger are `FACT <subject>.<name>` with provenance.

## Module map and ownership

| Area | Path | Origin |
|---|---|---|
| CAD core: DXF parser, worker, display list, render, svg, occurrences, session, store, units | `src/cad/` (mirrors SOURCE) | PORT |
| Indian-code arithmetic | `src/domain/india/` | PORT |
| BBS deterministic engine: extract, callout, evidence, members, bands, regions, sections, sequence, refs, placement, cover, disposition, ownership, build, verify, repair, askFrom, gaps, interview, chatResult, sheet, contract, schema, runlog, describe, conventions, overrides | `src/cad/bbs/` | PORT |
| BBS model loop: orchestrate, tasks, tools, judge, survey, investigate, notes, lifecycle | `src/cad/bbs/` | PORT |
| Drawing splitter | `src/cad/understanding/` | PORT |
| AI transport: openrouter, config, crops, log, memory, transcript | `src/cad/ai/` | PORT |
| Register domain: titleBlock, register, artifacts, folders, changeLog | `src/register/` | PORT |
| **PDF import** | `src/cad/pdf/` | NEW |
| **Fact ledger** | `src/facts/` | NEW |
| Studio shell UI | `src/App.tsx`, `src/components/`, `src/studio/` | NEW (per studio.html) |
| DWG convert client | `src/cad/dwg.ts` | PORT/adapt (service URL `/dwg-convert` via vite proxy) |
| DWG convert service | `services/dwg-convert/` | COPY |

## New-module contracts

### PDF (`src/cad/pdf/`)
A PDF page becomes a `PdfSheet`: `{ pageIndex, widthPt, heightPt, raster: ImageBitmap
| dataURL, texts: PdfTextRun[] }` with `PdfTextRun = { text, x, y, height }` in page
points, y-up. PDF sheets are **raster underlays + a text index** — they join the
register (title-block identity from text runs), can be viewed, and feed the splitter
by image; they do NOT produce CadDocument entities. Conversion of vector PDF to
entities is out of scope v1 and must be stated in the UI, not silently faked.

### Fact ledger (`src/facts/`)
Per-project ledger. `Fact = { id, subject, name, value?, unit?, state: 'MEASURED' |
'DECLARED' | 'DERIVED' | 'SUPPLIED' | 'MISSING', source?, evidence?, method?,
basis?, neededFor?, lookedIn?, ask?, readOn }`. API: `addFact`, `resolveFact`,
`requiredFactsFor(quantityKind)`, `missingFacts()`, persistence to localStorage per
project. A BLOCKED row carries the formula text and the missing fact ids.

## Layer 3 addendum — product as harness

Spec: `SOURCE/PRODUCT_AS_HARNESS.md` (authoritative). Three layers: SKILLS declare
required facts + a deterministic compute; MEMORY is the project fact ledger
(five states, provenance, persistent, trust-ordered overwrite, hash staleness);
HARNESS fills memory. **Skills never talk to a harness directly — memory is the
only thing both sides touch.** `src/facts/` is the ledger domain module; its
IndexedDB persistence lives additively in `src/cad/store.ts` as
`STORE_PROJECT_FACTS`. Skill manifests live in `src/skills/` and import their
`SKILL.md` knowledge via `?raw` — knowledge is never paraphrased into code.
Overwrite rule: a fact may only be replaced by a higher-trust state, or the same
state from a newer revision; a losing claim is recorded as contradicted, never
dropped. `supplied` facts survive drawing re-imports.

## UI requirements update (R1–R6)

Spec: `SOURCE/UI_REQUIREMENTS_UPDATE.md` (authoritative). Multiple projects (no
default project — project-scoped reads take projectId and fail loudly without
one; facts never cross projects), files-first boot, sections as real files under
a per-drawing `Sections/` folder with split-on-import (`splitStatus` per
register entry), memory rendered as the **Specification** (the dock tab is a
filter over the same store; every fact's source is a resolvable link chain
drawing › section › handles sharing the schedule's selection/highlight path),
inline `history: FactVersion[]` capped at 20 keeping first + last 19 with a
revision impact report, and one search with four kinds of hit where a result
always navigates and highlights. Two `declared` facts that disagree → record
both, mark contradicted, block, ask (same shape as missing).

## Editor tools addendum (the 22-tool strip)

Spec: `SOURCE/EDITOR_TOOLS_NOTE.md` (authoritative — it documents the machine as
built, and §13 lists five defects that must NOT be reproduced). The strip in this
shell is currently cosmetic: buttons set `ui.activeTool` and nothing draws.

Rules the port must keep: the controller owns interaction, `render.ts` owns pixels,
**every model change goes through `runCommand`** — no tool writes to the model
directly. Tools never see the raw cursor (`effPt` is post-snap). Snap flags are
MODEL state (`model.settings`), so the palette and status bar can never drift.
Tools never mutate the imported drawing — the underlay stays an underlay; created
geometry is BIM elements carrying a CAD layer name.

Per §14, three things travel with the strip into this design: the per-tool,
per-phase hint line must keep reaching the status bar; there must be **one keyboard
owner** (which fixes D1 and D2); and the snap flags stay model state.

Defects to fix in the port, not carry over: D1 `R` rotates a ghost and switches to
Room (two window listeners) · D2 a tool letter interrupts typed precision entry ·
D3 the status bar cannot name 8 of 22 tools (one source with TOOL_GROUPS) ·
D4 the Tools tooltip contradicts its default · D5 `Backspace` deletes geometry
(`Del` alone deletes; `Backspace` belongs to the precision buffer).

## Definition of done (v1)

- `npm run typecheck` clean, `npm test` green.
- `npm run dev` serves the studio shell at http://localhost:5174.
- Import a DXF → it lands in the register with identity, opens on CAD-black,
  pans/zooms, layers toggle.
- Import a DWG (service running) and a PDF → both file into the register.
- BBS tab runs the orchestrated engine (with OpenRouter key from `.env`); every
  row opens into its derivation; blocked rows name their missing facts.
