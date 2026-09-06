---
name: indian-construction
description: Conventions, codes, terminology and measurement rules of Indian construction and AEC practice — IS codes, CPWD/DSR BOQ items, electrical distribution-board and phase naming (ACDB/UDB/R-Y-B/TPN), standard dimensions, area definitions, and site workflow. Load when interpreting Indian CAD drawings, naming or categorising quantities, building takeoff/BOQ output, decoding block or layer names, or writing prompts/validators that reason about what a drawing means.
---

# Indian construction — working knowledge

Domain reference for interpreting drawings produced by Indian architects,
consultants and EPC contractors. Use it to decode names deterministically
before reaching for a model, and to sanity-check anything a model claims.

**Rule of use: this knowledge assigns MEANING. It never produces a quantity.**
Counts, lengths and areas come from geometry (`src/cad/metrics.ts`). Domain
knowledge says *what a thing is* and *how it should be measured*; the engine
says *how much there is*.

---

## 1. Units and notation

| Thing | Indian practice |
|---|---|
| Drawing units | millimetres, almost always (`$INSUNITS` 4) |
| Length in BOQ | running metre — written `Rmt`, `RM`, `R.mt` |
| Area | `sq.m` / `Sqm` / `m²`; real estate often `sq.ft` |
| Volume | `cu.m` / `Cum` / `m³` |
| Count | `Nos.` (numbers), `No.` |
| Weight (steel) | `MT` (metric tonne) or `kg` |
| Money | `₹`, lakh (10⁵), crore (10⁷); rates as `Rs./Sqm` |
| Levels | `+3.000`, `FFL` finished floor level, `SFL` structural floor level, `NGL` natural ground level, `PL` plinth level |

Drawing annotations frequently mix: `4350X4570mm Area -20.00Sq m.` is a
single label carrying dimensions *and* area — parse both.

---

## 2. Standard dimensions (use as sanity checks)

- **Brick**: traditional 230×110×75 mm; modular 190×90×90 mm
- **Wall thickness**: 230 mm (9″ external/load-bearing), 115 mm (4½″ partition),
  150 mm, 100 mm (block/gypsum partitions). A wall measuring 230 or 115 is
  almost certainly masonry; 100/75 suggests gypsum or glass partition.
- **Floor-to-floor**: 3.0–3.3 m residential, 3.6–4.5 m commercial/industrial
- **Door**: 900×2100 (main 1000–1200), toilet 750×2100, widths in 50 mm steps
- **Window**: sill 900 typical, 1200 for toilets/high-level
- **Slab**: 100–150 mm RCC
- **Column**: 230×450, 230×300, 300×300, 300×600
- **Beam**: 230×450, 230×600 typical
- **Corridor/passage**: 1200 min, 1800–2100 typical office, labelled directly
  on plan (`2020MM WIDE PASSAGE`)
- **Staircase**: riser 150–175, tread 250–300, flight width 1000–1500

---

## 3. Area definitions (RERA-relevant, frequently confused)

- **Carpet area** — usable floor within walls, excludes external walls; the
  RERA-mandated selling basis
- **Built-up area** — carpet + wall thickness + balcony (~10–15% over carpet)
- **Super built-up area** — built-up + share of common areas (~20–35% over
  carpet); "loading factor"
- **Plinth area** — measured to outer face of external walls per IS 3861

When a takeoff reports "room area", say which one. Room boundary polygons
derived from wall *inner faces* give **carpet area**.

---

## 4. Measurement rules — IS 1200

`IS 1200` (Method of measurement of building and civil engineering works) is
the governing standard; `CPWD DSR` (Delhi Schedule of Rates) supplies item
codes and rates that most public work follows. Key rules that change numbers:

- **Brickwork / masonry**: cu.m. Deduct openings **over 0.1 sq.m**. Small
  openings and bearing of beams/lintels under 0.1 sq.m are *not* deducted.
- **Plaster**: sq.m, measured separately per face and per thickness. Deduct
  openings over 0.5 sq.m; for openings 0.5–3 sq.m deduct one face only.
  Jambs/soffits of deducted openings are added back.
- **Painting**: sq.m; coefficients apply for grilles, railings, corrugated
  sheets rather than plain area.
- **RCC**: cu.m, concrete measured net; **no deduction** for reinforcement
  volume. Reinforcement measured separately in kg/MT via the **bar bending
  schedule (BBS)**.
- **Flooring / skirting**: sq.m and Rmt respectively.
- **Excavation**: cu.m, classified by soil type and depth stage.
- **Formwork/shuttering**: sq.m of contact area.

Consequence for our BOQ: wall volume must be *net of openings over 0.1 sq.m*
to be quotable. Gross volume is not a valid Indian BOQ figure.

---

## 5. Structural conventions

- Codes: **IS 456** (RCC), **IS 800** (steel), **IS 875** (loads),
  **IS 1893** (seismic), **IS 13920** (ductile detailing), **IS 2502** (bending)
- Concrete grades: `M20`, `M25`, `M30`, `M40` (M = mix, number = char. strength MPa)
- Steel grades: `Fe415`, `Fe500`, `Fe500D`, `Fe550`
- Clear cover: 20–25 mm slab, 25–30 mm beam/column, 50 mm footing/earth-facing
- Bar marks on drawings: `8Ø`, `T12`, `#16`, `12 TOR`, `Y16` — diameter in mm
- Grid naming: numbers one way, letters the other (`1..33`, `A..P`) with
  bubbles at the ends; spacing annotated `8400 C/C` (centre to centre)
- Foundation marks: `F1`, `F2`, `C1`, `P1` (footing/column/pile types) keyed
  to a schedule table on the same sheet

---

## 6. Electrical — the highest-value decodable naming

Indian electrical SLDs use dense, *rule-decodable* abbreviations. This is
where deterministic parsing beats a model outright.

**Phase colours (this is the big one):** Indian three-phase is
**R–Y–B** (Red, Yellow, Blue) plus **N** neutral and **E** earth. A suffix
`-R1`, `-Y2`, `-B3` on a board or circuit is **phase + circuit number**, not
an arbitrary id. So `ACDB-R1`, `ACDB-Y1`, `ACDB-B1` are three circuits on
three different phases of the same board — and a balanced design should have
roughly equal counts per phase. **That is an auditable check.**

**Board types:**

| Abbrev | Meaning |
|---|---|
| `MDB` / `PCC` | Main Distribution Board / Power Control Centre |
| `SDB` | Sub Distribution Board |
| `ACDB` | AC Distribution Board (air-conditioning circuits) |
| `UDB` | UPS Distribution Board |
| `LDB` / `LPDB` | Lighting (Power) Distribution Board |
| `EDB` | Emergency Distribution Board |
| `MCC` | Motor Control Centre |
| `APFC` | Automatic Power Factor Control panel |

**Protective devices:**

| Abbrev | Meaning |
|---|---|
| `MCB` | Miniature Circuit Breaker (≤125 A) |
| `MCCB` | Moulded Case Circuit Breaker |
| `ACB` | Air Circuit Breaker (large incomers) |
| `RCCB` / `RCBO` / `ELCB` | Earth-leakage protection |
| `SPD` | Surge Protection Device |
| `MFM` | Multi-Function Meter |
| `CT` / `PT` | Current / Potential transformer |

**Pole notation:** `SP` single pole, `DP` double pole, `TP` triple pole,
`TPN` triple pole + neutral, `FP`/`4P` four pole.
So `40A FPMCB` = 40 amp four-pole MCB. `400A,TM` = 400 A thermal-magnetic.

**Supply:** `415V` three-phase, `230V` single-phase, `50Hz`.
Ratings `KVA` (apparent) vs `KW` (real); `C.L` connected load, `D.L` demand load.

**Cable notation:** `3.5X185 SQ.MM AL ARMOURED` = 3½ core, 185 mm² cross
section, aluminium, armoured. `3C X 2.5 SQ.MM CU FRLS FLEXIBLE` = 3 core,
2.5 mm², copper, flame-retardant low-smoke. `AL`=aluminium, `CU`=copper,
`XLPE`/`PVC` insulation, `FRLS` flame retardant low smoke.

Codes: **IS 732** (wiring), **IS 3043** (earthing), **IS 8061**, CEA Safety
Regulations, National Building Code (**NBC 2016**) Part 8.

---

## 7. HVAC / plumbing / fire

- `AHU` air handling unit, `FCU` fan coil unit, `VRF`/`VRV` variable refrigerant,
  `CSU` ceiling suspended, `ODU`/`IDU` outdoor/indoor unit
- Capacity in **TR** (tons of refrigeration); `2 TON AC` is a room unit
- Diffusers: supply air diffuser (SAD), return air grille (RAG), linear slot
- Ducting in sq.m of sheet; insulation separately
- Plumbing: `CPVC`/`UPVC`/`GI` pipe, `NP2`/`NP3` RCC pipe, `IC` inspection
  chamber, `MH` manhole, `STP` sewage treatment plant, `OHT`/`UGT` overhead /
  underground tank
- Fire: NBC Part 4, sprinkler/hydrant/`FE` fire extinguisher, `FHC` hose cabinet

---

## 8. Drawing and layer conventions

Indian offices vary, but common patterns:

- Layer names often descriptive rather than standardised: `WALL`, `WINDOW`,
  `DOOR`, `STEEL`, `PLASTER`, `GRID`, `Tixt` (sic — typos are common),
  `Full H Patition` (sic). **Expect misspellings; match fuzzily.**
- AIA/ISO-style prefixes appear in larger firms: `A-WALL`, `S-COLUMN`,
  `E-ELECTRICAL`, `MEP-HVAC`
- Bound XREF layers carry `$0$`: `A1 Title Sheet$0$A-DETL-THIN`
- Anonymous blocks `*D1`, `*U21` are generated dimension/array geometry, not
  symbols — exclude from schedules
- Title block bottom-right: client, project, drawing title, drawing number,
  revision, scale (often `NTS`), drawn/checked by, date
- Revision cloud + delta triangle with revision number; revision history table
- `%%U` underline, `%%D` degree, `%%C` diameter (Ø), `%%P` plus-minus

---

## 9. Project and site workflow

- Roles: Client/Owner → PMC (project management consultant) → Architect →
  Structural/MEP consultants → Contractor → subcontractors
- Contract types: item-rate, lump-sum, EPC, turnkey
- **BOQ** bill of quantities → **RA bill** (running account, monthly progress
  billing) → measured in the **MB** (measurement book) → certified by PMC
- **BBS** bar bending schedule for reinforcement
- `GFC` good for construction, `IFC` issued for construction, `AFC` approved
  for construction, `WIP`, `As-built`
- Approvals: local municipal corporation, fire NOC, environment clearance,
  RERA registration for residential sales

---

## 10. How to apply this in this codebase

1. **Decode by rule first.** A regex over `ACDB-R1` yields board type, phase
   and circuit with certainty and zero cost. Only send genuinely opaque keys
   (`A$C64AE5EFA`) to a model.
2. **Use domain knowledge as a validator, not a source of numbers.** If a
   model labels something "230 mm brick wall", check the measured thickness.
   If a phase-balance check shows R:20 Y:20 B:3, surface it as a finding —
   that is the kind of insight nobody gets by eye.
3. **Report against IS 1200 rules.** Wall volume net of openings > 0.1 sq.m;
   plaster per face; RCC without deducting steel. Label the area basis
   (carpet/built-up) explicitly.
4. **Expect messy source data** — misspelt layers, mixed units in one label,
   drawings sharing a modelspace with unrelated sheets.
