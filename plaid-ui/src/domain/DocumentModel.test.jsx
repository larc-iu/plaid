// The two document-level operations the lifecycle owns — what the document is
// called, and a copy of it — and the shared screen that calls them.
//
// They are here rather than on each app's document because the Details screen
// all three apps mount calls `doc.rename` and `doc.copyTo` on whatever document
// it is handed. plaid-ud's document had both and plaid-umr's had neither, so
// Save and Copy threw in UMR. The mount below is over a document that adds
// nothing but its text, which is what a subclass looks like from this screen.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { renderComponent, all } from '../test/renderComponent.jsx';
import { configureUi } from '../lib/uiConfig.js';
import { DocumentModel } from './DocumentModel.js';

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
vi.mock('../components/shared/ConfirmProvider.jsx', () => ({ useConfirm: () => confirm }));

const { auth, editor } = vi.hoisted(() => ({ auth: {}, editor: {} }));
vi.mock('../contexts/useAuth.js', () => ({ useAuth: () => auth }));
vi.mock('../hooks/useDocumentEditor.js', () => ({ useDocumentEditor: () => editor }));
vi.mock('../lib/notify.js', () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }));

const { DocumentDetailsPage } = await import('../components/shared/DocumentDetailsPage.jsx');

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
// package for the whole run: name the app this screen is mounted in, and put
// back what the setup left.
const RESTORE = { appPrefix: 'plaid_igt', configNamespace: 'igt', appName: 'Plaid IGT' };

// A client that records the two calls these operations make and nothing else.
const recordingClient = ({ failCopy = false } = {}) => {
  const calls = [];
  return {
    calls,
    withOperation: (label, fn) => {
      calls.push(['operation', label]);
      return fn(() => {});
    },
    documents: {
      get: async () => ({ id: 'd1', name: 'One', metadata: {} }),
      update: async (id, name) => calls.push(['update', id, name]),
      copy: async (id, name) => {
        calls.push(['copy', id, name]);
        if (failCopy) throw new Error('nope');
        return { id: 'd2' };
      },
    },
  };
};

// A subclass shaped like plaid-umr's: it says what its text is and inherits
// everything a document is called upon to do as a document.
class Doc extends DocumentModel {
  get body() {
    return 'the cat sat';
  }
}

const load = (options = {}) => {
  const client = recordingClient(options);
  const doc = new Doc({ raw: { id: 'd1', name: 'One', metadata: {} }, client });
  const errors = [];
  doc.onError = (msg) => errors.push(msg);
  return { doc, client, errors };
};

describe('what every document can do as a document', () => {
  it('renames through the client, and shows the name before the round trip', async () => {
    const { doc, client } = load();
    const seen = [];
    client.documents.update = async (id, name) => {
      // The optimistic patch is in before the server answers.
      seen.push(doc.name);
      client.calls.push(['update', id, name]);
    };
    expect(await doc.rename('  Two  ')).toBe(true);
    expect(seen).toEqual(['Two']);
    expect(doc.name).toBe('Two');
    expect(client.calls).toEqual([
      ['operation', 'Rename document'],
      ['update', 'd1', 'Two'],
    ]);
  });

  it('does not write a blank name or the name it already has', async () => {
    const { doc, client } = load();
    expect(await doc.rename('   ')).toBe(false);
    expect(await doc.rename('One')).toBe(false);
    expect(client.calls).toEqual([]);
  });

  it('refuses a rename of an earlier state of the document', async () => {
    const client = recordingClient();
    const doc = new Doc({ raw: { id: 'd1', name: 'One' }, client, asOf: '2026-01-01T00:00:00Z' });
    const errors = [];
    doc.onError = (msg) => errors.push(msg);
    expect(await doc.rename('Two')).toBe(false);
    expect(doc.name).toBe('One');
    expect(client.calls).toEqual([]);
    expect(errors[0]).toMatch(/cannot be edited/);
  });

  it('copies to a new document and answers with its id and its name', async () => {
    const { doc, client } = load();
    expect(await doc.copyTo('  One (copy)  ')).toEqual({ id: 'd2', name: 'One (copy)' });
    expect(client.calls).toEqual([
      ['operation', 'Copy document'],
      ['copy', 'd1', 'One (copy)'],
    ]);
    // The document copied from is untouched.
    expect(doc.name).toBe('One');
    // An unnamed copy still has a name.
    expect((await doc.copyTo(''))?.name).toBe('One (copy)');
  });

  it('answers with null when the copy failed', async () => {
    const { doc, errors } = load({ failCopy: true });
    expect(await doc.copyTo('One (copy)')).toBe(null);
    expect(errors[0]).toMatch(/Failed to copy document/);
  });
});

// ---------------------------------------------------------------------------
// The screen that calls them.

const flush = () => act(async () => {});

const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

let view = null;
let path = null;

const Probe = () => {
  path = useLocation().pathname;
  return null;
};

const mount = async () => {
  view = await renderComponent(
    <MemoryRouter initialEntries={['/projects/p1/documents/d1/details']}>
      <Routes>
        <Route path="/projects/:p/documents/:d/details" element={<DocumentDetailsPage />} />
        <Route path="*" element={<p>somewhere else</p>} />
      </Routes>
      <Probe />
    </MemoryRouter>,
  );
  return view;
};

const button = (root, text) => all(root, 'button').find((b) => b.textContent.trim() === text);

const typeInto = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

let client = null;

beforeEach(() => {
  path = null;
  confirm.mockReset();
  confirm.mockResolvedValue(true);
  auth.user = { id: 'u', isAdmin: true };
  auth.getClient = () => ({ documents: { delete: vi.fn(async () => true) } });
  editor.projectId = 'p1';
  editor.documentId = 'd1';
  editor.project = { id: 'p1', name: 'Ay', maintainers: ['u'], writers: [], readers: [] };
  const loaded = load();
  client = loaded.client;
  editor.doc = loaded.doc;
  configureUi({ ...RESTORE, appRoutes: ROUTES });
  window.history.pushState({ idx: 0, key: 'page' }, '');
});

afterEach(async () => {
  if (view) await view.unmount();
  view = null;
  await flush();
  await tick();
  configureUi(RESTORE);
});

describe('the details screen over a document that adds nothing of its own', () => {
  it('saves the typed name', async () => {
    const view = await mount();
    await view.step(() => typeInto(view.container.querySelector('#document-name'), 'Two'));
    await view.step(() => click(button(view.container, 'Save')));
    await flush();

    expect(client.calls).toContainEqual(['update', 'd1', 'Two']);
    expect(view.container.querySelector('#document-name').value).toBe('Two');
  });

  it('copies the document and opens the copy', async () => {
    const view = await mount();
    await view.step(() => click(button(view.container, 'Copy document')));
    await view.step(async () => click(button(document.body, 'Copy')));
    await flush();

    expect(client.calls).toContainEqual(['copy', 'd1', 'One (copy)']);
    expect(path).toBe('/projects/p1/documents/d2/annotate');
    await tick();
  });
});
