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
    expect(doc.editBaselineText).toHaveBeenCalledWith(
      {
        base: 'the big fish',
        digest: 'd0',
        gaps: [{ start: 12, end: 12, value: ' swam' }],
      },
      expect.anything(),
    );
    h.unmount();
  });

  it('sends nothing for a save with nothing changed, and leaves the box', async () => {
    const doc = withDigest({ body: 'the fish' });
    const h = await mountDocumentHook(useBaselineOperations, { doc });
    await act(async () => h.api.handleEdit());
    await act(async () => h.api.handleSave());
    expect(doc.editBaselineText).not.toHaveBeenCalled();
    expect(h.api.isEditing).toBe(false);
    // Typed and taken back is no change either.
    await act(async () => h.api.handleEdit());
    await act(async () => h.api.handleTextChange(typed('the fishy')));
    await act(async () => h.api.handleTextChange(typed('the fish')));
    await act(async () => h.api.handleSave());
    expect(doc.editBaselineText).not.toHaveBeenCalled();
    expect(h.api.isEditing).toBe(false);
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

  describe('text typed while the save is on its way', () => {
    // Type " two" after "one", save, and type " three" while it is out.
    const typeDuringSave = async (doc) => {
      const h = await mountDocumentHook(useBaselineOperations, { doc });
      await act(async () => h.api.handleEdit());
      await act(async () =>
        h.api.editLogHandlers.onKeyDown({ target: { selectionStart: 3, selectionEnd: 3 } }),
      );
      await act(async () => h.api.handleTextChange(typed('one two')));
      let saved;
      await act(async () => {
        saved = h.api.handleSave();
      });
      await act(async () => h.api.handleTextChange(typed('one two three')));
      return { h, saved };
    };

    it('is kept in the box after the save lands, still to save, and saved as edits of the text stored', async () => {
      const answer = deferred();
      const doc = withDigest({ body: 'one', editBaselineText: vi.fn(() => answer.promise) });
      const { h, saved } = await typeDuringSave(doc);
      expect(hasUnsavedDraft()).toBe('The baseline text you have typed');
      await act(async () => {
        doc.body = 'one two';
        doc.layerInfo.primaryTextLayer.text.digest = 'd1';
        answer.resolve(true);
        await saved;
      });
      expect(doc.editBaselineText.mock.calls[0][0].gaps).toEqual([
        { start: 3, end: 3, value: ' two' },
      ]);
      expect(h.api.isEditing).toBe(true);
      expect(h.api.editedText).toBe('one two three');
      expect(hasUnsavedDraft()).toBe('The baseline text you have typed');
      doc.editBaselineText = vi.fn(async () => true);
      await act(async () => h.api.handleSave());
      expect(doc.editBaselineText).toHaveBeenCalledWith(
        {
          base: 'one two',
          digest: 'd1',
          gaps: [{ start: 7, end: 7, value: ' three' }],
        },
        expect.anything(),
      );
      h.unmount();
    });

    it('is moved onto what someone else saved meanwhile', async () => {
      const answer = deferred();
      const doc = withDigest({ body: 'one', editBaselineText: vi.fn(() => answer.promise) });
      const { h, saved } = await typeDuringSave(doc);
      await act(async () => {
        doc.body = 'zero one two';
        doc.layerInfo.primaryTextLayer.text.digest = 'd2';
        answer.resolve(true);
        await saved;
      });
      expect(h.api.isEditing).toBe(true);
      expect(h.api.editedText).toBe('zero one two three');
      doc.editBaselineText = vi.fn(async () => true);
      await act(async () => h.api.handleSave());
      expect(doc.editBaselineText).toHaveBeenCalledWith(
        {
          base: 'zero one two',
          digest: 'd2',
          gaps: [{ start: 12, end: 12, value: ' three' }],
        },
        expect.anything(),
      );
      h.unmount();
    });

    it('goes back behind the edits of a save that failed', async () => {
      const answer = deferred();
      const doc = withDigest({ body: 'one', editBaselineText: vi.fn(() => answer.promise) });
      const { h, saved } = await typeDuringSave(doc);
      await act(async () => {
        answer.resolve(false);
        await saved;
      });
      expect(h.api.isEditing).toBe(true);
      expect(h.api.editedText).toBe('one two three');
      doc.editBaselineText = vi.fn(async () => true);
      await act(async () => h.api.handleSave());
      expect(doc.editBaselineText).toHaveBeenCalledWith(
        {
          base: 'one',
          digest: 'd0',
          gaps: [{ start: 3, end: 3, value: ' two three' }],
        },
        expect.anything(),
      );
      h.unmount();
    });
  });

  // The second review of the edit-operation path (G1, U2, U3).
  describe('a save that failed after it landed, and a conflict', () => {
    const typeAndSave = async (doc) => {
      const h = await mountDocumentHook(useBaselineOperations, { doc });
      await act(async () => h.api.handleEdit());
      await act(async () =>
        h.api.editLogHandlers.onKeyDown({ target: { selectionStart: 3, selectionEnd: 3 } }),
      );
      await act(async () => h.api.handleTextChange(typed('one two')));
      let saved;
      await act(async () => {
        saved = h.api.handleSave();
      });
      return { h, saved };
    };
    // A save that stored the edit and then failed at a step after it: the
    // document is read again after it.
    const failsAfter = (answer) =>
      vi.fn(async (sent, outcome) => {
        await answer.promise;
        doc.body = 'one two';
        doc.layerInfo.primaryTextLayer.text.digest = 'd1';
        Object.assign(outcome, { landed: true, conflict: false });
        return false;
      });
    let doc;

    it('landed: the edits sent are not put back in the draft, and what was typed since is kept (G1)', async () => {
      const answer = deferred();
      doc = withDigest({ body: 'one' });
      doc.editBaselineText = failsAfter(answer);
      const { h, saved } = await typeAndSave(doc);
      await act(async () => h.api.handleTextChange(typed('one two three')));
      await act(async () => {
        answer.resolve();
        await saved;
      });
      expect(h.api.isEditing).toBe(true);
      expect(h.api.editedText).toBe('one two three');
      doc.editBaselineText = vi.fn(async () => true);
      await act(async () => h.api.handleSave());
      expect(doc.editBaselineText.mock.calls[0][0]).toEqual({
        base: 'one two',
        digest: 'd1',
        gaps: [{ start: 7, end: 7, value: ' three' }],
      });
      h.unmount();
    });

    it('landed, nothing typed since: the box closes with no draft (G1)', async () => {
      const answer = deferred();
      doc = withDigest({ body: 'one' });
      doc.editBaselineText = failsAfter(answer);
      const { h, saved } = await typeAndSave(doc);
      await act(async () => {
        answer.resolve();
        await saved;
      });
      expect(h.api.isEditing).toBe(false);
      expect(hasUnsavedDraft()).toBe(null);
      h.unmount();
    });

    it('refused because the same passage changed: says so until the next save or Cancel (U3)', async () => {
      doc = withDigest({
        body: 'one',
        editBaselineText: vi.fn(async (sent, outcome) => {
          Object.assign(outcome, { landed: false, conflict: true });
          return false;
        }),
      });
      const { h, saved } = await typeAndSave(doc);
      await act(async () => saved);
      expect(h.api.changedElsewhere).toBe(true);
      expect(h.api.editedText).toBe('one two');
      await act(async () => h.api.handleTextChange(typed('one two!')));
      expect(h.api.changedElsewhere).toBe(true);
      await act(async () => h.api.handleCancel());
      expect(h.api.changedElsewhere).toBe(false);
      h.unmount();
    });

    it('a failure that is no conflict says nothing lasting', async () => {
      doc = withDigest({ body: 'one', editBaselineText: vi.fn(async () => false) });
      const { h, saved } = await typeAndSave(doc);
      await act(async () => saved);
      expect(h.api.changedElsewhere).toBe(false);
      h.unmount();
    });

    it('landed, with what was typed since not movable onto the text stored: says so (U2)', async () => {
      const answer = deferred();
      doc = withDigest({ body: 'one', editBaselineText: vi.fn(() => answer.promise) });
      const { h, saved } = await typeAndSave(doc);
      // Typed over the word someone else changes meanwhile.
      await act(async () =>
        h.api.editLogHandlers.onKeyDown({ target: { selectionStart: 0, selectionEnd: 3 } }),
      );
      await act(async () => h.api.handleTextChange(typed('ONE two', 3)));
      await act(async () => {
        doc.body = 'uno two';
        doc.layerInfo.primaryTextLayer.text.digest = 'd2';
        answer.resolve(true);
        await saved;
      });
      expect(h.api.isEditing).toBe(true);
      expect(h.api.editedText).toBe('ONE two');
      expect(h.api.changedElsewhere).toBe(true);
      h.unmount();
    });
  });
});
