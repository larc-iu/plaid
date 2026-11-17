import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// An entry's Ask opens the assistant panel on the entry. On a window too narrow
// for the panel there is no panel, no header chip and no edge rail, so the
// entry offers a link to the vocabulary's project's Assistant tab in its place:
// the assistant can always be reached (DOC found 8).

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
  useAssistantAvailable: (_client, projectId) => (projectId ? true : null),
}));
vi.mock('@ui/components/assistant/subject.js', () => ({
  useAskAssistant: () => () => {},
  useAssistantSubject: () => {},
}));
const dock = vi.hoisted(() => ({ wide: false }));
vi.mock('@ui/components/assistant/useDock.js', () => ({ useWideEnoughToDock: () => dock.wide }));
const auth = vi.hoisted(() => ({ client: null, user: { id: 'u', isAdmin: false } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));

const { VocabularyItems } = await import('./VocabularyItems.jsx');
const { WriteQueue } = await import('@ui/domain/WriteQueue.js');

const PROJECT = { id: 'home', name: 'Home', vocabs: [{ id: 'v1' }], readers: [], writers: ['u'] };

const mount = async () => {
  const client = {
    withOperation: (_label, fn) => fn(() => {}),
    query: async () => ({ results: [[0]] }),
    projects: { list: async () => [PROJECT] },
    vocabLayers: {
      get: async (id, withItems) => ({
        id,
        name: 'Lexicon',
        config: {},
        ...(withItems ? { items: [{ id: 'a', form: 'kay', metadata: { gloss: 'eat' } }] } : {}),
      }),
    },
  };
  auth.client = client;
  const view = await renderComponent(
    <MemoryRouter initialEntries={['/vocabularies/v1?item=a']}>
      <VocabularyItems
        vocabularyId="v1"
        vocabulary={{ id: 'v1', name: 'Lexicon', project: 'home' }}
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

const ask = (root) => all(root, 'button').find((b) => b.textContent.trim() === 'Ask') ?? null;
const tabLink = (root) =>
  all(root, 'a').find((a) => a.getAttribute('href') === '/projects/home?tab=assistant') ?? null;

describe("an entry's way to the assistant", () => {
  it('is Ask where the window has room for the panel', async () => {
    dock.wide = true;
    const view = await mount();
    expect(ask(view.container)).not.toBeNull();
    expect(tabLink(view.container)).toBeNull();
    await view.unmount();
  });

  it('is a link to the Assistant tab on a narrow window', async () => {
    dock.wide = false;
    const view = await mount();
    expect(ask(view.container)).toBeNull();
    expect(tabLink(view.container)?.textContent.trim()).toBe('Assistant');
    await view.unmount();
  });
});
