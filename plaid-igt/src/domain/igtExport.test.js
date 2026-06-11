import { describe, it, expect } from 'vitest';
import { formatPlain, formatGb4e, formatExpex } from './igtExport.js';

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
