import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { fakeDocument, mountDocumentHook } from '../../../test/mountDocumentHook.jsx';
import { useBaselineOperations } from './useBaselineOperations.js';

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
      primaryTokenLayer: { id: 'w', tokens: [{ id: 'w1', begin: 0, end: 3 }] },
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
