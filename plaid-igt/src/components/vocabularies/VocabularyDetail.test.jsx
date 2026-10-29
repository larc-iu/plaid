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

// R58: a vocabulary an unfinished import made does not open until that import
// is over. It says so, and leads to the project, where Delete is.
describe('a vocabulary an unfinished import made', () => {
  it('opens on that alone, with the way to its project', async () => {
    auth.client = {
      vocabLayers: {
        get: async () => ({
          id: 'A',
          name: 'Half lexicon',
          config: { igt: { import: { projectId: 'P1' } } },
          maintainers: ['u'],
        }),
      },
      // Its project is still there, with its import unfinished.
      projects: { list: async () => [], get: async () => ({ id: 'P1' }) },
    };
    const view = await renderComponent(app);
    await view.step(() => new Promise((r) => setTimeout(r, 0)));
    expect(view.container.textContent).toContain(
      'This vocabulary belongs to an import that did not finish.',
    );
    expect(heading(view.container)).not.toBe('Half lexicon');
    const link = [...view.container.querySelectorAll('a')].find(
      (a) => a.textContent === 'Open its project',
    );
    expect(link.getAttribute('href')).toBe('/projects/P1');
    await view.unmount();
  });
});

// REV-FX-R57-3-1: a mark left on a vocabulary whose project is gone (a
// Delete whose unmark failed) never keeps it shut: it reads as no mark, and
// opening the page writes nothing (beta ruling R3).
describe('a vocabulary marked for a project that is gone', () => {
  it('opens as an ordinary vocabulary, and writes nothing', async () => {
    const unmarked = [];
    auth.client = {
      vocabLayers: {
        get: async () => ({
          id: 'A',
          name: 'Left lexicon',
          config: { igt: { import: { projectId: 'GONE' } } },
          maintainers: ['u'],
        }),
        deleteConfig: async (...a) => unmarked.push(a),
      },
      projects: {
        list: async () => [],
        get: async () => {
          throw Object.assign(new Error('Project not found'), { status: 404 });
        },
      },
    };
    const view = await renderComponent(app);
    await view.step(() => new Promise((r) => setTimeout(r, 0)));
    await view.step(() => new Promise((r) => setTimeout(r, 0)));
    expect(view.container.textContent).not.toContain('belongs to an import that did not finish');
    expect(heading(view.container)).toBe('Left lexicon');
    expect(unmarked).toEqual([]);
    await view.unmount();
  });
});
