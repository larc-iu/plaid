import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { fakeDocument, mountDocumentHook } from '../../../test/mountDocumentHook.jsx';
import {
  baselineLossSentence,
  removedStretches,
  useBaselineOperations,
} from './useBaselineOperations.js';

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
  const PUNCT = { igt: { ignoredTokens: { type: 'unicodePunctuation', whitelist: [] } } };
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
