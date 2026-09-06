// Local id helper. In SOURCE this lived in src/core/types.ts (app-level); the
// register domain stands alone here, so the two lines it used are inlined.

let idCounter = Math.floor(Math.random() * 1e6);

export function newId(prefix = 'el'): string {
  idCounter += 1;
  return `${prefix}_${idCounter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
