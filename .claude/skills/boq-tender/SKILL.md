---
name: boq-tender
description: Reading and reconciling an Indian tender Bill of Quantities — document structure, item grammar, rate-only and provisional items, and what a drawing take-off can and cannot supply.
---

# Indian Tender BOQ

Written against a real package: `ELECTRICAL_WORKS_BOQ.xls` from the Oriental
Nagpur logistics park tender, issued alongside its drawings. Every structural
claim below was counted in that file, not recalled.

---

## 1. The shape of the document — and the number that matters

```
597 rows total
 70 rows carry a quantity and a unit     ← the measurable bill
 23 preamble clauses (A, B, C …)
 77 numbered items (1.2, 1.3, 3.1 …)
 75 lettered sub-items  a) b) c)
 23 roman sub-items     i) ii) iii)
```

**Under 12% of a tender BOQ is a measurable line.** The rest is scope,
exclusions, specification, mode of measurement and headings. Anyone claiming to
"generate the BOQ from drawings" is claiming the wrong thing: drawings can
support part of the 70, and nothing else.

### Hierarchy

```
BOQ FOR ELECTRICAL WORKS (R0)          title, carries the revision
  Note / Preamble
    A  Scope of work …                 clause, no quantity
    B  All items shall be treated as supply, installation, testing …
    H  Cables: unless specified … 1100 V grade …
  1.2  Supplying, installing … 22 KV grade XLPE armoured cable
       a)  3 x 240 Sq.mm. Cable (E)        1500   RM
       b)  3 x 185 Sq.mm. Cable (E)         370   RM
  1.3  Supplying and making cable end termination …
       a)  3 x 240 Sq.mm. Cable               8   Sets
```

**The parent numbered row usually carries the specification and NO quantity;
its lettered children carry the sizes and the numbers.** A parser that only
reads rows with quantities loses the specification the quantity belongs to.

---

## 2. Item grammar — SITC

Nearly every item opens with the same construction:

> **"Supplying, installing, testing & commissioning of …"**

often abbreviated SITC. Preamble clause B in this tender makes it a default:
*"All the items of work shall be treated as supply, installation, testing,
commissioning and handover unless otherwise mentioned."*

Consequences when writing or matching items:

- The verb phrase is boilerplate. **Match on the noun and its specification**,
  not on the opening words.
- Scope words carry contractual weight: *including*, *complete with*,
  *as required*, *excluding*. "Including lugs" means the lugs are not a
  separate line — pricing them twice is a real error.
- The specification follows the noun: rating, size, material, standard, make.

---

## 3. Units, and their inconsistency

Counted in this one document:

| Unit | Rows | Note |
|---|---|---|
| `Mtrs.` | 25 | running metres |
| `Nos` | 20 | |
| `RM` | 18 | running metres — **same thing as `Mtrs.`** |
| `Nos.` | 3 | same as `Nos` |
| `Sets` | 2 | |
| `No.` | 1 | |
| `Pair` | 1 | |

Four spellings for two units, inside one issued tender. **Normalise before
comparing anything**, and never treat a unit string as an identifier.

`RM`/`Mtrs.` dominate: 43 of 70 measurable rows are linear. On an electrical
tender the bill is mostly **cable**, which is why a cable schedule matters more
than a symbol count.

---

## 4. Rate-only, provisional and "as required" items

A family of lines that carry a rate but no reliable quantity. They exist
because the quantity is genuinely unknown at tender.

| Kind | How it reads | What it means |
|---|---|---|
| **Rate only (RO)** | quantity blank, or `1`, or `RO` in the qty column | the contractor quotes a unit rate; the quantity is measured on site and paid at that rate |
| **Provisional sum** | a lump figure with no breakdown | a budget allowance, adjusted against actuals |
| **"as required"** | inside the description | scope is open — the contractor prices to satisfy a performance requirement, not a count |
| **Day work** | rates per hour / per person | for instructed work outside the bill |

Seen verbatim in this tender:

> *"Panel General Accessories **as required**"*
> *"Provision should be made to select DG's priority **as required in field only**"*
> *"stay set with turn buckles 7/2 MM GI stranded wire … complete **as required**"*

### The rule that matters

**Never compute a quantity for a rate-only item, and never report one as
"missing from the drawing".** It is missing by design. A take-off that flags
`Panel General Accessories as required` as an omission is reporting the
contract working correctly as a defect, and after the third such note the
reviewer stops reading the notes.

Detect them and set them aside as a class, with the reason.

---

## 5. What a drawing take-off can and cannot supply

For the 70 measurable rows of this tender:

| BOQ item | Drawing can supply it? |
|---|---|
| Cable, per size, in RM | **Partly** — from a cable schedule or measured route; a single-line diagram shows connectivity, not length |
| Panels, DBs, transformers, in Nos | **Yes** — countable symbols |
| Light fittings, fans, sockets | **Yes** — countable, by type |
| Earthing strip in RM | **Yes** if the earthing layout is drawn |
| Cable end terminations, in Sets | **No** — derived from cable runs and the specification, not drawn |
| Lugs, glands, danger plates, jointing kits | **No** — specification items |
| Testing, commissioning, documentation | **No** |
| Rate-only / provisional | **Never** — see §4 |

So the honest output of a multi-sheet take-off against a tender BOQ is a
**reconciliation**, in four buckets:

1. **Supported** — BOQ line, drawings measure it, both figures shown
2. **Disagrees** — measured differs from BOQ; the delta is the finding
3. **Not measurable** — specification or rate-only; excluded with the reason
4. **Drawn but not billed** — measured on the drawings, absent from the BOQ.
   *This is the commercially valuable bucket*: at tender it is a rate-loading
   opportunity, and during execution it is a variation claim.

---

## 6. Reading the file

- Tender BOQs are frequently **legacy binary `.xls`** (OLE2, magic
  `D0 CF 11 E0`), not `.xlsx`. A zip-based reader will not open them.
- Sheets are usually `Cover Page`, `Summary`, `BOQ` — the Summary is
  section-wise totals and is derived, so reconcile against `BOQ`.
- The title row carries the revision (`BOQ FOR ELECTRICAL WORKS (R0)`) and
  must travel with any comparison. A BOQ compared against the wrong revision
  is worse than no comparison.
- Rate and Amount columns are **empty at tender** — the contractor fills them.
  An empty rate is not missing data.

---

## 7. How to apply this

1. **Parse structure before items.** Preamble, section, numbered item,
   sub-item. Attach each quantity to its parent's specification.
2. **Classify every row** — measurable, specification-derived, rate-only,
   preamble. Only the first is a take-off target.
3. **Normalise units** before any comparison.
4. **Match on noun plus specification**, never on the SITC verb phrase.
5. **Report in the four buckets of §5**, and say which drawings supported each
   figure.
6. Read every quantity you emit off the drawing, and every quantity you compare
   against off the BOQ. Neither is ever typed by a model.
