import { describe, it, expect } from 'vitest';
import { buildTextGrid, defaultTextGridOptions } from './textgrid.js';
import { makeFixtureDoc, makeSentence, makeAlignmentToken } from './testFixtures.js';

const OPTIONS = {
  orthographies: ['Translit'],
  wordFields: ['POS'],
  morphFields: ['Gloss'],
  sentFields: ['Translation'],
  wordLine: 'both',
  perSpeaker: true,
};

// A reader for Praat's long text format, strict about what Praat itself
// refuses: every tier covers the grid, intervals touch, none is empty.
function readTextGrid(text) {
  const lines = text.split('\n');
  expect(lines[0]).toBe('File type = "ooTextFile"');
  expect(lines[1]).toBe('Object class = "TextGrid"');
  const num = (line) => Number(line.split('=')[1]);
  const str = (line) => {
    const raw = line.slice(line.indexOf('"') + 1, line.lastIndexOf('"'));
    return raw.replace(/""/g, '"');
  };
  const find = (from, prefix) => {
    for (let i = from; i < lines.length; i++) if (lines[i].trim().startsWith(prefix)) return i;
    throw new Error(`no ${prefix}`);
  };
  const xmax = num(lines[find(0, 'xmax')]);
  const size = num(lines[find(0, 'size')]);
  const tiers = [];
  let at = find(0, 'item []:');
  for (let t = 0; t < size; t++) {
    at = find(at + 1, `item [${t + 1}]:`);
    const name = str(lines[find(at, 'name =')]);
    const n = num(lines[find(at, 'intervals: size')]);
    const intervals = [];
    for (let i = 0; i < n; i++) {
      at = find(at + 1, `intervals [${i + 1}]:`);
      intervals.push({
        begin: num(lines[at + 1]),
        end: num(lines[at + 2]),
        text: str(lines[at + 3]),
      });
    }
    expect(intervals[0].begin, name).toBe(0);
    expect(intervals.at(-1).end, name).toBe(xmax);
    intervals.forEach((iv, i) => {
      expect(iv.end, name).toBeGreaterThan(iv.begin);
      if (i) expect(iv.begin, name).toBe(intervals[i - 1].end);
    });
    tiers.push({ name, intervals, texts: intervals.filter((iv) => iv.text !== '') });
  }
  return { xmax, tiers, byName: Object.fromEntries(tiers.map((t) => [t.name, t])) };
}

const aligned = (extra = {}) =>
  makeFixtureDoc({ alignmentTokens: [makeAlignmentToken('a1', 0, 14, 1.25, 3.5)], ...extra });

describe('buildTextGrid', () => {
  it('writes one interval per sentence on each line, timed by its segments', () => {
    const grid = readTextGrid(buildTextGrid(aligned(), OPTIONS));
    expect(grid.tiers.map((t) => t.name)).toEqual([
      'Sentence',
      'Segment',
      'Words',
      'Morphemes',
      'Translit',
      'Gloss',
      'POS',
      'Translation',
    ]);
    const only = (name) => grid.byName[name].texts.map((iv) => [iv.begin, iv.end, iv.text]);
    expect(only('Sentence')).toEqual([[1.25, 3.5, 'perros corren.']]);
    expect(only('Words')).toEqual([[1.25, 3.5, 'perros corren']]);
    expect(only('Morphemes')).toEqual([[1.25, 3.5, 'perro=s corren']]);
    // One item per word: the unglossed and untransliterated word keeps its place.
    expect(only('Gloss')).toEqual([[1.25, 3.5, 'dog=PL _']]);
    expect(only('Translit')).toEqual([[1.25, 3.5, 'perros-translit _']]);
    expect(only('POS')).toEqual([[1.25, 3.5, 'NOUN VERB']]);
    expect(only('Translation')).toEqual([[1.25, 3.5, 'The dogs run.']]);
    // At one segment per sentence the Segment tier would repeat the Sentence tier.
    expect(grid.byName.Segment.texts).toEqual([]);
    expect(grid.xmax).toBe(3.5);
  });

  it('covers the whole recording when its length is known', () => {
    const grid = readTextGrid(buildTextGrid(aligned(), OPTIONS, { mediaSeconds: 10 }));
    expect(grid.xmax).toBe(10);
    expect(grid.byName.Sentence.intervals.map((iv) => iv.text)).toEqual(['', 'perros corren.', '']);
  });

  it('leaves out a sentence with no time, and says so', () => {
    const warnings = [];
    const grid = readTextGrid(
      buildTextGrid(makeFixtureDoc(), OPTIONS, { onWarning: (w) => warnings.push(w) }),
    );
    expect(grid.byName.Sentence.texts).toEqual([]);
    expect(warnings).toEqual([
      '1 sentence with no time-aligned segment inside it was left out. A TextGrid holds only what has a time.',
    ]);
  });

  it('writes the segments when a sentence holds two', () => {
    const doc = aligned({
      alignmentTokens: [
        makeAlignmentToken('a1', 0, 6, 1, 2),
        makeAlignmentToken('a2', 7, 14, 2.5, 3),
      ],
    });
    const grid = readTextGrid(buildTextGrid(doc, OPTIONS));
    expect(grid.byName.Segment.texts.map((iv) => [iv.begin, iv.end, iv.text])).toEqual([
      [1, 2, 'perros'],
      [2.5, 3, 'corren.'],
    ]);
    expect(grid.byName.Sentence.texts.map((iv) => [iv.begin, iv.end])).toEqual([[1, 3]]);
  });

  it('names the tiers for a single speaker, and keeps every sentence on them', () => {
    const doc = makeFixtureDoc({
      alignmentTokens: [makeAlignmentToken('a1', 0, 14, 1, 2, 'Ana')],
    });
    const grid = readTextGrid(buildTextGrid(doc, { wordLine: 'surface', perSpeaker: true }));
    expect(grid.tiers.map((t) => t.name)).toEqual(['Sentence@Ana', 'Segment@Ana', 'Words@Ana']);
    expect(grid.byName['Sentence@Ana'].texts.map((iv) => iv.text)).toEqual(['perros corren.']);
  });

  it('splits the tiers by speaker, and keeps overlapping speech that way', () => {
    const tok = (id, begin, end, content) => ({
      id,
      begin,
      end,
      content,
      metadata: {},
      orthographies: {},
      annotations: {},
      vocabItem: null,
      morphemes: [],
    });
    const doc = {
      document: { id: 'd', name: 'Two', mediaUrl: null, metadata: {} },
      body: 'uno dos',
      sortedSentences: [
        makeSentence({ begin: 0, end: 3, tokens: [tok('t1', 0, 3, 'uno')] }),
        makeSentence({ begin: 4, end: 7, tokens: [tok('t2', 4, 7, 'dos')] }),
      ],
      alignmentTokens: [
        makeAlignmentToken('a1', 0, 3, 0, 2, 'Ana'),
        makeAlignmentToken('a2', 4, 7, 1, 3, 'Bo'),
      ],
    };
    const options = { wordLine: 'surface', perSpeaker: true };
    const grid = readTextGrid(buildTextGrid(doc, options));
    expect(grid.tiers.map((t) => t.name)).toEqual([
      'Sentence@Ana',
      'Segment@Ana',
      'Words@Ana',
      'Sentence@Bo',
      'Segment@Bo',
      'Words@Bo',
    ]);
    expect(grid.byName['Sentence@Bo'].texts.map((iv) => [iv.begin, iv.end])).toEqual([[1, 3]]);

    const warnings = [];
    const one = readTextGrid(
      buildTextGrid(doc, { ...options, perSpeaker: false }, { onWarning: (w) => warnings.push(w) }),
    );
    expect(one.byName.Sentence.texts.map((iv) => iv.text)).toEqual(['uno']);
    expect(warnings[0]).toMatch(/^1 sentence overlapping another on the same tier was left out/);
  });

  it('orders a tier by time, and leaves out a segment overlapping another', () => {
    // Text order against time order: the second segment is the earlier one.
    const backwards = readTextGrid(
      buildTextGrid(
        makeFixtureDoc({
          alignmentTokens: [
            makeAlignmentToken('a1', 0, 6, 5, 6),
            makeAlignmentToken('a2', 7, 14, 1, 2),
          ],
        }),
        { wordLine: 'surface' },
      ),
    );
    expect(backwards.byName.Segment.texts.map((iv) => [iv.begin, iv.end, iv.text])).toEqual([
      [1, 2, 'corren.'],
      [5, 6, 'perros'],
    ]);

    // Two speakers at once inside one sentence.
    const warnings = [];
    const crossTalk = readTextGrid(
      buildTextGrid(
        makeFixtureDoc({
          alignmentTokens: [
            makeAlignmentToken('a1', 0, 6, 1, 3, 'Ana'),
            makeAlignmentToken('a2', 7, 14, 2, 4, 'Bo'),
          ],
        }),
        { wordLine: 'surface' },
        { onWarning: (w) => warnings.push(w) },
      ),
    );
    expect(crossTalk.byName.Segment.texts.map((iv) => iv.text)).toEqual(['perros']);
    expect(crossTalk.byName.Sentence.texts.map((iv) => [iv.begin, iv.end])).toEqual([[1, 4]]);
    expect(warnings).toEqual([
      '1 segment overlapping another inside one sentence was left out of the Segment tier.',
    ]);
  });

  it('keeps a field named like a structural tier, and doubles a quote', () => {
    const doc = aligned();
    doc.sortedSentences[0].annotations.Sentence = { value: 'say "hi"' };
    const grid = readTextGrid(
      buildTextGrid(doc, { sentFields: ['Sentence'], wordLine: 'surface' }),
    );
    // The field keeps its name, and the structural tier is the one renamed.
    expect(grid.tiers.map((t) => t.name)).toEqual(['Sentence-2', 'Segment', 'Words', 'Sentence']);
    expect(grid.byName.Sentence.texts[0].text).toBe('say "hi"');
    expect(buildTextGrid(doc, { sentFields: ['Sentence'] })).toContain('text = "say ""hi""" ');
  });

  it('writes a grid with empty tiers for a document with no sentences', () => {
    const grid = readTextGrid(
      buildTextGrid({ document: {}, body: '', sortedSentences: [], alignmentTokens: [] }, {}),
    );
    expect(grid.tiers.map((t) => t.name)).toEqual(['Sentence', 'Segment', 'Morphemes']);
    expect(grid.xmax).toBe(1);
  });

  it('selects every line for a new preset', () => {
    const layers = {
      orthographies: ['A'],
      wordFields: ['B'],
      morphFields: ['C'],
      sentFields: ['D'],
      hasMorphemes: true,
    };
    expect(defaultTextGridOptions(layers)).toEqual({
      orthographies: ['A'],
      wordFields: ['B'],
      morphFields: ['C'],
      sentFields: ['D'],
      wordLine: 'both',
      perSpeaker: true,
      includeMedia: true,
    });
  });
});
