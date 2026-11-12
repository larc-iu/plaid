import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { refusal } from '../../../../plaid-client-js/src/testing.js';

// A vocabulary's rights are its project's roles (SPEC section 1, ruling 11.4).
// The vocabulary page and its Entries screen, with the real entry list and
// editor, as each person sees them: the maintainers, writers and readers of
// its project A (HM, HW, HR), those of a project B that links it and hold no
// role in A (BM, BW, BR), and an admin.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
  notifyPromise: vi.fn((p) => p),
  notifyWithAction: vi.fn(),
  isPermissionError: () => false,
  humanizeError: (e) => String(e),
}));
vi.mock('@ui/components/shared/ConfirmProvider', () => ({ useConfirm: () => async () => false }));
vi.mock('@ui/domain/CommentStore', () => ({
  CommentStore: class {
    load() {
      return Promise.resolve();
    }
    countFor() {
      return 0;
    }
  },
}));
vi.mock('@ui/domain/useCommentStore', () => ({ useCommentStore: () => 0 }));
vi.mock('./VocabularyCommentsTab', () => ({ VocabularyCommentsTab: () => null }));
vi.mock('@/components/projects/settings/TagsetsManager.jsx', () => ({
  TagsetsManager: () => null,
}));
vi.mock('@ui/components/assistant/useAssistantAvailable.js', () => ({
  useAssistantAvailable: () => false,
}));
vi.mock('@ui/components/assistant/subject.js', () => ({
  useAskAssistant: () => null,
  useAssistantSubject: () => {},
}));
vi.mock('@ui/components/assistant/useDock.js', () => ({ useWideEnoughToDock: () => false }));
// Radix's Select does not open here: drawn as a native select.
vi.mock('@ui/components/ui/select', () => ({
  Select: ({ value, onValueChange, children }) => (
    <select value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }) => children,
  SelectItem: ({ value, children }) => <option value={value}>{children}</option>,
  SelectTrigger: ({ id }) => <span data-trigger={id} />,
  SelectValue: () => null,
}));

const auth = vi.hoisted(() => ({ client: null, user: null, logout: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));

const { VocabularyDetail } = await import('./VocabularyDetail.jsx');

const A = {
  id: 'A',
  name: 'Ayvale',
  maintainers: ['hm'],
  writers: ['hw'],
  readers: ['hr'],
  vocabs: [{ id: 'V', name: 'Lexicon', project: 'A' }],
};
const B = {
  id: 'B',
  name: 'Beeworth',
  maintainers: ['bm'],
  writers: ['bw'],
  readers: ['br'],
  vocabs: [{ id: 'V', name: 'Lexicon', project: 'A' }],
};
// Another project HM maintains, which the vocabulary can move to.
const C = { id: 'C', name: 'Cedar', maintainers: ['hm'], writers: [], readers: [], vocabs: [] };
const PROJECTS = [A, B, C];

const hasRole = (p, user) =>
  user.isAdmin || [p.maintainers, p.writers, p.readers].some((l) => l.includes(user.id));

const clientFor = (user) => ({
  withOperation: (_label, fn) => fn(() => {}),
  batched(fn) {
    return fn(this);
  },
  query: async () => ({ results: [] }),
  vocabLayers: {
    get: async (id, withItems) => ({
      id,
      name: 'Lexicon',
      project: 'A',
      config: { igt: { fields: { gloss: { inline: true } } } },
      timeModified: null,
      ...(withItems ? { items: [{ id: 'a', form: 'kai', metadata: { gloss: 'eat' } }] } : {}),
    }),
    borrowers: async () => [{ id: 'B', name: user.isAdmin ? 'Beeworth' : null }],
  },
  projects: {
    list: async () => structuredClone(PROJECTS.filter((p) => hasRole(p, user))),
    get: async (id) => {
      const p = PROJECTS.find((x) => x.id === id);
      if (!p || !hasRole(p, user)) throw refusal(403, { error: 'Forbidden' });
      return structuredClone(p);
    },
  },
});

const mount = async (user, at) => {
  auth.user = user;
  auth.client = clientFor(user);
  const view = await renderComponent(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/vocabularies/:vocabularyId" element={<VocabularyDetail />} />
      </Routes>
    </MemoryRouter>,
  );
  for (let i = 0; i < 8; i++) await view.step(async () => {});
  return view;
};

const text = () => document.body.textContent;
const byLabel = (name) =>
  [...document.querySelectorAll('button, a')].find((b) => b.textContent.trim() === name);
const tab = (name) =>
  [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.trim() === name);
const formInput = () => document.querySelector('input[id$="-form"]');
const glossInput = () => document.querySelector('input[placeholder="Gloss"]');

const READER = 'Read only: you have reader access to “Ayvale”.';
const BORROWED = 'Read only: this vocabulary belongs to another project.';

// [who, user, what they see]
const ROLES = [
  ['HM', { id: 'hm' }, { project: 'Ayvale', manage: true, edit: true, note: null, move: true }],
  ['HW', { id: 'hw' }, { project: 'Ayvale', manage: false, edit: true, note: null }],
  ['HR', { id: 'hr' }, { project: 'Ayvale', manage: false, edit: false, note: READER }],
  ['BM', { id: 'bm' }, { project: 'another project', manage: false, edit: false, note: BORROWED }],
  ['BW', { id: 'bw' }, { project: 'another project', manage: false, edit: false, note: BORROWED }],
  ['BR', { id: 'br' }, { project: 'another project', manage: false, edit: false, note: BORROWED }],
  [
    'admin',
    { id: 'root', isAdmin: true },
    { project: 'Ayvale', manage: true, edit: true, note: null, move: true },
  ],
];

describe('the vocabulary page, by role', () => {
  it.each(ROLES)('%s', async (_who, user, see) => {
    const view = await mount(user, '/vocabularies/V?item=a');

    // The Project line under the title.
    expect(text()).toContain(`Project: ${see.project}`);
    const projectLink = [...document.querySelectorAll('a')].find(
      (a) => a.getAttribute('href') === '/projects/A',
    );
    expect(!!projectLink).toBe(see.project === 'Ayvale');
    // No Maintainers tab for anyone, Settings for a maintainer of A.
    expect(tab('Maintainers')).toBeUndefined();
    expect(!!tab('Settings')).toBe(see.manage);

    // The Entries screen.
    expect(!!byLabel('New')).toBe(see.edit);
    expect(!!byLabel('Bulk Add')).toBe(see.edit);
    expect(!!byLabel('Replace')).toBe(see.edit);
    expect(glossInput().disabled).toBe(!see.edit);
    expect(formInput().disabled).toBe(!see.manage);
    expect(!!byLabel('Save')).toBe(see.edit);
    expect(!!byLabel('Delete')).toBe(see.manage);
    expect(!!byLabel('Add sense')).toBe(see.edit);
    for (const note of [READER, BORROWED]) {
      expect(text().includes(note)).toBe(note === see.note);
    }
    await view.unmount();

    if (!see.manage) return;
    const settings = await mount(user, '/vocabularies/V?tab=settings');
    expect(document.getElementById('vocabulary-rename')).not.toBeNull();
    expect(!!document.querySelector('[data-trigger="vocabulary-move"]')).toBe(!!see.move);
    expect(!!byLabel('Delete vocabulary')).toBe(true);
    expect(text()).toContain('Used by other projects');
    expect(!!byLabel('Unlink')).toBe(true);
    await settings.unmount();
  });

  it('offers Settings only once the role in its project is known, so a link to it holds', async () => {
    const view = await mount({ id: 'hm' }, '/vocabularies/V?tab=settings');
    expect(tab('Settings').getAttribute('data-state')).toBe('active');
    await view.unmount();
  });
});
