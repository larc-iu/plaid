import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { hasUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';
import { fakeDocument, mountDocumentHook } from '../../../test/mountDocumentHook.jsx';
import { useBaselineOperations } from './useBaselineOperations.js';

const { notifyError } = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock('@/utils/feedback', async (importOriginal) => ({
  ...(await importOriginal()),
  notifyError,
}));

const typed = (value, caret = value.length) => ({
  target: { value, selectionStart: caret, selectionEnd: caret },
});

// A throw inside a save (a bug, not a refusal the document reports) is shown,
// and the draft stays to be saved again.
describe('useBaselineOperations, a save that throws', () => {
  it('shows an error, keeps the draft, and the next Save sends it', async () => {
    notifyError.mockClear();
    const doc = fakeDocument({
      body: 'one',
      layerInfo: { primaryTextLayer: { id: 'tl-1', text: { id: 't-1', digest: 'd0' } } },
      editBaselineText: vi.fn(async () => {
        throw new RangeError('Maximum call stack size exceeded');
      }),
    });
    const h = await mountDocumentHook(useBaselineOperations, { doc });
    await act(async () => h.api.handleEdit());
    await act(async () => h.api.handleTextChange(typed('one two')));
    await act(async () => h.api.handleSave());
    expect(notifyError).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'RangeError' }),
      'Failed to save baseline text',
    );
    expect(h.api.saving).toBe(false);
    expect(h.api.isEditing).toBe(true);
    expect(h.api.editedText).toBe('one two');
    expect(hasUnsavedDraft()).toBe('The baseline text you have typed');

    doc.editBaselineText = vi.fn(async () => true);
    await act(async () => h.api.handleSave());
    expect(doc.editBaselineText).toHaveBeenCalledWith(
      { base: 'one', digest: 'd0', gaps: [{ start: 3, end: 3, value: ' two' }] },
      expect.anything(),
    );
    h.unmount();
  });
});
