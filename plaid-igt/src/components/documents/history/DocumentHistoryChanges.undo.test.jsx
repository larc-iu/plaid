import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { buildRawDoc, makeIgtDoc } from '@/domain/test-helpers.js';

// Undo over what a document's History entry changed: for the project's
// maintainers only, and not while a service run writes. It undoes the entry's
// rows in this document, then goes back to the document now.

const feedback = vi.hoisted(() => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }));
vi.mock('@/utils/feedback', () => feedback);

const { DocumentHistoryChanges } = await import('./DocumentHistoryChanges.jsx');

const doc = () => {
  const raw = buildRawDoc();
  raw.textLayers[0].tokenLayers.flatMap((t) => t.spanLayers).find((s) => s.id === 'msl-0').spans = [
    { id: 'g1', value: 'walk', tokens: ['m-1'], metadata: {} },
  ];
  return makeIgtDoc({ raw });
};

const ROWS = [
  {
    kind: 'span',
    id: 'g1',
    layer: 'msl-0',
    document: 'doc-1',
    before: { id: 'g1', value: 'go', tokens: ['m-1'], metadata: {} },
    after: { id: 'g1', value: 'walk', tokens: ['m-1'], metadata: {} },
  },
];

const PROJECT = {
  id: 'proj-1',
  maintainers: ['boss'],
  writers: ['ana'],
  readers: ['rea'],
};

let view;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const mount = async ({ user, writeLockHeld = null, undo, backToNow = vi.fn() }) => {
  const d = doc();
  const client = {
    audit: {
      changesPage: vi.fn(async (entryId, { documentId }) => ({
        entries: documentId ? ROWS : [],
        nextCursor: null,
      })),
      undo,
    },
  };
  view = await renderComponent(
    <MemoryRouter>
      <DocumentHistoryChanges
        user={user}
        context={{
          client,
          projectId: 'proj-1',
          documentId: 'doc-1',
          project: PROJECT,
          writeLockHeld,
          pastEntry: { id: 'g1', label: 'Edit' },
          historySnapshot: d,
          liveDoc: d,
          backToNow,
        }}
      />
    </MemoryRouter>,
  );
  await view.step(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });
  return { client, backToNow };
};

const undoButton = () =>
  all(view.container, 'button').find((b) => b.textContent.trim() === 'Undo') ?? null;
const press = (el) =>
  view.step(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
const dialog = () => document.body.querySelector('[data-testid="undo-dialog"]');
const settle = () =>
  view.step(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });

describe('Undo over a document History entry’s changes', () => {
  it('is offered to a maintainer, not to a writer, a reader, or while a run writes', async () => {
    await mount({ user: { id: 'boss' } });
    expect(view.container.textContent).toContain('1 change, 1 replaced a person’s value');
    expect(undoButton()).not.toBeNull();
    await view.unmount();
    for (const user of [{ id: 'ana' }, { id: 'rea' }, null]) {
      await mount({ user });
      expect(view.container.textContent).toContain('1 change');
      expect(undoButton()).toBeNull();
      await view.unmount();
    }
    await mount({ user: { id: 'boss' }, writeLockHeld: { label: 'Analyze' } });
    expect(undoButton()).toBeNull();
    await view.unmount();
    // An admin maintains every project.
    await mount({ user: { id: 'root', isAdmin: true } });
    expect(undoButton()).not.toBeNull();
  });

  it('undoes this entry’s rows in this document, then goes back to now', async () => {
    const summary = {
      entry: 'g1',
      undone: { spans: { inserted: 0, updated: 1, deleted: 0 } },
      skipped: [],
      skippedCount: 0,
      notUndone: [],
    };
    const undo = vi.fn().mockResolvedValue(summary);
    const backToNow = vi.fn().mockResolvedValue(undefined);
    await mount({ user: { id: 'boss' }, undo, backToNow });
    await press(undoButton());
    await settle();
    expect(undo).toHaveBeenCalledWith('g1', {
      dryRun: true,
      documentId: 'doc-1',
      vocabLayerId: undefined,
    });
    expect(dialog().querySelector('[data-testid="undo-line"]').textContent).toBe('1 value');
    await press(all(dialog(), 'button').find((b) => b.textContent.trim() === 'Undo'));
    await settle();
    expect(undo).toHaveBeenLastCalledWith('g1', { documentId: 'doc-1', vocabLayerId: undefined });
    expect(feedback.notifySuccess).toHaveBeenCalledWith('1 value undone.', 'Undone');
    expect(backToNow).toHaveBeenCalledTimes(1);
  });
});
