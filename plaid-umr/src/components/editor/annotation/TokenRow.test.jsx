import { describe, it, expect, vi } from 'vitest';
import { renderComponent, texts } from '@ui/test/renderComponent.jsx';
import { TokenRow } from './TokenRow.jsx';

// A word of two morphemes with a morpheme gloss in two languages, the shape
// that repeats a line's key: Lamkang carries three morpheme glosses.
const sentence = () => ({
  words: [{ id: 'w1', index: 1, begin: 0, end: 7, text: 'harnuu' }],
  morphemes: [
    { id: 'm1', begin: 0, end: 7, text: 'har nuu', morphType: 'stem' },
    { id: 'm2', begin: 0, end: 7, text: 'da', morphType: 'suffix' },
  ],
  ilg: [
    { header: 'Morphemes', key: 'morphemes', lang: null, perWord: [['har nuu', 'da']] },
    {
      header: 'Morpheme Gloss (en)',
      key: 'morpheme-gloss',
      lang: 'en',
      perWord: [['its blood', 'PFV']],
    },
    {
      header: 'Morpheme Gloss (lmk)',
      key: 'morpheme-gloss',
      lang: 'lmk',
      perWord: [['hii', 'da']],
    },
  ],
});

describe('TokenRow', () => {
  it('draws two lines of one kind without a repeated key, spaces as spaces', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await renderComponent(<TokenRow sentence={sentence()} wordRef={() => undefined} />);
      expect(texts(r.container, '.umr-morph-form')).toEqual(['har nuu', 'da']);
      expect(texts(r.container, '.umr-word-gloss:not(.umr-morph-form)')).toEqual([
        'its blood',
        'hii',
        'PFV',
        'da',
      ]);
      await r.unmount();
      const keyWarnings = error.mock.calls.filter((args) =>
        args.some((a) => String(a).includes('same key')),
      );
      expect(keyWarnings).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });
});
