import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// The project the Entries screen files its assistant conversation under. A
// vocabulary belongs to one project, so that one, when this person can read
// it. After a move the old project still links the vocabulary: a member of
// both used to get no pane at all (several readable projects link it), and
// so did a member of the home who also reads a borrower (REV-VH-C S5-6).

const subject = vi.hoisted(() => ({ last: null }));
vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
  isPermissionError: () => false,
  humanizeError: (e) => String(e),
}));
vi.mock('@ui/components/shared/ConfirmProvider', () => ({ useConfirm: () => async () => true }));
vi.mock('@ui/domain/useCommentStore', () => ({ useCommentStore: () => 0 }));
vi.mock('@ui/components/assistant/useAssistantAvailable.js', () => ({
  useAssistantAvailable: () => false,
}));
vi.mock('@ui/components/assistant/subject.js', () => ({
  useAskAssistant: () => null,
  useAssistantSubject: (s) => {
    subject.last = s;
  },
}));
vi.mock('@ui/components/assistant/useDock.js', () => ({ useWideEnoughToDock: () => false }));
const auth = vi.hoisted(() => ({ client: null, user: { id: 'u', isAdmin: false } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));

const { VocabularyItems } = await import('./VocabularyItems.jsx');
const { WriteQueue } = await import('@ui/domain/WriteQueue.js');

const project = (id, name) => ({
  id,
  name,
  vocabs: [{ id: 'v1' }],
  readers: [],
  writers: ['u'],
  maintainers: [],
});

const mount = async (projects, vocabulary) => {
  const client = {
    withOperation: (_label, fn) => fn(),
    query: async () => ({ results: [] }),
    vocabLayers: { get: async () => ({ id: 'v1', name: 'Lexicon', config: {}, items: [] }) },
    projects: { list: async () => projects },
  };
  auth.client = client;
  subject.last = null;
  const view = await renderComponent(
    <MemoryRouter initialEntries={['/vocabularies/v1']}>
      <VocabularyItems
        vocabularyId="v1"
        vocabulary={vocabulary}
        client={client}
        fields={[{ name: 'gloss', type: 'text' }]}
        writes={new WriteQueue()}
      />
    </MemoryRouter>,
  );
  for (let i = 0; i < 6; i++)
    await view.step(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  return view;
};

describe('the project of the Entries screen assistant', () => {
  it("is the vocabulary's own project after a move, the old one still linking it", async () => {
    const view = await mount([project('old', 'Old'), project('home', 'Home')], {
      id: 'v1',
      name: 'Lexicon',
      project: 'home',
    });
    expect(subject.last?.projectId).toBe('home');
    expect(subject.last?.projectName).toBe('Home');
    await view.unmount();
  });

  it('is the one readable project that links it when its own cannot be read', async () => {
    const view = await mount([project('b1', 'B1')], { id: 'v1', name: 'Lexicon', project: 'home' });
    expect(subject.last?.projectId).toBe('b1');
    await view.unmount();
  });

  it('is none when several readable projects link it and its own cannot be read', async () => {
    const view = await mount([project('b1', 'B1'), project('b2', 'B2')], {
      id: 'v1',
      name: 'Lexicon',
      project: 'home',
    });
    expect(subject.last?.projectId).toBeUndefined();
    await view.unmount();
  });
});
