import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { AuthContext } from '@ui/contexts/useAuth.js';
import { SubjectContext } from '@ui/components/assistant/subject.js';
import {
  buildRawDoc,
  makeFakeClient,
  resetIds,
  makeIgtDoc,
  settle,
} from '@/domain/test-helpers.js';
import { DocumentProvider } from '../contexts/DocumentContext.jsx';
import { AnalyzeIsland } from './AnalyzeIsland.jsx';

// A vocabulary has a home project, and the Analyze popover asks the home's
// roles (SPEC 5.4, ruling 11.4): a writer of the home adds entries ("+ Create"
// on a word, a morpheme and a multi-word expression) and changes a linked
// entry's type. A vocabulary the document's project borrows is read only in
// it, admins included: its entries are linked to, and one line in the popover
// says whose it is. A reader of the home changes nothing.

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));
vi.mock('./AutoAnalyzeDialog.jsx', () => ({ AutoAnalyzeDialog: () => null }));

// Project A owns "LA" and borrows "LB" from project B. Project B owns "LB" and
// borrows "LA".
const A = {
  id: 'proj-a',
  name: 'A',
  maintainers: ['hm'],
  writers: ['hw'],
  readers: ['hr'],
  config: { plaid: {} },
  vocabs: [
    { id: 'la', name: 'LA', project: 'proj-a' },
    { id: 'lb', name: 'LB', project: 'proj-b' },
  ],
};
const B = {
  id: 'proj-b',
  name: 'B',
  maintainers: ['bm'],
  writers: ['bw'],
  readers: ['br'],
  config: { plaid: {} },
  vocabs: [
    { id: 'lb', name: 'LB', project: 'proj-b' },
    { id: 'la', name: 'LA', project: 'proj-a' },
  ],
};
const ADMIN = { id: 'root', isAdmin: true };

// "the cat sat down": "cat"'s morpheme linked to LA's "cat", "sat"'s to LB's.
const lexicons = (only) => {
  const all = {
    la: {
      id: 'la',
      name: 'LA',
      project: 'proj-a',
      items: [{ id: 'i-cat', form: 'cat', metadata: { morphType: 'stem' } }],
      vocabLinks: [{ id: 'lk-cat', tokens: ['m-2'], vocabItem: { id: 'i-cat', form: 'cat' } }],
    },
    lb: {
      id: 'lb',
      name: 'LB',
      project: 'proj-b',
      items: [{ id: 'i-sat', form: 'sat', metadata: { morphType: 'stem' } }],
      vocabLinks: [{ id: 'lk-sat', tokens: ['m-3'], vocabItem: { id: 'i-sat', form: 'sat' } }],
    },
  };
  return Object.fromEntries(only.map((id) => [id, all[id]]));
};

let view;
let client;

const open = async ({ project, user, only = ['la', 'lb'], readOnly = false }) => {
  const raw = buildRawDoc({
    body: 'the cat sat down',
    words: [
      { id: 'w-1', begin: 0, end: 3 },
      { id: 'w-2', begin: 4, end: 7 },
      { id: 'w-3', begin: 8, end: 11 },
      { id: 'w-4', begin: 12, end: 16 },
    ],
  });
  const vocabularies = lexicons(only);
  client = makeFakeClient({ project, vocabularies });
  client.query = async () => ({ results: [] });
  const doc = makeIgtDoc({
    raw,
    project: { ...project, vocabs: project.vocabs.filter((v) => only.includes(v.id)) },
    projectId: project.id,
    vocabularies,
    client,
    user,
  });
  client.documents.get = async () => doc.raw;
  view = await renderComponent(
    <MemoryRouter>
      <AuthContext.Provider value={{ user }}>
        <SubjectContext.Provider value={{ ask: vi.fn() }}>
          <DocumentProvider
            value={{
              doc,
              readOnly,
              comments: null,
              canWrite: !readOnly,
              canManage: false,
              assistantOnline: false,
              goToTab: vi.fn(),
            }}
          >
            <AnalyzeIsland />
          </DocumentProvider>
        </SubjectContext.Provider>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
  return doc;
};

const $ = (sel) => view.container.querySelector(sel);
const popover = () => $('.igt-vocab-pop');
const click = (el, init = {}) =>
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
const key = (el, k, init = {}) =>
  el.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }),
  );
const openOn = (tokenId) => click($(`button[data-vocab-opener="${tokenId}"]`));
const close = () => {
  if (popover()) key(popover().querySelector('.igt-vocab-pop__search'), 'Escape');
};
const gather = () => {
  const form = (id) => $(`[data-word-col="${id}"] .igt-token-form`);
  click(form('w-3'), { shiftKey: true });
  click(form('w-4'), { shiftKey: true });
  key($('button.igt-mwe__label[data-vocab-opener="mwe:new"]'), 'Enter');
};
const createRow = () => popover().querySelector('.igt-vocab-pop__create');
const note = () =>
  popover().querySelector('.igt-vocab-pop__borrowed')?.textContent.replace(/\s+/g, ' ').trim() ??
  null;
const tabs = () =>
  [...popover().querySelectorAll('.igt-vocab-pop__vocabtab')].map((t) => t.textContent.trim());
const typeOf = (morphId) => {
  openOn(morphId);
  const select = popover().querySelector('.igt-vocab-pop__type select');
  const disabled = select.disabled;
  close();
  return disabled ? 'disabled' : 'enabled';
};
const switchTo = (name) =>
  click(
    [...popover().querySelectorAll('button.igt-vocab-pop__vocabtab')].find(
      (t) => t.textContent.trim() === name,
    ),
  );

beforeEach(() => {
  resetIds();
  sessionStorage.clear();
});
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('a writer of the home project', () => {
  const asHw = () => open({ project: A, user: { id: 'hw' } });

  it('is offered "+ Create" on a word into its own vocabulary, and it makes the entry', async () => {
    await asHw();
    openOn('w-1');
    expect(createRow()).not.toBeNull();
    expect(note()).toBeNull();
    click(createRow());
    click(createRow());
    await settle(4);
    const made = client.calls.find((c) => c.kind === 'vocabItems.create');
    expect(made.args.slice(0, 2)).toEqual(['la', 'the']);
  });

  it('is offered "+ Create" for a multi-word expression in its own vocabulary', async () => {
    await asHw();
    gather();
    expect(createRow()).not.toBeNull();
  });

  it('puts a morpheme’s new entry only into its own vocabulary', async () => {
    await asHw();
    openOn('m-1');
    expect(createRow()).not.toBeNull();
    expect(tabs()).toEqual(['LA↗']);
  });

  it('changes the type of an entry of its own vocabulary, not of a borrowed one', async () => {
    await asHw();
    expect(typeOf('m-2')).toBe('enabled');
    expect(typeOf('m-3')).toBe('disabled');
  });

  it('is offered no "+ Create" while the borrowed vocabulary is shown, with one line why', async () => {
    await asHw();
    openOn('w-1');
    switchTo('LB');
    expect(createRow()).toBeNull();
    expect(note()).toBe('“LB” belongs to another project.');
    switchTo('LA');
    expect(createRow()).not.toBeNull();
    expect(note()).toBeNull();
  });
});

describe('a writer of a project that borrows the vocabulary', () => {
  const asBw = () => open({ project: B, user: { id: 'bw' }, only: ['la'] });

  it('is offered no "+ Create" on a word, a morpheme or an expression', async () => {
    await asBw();
    openOn('w-1');
    expect(createRow()).toBeNull();
    expect(note()).toBe('“LA” belongs to another project.');
    close();
    openOn('m-1');
    expect(createRow()).toBeNull();
    expect(popover().querySelector('.igt-vocab-pop__vocabsel')).toBeNull();
    expect(note()).toBe('“LA” belongs to another project.');
    close();
    gather();
    expect(createRow()).toBeNull();
    expect(note()).toBe('“LA” belongs to another project.');
  });

  it('makes no entry from the keyboard', async () => {
    await asBw();
    for (const tokenId of ['w-1', 'm-1']) {
      openOn(tokenId);
      const search = popover().querySelector('.igt-vocab-pop__search');
      key(search, 'Enter');
      key(search, 'Enter', { ctrlKey: true });
      key(search, 'Enter', { ctrlKey: true, shiftKey: true });
      await settle(4);
      expect(popover()?.querySelector('.igt-vocab-pop__create-input') ?? null).toBeNull();
      close();
    }
    expect(client.calls.some((c) => c.kind === 'vocabItems.create')).toBe(false);
  });

  it('cannot change the type of a linked entry', async () => {
    await asBw();
    expect(typeOf('m-2')).toBe('disabled');
  });

  it('links a word to an entry of the borrowed vocabulary', async () => {
    await asBw();
    openOn('w-2');
    click(
      [...popover().querySelectorAll('.igt-vocab-pop__item')].find((el) =>
        el.textContent.includes('cat'),
      ),
    );
    await settle(4);
    const link = client.calls.find((c) => c.kind === 'vocabLinks.create');
    expect(link.args.slice(0, 2)).toEqual(['i-cat', ['w-2']]);
  });
});

describe('an admin', () => {
  it('adds entries in the home project', async () => {
    await open({ project: A, user: ADMIN, only: ['la'] });
    openOn('w-1');
    expect(createRow()).not.toBeNull();
    close();
    expect(typeOf('m-2')).toBe('enabled');
  });

  it('reads a borrowed vocabulary only, in the project that borrows it', async () => {
    await open({ project: B, user: ADMIN, only: ['la'] });
    openOn('w-1');
    expect(createRow()).toBeNull();
    expect(note()).toBe('“LA” belongs to another project.');
    close();
    expect(typeOf('m-2')).toBe('disabled');
  });
});

describe('a reader of the home project', () => {
  // The document is read only for a reader, and its lexicon chips open
  // nothing.
  it('is offered no "+ Create" and no type', async () => {
    await open({ project: A, user: { id: 'hr' }, only: ['la'], readOnly: true });
    for (const tokenId of ['w-1', 'm-1', 'm-2']) {
      const opener = $(`[data-vocab-opener="${tokenId}"]`);
      if (opener) click(opener);
      expect(popover()).toBeNull();
    }
    expect($('.igt-vocab-pop__create')).toBeNull();
    expect($('.igt-vocab-pop__type')).toBeNull();
  });
});
