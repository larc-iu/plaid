import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// A vocabulary's History (audit-vocab-history, ruled b): a rail of every change
// to it, and the vocabulary as it was after any of them, handed to the Entries
// tab read-only and read at that time.

const shown = vi.hoisted(() => ({ props: null }));
vi.mock('./VocabularyItems', () => ({
  VocabularyItems: (props) => {
    shown.props = props;
    return null;
  },
}));
vi.mock('./VocabularyMaintainers', () => ({ VocabularyMaintainers: () => null }));
vi.mock('./VocabularyCommentsTab', () => ({ VocabularyCommentsTab: () => null }));
vi.mock('@/components/projects/settings/TagsetsManager.jsx', () => ({
  TagsetsManager: () => null,
}));
vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  humanizeError: (e) => String(e),
}));
vi.mock('@ui/components/shared/ConfirmProvider', () => ({ useConfirm: () => async () => false }));
vi.mock('@ui/domain/CommentStore', () => ({
  CommentStore: class {
    load() {
      return Promise.resolve();
    }
  },
}));
vi.mock('@ui/domain/useCommentStore', () => ({ useCommentStore: () => 0 }));
const auth = vi.hoisted(() => ({
  client: null,
  user: { id: 'u', isAdmin: false },
  logout: vi.fn(),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));

const { VocabularyDetail } = await import('./VocabularyDetail.jsx');

const THEN = '2026-09-20T10:00:00Z';
const reads = [];
const client = {
  projects: { list: async () => [] },
  vocabLayers: {
    get: async (id, withItems, asOf) => {
      reads.push([id, !!withItems, asOf ?? null]);
      return {
        id,
        name: 'Lexicon',
        maintainers: ['u'],
        config: { igt: { fields: { gloss: { inline: true } } } },
        ...(asOf ? { items: [{ id: 'a', form: 'kai' }] } : {}),
      };
    },
    audit: async (...args) => {
      audits.push(args);
      return log;
    },
  },
};
const audits = [];
const log = [
  {
    id: 'op1',
    time: THEN,
    endTime: THEN,
    message: 'Edit entry "kai"',
    ops: [{ id: 'op1', time: THEN, description: 'Update vocab item x' }],
  },
];

const settle = async (view) => {
  for (let i = 0; i < 4; i++) await view.step(async () => {});
};
const button = (name) => all(document.body, 'button').find((b) => b.textContent.trim() === name);

describe('the vocabulary History', () => {
  it('lists the changes, and hands the Entries tab the vocabulary as it was, read-only', async () => {
    auth.client = client;
    const view = await renderComponent(
      <MemoryRouter initialEntries={['/vocabularies/A']}>
        <Routes>
          <Route path="/vocabularies/:vocabularyId" element={<VocabularyDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    await settle(view);
    expect(shown.props.past).toBeNull();

    await view.step(() => button('History').click());
    await settle(view);
    const row = all(document.body, 'span').find((s) => s.textContent === 'Edit entry "kai"');
    expect(row).toBeTruthy();

    await view.step(() => row.click());
    // Read-only from the click, before the read lands.
    await settle(view);
    expect(reads).toContainEqual(['A', true, THEN]);
    expect(shown.props.past.time).toBe(THEN);
    expect(shown.props.past.vocabulary.items).toEqual([{ id: 'a', form: 'kai' }]);
    expect(shown.props.canRestore).toBe(true);
    expect(document.body.textContent).toContain('Read-only. This is the vocabulary as of');
    const settings = all(document.body, '[role="tab"]').find((t) =>
      t.textContent.includes('Settings'),
    );
    expect(settings.hasAttribute('data-disabled')).toBe(true);

    await view.step(() => button('Return to current').click());
    await settle(view);
    expect(shown.props.past).toBeNull();
    await view.unmount();
  });

  it('leaves the past state behind when the reader walks to another vocabulary', async () => {
    auth.client = client;
    let go;
    const Nav = () => {
      go = useNavigate();
      return null;
    };
    const view = await renderComponent(
      <MemoryRouter initialEntries={['/vocabularies/A']}>
        <Nav />
        <Routes>
          <Route path="/vocabularies/:vocabularyId" element={<VocabularyDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    await settle(view);
    await view.step(() => button('History').click());
    await settle(view);
    const row = all(document.body, 'span').find((s) => s.textContent === 'Edit entry "kai"');
    await view.step(() => row.click());
    await settle(view);
    expect(shown.props.past).not.toBeNull();

    await view.step(() => go('/vocabularies/B'));
    await settle(view);
    expect(shown.props.vocabularyId).toBe('B');
    expect(shown.props.past).toBeNull();
    expect(document.body.textContent).not.toContain('Read-only. This is the vocabulary as of');
    await view.unmount();
  });

  it("lists one entry's changes from the entry's History, and every change from the vocabulary's", async () => {
    auth.client = client;
    audits.length = 0;
    const view = await renderComponent(
      <MemoryRouter initialEntries={['/vocabularies/A']}>
        <Routes>
          <Route path="/vocabularies/:vocabularyId" element={<VocabularyDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    await settle(view);
    await view.step(() => shown.props.onOpenHistory('a'));
    await settle(view);
    expect(audits.at(-1)).toEqual(['A', undefined, undefined, undefined, 'a']);
    expect(shown.props.historyItemId).toBe('a');
    // The vocabulary's own button widens the rail to every change.
    await view.step(() => button('History').click());
    await settle(view);
    expect(audits.at(-1)).toEqual(['A', undefined, undefined, undefined, undefined]);
    expect(shown.props.historyItemId).toBeNull();
    await view.unmount();
  });
});
