import { describe, it, expect } from 'vitest';
import { formatPlain, formatTsv, formatGb4e, formatExpex, formatLeipzig } from './igtExport.js';

const FIELDS = { morphFields: ['Gloss'], wordFields: ['POS'], sentFields: ['Translation'] };

const span = (v) => ({ value: v });
const SENT = {
  annotations: { Translation: span('The dogs run.') },
  tokens: [
    {
      content: 'perros',
      annotations: { POS: span('NOUN') },
      morphemes: [
        { metadata: { form: 'perro' }, annotations: { Gloss: span('dog') } },
        { metadata: { form: 's' }, annotations: { Gloss: span('PL') } },
      ],
    },
    {
      content: 'corren',
      annotations: { POS: span('VERB') },
      morphemes: [
        { metadata: { form: 'corr' }, annotations: { Gloss: span('run') } },
        { metadata: { form: 'en' }, annotations: { Gloss: span('3PL') } },
      ],
    },
    { content: '.', annotations: {}, morphemes: [] },
  ],
};

describe('formatPlain', () => {
  it('aligns segmented forms, gloss tiers, and word tiers in columns', () => {
    const out = formatPlain(SENT, FIELDS);
    expect(out).toBe([
      'perro-s  corr-en  .',
      'dog-PL   run-3PL',
      'NOUN     VERB',
      '‘The dogs run.’',
    ].join('\n'));
  });

  it('pads by code points so astral forms align', () => {
    const s = {
      annotations: {},
      tokens: [
        { content: '𝕒𝕒', annotations: {}, morphemes: [{ metadata: { form: '𝕒𝕒' }, annotations: { Gloss: span('x') } }] },
        { content: 'b', annotations: {}, morphemes: [{ metadata: { form: 'b' }, annotations: { Gloss: span('yy') } }] },
      ],
    };
    const lines = formatPlain(s, { morphFields: ['Gloss'], wordFields: [], sentFields: [] }).split('\n');
    // "𝕒𝕒" is 2 code points wide -> second column starts after width 2 + 2 spaces.
    expect(lines[0]).toBe('𝕒𝕒  b');
    expect(lines[1]).toBe('x   yy');
  });
});

describe('formatTsv', () => {
  it('emits one tab-separated row per tier plus translation rows', () => {
    const out = formatTsv(SENT, FIELDS);
    expect(out.split('\n')).toEqual([
      'perro-s\tcorr-en\t.',
      'dog-PL\trun-3PL\t',
      'NOUN\tVERB\t',
      'The dogs run.',
    ]);
  });

  it('collapses tabs/newlines inside cells', () => {
    const s = {
      annotations: {},
      tokens: [{ content: 'a\tb', annotations: {}, morphemes: [] }],
    };
    const out = formatTsv(s, { morphFields: [], wordFields: [], sentFields: [] });
    expect(out).toBe('a b');
  });
});

describe('formatLeipzig', () => {
  it('emits a data-gloss div with one <p> per tier and the translation', () => {
    const out = formatLeipzig(SENT, FIELDS);
    expect(out.split('\n')).toEqual([
      '<div data-gloss>',
      '  <p>perro-s corr-en .</p>',
      '  <p>dog-PL run-3PL \u00a0</p>',
      '  <p>NOUN VERB \u00a0</p>',
      '  <p>‘The dogs run.’</p>',
      '</div>',
    ]);
  });

  it('escapes HTML and holds multiword cells together with NBSP', () => {
    const s = {
      annotations: {},
      tokens: [{
        content: 'x',
        annotations: { POS: span('a <b> & c') },
        morphemes: [],
      }],
    };
    const out = formatLeipzig(s, { morphFields: [], wordFields: ['POS'], sentFields: [] });
    expect(out).toContain('<p>a\u00a0&lt;b&gt;\u00a0&amp;\u00a0c</p>');
  });
});

describe('formatGb4e', () => {
  it('emits two aligned lines with {} for empty glosses and the translation', () => {
    const out = formatGb4e(SENT, FIELDS);
    expect(out).toContain('\\gll perro-s corr-en .\\\\');
    expect(out).toContain('     dog-PL run-3PL {}\\\\');
    expect(out).toContain("\\glt `The dogs run.'");
    expect(out.startsWith('\\begin{exe}')).toBe(true);
    expect(out.endsWith('\\end{exe}')).toBe(true);
  });

  it('escapes LaTeX specials', () => {
    const s = {
      annotations: {},
      tokens: [{ content: 'a_b', annotations: {}, morphemes: [{ metadata: { form: 'a_b' }, annotations: { Gloss: span('100%') } }] }],
    };
    const out = formatGb4e(s, { morphFields: ['Gloss'], wordFields: [], sentFields: [] });
    expect(out).toContain('a\\_b');
    expect(out).toContain('100\\%');
  });
});

describe('formatExpex', () => {
  it('emits the gla/glb/glft block', () => {
    const out = formatExpex(SENT, FIELDS);
    expect(out).toContain('\\gla perro-s corr-en . //');
    expect(out).toContain('\\glb dog-PL run-3PL {} //');
    expect(out).toContain("\\glft `The dogs run.' //");
    expect(out.startsWith('\\ex')).toBe(true);
    expect(out.endsWith('\\xe')).toBe(true);
  });
});
