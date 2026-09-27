import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all, byText } from '@ui/test/renderComponent.jsx';

// Linking a vocabulary to a project takes a maintainer of the vocabulary as
// well as of the project, since the link lets every project member read and
// write it. The list shows every vocabulary the user can read, so a row they
// do not maintain is shown but cannot be ticked, and a refusal the server
// still sends is shown as the server words it.

const notifyError = vi.fn();
vi.mock('@/utils/feedback', () => ({ notifyError: (...a) => notifyError(...a) }));

let auth;
vi.mock('@/contexts/AuthContext.jsx', () => ({ useAuth: () => auth }));

import { VocabularySettings } from './VocabularySettings.jsx';

const REFUSAL = 'Only a maintainer of this vocabulary can link it to a project.';
const refused = () => {
  const e = new Error(`HTTP 403 ${REFUSAL} at http://localhost/api/v1/projects/p1/vocabs/v2`);
  e.status = 403;
  e.responseData = { error: REFUSAL };
  return e;
};

const makeClient = ({ linked = [], link } = {}) => ({
  vocabLayers: {
    list: vi.fn(async () => [
      { id: 'v1', name: 'Mine', maintainers: ['me@x.org'] },
      { id: 'v2', name: 'Theirs', maintainers: ['other@x.org'] },
    ]),
  },
  projects: {
    get: vi.fn(async () => ({ id: 'p1', vocabs: linked.map((id) => ({ id })) })),
    linkVocab: vi.fn(link ?? (async () => {})),
    unlinkVocab: vi.fn(async () => {}),
  },
});

const rowOf = (root, name) => byText(root, 'tbody tr', name);
const boxOf = (root, name) => rowOf(root, name).querySelector('input[type=checkbox]');

const mount = (client) =>
  renderComponent(
    <MemoryRouter>
      <VocabularySettings projectId="p1" client={client} />
    </MemoryRouter>,
  );

beforeEach(() => {
  notifyError.mockClear();
  auth = { user: { id: 'me@x.org', isAdmin: false } };
});

describe('Project settings, Vocabularies', () => {
  it('will not tick a vocabulary the user does not maintain', async () => {
    const client = makeClient();
    const view = await mount(client);
    expect(boxOf(view.container, 'Mine').disabled).toBe(false);
    expect(boxOf(view.container, 'Theirs').disabled).toBe(true);
    expect(rowOf(view.container, 'Theirs').textContent).toContain(
      'Only its maintainers can link it.',
    );
    await view.step(() => rowOf(view.container, 'Theirs').click());
    expect(client.projects.linkVocab).not.toHaveBeenCalled();
    await view.step(() => rowOf(view.container, 'Mine').click());
    expect(client.projects.linkVocab).toHaveBeenCalledWith('p1', 'v1');
    await view.unmount();
  });

  it('leaves a linked vocabulary free to unlink, maintained or not', async () => {
    const view = await mount(makeClient({ linked: ['v2'] }));
    expect(boxOf(view.container, 'Theirs').disabled).toBe(false);
    expect(boxOf(view.container, 'Theirs').checked).toBe(true);
    await view.unmount();
  });

  it('lets an admin link any vocabulary', async () => {
    auth = { user: { id: 'admin@x.org', isAdmin: true } };
    const view = await mount(makeClient());
    expect(all(view.container, 'tbody input[type=checkbox]').map((b) => b.disabled)).toEqual([
      false,
      false,
    ]);
    await view.unmount();
  });

  it("shows the server's refusal and keeps the list", async () => {
    const client = makeClient({
      link: async () => {
        throw refused();
      },
    });
    const view = await mount(client);
    await view.step(() => rowOf(view.container, 'Mine').click());
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError.mock.calls[0][0]).toBe(REFUSAL);
    expect(view.container.textContent).not.toMatch(/refresh the page/);
    expect(boxOf(view.container, 'Mine').checked).toBe(false);
    await view.unmount();
  });
});

// Every write shows before the server answers. A tick is a link sent, and the
// row it ticked is what a refusal takes back, leaving any other row alone.
describe('Project settings, Vocabularies, before the server answers', () => {
  const held = () => {
    let settle;
    const promise = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    return { promise, settle };
  };
  const twoOfMine = (linkVocab) => ({
    vocabLayers: {
      list: vi.fn(async () => [
        { id: 'v1', name: 'Alpha', maintainers: ['me@x.org'] },
        { id: 'v3', name: 'Gamma', maintainers: ['me@x.org'] },
        { id: 'v4', name: 'Delta', maintainers: ['me@x.org'] },
      ]),
    },
    projects: {
      get: vi.fn(async () => ({ id: 'p1', vocabs: [{ id: 'v4' }] })),
      linkVocab: vi.fn(linkVocab),
      unlinkVocab: vi.fn(async () => {}),
    },
  });

  it('ticks a row at once and sends the link', async () => {
    const answer = held();
    const client = twoOfMine(() => answer.promise);
    const view = await mount(client);
    await view.step(() => rowOf(view.container, 'Alpha').click());
    expect(boxOf(view.container, 'Alpha').checked).toBe(true);
    expect(client.projects.linkVocab).toHaveBeenCalledWith('p1', 'v1');
    await view.step(async () => answer.settle.resolve());
    expect(boxOf(view.container, 'Alpha').checked).toBe(true);
    expect(notifyError).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('unticks a row as soon as the unlink is confirmed', async () => {
    const answer = held();
    const client = twoOfMine(async () => {});
    client.projects.unlinkVocab = vi.fn(() => answer.promise);
    const view = await mount(client);
    await view.step(() => rowOf(view.container, 'Delta').click());
    const confirm = byText(document.body, '[role=alertdialog] button', 'Unlink');
    await view.step(() => confirm.click());
    expect(boxOf(view.container, 'Delta').checked).toBe(false);
    expect(byText(document.body, '[role=alertdialog] button', 'Unlink')).toBeNull();
    await view.step(async () => answer.settle.resolve());
    expect(client.projects.unlinkVocab).toHaveBeenCalledWith('p1', 'v4');
    await view.unmount();
  });

  it('sends the second tick after the first, and a refusal takes back only its own row', async () => {
    const first = held();
    const client = twoOfMine((pid, id) => (id === 'v1' ? first.promise : Promise.resolve()));
    const view = await mount(client);
    await view.step(() => rowOf(view.container, 'Alpha').click());
    await view.step(() => rowOf(view.container, 'Gamma').click());
    expect(boxOf(view.container, 'Alpha').checked).toBe(true);
    expect(boxOf(view.container, 'Gamma').checked).toBe(true);
    // Gamma waits its turn behind Alpha.
    expect(client.projects.linkVocab).toHaveBeenCalledTimes(1);
    await view.step(async () => first.settle.reject(refused()));
    expect(client.projects.linkVocab.mock.calls.map((c) => c[1])).toEqual(['v1', 'v3']);
    expect(boxOf(view.container, 'Alpha').checked).toBe(false);
    expect(boxOf(view.container, 'Gamma').checked).toBe(true);
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError.mock.calls[0][0]).toBe(REFUSAL);
    await view.unmount();
  });

  it('can link a vocabulary again after unlinking one it may link', async () => {
    const view = await mount(twoOfMine(async () => {}));
    await view.step(() => rowOf(view.container, 'Delta').click());
    await view.step(() => byText(document.body, '[role=alertdialog] button', 'Unlink').click());
    expect(boxOf(view.container, 'Delta').disabled).toBe(false);
    await view.unmount();
  });
});

describe('Project settings, Vocabularies, a row the user may not link', () => {
  it('locks again once a vocabulary they do not maintain is unlinked', async () => {
    const view = await mount(makeClient({ linked: ['v2'] }));
    await view.step(() => rowOf(view.container, 'Theirs').click());
    await view.step(() => byText(document.body, '[role=alertdialog] button', 'Unlink').click());
    expect(boxOf(view.container, 'Theirs').checked).toBe(false);
    expect(boxOf(view.container, 'Theirs').disabled).toBe(true);
    await view.unmount();
  });
});

describe('Project settings, Vocabularies, a list that will not load', () => {
  it('shows the panel and no toast about an update', async () => {
    const client = makeClient();
    client.vocabLayers.list = vi.fn(async () => {
      throw new Error('HTTP 500');
    });
    const view = await mount(client);
    expect(view.container.textContent).toMatch(/Configuration Error/);
    expect(notifyError).not.toHaveBeenCalled();
    await view.unmount();
  });
});
