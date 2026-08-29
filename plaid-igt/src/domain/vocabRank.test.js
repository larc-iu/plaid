import { describe, it, expect } from 'vitest';
import { rankVocabItems, TIERS } from './vocabRank.js';

const items = [
  { id: 'i-lar', form: 'lar', _detail: 'PL' },
  { id: 'i-ler', form: 'lerx', _detail: '' },
  { id: 'i-le', form: 'le', _detail: '' },
  { id: 'i-det', form: 'zzz', _detail: 'ler is here' },
];
const forms = (r) => r.map((it) => it.form);

describe('rankVocabItems', () => {
  it('ranks by tier against the token form when nothing is typed', () => {
    const r = rankVocabItems(items, { form: 'ler' });
    // lar / le tie on distance (1 each) and fall back to id order.
    expect(forms(r)).toEqual(['lerx', 'zzz', 'lar', 'le']);
    expect(r.map((it) => it._tier)).toEqual([TIERS.PREFIX, TIERS.DETAIL, TIERS.FUZZY, TIERS.FUZZY]);
    expect(r.every((it) => it._prec === null)).toBe(true);
  });

  it('puts precedent first, most-linked first, and carries the count', () => {
    const precedent = new Map([
      ['i-lar', 7],
      ['i-le', 9],
    ]);
    const r = rankVocabItems(items, { form: 'ler', precedent });
    expect(forms(r)).toEqual(['le', 'lar', 'lerx', 'zzz']);
    expect(r[0]._prec).toBe(9);
    expect(r[1]._prec).toBe(7);
    expect(r[2]._prec).toBeNull();
  });

  it('a typed search ranks on the typed text alone, drops fuzzy rows, ignores precedent', () => {
    const precedent = new Map([['i-lar', 7]]);
    const r = rankVocabItems(items, { form: 'ler', search: 'le', precedent });
    expect(forms(r)).toEqual(['le', 'lerx', 'zzz']);
    expect(r.every((it) => it._prec === null)).toBe(true);
  });

  it('a zero count is not precedent', () => {
    const r = rankVocabItems(items, { form: 'lar', precedent: new Map([['i-le', 0]]) });
    expect(forms(r)[0]).toBe('lar');
    expect(r[0]._prec).toBeNull();
  });
});
