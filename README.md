# BIMCAD Studio — Drawing Register & Bar Bending Schedule

Reads a structural reinforcement drawing (DXF or PDF), works out what it says,
asks about what it does not, and produces a Bar Bending Schedule where every
number can be traced back to the line on the sheet it came from.

Two rules govern the whole codebase:

1. **The model assigns meaning. Code computes every number.** No schema the
   model fills has a field a dimension, count, pitch or length could be typed
   into. The model points — at evidence ids, entity handles, table cells — and
   the engine reads the value off the drawing and computes with IS 456,
   IS 2502 and IS 1786.
2. **A quantity is computed only when every fact it depends on is known.** A
   missing dependency produces a formula with a named hole, never an invented
   number. A blocked cell is empty, never zero, and is in no total.

---

## Getting started

```bash
npm install
cp .env.example .env      # then fill in the values below
npm run db:migrate        # create the schema in your Supabase project
npm run dev               # Vite prints the URL — 5173 unless it is taken
```

### Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` — must be clean |
| `npm test` | The whole suite — 156 files, 2,057 tests |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:domain` | Engine and pipeline tests only |
| `npm run test:frontend` | React component tests only |
| `npm run db:migrate` | Apply `supabase/migrations/*.sql` in order |
| `npm run db:check` | Report which migrations would run, change nothing |
| `npm run db:verify` | 29 end-to-end checks against the live database |
| `npm run check:secrets` | Fail if a secret would ship in the client bundle |
| `npm run tokens` | Regenerate design tokens |

### Maintenance scripts

```bash
# Build a schedule from a drawing outside the app — the product's own path,
# nothing parallel. Writes the result JSON, the run log and the .xlsx.
npx vite-node scripts/bbs-run.ts -- --dxf "C:\path\to\drawing.dxf" \
    [--facts facts.json] [--answers answers.json] [--about about.json] \
    [--number PCD-IND-B300-S-803-R0] [--rev R0] [--turns 10] [--recalc]

node scripts/db-prune-duplicates.mjs           # report repeated runs/artifacts
node scripts/db-prune-duplicates.mjs --apply   # remove them
node scripts/auth-config.mjs --no-confirmation # turn off email confirmation
node scripts/dump-xlsx.mjs <file.xlsx>         # print a workbook as text
```

`--recalc` replays a run from its saved About Drawing memory with no model
call at all: seconds, free, and it exercises the entire deterministic path.

### Environment

Put these in `.env`. Only the two `VITE_`-prefixed keys and the Supabase
publishable key ever reach the browser — `vite-plugins/publicEnv.ts` enforces
that with an allowlist, and `npm run check:secrets` fails the build if a
secret leaks into the bundle.

| Variable | Used for |
| --- | --- |
| `SUPABASE_URL` | Project URL (client + scripts) |
| `SUPABASE_PUBLISHABLE_KEY` | Browser client — safe to ship |
| `SUPABASE_SECRET_KEY` | **Server/scripts only.** Never in the bundle |
| `SUPABASE_DB_HOST` / `_PORT` / `_PASSWORD` | Migrations. Use the session pooler host; the direct host is IPv6-only |
| `VITE_OPENROUTER_API_KEY` | Model access from the browser |
| `VITE_OPENROUTER_TEXT_MODEL` / `_VISION_MODEL` / `_JUDGE_MODEL` | Which models to use |

---

## Architecture

### The pipeline

```
DXF / PDF
   ↓  src/cad/dxf, src/cad/pdf          parse to entities
   ↓  src/cad/bbs/extract.ts            callouts, marks, dimensions, tables
   ↓  src/cad/bbs/evidence.ts           an evidence graph: every node has an id
   ↓  src/cad/bbs/sections.ts           split the sheet into readable regions
   ↓  src/cad/bbs/orchestrate.ts        the ONLY model loop — see below
   ↓  src/facts/ledger.ts               the fact ledger: values with provenance
   ↓  calculations/schedule.ts          the ONLY place a row becomes a BbsRow
   ↓  calculations/validation.ts        calculated ≠ validated; the FINAL gate
   ↓  src/io/bbsWorkbook.ts             the .xlsx every consumer reads from
```

### The one calculation path

`calculations/schedule.ts` is the single builder. Every consumer — the on-screen
table, the workbook, the CLI, the editable grid — calls `scheduleRow` and reads
its result. There is no second engine anywhere, and Excel is emphatically not
one.

Each row passes five stages, and records which one it stopped at:

```
resolveGeometry → resolveCuttingLength → calculateQuantity
    → calculateWeight → scheduleRow
        → buildSteelSummary → reconcileSchedule
```

**Cutting-length priority.** Entered by hand → the drawing's own geometry (a
traced polyline, shape `CUS`) → a stated formula → the shape formula → unresolved.
A library formula is what a schedule uses when the drawing does not draw the bar.

**Quantity.** `AUTO_SPACING` is `ceil((axis − 2·cover) / spacing) + 1` — the
fencepost is deliberate. `MANUAL` and `CUSTOM_FORMULA` outrank it. Member count
and bars per member are kept separate and multiplied; a count that cannot be
derived is `null`, never 1 and never 0.

**A second opinion.** For every row an independent derivation is built from
straight arms, exact arcs, hooks, development and lap, and compared with the
primary. Outside tolerance the row is `REJECTED` and a person settles it — the
engine does not pick.

**Custom formulas** (`calculations/formula.ts`) admit exactly `L W H T S COVER DIA`
plus arithmetic and a few rounding functions. No `eval`, no `Function`; an
unknown name is refused by name.

### The fact ledger

`src/facts/ledger.ts` holds every value with its state and provenance:
`MEASURED`, `DECLARED`, `DERIVED`, `SUPPLIED`, `MISSING`. A stronger source is
never displaced by a weaker one except by an explicit override, and the reading
is kept beside the person's value either way.

Facts cross into the engine as `EngineFact` (`src/cad/bbs/refs.ts`), carrying
`DRAWING_READ | USER_INPUT | DERIVED | ASSUMED` and the source text — so a
schedule-table cell is never described as "you told us".

> **The key-space trap.** The engine speaks `f1_width`; the ledger speaks
> `F1.width`. `stampManifest` normalises to ledger ids. A comparison across the
> two silently means "always different", which once rebuilt one schedule 162
> times.

### A run is row-specific

A **total run** is the extent of a *running* structure — a wall, a beam, a
fence. It is not a dimension of a footing or a column, so it is never asked for
globally. `runApplies` is decided per member: the structure's class, else the
member's own kind, else the shape of the drawn layout (a two-dimensional spread
of tags is a plan and is counted; a one-dimensional band could be a module of
something longer and is asked about). Tag counts are two-dimensional —
collapsing a 5 × 8 grid along one axis once counted 8 footings instead of 40.

### The model loop

`src/cad/bbs/orchestrate.ts` is the only place a model is called. It reads
sections, claims ownership of callouts, establishes placement and shape, and
asks the user for what neither the sheet nor the record states. Questions are
deduped by **dependency key** — the fact id the answer writes to — so ten rows
waiting on one cover produce one question, and an answered fact is never asked
again.

`src/cad/bbs/judge.ts` is an independent verifier that reviews the finished
reading; `verify.ts` holds the referee's gates.

### Calculated is not validated

`calculations/validation.ts` keeps two statuses apart:

- **Calculation** — `DRAFT · CALCULATING · CALCULATED · STALE · REBUILDING · ERROR`
- **Engineering** — `UNVALIDATED · PARTIALLY_VALIDATED · VALIDATED · REJECTED`

A schedule is **FINAL** only when all sixteen gates pass: no blocked rows, no
missing facts, no mismatches, geometry and cutting lengths resolved, quantity
and weight validated, the summary reconciled, the drawing hash current,
provenance present, no assumed input, no drift, **and no unresolved dispute**.
Anything less is `INCOMPLETE`, and the failing gates are named.

A **dispute** is a finding the arithmetic cannot answer — a sanity check saying
the steel per metre is a fraction of what the structure carries, an independent
verifier rejecting a placement count, a failed referee gate. Recalculating does
not clear one. A person ticks "I have checked this" and the acknowledgement is
recorded with their name and the time.

### Expand / Edit — completing a schedule

Questioning takes everything it safely can. What is left — a shape that must be
read off a section, a design cutting length — is completed in the editable
schedule (`calculations/bbsEdit.ts`, `src/components/BbsEditor.tsx`).

```
Files → BBS folder → select a schedule → Expand / Edit
   ↓  the full page: every row, every column the .xlsx carries
   ↓  white cells are inputs; grey cells are calculated and inert
   ↓  Save & recalculate
        → validate value and unit
        → USER_INPUT DataFact, keeping the drawing's value and provenance
        → record an override where they differ
        → invalidate the rows that read the fact
        → calculations/schedule.ts
        → steel summary → reconciliation → validation
        → written back to the SAME artifact
```

**An edit is a correction, not a revision.** Editing `…-BBS-v1.xlsx` leaves you
with `…-BBS-v1.xlsx`: same artifact id, same version, same file name. Only
**Save as new version** mints v2. The audit trail survives the file staying
put — the artifact carries a `history` of every edit (the fact, the value
written, the value it replaced and where that came from), and each save files a
`bbs_calculation_runs` record beside it.

Figures that must come from a drawing — shape code, A/B/C/D legs, an entered
cutting length — are accepted only against an explicit confirmation, in the
grid or via the workbook's *Confirm from drawing* column.

**Excel round trip.** Download, edit in Excel, bring it back:
`readXlsxGrids` (`src/io/xlsx.ts`) parses the workbook and `editsFromWorkbook`
turns changed cells into the same edits the grid makes. A blank cell means no
change, never "clear this".

Schedules filed before builds recorded their inputs are **reconstructed** from
what the artifact prints and then checked by re-running every bar; one that
cannot be reproduced is named and left un-editable rather than quietly edited.

### Persistence

Supabase is the source of truth; IndexedDB is a mirror so the register survives
a dropped connection. Row-level security scopes every table to its owner and
drawing files live in a private bucket.

| Table | Holds |
| --- | --- |
| `profiles` | the account |
| `projects`, `drawings`, `drawing_sections` | the register |
| `drawing_readings` | what a run read from a sheet |
| `data_facts` | the fact ledger, one row per version |
| `bbs_calculation_runs`, `bbs_rows` | every run and its rows |
| `project_artifacts` | filed outputs, with `updated_at` for in-place edits |
| `interview_logs` | what was asked, beside what was answered |

Migrations are in `supabase/migrations/`, applied in filename order by
`npm run db:migrate`.

---

## Repository layout

```
calculations/          the engine — no React, no I/O
  schedule.ts            the one row builder, stages and trace
  validation.ts          engineering validation and the FINAL gate
  bbsEdit.ts             the editable grid, edits → facts → recalculation
  formula.ts             the safe custom-formula parser

src/
  cad/bbs/             drawing understanding and the model loop
  cad/dxf, cad/pdf     parsers
  facts/               the ledger, DataFacts, blocked-row rendering
  interview/           questions, answers, session, audit
  domain/india/        IS 456 / IS 2502 / IS 1786 and the shape library
  io/                  xlsx reader and writer, the BBS workbook
  studio/              app state, the register, the real data layer
  data/                Supabase access per table
  register/            filed artifacts and versioning
  components/          the UI
  auth/                sign-in, session, the auth gate

scripts/               migrations, verification, the CLI runner
supabase/migrations/   schema, in order
tests/
  core/                engine unit tests, case by case
  domain/              pipeline, persistence and workflow tests
  frontend/            React component tests
```

## Testing

```bash
npm test           # everything
npm run typecheck  # must be clean
```

The suite is the specification. Notable files:

- `tests/core/bbs/engine-cases.test.ts` — every shape, quantity mode and IS rule,
  and every member kind: footing, column, beam, slab, wall, stair, custom.
- `tests/domain/bbs-complete-workflow.test.ts` — questions → partial schedule →
  Expand/Edit → recalculation → FINAL, plus the Excel round trip and disputes.
- `tests/domain/bbs-edit-in-place.test.ts` — an edit updates v1 and keeps its
  history; only an explicit action makes v2.
- `tests/domain/stale-loop.test.ts` — the manifest speaks one key space.
- `tests/domain/placement-run-gate.test.ts` — when a run applies, and when it does not.

No member name from any real drawing appears in calculation logic. The marks in
the fixtures are fixtures.
