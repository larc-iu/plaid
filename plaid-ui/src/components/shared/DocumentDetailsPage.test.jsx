// The document's own tab, and the two things it does that take the reader off
// it. A copy and a delete are router pushes, which is none of the three ways
// out the unsaved-draft hook watches, so the screen has to ask (and to take
// its history entry back out) itself.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderComponent, all } from '../../test/renderComponent.jsx';
import { configureUi } from '../../lib/uiConfig.js';
import { DocumentModel } from '../../domain/DocumentModel.js';

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn(async () => false) }));
vi.mock('./ConfirmProvider.jsx', () => ({ useConfirm: () => confirm }));

const { auth, editor } = vi.hoisted(() => ({ auth: {}, editor: {} }));
vi.mock('../../contexts/useAuth.js', () => ({ useAuth: () => auth }));
vi.mock('../../hooks/useDocumentEditor.js', () => ({ useDocumentEditor: () => editor }));
vi.mock('../../lib/notify.js', () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }));

const { DocumentDetailsPage } = await import('./DocumentDetailsPage.jsx');
const { hasUnsavedDraft } = await import('../../hooks/useUnsavedDraft.js');

const ROUTES = {
  projects: '/projects',
  login: '/login',
  profile: '/profile',
  documents: (p) => `/projects/${p}/documents`,
  document: (p, d) => `/projects/${p}/documents/${d}/annotate`,
  sentence: (p, d, s) => `/projects/${p}/documents/${d}/annotate?sent=${s}`,
  at: { project: () => true, document: () => true, assistant: () => false },
};
// The suite runs under plaid-igt's vitest, whose setup file configures the
// package for the whole run. This screen links into the app that mounts it, so
// the test names that app's routes and puts back what the setup left.
const RESTORE = { appPrefix: 'plaid_igt', configNamespace: 'igt', appName: 'Plaid IGT' };

let copied = [];

class Doc extends DocumentModel {
  constructor(raw) {
    super({ raw, client: { withOperation: (_, fn) => fn(), documents: {} } });
  }
  get body() {
    return 'the cat sat';
  }
  async copyTo(name) {
    copied.push(name);
    return { id: 'd2', name };
  }
  async rename() {
    return true;
  }
}

const deleteDocument = vi.fn(async () => true);

let path = null;
const Probe = () => {
  path = useLocation().pathname;
  return null;
};

const flush = () => act(async () => {});

// The screen stays mounted only for the test that mounted it: a draft left
// registered by a failing assertion would follow the next test into its own
// history.
let view = null;

const mount = async () => {
  view = await renderComponent(
    <MemoryRouter initialEntries={['/projects/p1/documents/d1/details']}>
      <DocumentDetailsPage />
      <Probe />
    </MemoryRouter>,
  );
  return view;
};

const button = (root, text) => all(root, 'button').find((b) => b.textContent.trim() === text);

// Typing into a controlled input: React skips onChange when the DOM value is
// assigned directly, so it goes through the native setter first.
const typeInto = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

// Where in the browser's history this test stands. The hook puts ONE extra
// entry in front of the page while a draft exists, so `idx` says whether it is
// still there.
const idx = () => window.history.state?.idx;

beforeEach(() => {
  copied = [];
  path = null;
  confirm.mockReset();
  confirm.mockResolvedValue(true);
  deleteDocument.mockClear();
  auth.user = { id: 'u', isAdmin: true };
  auth.getClient = () => ({ documents: { delete: deleteDocument } });
  editor.projectId = 'p1';
  editor.documentId = 'd1';
  editor.project = { id: 'p1', name: 'Ay', maintainers: ['u'], writers: [], readers: [] };
  editor.doc = new Doc({ id: 'd1', name: 'One', metadata: {} });
  configureUi({ ...RESTORE, appRoutes: ROUTES });
  window.history.pushState({ idx: 0, key: 'page' }, '');
});

afterEach(async () => {
  if (view) await view.unmount();
  view = null;
  await flush();
  configureUi(RESTORE);
});

const typeAName = async (view) => {
  await view.step(() => typeInto(view.container.querySelector('#document-name'), 'Two'));
  expect(hasUnsavedDraft()).toBe('The name you have typed');
};

describe('the document details screen', () => {
  it('shows the document’s name, its id and what it can do', async () => {
    const view = await mount();
    expect(view.container.querySelector('#document-name').value).toBe('One');
    expect(view.container.querySelector('#document-id').value).toBe('d1');
    expect(view.container.textContent).toContain('Copy document');
    expect(view.container.textContent).toContain('Delete document');
  });

  it('asks before a copy takes the reader to it, and stays put on no', async () => {
    const view = await mount();
    await typeAName(view);
    confirm.mockResolvedValue(false);

    await view.step(() => click(button(view.container, 'Copy document')));
    await view.step(async () => click(button(document.body, 'Copy')));
    await flush();

    expect(copied).toEqual(['One (copy)']);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'The name you have typed is not saved. Leaving loses it.',
      }),
    );
    // Nothing navigated behind the question, and the name is still typed.
    expect(path).toBe('/projects/p1/documents/d1/details');
    expect(hasUnsavedDraft()).toBe('The name you have typed');
  });

  it('opens the copy once the reader says the typed name may go', async () => {
    const view = await mount();
    await typeAName(view);
    expect(idx()).toBe(1); // the extra entry is in front of the page

    await view.step(() => click(button(view.container, 'Copy document')));
    await view.step(async () => click(button(document.body, 'Copy')));
    await flush();

    expect(path).toBe('/projects/p1/documents/d2/annotate');
    // And the extra entry came out on the way, so Back is not spent on it.
    expect(idx()).toBe(0);
  });

  it('deletes without a second question, and takes its history entry with it', async () => {
    const view = await mount();
    await typeAName(view);
    expect(idx()).toBe(1);

    await view.step(async () => {
      click(button(view.container, 'Delete document'));
    });
    await flush();

    expect(deleteDocument).toHaveBeenCalledWith('d1');
    // One question, the delete's own: there is nothing left to rename.
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0].title).toBe('Delete “One”');
    expect(path).toBe('/projects/p1/documents');
    expect(idx()).toBe(0);
    expect(hasUnsavedDraft()).toBe(null);
  });
});
