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

// A gloss's tags are set in small caps, as plaid-igt shows and exports them
// (glossSmallCaps), and the words around them are left as they are.
describe('TokenRow glosses', () => {
  it('sets a tag in small caps and leaves a lexical gloss alone', async () => {
    const r = await renderComponent(<TokenRow sentence={sentence()} wordRef={() => undefined} />);
    expect(texts(r.container, '.plaid-sc')).toEqual(['PFV']);
    // The text reads the same with the small caps in it.
    expect(texts(r.container, '.umr-word-gloss:not(.umr-morph-form)')[2]).toBe('PFV');
    await r.unmount();
  });

  it('sets the tags of a word gloss in small caps', async () => {
    const s = {
      words: [{ id: 'w1', index: 1, begin: 0, end: 3, text: 'abc' }],
      morphemes: [],
      ilg: [{ header: 'Word Gloss (en)', key: 'word-gloss', lang: 'en', perWord: [['go.PST']] }],
    };
    const r = await renderComponent(<TokenRow sentence={s} wordRef={() => undefined} />);
    expect(texts(r.container, '.plaid-sc')).toEqual(['PST']);
    expect(texts(r.container, '.umr-word-gloss')).toEqual(['go.PST']);
    await r.unmount();
  });
});

// A line is named as the export writes it, and the names read left to right
// in either script, which is also what keeps them in the left margin of an
// RTL document (their logical insets resolve by their own direction).
describe('TokenRow line names', () => {
  it('prints the header the file is written with, not the one it was imported with', async () => {
    const s = {
      words: [{ id: 'w1', index: 1, begin: 0, end: 3, text: 'abc' }],
      morphemes: [],
      ilg: [
        { header: 'MORPHEME GLOSS(EN)', key: 'morpheme-gloss', lang: 'en', perWord: [['x']] },
        { header: 'Word Gloss', key: 'word-gloss', lang: 'en', perWord: [['y']] },
        { header: 'Speaker', key: 'other', lang: null, perWord: [['z']] },
        { header: 'SPANISH SENT GLOSS', key: 'sentence-gloss', lang: 'es', items: ['w'] },
      ],
    };
    const r = await renderComponent(
      <TokenRow sentence={s} direction="rtl" wordRef={() => undefined} />,
    );
    expect(texts(r.container, '.umr-legend .umr-tier-label')).toEqual([
      'Morpheme Gloss (en)',
      'Word Gloss (en)',
      'Speaker',
    ]);
    expect(texts(r.container, '.umr-ilg-header')).toEqual(['Sentence Gloss (es)']);
    expect(r.container.querySelector('.umr-legend').getAttribute('dir')).toBe('ltr');
    expect(r.container.querySelector('.umr-ilg-header').getAttribute('dir')).toBe('ltr');
    await r.unmount();
  });
});

// The joints between morphemes: by morph type where the morphemes are
// tokens, and none added where a stored line's items carry their own, as a
// .umr file writes them (Q3-UMR-POLISH-5).
describe('TokenRow joints', () => {
  const joints = (r) => texts(r.container, '.umr-morph-joiner');

  it('draws the morph types’ joints where the morphemes are tokens', async () => {
    const s = sentence();
    s.morphemes[1].morphType = 'enclitic';
    const r = await renderComponent(<TokenRow sentence={s} wordRef={() => undefined} />);
    expect(joints(r)).toEqual(['=']);
    await r.unmount();
  });

  it('adds none beside the joints a stored line carries', async () => {
    const r = await renderComponent(
      <TokenRow
        sentence={{
          words: [
            { id: 'w1', index: 1, begin: 0, end: 13, text: 'tsɨmɨntsarara' },
            { id: 'w2', index: 2, begin: 14, end: 18, text: 'siánígíí' },
            { id: 'w3', index: 3, begin: 19, end: 22, text: 'nuu' },
          ],
          morphemes: [],
          ilg: [
            {
              header: 'Morphemes',
              key: 'morphemes',
              lang: null,
              perWord: [
                ['ts-', 'ɨmɨntsara', '-ra'],
                ['si-', '’án', '=ígíí'],
                ['nu', 'u'],
              ],
            },
          ],
        }}
        wordRef={() => undefined}
      />,
    );
    expect(joints(r)).toEqual(['', '', '', '', '-']);
    await r.unmount();
  });
});
