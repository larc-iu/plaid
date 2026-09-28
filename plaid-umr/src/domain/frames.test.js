// The bundled frame files and what `FRAME_LANGUAGES` says about them.
//
// The settings screen names the language and the roleset count without
// loading the file, because the smallest is 916K and the largest 2.3M. That
// shortcut is only safe while these agree, so this reads the files and holds
// the table to them.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FRAME_LANGUAGES, argSummary, argsOf, baseTag, framesFor, sensesFor } from './lexicon.js';
import { repair } from '../data/frames/fix-arabic.mjs';

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

  // The README's shape, `"give-01": { "ARG0": "giver", ... }`. Chinese came
  // with `"ARG0:"` and Portuguese with `{ args, examples, name }`, and the
  // role picker offered neither a single argument.
  it.each(Object.keys(FILE))('holds %s rolesets as flat argument lists', (tag) => {
    const frames = read(FILE[tag]);
    const bad = Object.entries(frames).filter(
      ([, args]) =>
        !args ||
        typeof args !== 'object' ||
        Object.entries(args).some(
          ([k, v]) => !/^ARG[-A-Za-z0-9]*$/.test(k) || typeof v !== 'string',
        ),
    );
    expect(bad.slice(0, 3)).toEqual([]);
    // Some rolesets name no argument at all in the source (131 of the
    // Portuguese ones), but most must read.
    const readable = Object.keys(frames).filter((id) => argsOf(frames, id).length);
    expect(readable.length / Object.keys(frames).length).toBeGreaterThan(0.9);
  });

  it('reads the Chinese and Portuguese arguments', () => {
    expect(argsOf(read(FILE.zh), '\u751f\u6d3b-01').map((a) => a.role)).toEqual([':ARG0', ':ARG1']);
    const pt = read(FILE.pt);
    expect(argsOf(pt, 'abandonar-01').length).toBeGreaterThan(0);
    expect(argSummary(pt['abandonar-01'])).not.toMatch(/object Object/);
  });
});

// Upstream keyed 1382 Arabic rolesets with Latin letters for أ إ آ ؤ ذ ء
// (`تXكير-01`) and 106 with a doubled hyphen where a vowel class was lost
// (`نزح--01`), so no typed word was offered them. fix-arabic.mjs repairs them.
describe('the Arabic frame file', () => {
  const arabic = read(FILE.ar);
  const renames = read('arabic-renames.json');

  it('offers a repaired roleset for its word', () => {
    const ids = (word) => sensesFor(arabic, word).map((s) => s.id);
    expect(ids('\u062a\u0630\u0643\u064a\u0631')).toContain('\u062a\u0630\u0643\u064a\u0631-01'); // تذكير
    expect(ids('\u0646\u0632\u062d')).toEqual(['\u0646\u0632\u062d-01', '\u0646\u0632\u062d-02']); // نزح
    expect(ids('\u0645\u0624\u062f\u064a')).toContain('\u0645\u0624\u062f\u064a-02'); // مؤدي
    expect(ids('\u0627\u0633\u062a\u0647\u0632\u0627\u0621')).toContain(
      '\u0627\u0633\u062a\u0647\u0632\u0627\u0621-01', // استهزاء
    );
  });

  it('keeps Latin letters only in the six ids that spell English words', () => {
    const latin = Object.keys(arabic).filter((id) => /[A-Za-z]/.test(id));
    expect(latin).toHaveLength(6);
    latin.forEach((id) => expect(id).toMatch(/[ce]/));
  });

  // Each of these is a second verb of its root (أثر--01 beside أثر-01), so
  // taking the hyphen off would take the other's id.
  it('keeps a doubled hyphen only where the plain id is another roleset', () => {
    const doubled = Object.keys(arabic).filter((id) => id.includes('--'));
    expect(doubled).toHaveLength(22);
    doubled.forEach((id) => {
      const plain = id.replace('--', '-');
      expect(arabic[plain]).toBeDefined();
      expect(arabic[plain]).not.toEqual(arabic[id]);
    });
  });

  it('offers every roleset for its lemma typed bare, a lemma--NN one after the plain', () => {
    const lemma = (id) => id.replace(/-\d+$/, '').replace(/-$/, '');
    const missed = Object.keys(arabic).filter(
      (id) => !sensesFor(arabic, lemma(id)).some((s) => s.id === id),
    );
    expect(missed).toEqual([]);
    const ids = sensesFor(arabic, '\u0623\u062b\u0631').map((s) => s.id); // أثر
    expect(ids.slice(0, 4)).toEqual([
      '\u0623\u062b\u0631-01',
      '\u0623\u062b\u0631-02',
      '\u0623\u062b\u0631-03',
      '\u0623\u062b\u0631--01',
    ]);
  });

  it('holds no tanwin or other mark in an id', () => {
    expect(Object.keys(arabic).filter((id) => /[\u064b-\u0652]/.test(id))).toEqual([]);
    const ids = (word) => sensesFor(arabic, word).map((s) => s.id);
    expect(ids('\u0647\u0643\u0639')).toEqual([
      '\u0647\u0643\u0639-01',
      '\u0647\u0643\u0639-02',
      '\u0647\u0643\u0639-03',
    ]); // هكع
    expect(ids('\u0645\u062b\u0646\u064a\u0627\u064b')).toContain(
      '\u0645\u062b\u0646\u064a\u0627-02', // مثنياً finds مثنيا-02
    );
  });

  // الأم is ال + أم, and folded it also reads as ألام.
  it('lists the lemma the word writes before one only the alif fold finds', () => {
    expect(sensesFor(arabic, '\u0627\u0644\u0623\u0645')[0].id).toBe('\u0623\u0645-01');
    expect(sensesFor(arabic, '\u0642\u0631\u0623\u062a')[0].id).toBe('\u0642\u0631\u0623-01'); // قرأت
  });

  it('records every changed id, and each points at a roleset', () => {
    expect(Object.keys(renames)).toHaveLength(1466);
    Object.entries(renames).forEach(([old, id]) => {
      expect(arabic[old]).toBeUndefined();
      expect(arabic[id]).toBeDefined();
    });
  });

  it('changes nothing when run again on its own output', () => {
    const again = repair(arabic);
    expect(again.renames).toEqual({});
    expect(again.frames).toEqual(arabic);
  });

  it('merges a repaired id into an identical roleset and leaves a different one', () => {
    const out = repair({
      'Oثر-01': { ARG0: 'a' },
      'Oثر--01': { ARG0: 'b' },
      'Oثر--02': { ARG0: 'c' },
      'قر-01': { ARG0: 'x' },
      'قر--01': { ARG0: 'x' },
      'دeفeند-01': { ARG0: 'd' },
    });
    expect(out.frames).toEqual({
      'أثر-01': { ARG0: 'a' },
      'أثر--01': { ARG0: 'b' },
      'أثر-02': { ARG0: 'c' },
      'قر-01': { ARG0: 'x' },
      'دeفeند-01': { ARG0: 'd' },
    });
    expect(out.renames).toEqual({
      'Oثر-01': 'أثر-01',
      'Oثر--01': 'أثر--01',
      'Oثر--02': 'أثر-02',
      'قر--01': 'قر-01',
    });
    expect(out.leftLatin).toEqual(['دeفeند-01']);
    expect(out.leftTaken).toEqual(['Oثر--01']);
  });

  // Tanwin is written only on a word's last letter, so upstream's مثنياً loses
  // it, and هٍع, from PropBank's `haKaE` where K (kasratan) was typed for k,
  // is هكع, a verb of coughing, calm and sleep sitting.
  it('takes a tanwin mark off a lemma, and reads one inside a word as the k it was', () => {
    const out = repair({
      '\u0645\u062b\u0646\u064a\u0627\u064b-01': { ARG0: 'a' }, // مثنياً
      '\u0647\u064d\u0639-01': { ARG0: 'b' }, // هٍع
      '\u0642\u0631-01': { ARG0: 'c' }, // قر
    });
    expect(out.frames).toEqual({
      '\u0645\u062b\u0646\u064a\u0627-01': { ARG0: 'a' },
      '\u0647\u0643\u0639-01': { ARG0: 'b' },
      '\u0642\u0631-01': { ARG0: 'c' },
    });
    expect(out.renames).toEqual({
      '\u0645\u062b\u0646\u064a\u0627\u064b-01': '\u0645\u062b\u0646\u064a\u0627-01',
      '\u0647\u064d\u0639-01': '\u0647\u0643\u0639-01',
    });
  });

  // Not in today's file, but a later upstream may key one roleset both ways.
  it('never takes the id of a roleset that already had it', () => {
    const out = repair({
      'Oفك-01': { ARG0: 'new' },
      'أفك-01': { ARG0: 'old' },
      'Oمن-01': { ARG0: 'same' },
      'أمن-01': { ARG0: 'same' },
    });
    expect(out.frames).toEqual({
      'Oفك-01': { ARG0: 'new' },
      'أفك-01': { ARG0: 'old' },
      'أمن-01': { ARG0: 'same' },
    });
    expect(out.renames).toEqual({ 'Oمن-01': 'أمن-01' });
    expect(out.leftTaken).toEqual(['Oفك-01']);
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
