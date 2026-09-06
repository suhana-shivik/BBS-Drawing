import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { attachmentSize, extractXlsx } from '../../src/studio/chatAttachments';

describe('chat attachments', () => {
  it('extracts readable rows from an xlsx workbook before it reaches the model', () => {
    const workbook = zipSync({
      'xl/sharedStrings.xml': strToU8(
        '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Member</t></si><si><t>TB1</t></si><si><t>Cover</t></si></sst>',
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>30</v></c></row></sheetData></worksheet>',
      ),
    });

    const buffer = workbook.buffer.slice(workbook.byteOffset, workbook.byteOffset + workbook.byteLength);
    expect(extractXlsx(buffer)).toContain('Member\tCover');
    expect(extractXlsx(buffer)).toContain('TB1\t30');
  });

  it('renders compact file sizes for attachment chips', () => {
    expect(attachmentSize(2_048)).toBe('2 KB');
    expect(attachmentSize(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});

