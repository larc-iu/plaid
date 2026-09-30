import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { hasUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';
import { fakeDocument, mountDocumentHook } from '../../../test/mountDocumentHook.jsx';
import { useBaselineOperations } from './useBaselineOperations.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

// A change of the box as the textarea reports it: the new value, and the
// caret after it (UTF-16, as the DOM gives it).
const typed = (value, caret = value.length) => ({
  target: { value, selectionStart: caret, selectionEnd: caret },
});

const withDigest = (over) =>
  fakeDocument({
    layerInfo: { primaryTextLayer: { id: 'tl-1', text: { id: 't-1', digest: 'd0' } } },
    ...over,
  });

describe('useBaselineOperations', () => {
  it('sends the edits typed at the caret over the body the draft was typed over, with its digest', async () => {
    const doc = withDigest({ body: 'the big fish' });
    const h = await mountDocumentHook(useBaselineOperations, { doc });
    await act(async () => h.api.handleEdit());
    await act(async () =>
      h.api.editLogHandlers.onKeyDown({ target: { selectionStart: 12, selectionEnd: 12 } }),
    );
    await act(async () => h.api.handleTextChange(typed('the big fish swam')));
    // A refetch (a refused save, another tab's write) brings a newer body.
    await h.setInputs({ doc: { ...doc, body: 'the fish' } });
    await act(async () => h.api.handleSave());
    expect(doc.editBaselineText).toHaveBeenCalledWith({
      base: 'the big fish',
      digest: 'd0',
      gaps: [{ start: 12, end: 12, value: ' swam' }],
    });
    h.unmount();
  });

  it('keeps a letter deleted inside a word where it was deleted', async () => {
    const doc = withDigest({ body: 'aa aa aa' });
    const h = await mountDocumentHook(useBaselineOperations, { doc });
    await act(async () => h.api.handleEdit());
    // Backspace after the second word's first letter
    await act(async () =>
      h.api.editLogHandlers.onKeyDown({ target: { selectionStart: 4, selectionEnd: 4 } }),
    );
    await act(async () => h.api.handleTextChange(typed('aa a aa', 3)));
    await act(async () => h.api.handleSave());
    expect(doc.editBaselineText.mock.calls[0][0].gaps).toEqual([{ start: 3, end: 4, value: '' }]);
    h.unmount();
  });

  it('does not ask before leaving while the save is on its way, and asks again if it fails', async () => {
    const answer = deferred();
    const doc = withDigest({ body: 'one', editBaselineText: vi.fn(() => answer.promise) });
    const h = await mountDocumentHook(useBaselineOperations, { doc });
    await act(async () => h.api.handleEdit());
    await act(async () => h.api.handleTextChange(typed('one two')));
    expect(hasUnsavedDraft()).toBe('The baseline text you have typed');
    let saved;
    await act(async () => {
      saved = h.api.handleSave();
    });
    expect(h.api.saving).toBe(true);
    expect(hasUnsavedDraft()).toBe(null);
    await act(async () => {
      answer.resolve(false);
      await saved;
    });
    expect(hasUnsavedDraft()).toBe('The baseline text you have typed');
    h.unmount();
  });
});
