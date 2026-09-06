---
name: bar-bending-schedule
description: Producing a Bar Bending Schedule from a structural reinforcement drawing — reading rebar callouts and schedule tables, shape codes and their cutting-length formulas, IS 456 / IS 2502 / IS 1786 derivations for development length, laps, hooks and bend deductions, bar counting rules, linear members (boundary walls, tie beams, fences) measured per running metre, the interview protocol for what to ask when a sheet is silent, and steel summary by diameter. Load when extracting reinforcement from a drawing, building or checking a BBS, interpreting bar callouts like "10-20+14-16" or "8 (2L)@100 c/c", asking a user for what a drawing cannot state, or wiring drawing data into a BBS engine.
---

# Bar Bending Schedule

A BBS turns a drawing's rebar callouts into a cutting list a yard can cut from
and a QS can bill against. Those two must be the same number.

**The governing rule of this codebase: we extract INPUTS, we never invent a
cutting length.** The detailer's number wins if they typed one; otherwise the
shape formula or the IS derivation produces a *suggestion* that a human
accepts. A model that outputs `cutting_length_mm = 1432` from a picture is the
exact failure this module exists to prevent — 4 mm of silent drift scraps steel.

---

## 1. What a drawing actually carries

Reinforcement drawings are terse. Expect to find:

| On the drawing | Example | Gives you |
|---|---|---|
| Element schedule table | `PEDESTAL SCHEDULE: P1 \| 730x1275` | member mark + plan size |
| Main bar callout | `10-20+14-16` | 10 nos of 20φ **plus** 14 nos of 16φ |
| Tie/stirrup callout | `8 (2L)@100 c/c` | 8φ, 2-legged, 100 mm centres |
| Distribution callout | `10 @150c/c` | 10φ at 150 mm centres |
| Zone qualifier | `ZONE A-8 @100C/C` | spacing varies along the member |
| Grade note | `CONCRETE FOR RCC WORK SHALL BE M25` | drives τbd, hence Ld |
| Cover note | `CLEAR COVER 50mm` | drives centre-line dimensions |

Expect NOT to find: cutting lengths, bar marks (often absent), shape codes,
lap positions, or hook types. Those are the detailer's to supply or the
engine's to derive.

**Callout grammar seen in the wild** — parse defensively:
```
10-20+14-16      n-φ  plus  n-φ          (mains, two diameters)
8 (2L)@100 C/C   φ (legs) @ spacing      (stirrup)
T12-150          grade-φ-spacing         (British-influenced offices)
Y16@200          Y = deformed, φ @ spacing
12φ @ 150 c/c    φ symbol may be ø Ø Φ φ or absent entirely
#16              US-influenced, rare here
```
Spacing may read `c/c`, `C/C`, `@`, or `cts`. Diameter may precede or follow.

---

## 2. Element dimensions come from the schedule table

A structural sheet almost always carries a table: `MARK | SIZE`, sometimes with
depth, sometimes not. **In DXF a table has no structure** — it is text
positioned inside a grid of lines. Reconstruct it by clustering text on Y for
rows and sorting on X for columns.

Watch for: two-column layouts (P1–P6 left, P7–P8 right on one table), merged
header cells, and the size written as `730x1275` where the BBS wants
`L = 1.275 m, B = 0.730 m` — **the drawing's order is not always L×B**.

Height and founding level usually live on a *different* sheet (the foundation
GA or a section). A BBS for a pedestal needs `H` and `Ft`; if only the plan
sheet is loaded, those are genuinely unavailable — say so, do not assume.

---

## 3. Shape codes and cutting-length formulas

`A`, `B`, `C`… are the dimensioned arms, measured centre-line.

| Code | Shape | Formula |
|---|---|---|
| 00 | Straight | `A` |
| 11 | L — one 90° bend | `A + B` |
| 21 | U — two 90° bends | `A + B + C` |
| 31 | Triangle | `A + B + C` |
| 34 | Cranked / bent-up | `A + C × B × tan(D/2)`, D default 45° |
| 41 | Rectangle | `2 × (A + B)` |
| 51 | Closed stirrup / link | `2 × (A + B)` |
| 52 | Open stirrup | `A + 2 × B` |
| 60 | Circle / ring | `π × A` |
| POL | Regular polygon | `B × A` (A side, B sides 3–20) |
| 77 | Spiral / helix | `n × √((π·A)² + B²)`, `n = C/B + 1` |

**Stirrup centre-line dimension** — the one everybody gets wrong:
```
centre-line arm = member dimension − 2 × cover − φ
```
Not `member − 2 × cover`. The bar's own diameter comes off too, because the
dimension is to the bar centre.

---

## 4. IS derivations (a second opinion, never an override)

### Development length — IS 456 cl. 26.2.1
```
Ld  = φ · σs / (4 · τbd)          σs = 0.87 · fy
τbd = Table 21 × 1.6 if deformed (cl. 26.2.1.1) × 1.25 if in compression
```
τbd for plain bars in tension (IS 456 Table 21):

| M15 | M20 | M25 | M30 | M35 | M40+ |
|---|---|---|---|---|---|
| 1.0 | 1.2 | 1.4 | 1.5 | 1.7 | 1.9 |

The table stops at M40; higher grades take the M40 value — **not extrapolated**.

> Real-world check: many Indian offices simply use **Ld = 49φ** for Fe500/M25
> and apply it uniformly. If a project's existing schedules show a flat
> multiple, that convention is the project's fact — record it in memory and use
> it rather than re-deriving something 30 mm different.

### Lap — IS 456 cl. 26.2.5.1
```
Lap = max(Ld, 30φ)   in tension
Lap = max(Ld, 24φ)   in compression
```
The floor applies *after* Ld, which is why a small bar in strong concrete does
not end up with an absurdly short lap.

**Lap is inside the cutting length, not added to it.** `lap_length × lap_count`
only declares how much of the entered length is lap, so the summary can
separate claimable lap steel from member steel.

### Hooks — IS 2502 cl. 5.2 / Table 1

| Hook | Allowance | Floor | Tail |
|---|---|---|---|
| 90° | 8φ | 75 mm | 4φ |
| 135° | 10φ | 75 mm | 6φ (seismic, IS 13920) |
| 180° | 9φ | 75 mm | 4φ |

The hook's own turn is charged as a bend alongside the shape's corners — which
is why the textbook stirrup adds `2 × 10φ` for hooks then subtracts `2 × 3φ`
for their 135° bends.

### Bend deduction — why a corner costs length

A drawing dimensions a bent bar to the **intersection** of its arms, but the
bar turns on an arc shorter than that corner. Cut to the dimensioned sum and
every bar comes out long.

```
CONVENTIONAL   45° = 1φ    90° = 2φ    135° = 3φ
ARC_EXACT      deduction = R·(2·tan(θ/2) − θ),  R = internal radius + φ/2
               allowance = arc R·θ going back on
```
Minimum internal bend radius, IS 2502 Table 2: **stirrups 2φ, main bars 4φ**.
Never mix the two modes in one schedule — that subtracts each corner twice.

---

## 5. Counting bars

```
MANUAL          n = stated number
AUTO_SPACING    span = member axis − 2 × cover
                n    = ceil(span / spacing) + 1
CUSTOM_FORMULA  expression over L, W, H, T, S, COVER, DIA
totalBars = n × no_of_times
```

**The `+ 1` is the fence-post** and it is the single most common under-count in
a hand-written BBS: eight 150 mm gaps carry nine bars.

Bars stop at the cover line, not the concrete face — hence `− 2 × cover`.
If the actual pitch (`span / gaps`) differs from the requested spacing by more
than ~1 mm, flag it: the last gap closing short is normal, but the detailer
should decide whether to re-pitch.

---

## 6. Weight — IS 1786 Table 1

Use the **nominal** mass, not `π/4·d²·ρ`. The steel invoice and the site check
sheet are both written against nominal; the two differ in the third decimal,
which is immaterial on one bar and a visible reconciliation gap over 40 tonnes.

| φ mm | 6 | 8 | 10 | 12 | 16 | 20 | 25 | 28 | 32 | 36 | 40 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| kg/m | 0.222 | 0.395 | 0.617 | 0.888 | 1.580 | 2.470 | 3.850 | 4.830 | 6.310 | 7.990 | 9.860 |

A diameter outside the table (a 22 mm import, a legacy 5 mm) falls back to
`π/4·d²·7850` — and the fallback must be **reported**, not silently applied.

```
total length (m) = cutting length (mm) × total bars / 1000
weight (kg)      = total length × unit weight
with wastage     = weight × (1 + wastage%/100)      ← ordering margin, NEVER in net weight
```

**Steel summary groups by diameter and nothing else** — two rows of 12φ in
different shapes are one line, because the yard cuts by diameter.

---

## 7. Gotchas that cost money

- **`dia_mm` arrives as a string.** Postgres returns NUMERIC as `"8.00"`, which
  misses a table keyed by `8` and silently falls through to the density
  formula — 0.394584 instead of 0.395. Coerce at every boundary.
- **`$INSUNITS` lies.** Structural DXFs routinely declare inches while
  dimensioned in millimetres. Check the declared unit against the drawing's own
  dimension labels before trusting any measured length.
- **Cutting length labelled "(Meter)" over a millimetre figure** is the one
  error on a circulated BBS sheet that scraps steel. Print the unit you mean.
- **Lap shown as a separate row double-counts** when lap is already inside the
  cutting length. Footnote it instead.
- **`+1` fence-post** (§5) — check every AUTO_SPACING row.
- **Zone-varying spacing** (`ZONE A-8@100`, `ZONE B-8@175`) is two rows, not
  one averaged row.

---

## 8. How this codebase divides the work

```
drawing  →  deterministic extraction   marks, sizes, callouts, grade, cover
                     ↓
         →  AI interpretation          which callout belongs to which member,
                                       bar type, shape code, zone handling
                                       ── MEANING ONLY, never a number ──
                     ↓
         →  engine                     counts, shape formula, IS derivation,
                                       weights from IS 1786
                     ↓
         →  detailer                   overrides any length; their number wins
```

Record per-project conventions in harness memory as they are discovered —
Ld multiple, cover, concrete/steel grade, bend mode, wastage — because they are
constant across a project's sheets and re-deriving them per drawing is how two
schedules on one site end up disagreeing.

---

## 9. Linear members — walls, tie beams, fences, trenches

The sections above assume a **counted** member: F1 exists 9 times, each
identical. A boundary wall breaks that assumption, and a schedule built on it
comes out wrong by whatever the run length was.

**Three member kinds, and everything downstream follows from the kind:**

| Kind | Examples | Quantity driver | The question that unlocks it |
|---|---|---|---|
| `counted` | footing, pedestal, column, stub col | Nos — tags or schedule | "how many?" |
| `linear` | tie beam, RCC/compound wall, plinth beam, fence, drain | **Running metres**, split into bays and zones | "what is the total run, and how does it break up?" |
| `unit` | precast panel, H-pole, gate post, coping | Nos of factory units | "how many units?" — often a supply item for the BOQ, with no cut steel at all |

### What a typical-detail sheet is

A boundary wall drawing is almost always a TYPICAL DETAIL: one bay drawn, one
section per ground condition, members declared by name+size ("TB-(350X400)",
"RCC WALL 200THK.", "H-POLE (150X150X2400)") with **no schedule table**. Two
consequences, both mandatory:

- **Counts on the layout are NOT the job.** Seven F1 tags illustrate the
  typical stretch. Real counts derive from `run ÷ bay spacing`, and the run
  exists only on the site plan or in the client's head. It MUST be asked.
- **The run is the master quantity.** Every figure — footings, columns, beam
  steel, wall steel, panels — multiplies out of it. Getting the run wrong is
  not an error in one row; it scales the whole schedule.

### Linear steel arithmetic

**Longitudinal bars** (along the run — tie beam mains, wall horizontals):
```
bars per layer  = stated count (e.g. "8-12TOR" = 8 nos of 12φ)
run per bar     = total run + laps
laps            = ceil(run / stock) − 1 per bar, lap = (noted multiple)·φ
                  stock length 12 m unless the office states otherwise
```
Forgetting laps under-orders ~4% on a 300 m wall. Continuous through columns
unless the detail breaks them — a tie beam cast bay-by-bay laps at EVERY
column, which is `bays − 1` laps, far more than stock-length laps alone.

**Transverse bars** (across the run — links, stirrups, wall verticals):
```
nos = floor(clear bay / spacing) + 1, per bay  ×  number of bays
```
Never `total run / spacing` in one division — each bay restarts the spacing
at the column face, and on 150 bays the difference is 150 bars.

**Zones from ground steps.** "LEVEL DIFFERENCE 900MM" in a title means the
wall height is not one number: stretches at different founding levels have
different vertical-bar lengths and often different sections (that is why the
sheet has SECTION 1-1 *and* 2-2). The schedule needs `(stretch length, section,
founding level)` per zone — a per-stretch table, asked, not assumed.

### Marks on these sheets

The grammar widens: `TB` (no digit), `S.C` (dotted), `TB-(350X400)`
(size-as-identity), `C2- (350x525)`, bare `(2000x300x50thk)` a line away from
its name, `200 THK. RCC WALL` (size first). Dots are typography — `S.C` ≡ SC.
A declaration ties a name to a size exactly as a schedule row does; treat it
with the same authority.

Callout dialect seen on these sheets: `10TOR@200C/C` (TOR = deformed bar, ≡
T10), `2-16TOR+2-12TOR` (compound mains), `4L-8TOR@150C/C` (4-legged),
`8TOR@200C/C(LINK)` — the `(LINK)` suffix names the bar type.

---

## 10. The interview — what to ask when the sheet is silent

The engine refuses to invent a number; this section is the other half of that
bargain: **know what to ask, ask it well, and stop when answered.**

### Rules of the interview

1. **Read first, ask second.** Never ask what the sheet answers. A cover
   TABLE in the notes means cover is a *confirm*, not a question. A global
   note ("ALL DISTRIBUTION 8@250") is a rule to apply, not a gap.
2. **Batch 5–10 questions per round**, ordered by what they unblock. One
   question per round wastes the user's time; thirty is a form, not an
   interview.
3. **Every question carries**: why it is needed, what it unblocks (which
   rows/members), what the sheet DID say nearby (evidence), and a suggestion
   only when the sheet gives a basis for one — with the basis stated.
4. **Typed answers only**: a number with a unit, a choice, a yes/no confirm,
   or a per-stretch table. Free prose cannot reach arithmetic.
5. **Challenge implausible answers** in the next round instead of swallowing
   them: a negative length, a spacing under a bar diameter, a wall height
   10× the drawn storey, an answer that contradicts a dimension on the sheet.
   Say what it contradicts and ask again.
6. **Counted vs assumed is a different question.** A count read off plan tags
   is a *confirm* ("counted 20 P5 tags — is the layout the whole job?"); a
   count nobody stated is *blocking* ("1 assumed — every quantity multiplies
   by this").
7. **Stop.** When the remaining unknowns change nothing, say the schedule is
   complete and what was assumed nowhere.

### The checklist, per member kind

**Any sheet:** concrete grade · steel grade · cover (confirm if tabulated) ·
lap/Ld multiple (confirm if noted) · wastage % · what the drawing number and
revision are, if unreadable.

**Counted members** (footing, pedestal, column):
- count per mark (confirm plan-tag counts; ask when assumed 1)
- the axis a plan cannot show: HEIGHT from levels — footing top to FFL/TOP,
  never guessable from a plan view
- starter-bar bottom leg (NOT Ld) and lap projection above — office
  conventions, on no drawing
- which of two read dimensions is which, when one was filed as height

**Linear members** (wall, tie beam, fence) — the §9 set:
- **total run in metres** (the master quantity)
- bay spacing (confirm if drawn) and number of bays
- zone table for level steps: stretch length × governing section × founding
  level
- are longitudinal bars continuous through columns or lapped each bay?
- stock length if not 12 m

**Unit members** (precast panel, H-pole):
- units per bay (panels stack: how many high?), total units
- supply-only or site-cut steel?

### Worked example — the GAMCO boundary wall sheet

Given: typical detail, F1/C1/C2/SC/TB declared with sizes, RCC WALL 200 thk,
panels 2000×300×50, poles 150×150×2400, bay spacing 2050 drawn, two sections,
"LEVEL DIFFERENCE 900MM" in the title, cover table and global bar rules in
notes. Round 1 asks — and nothing else:

1. Total run of the boundary wall, in metres. *(number, RM — blocks everything)*
2. Bay spacing reads 2050 c/c — confirm, and how many bays? *(confirm+number)*
3. How does the run split between Section 1-1 and Section 2-2, given the
   900 mm level difference? *(per-stretch table)*
4. Founding level / wall height per stretch — F.G.L to +300 is drawn; depth
   below F.G.L varies with the step. *(per-stretch table)*
5. Panels are 2000×300 — how many panels high between poles? *(number)*
6. One H-pole per bay? *(confirm)*
7. Cover table read as 50 fdn / 40 col / 30 beam / 20 slab — confirm. *(confirm)*
8. C1=15, C2=6, F1=7 were counted on the layout — whole job, or one typical
   stretch? *(choice — decides whether counts derive from the run)*

Grade, laps (50D), distribution (8@250), chairs (10), spacers (25@300) are
NOT asked: the notes state them. That is the difference between an interview
and a form.

---

## 11. Notes that legislate

General notes divide into description and LAW. The law kind governs every
member it names and answers questions before they are asked:

| Note | Rule | Feeds |
|---|---|---|
| "ALL DISTRIBUTION BARS ARE 8 @ 250 C/C" | distribution: 8φ @ 250 | every slab/wall distribution run |
| "ALL CHAIRS ARE 10" | chairs: 10φ | the chairs convention |
| "ALL SPACER BARS ARE 25 @ 300 C/C" | spacer: 25φ @ 300 | spacer rows |
| "LAPS, SPLICES & BOND LENGTH SHOULD BE 50 D" | lap/Ld multiple: 50 | `ldMultiple` — the sheet stating its own development length |
| "MINIMUM CLEAR COVER … a. FOUNDATION 50 b. COLUMN 40 …" | cover PER MEMBER | each member's cover; there is no single sheet cover |

Applying a stated rule without asking is correct. Asking about a stated rule
is noise. Overriding a stated rule silently is the one unforgivable move —
if a computed Ld disagrees with the noted 50D, the note wins and the
disagreement is reported.
