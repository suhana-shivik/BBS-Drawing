// The specification, as a file you can keep.
//
// What is on screen is already Markdown — the drawing note and every section
// note are written that way and rendered verbatim. So this does not re-render
// anything into a new format; it CONCATENATES what is already the record, with
// a header saying which drawing it came from and when.
//
// That distinction matters more than it looks. The note is the established
// reading of a drawing, and a checker reading the file has to be able to trust
// that it says exactly what the app says. Reformatting it here would create a
// second version of the truth that drifts from the first the moment either
// changes.
//
// SECTION NOTES ARE INCLUDED IN FULL. The panel keeps them folded away behind
// a disclosure each, which is right for reading on screen and wrong for a file:
// somebody downloading the specification is taking it somewhere the folds do
// not exist.

import { downloadBytes } from './exportSchedule';

export interface AboutDrawingNote {
  drawingName: string;
  updatedAt: number;
  note: string;
  conclusionCount: number;
  sectionNotes: { sectionId: string; label: string; note: string }[];
}

/** A filename a file manager will not mangle, ending in the extension. */
export function specFileName(drawingName: string): string {
  const stem = (drawingName || 'drawing')
    // strip a CAD extension first, so "X.dxf" does not become "X_dxf"
    .replace(/\.(dxf|dwg|pdf)$/i, '')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${stem || 'drawing'}-specification.md`;
}

/**
 * The whole specification for one drawing, as Markdown.
 *
 * The notes go in VERBATIM, each under a heading that names where it came
 * from. Nothing is summarised, truncated or re-worded: this file is the
 * record, and a record that has been tidied is a different document.
 */
export function specificationMarkdown(about: AboutDrawingNote, at = new Date()): string {
  const updated = new Date(about.updatedAt);
  const lines: string[] = [
    `# Specification — ${about.drawingName}`,
    '',
    `- **Drawing:** ${about.drawingName}`,
    `- **Validated conclusions:** ${about.conclusionCount}`,
    `- **Note updated:** ${updated.toLocaleString('en-IN')}`,
    `- **Exported:** ${at.toLocaleString('en-IN')}`,
    '',
    '---',
    '',
    about.note.trim(),
  ];

  if (about.sectionNotes.length) {
    lines.push(
      '',
      '---',
      '',
      `# Section notes`,
      '',
      // Said explicitly, because the count is the thing a reader checks the
      // file against: a specification missing a section is worse than one that
      // never claimed to have it.
      `${about.sectionNotes.length} section${about.sectionNotes.length === 1 ? '' : 's'} of ${about.drawingName}.`,
    );
    for (const section of about.sectionNotes) {
      lines.push(
        '',
        `## ${section.sectionId} · ${section.label}`,
        '',
        section.note.trim() || '_No note was established for this section._',
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}

/** Write the file. Same download path the schedule exports use. */
export function downloadSpecification(about: AboutDrawingNote): string {
  const name = specFileName(about.drawingName);
  downloadBytes(specificationMarkdown(about), name, 'text/markdown;charset=utf-8');
  return name;
}
