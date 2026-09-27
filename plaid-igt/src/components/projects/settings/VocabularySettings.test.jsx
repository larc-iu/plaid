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
