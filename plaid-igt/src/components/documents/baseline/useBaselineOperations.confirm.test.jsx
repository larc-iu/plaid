import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { fakeDocument, mountDocumentHook } from '../../../test/mountDocumentHook.jsx';
import { removedStretches } from '@ui/lib/editLog.js';
import { baselineLossSentence, useBaselineOperations } from './useBaselineOperations.js';

const removesText = (base, gaps) => removedStretches(base, gaps).length > 0;

// Luke (2026-10-16): on a tokenized document, Baseline asks before a save
// only when the save deletes or replaces text. An insert, glued to a word or
// not, saves without asking.

const typed = (value, caret = value.length) => ({
  target: { value, selectionStart: caret, selectionEnd: caret },
});

const tokenized = (body) =>
  fakeDocument({
    body,
    layerInfo: {
      primaryTextLayer: { id: 'tl-1', text: { id: 't-1', digest: 'd0' } },
      primaryTokenLayer: {
        id: 'w',
        tokens: [
          { id: 'w1', begin: 0, end: 3 },
          { id: 'w2', begin: 4, end: 7 },
        ],
      },
    },
  });

const asks = () => document.body.querySelector('[role="alertdialog"]') !== null;

// Select [from, to) (UTF-16), and change the box to `next` with the caret at `caret`.
const change = async (h, from, to, next, caret) => {
  await act(async () =>
    h.api.editLogHandlers.onKeyDown({ target: { selectionStart: from, selectionEnd: to } }),
  );
  await act(async () => h.api.handleTextChange(typed(next, caret)));
};

const saveWith = async (body, edit) => {
  const doc = tokenized(body);
  const h = await mountDocumentHook(useBaselineOperations, { doc });
  await act(async () => h.api.handleEdit());
  await edit(h);
  await act(async () => {
    h.api.handleSave();
  });
  return { doc, h };
};

describe('useBaselineOperations, the confirm before a save', () => {
  // A confirm left open is portalled outside the hook's container.
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does not ask for text typed at a sentence start', async () => {
    const { doc, h } = await saveWith('The dog ran. The cat sat.', (h) =>
      change(h, 13, 13, 'The dog ran. Then The cat sat.', 18),
    );
    expect(asks()).toBe(false);
    expect(doc.editBaselineText).toHaveBeenCalled();
    await h.unmount();
  });

  it('does not ask for a word typed between two words, or letters glued to one', async () => {
    let { doc, h } = await saveWith('The dog ran.', (h) => change(h, 4, 4, 'The big dog ran.', 8));
    expect(asks()).toBe(false);
    expect(doc.editBaselineText).toHaveBeenCalled();
    await h.unmount();
    ({ doc, h } = await saveWith('The dog ran.', (h) => change(h, 7, 7, 'The dogs ran.', 8)));
    expect(asks()).toBe(false);
    expect(doc.editBaselineText).toHaveBeenCalled();
    await h.unmount();
  });

  it('does not ask for text added to a body with CRLF line breaks', async () => {
    const { doc, h } = await saveWith('one\r\ntwo', (h) => change(h, 7, 7, 'one\ntwo three', 13));
    expect(asks()).toBe(false);
    expect(doc.editBaselineText).toHaveBeenCalled();
    await h.unmount();
  });

  it('does not ask for a paste over the whole box that only adds text', async () => {
    const { doc, h } = await saveWith('one two', (h) => change(h, 0, 7, 'one two three', 13));
    expect(asks()).toBe(false);
    expect(doc.editBaselineText).toHaveBeenCalled();
    await h.unmount();
  });

  it('asks for a delete, and saves nothing until answered', async () => {
    const { doc, h } = await saveWith('The dog ran.', (h) => change(h, 3, 7, 'The ran.', 3));
    expect(asks()).toBe(true);
    expect(doc.editBaselineText).not.toHaveBeenCalled();
    await h.unmount();
  });

  it('asks for a replace', async () => {
    const { doc, h } = await saveWith('The dog ran.', (h) => change(h, 4, 7, 'The cat ran.', 7));
    expect(asks()).toBe(true);
    expect(doc.editBaselineText).not.toHaveBeenCalled();
    await h.unmount();
  });
});

describe('useBaselineOperations, the counts in the confirm', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });
  const PUNCT = { plaid: { ignoredTokens: { type: 'unicodePunctuation', whitelist: [] } } };
  const withLayers = (body, tokens, spans = []) => {
    const words = { id: 'w', config: PUNCT, tokens, spanLayers: [{ id: 'g', spans }] };
    return fakeDocument({
      body,
      layerInfo: {
        primaryTextLayer: { id: 'tl-1', text: { id: 't-1', digest: 'd0' }, tokenLayers: [words] },
        primaryTokenLayer: words,
      },
    });
  };
  const save = async (doc, edit) => {
    const h = await mountDocumentHook(useBaselineOperations, { doc });
    await act(async () => h.api.handleEdit());
    await edit(h);
    await act(async () => {
      h.api.handleSave();
    });
    return h;
  };
  const question = () => document.body.querySelector('[role="alertdialog"]')?.textContent || '';

  it('names what the shared loss counter finds in the removed text (ruling 27)', async () => {
    const doc = withLayers(
      'The dog ran.',
      [
        { id: 'w1', begin: 0, end: 3 },
        { id: 'w2', begin: 4, end: 7 },
      ],
      [{ id: 's1', tokens: ['w2'], value: 'DOG' }],
    );
    const h = await save(doc, (h) => change(h, 3, 7, 'The ran.', 3));
    expect(question()).toContain('Deletes 1 word and 1 annotation.');
    await h.unmount();
  });

  it('asks nothing when the only tokens are punctuation, as for untokenized text (ruling 29)', async () => {
    const doc = withLayers('The dog ran.', [{ id: 'p1', begin: 11, end: 12 }]);
    const h = await save(doc, (h) => change(h, 3, 7, 'The ran.', 3));
    expect(asks()).toBe(false);
    expect(doc.editBaselineText).toHaveBeenCalled();
    await h.unmount();
  });

  // REV7-IGT-4: "Ana, kuti", the comma deleted. No word changes, with or
  // without ud's token over the comma and ud's lemma on it.
  const anaKuti = (ud) => {
    const words = [
      { id: 'w1', begin: 0, end: 3 },
      ...(ud ? [{ id: 'p1', begin: 3, end: 4 }] : []),
      { id: 'w2', begin: 5, end: 9 },
    ];
    const doc = withLayers(
      'Ana, kuti',
      words,
      ud ? [{ id: 'lemma', tokens: ['p1'], value: ',' }] : [],
    );
    if (ud) {
      // ud's syntactic word nested in its comma token, with a lemma of its own.
      doc.layerInfo.primaryTextLayer.tokenLayers.push({
        id: 'ud-words',
        parentTokenLayer: 'w',
        tokens: [{ id: 'sw1', begin: 3, end: 4 }],
        spanLayers: [{ id: 'ud-lemma', spans: [{ id: 'l2', tokens: ['sw1'], value: ',' }] }],
      });
    }
    return doc;
  };

  it('asks nothing for a deletion that changes no word, with or without ud punctuation tokens', async () => {
    for (const ud of [false, true]) {
      const doc = anaKuti(ud);
      const h = await save(doc, (h) => change(h, 3, 4, 'Ana kuti', 3));
      expect(asks()).toBe(false);
      expect(doc.editBaselineText).toHaveBeenCalled();
      await h.unmount();
      document.body.innerHTML = '';
    }
  });

  it('says the same with or without ud punctuation tokens when a word goes or changes', () => {
    for (const ud of [false, true]) {
      const doc = anaKuti(ud);
      expect(baselineLossSentence(doc, [[0, 4]])).toBe('Deletes 1 word.');
      expect(baselineLossSentence(doc, [[2, 4]])).toBe('Changes the words in the removed text.');
      expect(baselineLossSentence(doc, [[3, 5]])).toBe('');
    }
  });
});

// R45: a stretch typed over that covers whole sentences or segments deletes
// them, with the translations and times on them, and one typed over exactly
// keeps them (R42 Q1), so neither it nor what is on it is counted (REV-DUMB F4).
describe('baselineLossSentence, sentences and segments', () => {
  const TRANSLATION = { igt: { sentenceRole: 'translation' } };
  // `one two.\nthree four.`: two sentences, each with a translation and a
  // segment with its times, and four words
  const lines = () => {
    const body = 'one two.\nthree four.';
    const words = {
      id: 'w',
      tokens: [
        { id: 'w1', begin: 0, end: 3 },
        { id: 'w2', begin: 4, end: 7 },
        { id: 'w3', begin: 9, end: 14 },
        { id: 'w4', begin: 15, end: 19 },
      ],
      spanLayers: [],
    };
    const sentences = {
      id: 's',
      overlapMode: 'partitioning',
      tokens: [
        { id: 's1', begin: 0, end: 9 },
        { id: 's2', begin: 9, end: 20 },
      ],
      spanLayers: [
        {
          id: 'tr',
          config: TRANSLATION,
          spans: [
            { id: 't1', tokens: ['s1'], value: 'one two' },
            { id: 't2', tokens: ['s2'], value: 'three four' },
          ],
        },
      ],
    };
    const segments = {
      id: 'a',
      tokens: [
        { id: 'a1', begin: 0, end: 8, metadata: { timeBegin: 0, timeEnd: 1 } },
        { id: 'a2', begin: 9, end: 20, metadata: { timeBegin: 1, timeEnd: 2 } },
      ],
      spanLayers: [],
    };
    return fakeDocument({
      body,
      layerInfo: {
        primaryTextLayer: {
          id: 'tl-1',
          text: { id: 't-1', digest: 'd0' },
          tokenLayers: [sentences, words, segments],
        },
        primaryTokenLayer: words,
        sentenceTokenLayer: sentences,
        alignmentTokenLayer: segments,
      },
    });
  };
  const said = (doc, gaps) => baselineLossSentence(doc, removedStretches(doc.body, gaps));

  it('counts the sentences and segments a paste over both lines covers whole', () => {
    // pasted as `uno dos.\ntres cuatro.`: only the `.` at the end is shared,
    // so the first sentence and segment lie inside the stretch
    const doc = lines();
    expect(said(doc, [{ start: 0, end: 20, value: 'uno dos.\ntres cuatro.' }])).toBe(
      'Deletes 1 sentence with 1 translation, 1 segment with its times and 4 words.',
    );
  });

  it('counts both lines deleted whole', () => {
    const doc = lines();
    expect(said(doc, [{ start: 0, end: 20, value: '' }])).toBe(
      'Deletes 2 sentences with 2 translations, 2 segments with their times and 4 words.',
    );
  });

  it('keeps a sentence and a segment typed over exactly out of the count', () => {
    const doc = lines();
    // the first sentence typed over exactly, its line break included: it and
    // its translation stay, and its segment, which the stretch covers with
    // more, goes
    expect(said(doc, [{ start: 0, end: 9, value: 'X Y!' }])).toBe(
      'Deletes 1 segment with its times and 2 words.',
    );
    // the first segment typed over exactly: it stays with its times
    expect(said(doc, [{ start: 0, end: 8, value: 'X Y!' }])).toBe('Deletes 2 words.');
  });
});

// REV-DUMB round 2: a sentence goes when all its letters do, its line break
// left or not, and a segment or sentence typed over exactly with only
// whitespace goes too (H1 to H3). `a b.\nc d.\ne f.`: three sentences with a
// translation each, three segments with times, and (with `words`) six words.
describe('baselineLossSentence, a line deleted or blanked', () => {
  const threeLines = (words = true) => {
    const t = (id, begin, end, extra = {}) => ({ id, begin, end, ...extra });
    const wordLayer = {
      id: 'w',
      tokens: words
        ? [
            t('w1', 0, 1),
            t('w2', 2, 4),
            t('w3', 5, 6),
            t('w4', 7, 9),
            t('w5', 10, 11),
            t('w6', 12, 14),
          ]
        : [],
      spanLayers: [],
    };
    const sentences = {
      id: 's',
      overlapMode: 'partitioning',
      tokens: [t('s1', 0, 5), t('s2', 5, 10), t('s3', 10, 14)],
      spanLayers: [
        {
          id: 'tr',
          config: { igt: { sentenceRole: 'translation' } },
          spans: ['s1', 's2', 's3'].map((id) => ({ id: `t-${id}`, tokens: [id], value: id })),
        },
      ],
    };
    const times = (i) => ({ metadata: { timeBegin: i, timeEnd: i + 1 } });
    const segments = {
      id: 'a',
      tokens: [t('a1', 0, 4, times(0)), t('a2', 5, 9, times(1)), t('a3', 10, 14, times(2))],
      spanLayers: [],
    };
    return fakeDocument({
      body: 'a b.\nc d.\ne f.',
      layerInfo: {
        primaryTextLayer: {
          id: 'tl-1',
          text: { id: 't-1', digest: 'd0' },
          tokenLayers: [sentences, wordLayer, segments],
        },
        primaryTokenLayer: wordLayer,
        sentenceTokenLayer: sentences,
        alignmentTokenLayer: segments,
      },
    });
  };
  const said = (doc, gaps) => baselineLossSentence(doc, removedStretches(doc.body, gaps));
  const H = 'Deletes 1 sentence with 1 translation, 1 segment with its times and 2 words.';

  it("H1: a line's text deleted, its line break left, deletes the sentence", () => {
    expect(said(threeLines(), [{ start: 5, end: 9, value: '' }])).toBe(H);
  });

  it('H2: a line selected with its line break and Enter typed is the same', () => {
    expect(said(threeLines(), [{ start: 5, end: 10, value: '\n' }])).toBe(H);
  });

  it('H3: a segment typed over exactly with a space deletes it and its sentence', () => {
    expect(said(threeLines(), [{ start: 5, end: 9, value: ' ' }])).toBe(H);
    expect(said(threeLines(false), [{ start: 5, end: 9, value: ' ' }])).toBe(
      'Deletes 1 sentence with 1 translation and 1 segment with its times.',
    );
  });
});

describe('removesText', () => {
  it('is false for inserts and for what a replace gives back at its ends', () => {
    expect(removesText('ab cd', [{ start: 2, end: 2, value: ' x' }])).toBe(false);
    expect(removesText('ab cd', [{ start: 0, end: 5, value: 'ab cd ef' }])).toBe(false);
    expect(removesText('ab cd', [{ start: 0, end: 5, value: 'x ab cd' }])).toBe(false);
    expect(removesText('a\u{1F600}b', [{ start: 1, end: 2, value: '\u{1F600}\u{1F600}' }])).toBe(
      false,
    );
  });

  it('is true for a delete or a letter typed over', () => {
    expect(removesText('ab cd', [{ start: 2, end: 3, value: '' }])).toBe(true);
    expect(removesText('ab cd', [{ start: 3, end: 4, value: 'x' }])).toBe(true);
    expect(removesText('a\u{1F600}b', [{ start: 1, end: 2, value: '\u{1F601}' }])).toBe(true);
  });
});
