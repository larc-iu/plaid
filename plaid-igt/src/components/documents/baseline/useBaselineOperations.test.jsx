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

describe('useBaselineOperations', () => {
  it('sends the body the draft was typed over, and not the body read since', async () => {
    const doc = fakeDocument({ body: 'the big fish' });
    const h = await mountDocumentHook(useBaselineOperations, { doc });
    await act(async () => h.api.handleEdit());
    await act(async () => h.api.updateEditedText('the big fish swam'));
    // A refetch (a refused save, another tab's write) brings a newer body.
    await h.setInputs({ doc: { ...doc, body: 'the fish' } });
    await act(async () => h.api.handleSave());
    expect(doc.saveBaselineText).toHaveBeenCalledWith('the big fish swam', 'the big fish');
    h.unmount();
  });

  it('does not ask before leaving while the save is on its way, and asks again if it fails', async () => {
    const answer = deferred();
    const doc = fakeDocument({ body: 'one', saveBaselineText: vi.fn(() => answer.promise) });
    const h = await mountDocumentHook(useBaselineOperations, { doc });
    await act(async () => h.api.handleEdit());
    await act(async () => h.api.updateEditedText('one two'));
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
