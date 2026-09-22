// The bundled frame files and what `FRAME_LANGUAGES` says about them.
//
// The settings screen names the language and the roleset count without
// loading the file, because the smallest is 916K and the largest 2.3M. That
// shortcut is only safe while these agree, so this reads the files and holds
// the table to them.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FRAME_LANGUAGES, baseTag, framesFor } from './lexicon.js';

const FILE = {
  en: 'english.json',
  zh: 'chinese.json',
  ar: 'arabic.json',
  pt: 'portuguese.json',
};

// From the package root: vitest runs there, and import.meta.url under the
// happy-dom environment does not resolve to a readable path.
const read = (name) =>
  JSON.parse(readFileSync(path.join(process.cwd(), 'src/data/frames', name), 'utf8'));

describe('the bundled frame files', () => {
  it('has one table entry per file, and no entry without a file', () => {
    expect(Object.keys(FRAME_LANGUAGES).sort()).toEqual(Object.keys(FILE).sort());
  });

  it.each(Object.keys(FILE))('counts %s exactly', (tag) => {
    expect(Object.keys(read(FILE[tag])).length).toBe(FRAME_LANGUAGES[tag].rolesets);
  });

  it('holds a roleset in the shape the pickers read', () => {
    const english = read(FILE.en);
    expect(english['give-01']).toMatchObject({ ARG0: expect.any(String) });
  });
});

describe('finding a language’s frames', () => {
  it('reads a region tag as its base language', () => {
    expect(baseTag('en-US')).toBe('en');
    expect(baseTag('PT_BR')).toBe('pt');
    expect(baseTag('')).toBe('');
    expect(framesFor('zh-Hans')?.name).toBe('Chinese');
  });

  it('is null for a language with no bundled file, which is most of them', () => {
    expect(framesFor('arp')).toBeNull();
    expect(framesFor('lez')).toBeNull();
    expect(framesFor('')).toBeNull();
    expect(framesFor(undefined)).toBeNull();
  });
});
