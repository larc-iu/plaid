import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// Undo over what a vocabulary's History entry changed: its entries, and every
// link to them in any document, for the vocabulary's maintainers. A row left
// is shown at its entry or at its document.

const feedback = vi.hoisted(() => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }));
vi.mock('@/utils/feedback', () => feedback);

const { VocabHistoryChanges } = await import('./VocabHistoryChanges.jsx');

// A merge of kay into kai: kay deleted, its link in d1 moved to kai.
const OWN = [
  {
    kind: 'vocab-item',
    id: 'kay',
    vocabLayer: 'v1',
    before: { id: 'kay', form: 'kay', metadata: {} },
  },
];
const LINKS = [
  {
    kind: 'vocab-link',
    id: 'l1',
    document: 'd1',
    before: { id: 'l1', tokens: ['m1'], vocabItem: { id: 'kay', layer: 'v1' } },
    after: { id: 'l1', tokens: ['m1'], vocabItem: { id: 'kai', layer: 'v1' } },
  },
];
const PAST = {
  time: 't',
  vocabulary: { id: 'v1', name: 'Story lexicon', items: [{ id: 'kai', form: 'kai' }] },
};

let view;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const settle = () =>
  view.step(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });

const mount = async ({ canUndo, undo, onUndone = vi.fn() }) => {
  const client = {
    audit: {
      changesPage: vi.fn(async (entryId, { vocabLayerId }) => ({
        entries: vocabLayerId ? OWN : [...OWN, ...LINKS],
        nextCursor: null,
      })),
      undo,
    },
    documents: { get: vi.fn(async () => ({ name: 'Story one', project: 'p1' })) },
  };
  view = await renderComponent(
    <MemoryRouter>
      <VocabHistoryChanges
        client={client}
        vocabularyId="v1"
        entry={{ id: 'g1', label: 'Merge' }}
        past={PAST}
        canUndo={canUndo}
        onUndone={onUndone}
      />
    </MemoryRouter>,
  );
  await settle();
  return { onUndone };
};

const undoButton = (root = view.container) =>
  all(root, 'button').find((b) => b.textContent.trim() === 'Undo') ?? null;
const press = (el) =>
  view.step(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
const dialog = () => document.body.querySelector('[data-testid="undo-dialog"]');

describe('Undo over a vocabulary History entry’s changes', () => {
  it('is offered to the vocabulary’s maintainers only', async () => {
    await mount({ canUndo: false });
    expect(view.container.textContent).toContain('1 entry, 1 link in 1 document');
    expect(undoButton()).toBeNull();
  });

  it('undoes the vocabulary’s part, every row left shown at its entry or document', async () => {
    const left = [
      { kind: 'vocab-item', id: 'kay', vocabLayer: 'v1', reason: 'name-taken' },
      { kind: 'vocab-link', id: 'l1', document: 'd1', reason: 'locked' },
    ];
    const undo = vi.fn().mockResolvedValue({
      entry: 'g1',
      undone: {},
      skipped: left,
      skippedCount: 2,
      notUndone: [],
    });
    await mount({ canUndo: true, undo });
    await press(undoButton());
    await settle();
    expect(undo).toHaveBeenCalledWith('g1', {
      dryRun: true,
      documentId: undefined,
      vocabLayerId: 'v1',
    });
    expect(dialog().textContent).toContain('Nothing to undo.');
    const places = all(dialog(), '[data-place]').map((p) => [
      p.textContent,
      p.querySelector('a')?.getAttribute('href') ?? null,
    ]);
    expect(places).toEqual([
      ['Story one1 change', '/projects/p1/documents/d1'],
      ['kay1 change', '/vocabularies/v1?item=kay'],
    ]);
  });

  it('goes back to the vocabulary now after an undo', async () => {
    const summary = {
      entry: 'g1',
      undone: {
        vocabItems: { inserted: 1, updated: 0, deleted: 0 },
        vocabLinks: { inserted: 0, updated: 1, deleted: 0 },
      },
      skipped: [],
      skippedCount: 0,
      notUndone: [],
    };
    const undo = vi.fn().mockResolvedValue(summary);
    const { onUndone } = await mount({ canUndo: true, undo });
    await press(undoButton());
    await settle();
    expect(dialog().querySelector('[data-testid="undo-line"]').textContent).toBe(
      '1 link and 1 lexicon entry brought back',
    );
    await press(undoButton(dialog()));
    await settle();
    expect(undo).toHaveBeenLastCalledWith('g1', { documentId: undefined, vocabLayerId: 'v1' });
    expect(feedback.notifySuccess).toHaveBeenCalledWith(
      '1 link and 1 lexicon entry brought back.',
      'Undone',
    );
    expect(onUndone).toHaveBeenCalledTimes(1);
  });
});
