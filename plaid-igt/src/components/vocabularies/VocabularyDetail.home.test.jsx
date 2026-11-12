import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { fakeClient, refusal } from '../../../../plaid-client-js/src/testing.js';
import { settle } from '@/domain/test-helpers.js';

// A vocabulary belongs to one project, its home (SPEC 5.4, 5.8): it is made
// in a project the person maintains, it moves to another they maintain, and
// its delete is refused while another project uses it. The requests are read
// as the real client sends them.

vi.mock('./VocabularyItems', () => ({ VocabularyItems: () => null }));
vi.mock('./VocabularyCommentsTab', () => ({ VocabularyCommentsTab: () => null }));
vi.mock('./VocabularyBorrowers', () => ({ VocabularyBorrowers: () => null }));
vi.mock('@/components/projects/settings/TagsetsManager.jsx', () => ({
  TagsetsManager: () => null,
}));
vi.mock('@ui/components/ui/select', () => ({
  Select: ({ value, onValueChange, children }) => (
    <select value={value} onChange={(e) => onValueChange(e.target.value)}>
      <option value="" />
      {children}
    </select>
  ),
  SelectContent: ({ children }) => children,
  SelectItem: ({ value, children }) => <option value={value}>{children}</option>,
  SelectTrigger: ({ id, disabled, children }) => (
    <span data-trigger={id} data-disabled={!!disabled}>
      {children}
    </span>
  ),
  SelectValue: ({ placeholder }) => <span data-placeholder="">{placeholder}</span>,
}));
vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  humanizeError: (e) => String(e),
}));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@ui/components/shared/ConfirmProvider', () => ({ useConfirm: () => confirm }));
vi.mock('@ui/domain/CommentStore', () => ({
  CommentStore: class {
    load() {
      return Promise.resolve();
    }
  },
}));
vi.mock('@ui/domain/useCommentStore', () => ({ useCommentStore: () => 0 }));

const auth = vi.hoisted(() => ({ client: null, user: { id: 'u' }, logout: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));

const { VocabularyDetail } = await import('./VocabularyDetail.jsx');
const feedback = await import('@/utils/feedback');

const P1 = { id: 'P1', name: 'Pear', maintainers: ['u'], writers: [], readers: [], vocabs: [] };
const P2 = { id: 'P2', name: 'Quince', maintainers: [], writers: ['u'], readers: [], vocabs: [] };
const P3 = { id: 'P3', name: 'Rowan', maintainers: ['u'], writers: [], readers: [], vocabs: [] };

let where;
const Where = () => {
  where = useLocation();
  return null;
};

const mount = async (client, at) => {
  auth.client = client;
  const view = await renderComponent(
    <MemoryRouter initialEntries={[at]}>
      <Where />
      <Routes>
        <Route path="/vocabularies/new" element={<VocabularyDetail />} />
        <Route path="/vocabularies/:vocabularyId" element={<VocabularyDetail />} />
      </Routes>
    </MemoryRouter>,
  );
  for (let i = 0; i < 4; i++) await view.step(async () => {});
  return view;
};
const setValue = (el, value) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value);
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
};
const button = (name) => all(document.body, 'button').find((b) => b.textContent.trim() === name);
const projectSelect = () =>
  document.querySelector('[data-trigger="vocabulary-new-project"]')?.closest('select');
const options = (select) => [...select.options].map((o) => o.textContent).filter(Boolean);

beforeEach(() => {
  vi.clearAllMocks();
  confirm.mockImplementation(async () => true);
});

describe('a new vocabulary', () => {
  // The create names the project first and the id it minted in `{ id }`, the
  // same id on every press until one is answered.
  const creating = (answers) => {
    const creates = [];
    const client = {
      withOperation: (_label, fn) => fn(),
      projects: { list: async () => structuredClone([P1, P2, P3]) },
      vocabLayers: {
        create: async (...args) => {
          expect(args).toHaveLength(4);
          const [projectId, name, auditMessage, opts] = args;
          expect(typeof projectId).toBe('string');
          expect(auditMessage).toBeUndefined();
          expect(opts.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
          creates.push({ projectId, name, id: opts.id });
          const next = answers.shift();
          if (next) throw next;
          return { id: opts.id };
        },
        setConfig: async () => {},
      },
    };
    return { client, creates };
  };

  it('is made in the project the link names, under the id it minted', async () => {
    const { client, creates } = creating([]);
    const view = await mount(client, '/vocabularies/new?project=P3');
    expect(options(projectSelect())).toEqual(['Pear', 'Rowan']);
    expect(projectSelect().value).toBe('P3');
    await view.step(() => setValue(document.getElementById('vocabulary-new-name'), 'Lexicon'));
    await view.step(async () => {
      button('Create vocabulary').click();
      await settle(5);
    });
    expect(creates).toEqual([{ projectId: 'P3', name: 'Lexicon', id: creates[0].id }]);
    expect(where.pathname).toBe(`/vocabularies/${creates[0].id}`);
    await view.unmount();
  });

  it('sends the same id again after an answer that never came', async () => {
    const lost = Object.assign(new Error('Network'), { status: 0 });
    const { client, creates } = creating([lost]);
    const view = await mount(client, '/vocabularies/new?project=P1');
    await view.step(() => setValue(document.getElementById('vocabulary-new-name'), 'Lexicon'));
    for (let i = 0; i < 2; i++) {
      await view.step(async () => {
        button('Create vocabulary').click();
        await settle(5);
      });
    }
    expect(creates.map((c) => c.projectId)).toEqual(['P1', 'P1']);
    expect(creates[1].id).toBe(creates[0].id);
    await view.unmount();
  });

  it('waits for a project to be chosen, and offers only those the person maintains', async () => {
    const { client, creates } = creating([]);
    const view = await mount(client, '/vocabularies/new?project=P2');
    // P2 is one they write in, not one they maintain.
    expect(projectSelect().value).toBe('');
    await view.step(() => setValue(document.getElementById('vocabulary-new-name'), 'Lexicon'));
    expect(button('Create vocabulary').disabled).toBe(true);
    await view.step(() => setValue(projectSelect(), 'P1'));
    expect(button('Create vocabulary').disabled).toBe(false);
    await view.step(async () => {
      button('Create vocabulary').click();
      await settle(5);
    });
    expect(creates.map((c) => c.projectId)).toEqual(['P1']);
    await view.unmount();
  });

  it('says so when the person maintains no project, and cannot be created', async () => {
    const { client } = creating([]);
    client.projects.list = async () => [P2];
    const view = await mount(client, '/vocabularies/new');
    expect(document.querySelector('[data-placeholder]').textContent).toBe(
      'No project you maintain.',
    );
    expect(options(projectSelect())).toEqual([]);
    await view.step(() => setValue(document.getElementById('vocabulary-new-name'), 'Lexicon'));
    expect(button('Create vocabulary').disabled).toBe(true);
    await view.unmount();
  });
});

// The vocabulary V of project A (Ayvale), maintained by u, who also maintains
// C (Cedar) and writes in W.
const A = { id: 'A', name: 'Ayvale', maintainers: ['u'], writers: [], readers: [], vocabs: [] };
const C = { id: 'C', name: 'Cedar', maintainers: ['u'], writers: [], readers: [], vocabs: [] };
const W = { id: 'W', name: 'Willow', maintainers: [], writers: ['u'], readers: [], vocabs: [] };
const server = (answer = () => undefined) => {
  const vocabulary = { id: 'V', name: 'Lexicon', project: 'A', config: {} };
  const projects = [A, C, W];
  return fakeClient({
    answer: (req) => {
      const given = answer(req, vocabulary);
      if (given !== undefined) return given;
      if (req.kind === 'vocabLayers.get') return structuredClone(vocabulary);
      if (req.method === 'GET' && req.path === '/api/v1/projects')
        return { entries: structuredClone(projects), nextCursor: null };
      if (req.kind === 'projects.get') {
        const p = projects.find((x) => x.id === req.args[0]);
        if (!p) throw refusal(403, { error: 'Forbidden' });
        return structuredClone(p);
      }
      if (req.kind === 'vocabLayers.move') {
        vocabulary.project = req.args[1];
        return structuredClone(vocabulary);
      }
      return undefined;
    },
  });
};
const projectLine = () =>
  [...document.querySelectorAll('p')].find((p) => p.textContent.startsWith('Project:'))
    ?.textContent;

describe('the vocabulary page names its project', () => {
  it('as a link for someone who can read it, else as another project', async () => {
    const client = server();
    const view = await mount(client, '/vocabularies/V');
    expect(projectLine()).toBe('Project: Ayvale');
    expect(
      [...document.querySelectorAll('a')]
        .find((a) => a.textContent === 'Ayvale')
        .getAttribute('href'),
    ).toBe('/projects/A');
    await view.unmount();

    const outside = server((req) => {
      if (req.kind === 'projects.get' && req.args[0] === 'A') throw refusal(403, {});
      return undefined;
    });
    const again = await mount(outside, '/vocabularies/V');
    expect(projectLine()).toBe('Project: another project');
    await again.unmount();
  });
});

describe('moving a vocabulary', () => {
  const moveSelect = () =>
    document.querySelector('[data-trigger="vocabulary-move"]')?.closest('select');

  it('offers the other projects the person maintains, asks, and moves', async () => {
    const client = server();
    const view = await mount(client, '/vocabularies/V?tab=settings');
    expect(options(moveSelect())).toEqual(['Cedar']);
    await view.step(async () => {
      setValue(moveSelect(), 'C');
      await settle(5);
    });
    expect(confirm).toHaveBeenCalledWith({
      title: 'Move “⁨Lexicon⁩” to “⁨Cedar⁩”?',
      description: '“⁨Cedar⁩” becomes its project. “⁨Ayvale⁩” keeps it linked.',
      confirmLabel: 'Move',
    });
    const moves = client.requests.filter((r) => r.kind === 'vocabLayers.move');
    expect(moves.map((r) => [r.method, r.path, r.body])).toEqual([
      ['POST', '/api/v1/vocab-layers/V/move', { 'project-id': 'C' }],
    ]);
    // Its project now, and the rights are Cedar's: still Settings.
    expect(projectLine()).toBe('Project: Cedar');
    expect(document.getElementById('vocabulary-rename')).not.toBeNull();
    // Ayvale is a project it can move back to.
    expect(options(moveSelect())).toEqual(['Ayvale']);
    await view.unmount();
  });

  it('moves nothing when the question is cancelled', async () => {
    confirm.mockImplementation(async () => false);
    const client = server();
    const view = await mount(client, '/vocabularies/V?tab=settings');
    await view.step(async () => {
      setValue(moveSelect(), 'C');
      await settle(5);
    });
    expect(client.requests.filter((r) => r.kind === 'vocabLayers.move')).toEqual([]);
    expect(projectLine()).toBe('Project: Ayvale');
    await view.unmount();
  });

  it('goes back to its project when the move is refused', async () => {
    const client = server((req) => {
      if (req.kind === 'vocabLayers.move')
        throw refusal(403, {
          error: 'Moving a vocabulary needs maintainer rights on both projects.',
        });
      return undefined;
    });
    const view = await mount(client, '/vocabularies/V?tab=settings');
    await view.step(async () => {
      setValue(moveSelect(), 'C');
      await settle(10);
    });
    expect(feedback.notifyError).toHaveBeenCalledWith(
      expect.anything(),
      'Failed to move the vocabulary',
    );
    expect(projectLine()).toBe('Project: Ayvale');
    await view.unmount();
  });

  it('is not offered to a maintainer of no other project', async () => {
    const client = server((req) =>
      req.method === 'GET' && req.path === '/api/v1/projects'
        ? { entries: structuredClone([A, W]), nextCursor: null }
        : undefined,
    );
    const view = await mount(client, '/vocabularies/V?tab=settings');
    expect(document.getElementById('vocabulary-rename')).not.toBeNull();
    expect(moveSelect()).toBeUndefined();
    await view.unmount();
  });
});

describe('the delete question, as the client sends it', () => {
  const dialogText = () => document.querySelector('[role="dialog"]')?.textContent ?? '';
  const dialogButtons = () =>
    all(document.body, '[role="dialog"] button')
      .map((b) => b.textContent.trim())
      // The dialog's own corner close.
      .filter((t) => t && t !== 'Close');
  const sentSince = (client, n) => client.requests.slice(n).map((r) => [r.method, r.path, r.query]);

  it('sends only the dry run when it opens', async () => {
    const client = server((req) =>
      req.kind === 'vocabLayers.delete' && req.query['dry-run'] ? { links: 3 } : undefined,
    );
    const view = await mount(client, '/vocabularies/V?tab=settings');
    const before = client.requests.length;
    await view.step(async () => {
      button('Delete vocabulary').click();
      await settle(5);
    });
    expect(sentSince(client, before)).toEqual([
      ['DELETE', '/api/v1/vocab-layers/V', { 'dry-run': 'true' }],
    ]);
    expect(dialogText()).toContain(
      'Its entries are linked to 3 words/morphemes. Those links will be removed.',
    );
    await view.unmount();
  });

  it('is refused, Cancel only, while other projects use it', async () => {
    const client = server((req) => {
      if (req.kind === 'vocabLayers.delete')
        throw refusal(409, { error: '1 other project uses this vocabulary.', 'other-projects': 1 });
      return undefined;
    });
    const view = await mount(client, '/vocabularies/V?tab=settings');
    const before = client.requests.length;
    await view.step(async () => {
      button('Delete vocabulary').click();
      await settle(5);
    });
    expect(sentSince(client, before)).toEqual([
      ['DELETE', '/api/v1/vocab-layers/V', { 'dry-run': 'true' }],
    ]);
    expect(dialogText()).toContain(
      '1 other project uses this vocabulary. It can be deleted once that project unlinks it.',
    );
    expect(dialogButtons()).toEqual(['Cancel']);
    await view.unmount();
  });
});
