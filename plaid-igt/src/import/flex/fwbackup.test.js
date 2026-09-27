import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { readFwbackup } from './fwbackup.js';

const XML = '<?xml version="1.0" encoding="utf-8"?><languageproject></languageproject>';

describe('readFwbackup', () => {
  it('reads the .fwdata and names the project after it', () => {
    const { name, xml } = readFwbackup(zipSync({ 'Lezgi.fwdata': strToU8(XML) }));
    expect(name).toBe('Lezgi');
    expect(xml).toBe(XML);
  });

  it('refuses an .fwdata holding a NUL, by its file name', () => {
    const bytes = zipSync({ 'Lezgi.fwdata': strToU8(`${XML}\u0000`) });
    expect(() => readFwbackup(bytes)).toThrow(
      'Lezgi.fwdata is not UTF-8. Save it as UTF-8 and import it again.',
    );
  });
});
