import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// One route component serves every vocabulary id, so walking from A to B keeps
// this screen mounted and starts a second load without ending the first.
// Nothing orders them, and the Settings tab holds the FIELD INVENTORY and the
// tagsets read off the loaded vocabulary: A landing last would leave A's fields
// under B's name, one Save away from writing them onto B.

vi.mock('./VocabularyItems', () => ({ VocabularyItems: () => null }));
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
  user: { id: 'u', isAdmin: true },
  logout: vi.fn(),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));

const { VocabularyDetail } = await import('./VocabularyDetail.jsx');

const VOCABS = {
  A: { id: 'A', name: 'Ayvale lexicon', config: {}, maintainers: ['u'] },
  B: { id: 'B', name: 'Beeworth lexicon', config: {}, maintainers: ['u'] },
};

// One deferred `vocabLayers.get` per id.
const deferred = () => {
  const pending = new Map();
  return {
    settle: (id) => pending.get(id)(VOCABS[id]),
    client: {
      vocabLayers: { get: (id) => new Promise((resolve) => pending.set(id, resolve)) },
      projects: { list: async () => [] },
    },
  };
};

let go;

const Nav = () => {
  go = useNavigate();
  return null;
};

const app = (
  <MemoryRouter initialEntries={['/vocabularies/A']}>
    <Nav />
    <Routes>
      <Route path="/vocabularies/:vocabularyId" element={<VocabularyDetail />} />
    </Routes>
  </MemoryRouter>
);

const heading = (container) => container.querySelector('h1')?.textContent ?? '';

describe('the vocabulary screen when the reader walks to another vocabulary', () => {
  it('keeps the vocabulary it was last asked for, however late the other answers', async () => {
    const d = deferred();
    auth.client = d.client;
    const view = await renderComponent(app);

    await view.step(() => go('/vocabularies/B'));
    await view.step(async () => d.settle('B'));
    await view.step(async () => d.settle('A'));

    expect(heading(view.container)).toBe('Beeworth lexicon');
    await view.unmount();
  });

  it('shows the newest vocabulary even when the abandoned one answers first', async () => {
    const d = deferred();
    auth.client = d.client;
    const view = await renderComponent(app);

    await view.step(() => go('/vocabularies/B'));
    await view.step(async () => d.settle('A'));
    expect(heading(view.container)).not.toBe('Ayvale lexicon');

    await view.step(async () => d.settle('B'));
    expect(heading(view.container)).toBe('Beeworth lexicon');
    await view.unmount();
  });

  it('shows what the one vocabulary it was asked for said', async () => {
    const d = deferred();
    auth.client = d.client;
    const view = await renderComponent(app);
    await view.step(async () => d.settle('A'));
    expect(heading(view.container)).toBe('Ayvale lexicon');
    await view.unmount();
  });
});
