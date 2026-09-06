import { strFromU8, unzipSync } from 'fflate';
import type { StudioChatAttachment } from './data';

export const MAX_CHAT_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
export const MAX_ATTACHMENTS_BYTES = 30 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 160_000;

const extensionOf = (name: string): string => name.split('.').pop()?.toLowerCase() ?? '';

const TEXT_EXTENSIONS = new Set([
  'txt', 'csv', 'tsv', 'json', 'md', 'xml', 'yaml', 'yml', 'html', 'css', 'js', 'ts',
  'jsx', 'tsx', 'svg', 'dxf', 'log', 'ini', 'toml', 'sql',
]);

function dataUrlFor(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsDataURL(file);
  });
}

function xml(bytes: Uint8Array | undefined): Document | null {
  if (!bytes) return null;
  const doc = new DOMParser().parseFromString(strFromU8(bytes), 'application/xml');
  return doc.querySelector('parsererror') ? null : doc;
}

function columnNumber(reference: string): number {
  const letters = reference.match(/[A-Za-z]+/)?.[0]?.toUpperCase() ?? 'A';
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, value - 1);
}

/** Convert the readable cells of an OOXML workbook into compact TSV evidence. */
export function extractXlsx(buffer: ArrayBuffer): string {
  const archive = unzipSync(new Uint8Array(buffer));
  const shared = xml(archive['xl/sharedStrings.xml']);
  const strings = shared
    ? [...shared.querySelectorAll('si')].map((node) => [...node.querySelectorAll('t')].map((t) => t.textContent ?? '').join(''))
    : [];
  const sheets = Object.keys(archive)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const output: string[] = [];

  for (const [sheetIndex, path] of sheets.entries()) {
    const sheet = xml(archive[path]);
    if (!sheet) continue;
    output.push(`--- Sheet ${sheetIndex + 1} ---`);
    const rows = [...sheet.querySelectorAll('sheetData > row')].slice(0, 500);
    for (const row of rows) {
      const values: string[] = [];
      for (const cell of [...row.querySelectorAll(':scope > c')].slice(0, 80)) {
        const index = columnNumber(cell.getAttribute('r') ?? 'A1');
        while (values.length < index) values.push('');
        const type = cell.getAttribute('t');
        const raw = cell.querySelector('v')?.textContent ?? '';
        const value = type === 's'
          ? strings[Number(raw)] ?? ''
          : type === 'inlineStr'
            ? [...cell.querySelectorAll('is t')].map((t) => t.textContent ?? '').join('')
            : type === 'b'
              ? raw === '1' ? 'TRUE' : 'FALSE'
              : raw;
        values[index] = value.replace(/[\t\r\n]+/g, ' ').trim();
      }
      while (values.length && !values[values.length - 1]) values.pop();
      if (values.some(Boolean)) output.push(values.join('\t'));
      if (output.join('\n').length >= MAX_EXTRACTED_CHARS) break;
    }
    if (output.join('\n').length >= MAX_EXTRACTED_CHARS) break;
  }
  return output.join('\n').slice(0, MAX_EXTRACTED_CHARS);
}

export async function attachmentFromFile(file: File): Promise<StudioChatAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${file.name} is larger than 12 MB.`);
  }
  const ext = extensionOf(file.name);
  const mimeType = file.type || 'application/octet-stream';
  const isImage = mimeType.startsWith('image/');
  const isXlsx = ext === 'xlsx' || mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const isText = mimeType.startsWith('text/') || TEXT_EXTENSIONS.has(ext);
  let text: string | undefined;
  let kind: StudioChatAttachment['kind'] = 'file';

  if (isImage) kind = 'image';
  else if (isXlsx) {
    kind = 'spreadsheet';
    text = extractXlsx(await file.arrayBuffer());
    if (!text.trim()) throw new Error(`${file.name} contains no readable worksheet cells.`);
  } else if (isText) {
    kind = ext === 'csv' || ext === 'tsv' ? 'spreadsheet' : 'text';
    text = (await file.text()).slice(0, MAX_EXTRACTED_CHARS);
  }

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: file.name,
    mimeType,
    size: file.size,
    dataUrl: await dataUrlFor(file),
    ...(text !== undefined ? { text } : {}),
    kind,
  };
}

export const attachmentSize = (bytes: number): string =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

