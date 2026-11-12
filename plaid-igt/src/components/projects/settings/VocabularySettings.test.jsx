import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all, byText } from '@ui/test/renderComponent.jsx';

// A vocabulary belongs to one project, its home. Linking it into this project
// (borrowing it) takes a maintainer of this project who holds a role in the
// home. The list shows every vocabulary the user can read: this project's own
// ones ticked and locked, the others with the project they come from, and a
// row the user may not link is shown but cannot be ticked. A refusal the
// server still sends is shown as the server words it.

const notifyError = vi.fn();
vi.mock('@/utils/feedback', () => ({ notifyError: (...a) => notifyError(...a) }));

let auth;
vi.mock('@/contexts/AuthContext.jsx', () => ({ useAuth: () => auth }));

import { VocabularySettings } from './VocabularySettings.jsx';

const REFUSAL = 'Linking a vocabulary needs access to the project it belongs to.';
const refused = () => {
  const e = new Error(`HTTP 403 ${REFUSAL} at http://localhost/api/v1/projects/p1/vocabs/v2`);
  e.status = 403;
  e.responseData = { error: REFUSAL };
  return e;
};

// A batch as the client sends one: every op it queues, sent together. The
// unlink goes in one, with the types its morphemes keep.
const batching = (client) => {
  client.tokens = client.tokens ?? { bulkUpdate: vi.fn(async () => {}) };
  client.vocabLayers.get = client.vocabLayers.get ?? vi.fn(async () => ({ items: [] }));
  client.tokenLayers = client.tokenLayers ?? { get: vi.fn(async () => ({ project: 'p1' })) };
  // The open operation's label, as the writes inside it carry it.
  client.labels = [];
  client.withOperation = vi.fn(async (label, fn) => {
    client.labels.push(label);
    try {
      return await fn();
    } finally {
      client.labels.pop();
    }
  });
  client.batched = vi.fn(async (fn) => {
    const sent = [];
    await fn({
      projects: { unlinkVocab: (...a) => sent.push(client.projects.unlinkVocab(...a)) },
      tokens: { bulkUpdate: (...a) => sent.push(client.tokens.bulkUpdate(...a)) },
    });
    return Promise.all(sent);
  });
  return client;
};

// The home projects as `projects.list()` gives them, with their role lists.
// "Field notes" holds Mine, and the user reads it. Theirs's home is a project
// the user holds no role in, which only an admin's list carries.
const FIELD_NOTES = {
  id: 'pa',
  name: 'Field notes',
  maintainers: [],
  writers: [],
  readers: ['me@x.org'],
};
const CLOSED = { id: 'pb', name: 'Closed', maintainers: ['other@x.org'], writers: [], readers: [] };
const homesFor = () => (auth.user.isAdmin ? [FIELD_NOTES, CLOSED] : [FIELD_NOTES]);
const VOCABS = {
  v1: { id: 'v1', name: 'Mine', project: 'pa' },
  v2: { id: 'v2', name: 'Theirs', project: 'pb' },
};
// This project, as the page reads it: the user maintains it.
const thisProject = (vocabs) => ({ id: 'p1', name: 'Story', maintainers: ['me@x.org'], vocabs });

const makeClient = ({ linked = [], link, own = [] } = {}) =>
  batching({
    vocabLayers: {
      list: vi.fn(async () => [...own, VOCABS.v1, VOCABS.v2]),
    },
    projects: {
      get: vi.fn(async () => thisProject([...own, ...linked.map((id) => VOCABS[id])])),
      list: vi.fn(async () => homesFor()),
      linkVocab: vi.fn(link ?? (async () => {})),
      unlinkVocab: vi.fn(async () => {}),
    },
    query: vi.fn(async () => ({ results: [] })),
  });

const rowOf = (root, name) => byText(root, 'tbody tr', name);
const boxOf = (root, name) => rowOf(root, name).querySelector('input[type=checkbox]');

// The page's project, as the page read it.
const mount = async (client, onProjectUpdate) =>
  renderComponent(
    <MemoryRouter>
      <VocabularySettings
        project={await client.projects.get('p1')}
        projectId="p1"
        client={client}
        onProjectUpdate={onProjectUpdate}
      />
    </MemoryRouter>,
  );

beforeEach(() => {
  notifyError.mockClear();
  auth = { user: { id: 'me@x.org', isAdmin: false } };
});

describe('Project settings, Vocabularies', () => {
  it('will not tick a vocabulary of a project the user holds no role in', async () => {
    const client = makeClient();
    const view = await mount(client);
    expect(boxOf(view.container, 'Mine').disabled).toBe(false);
    expect(boxOf(view.container, 'Theirs').disabled).toBe(true);
    expect(rowOf(view.container, 'Theirs').textContent).toContain(
      'Needs access to the project it belongs to.',
    );
    expect(rowOf(view.container, 'Mine').textContent).not.toContain('Needs access');
    await view.step(() => rowOf(view.container, 'Theirs').click());
    expect(client.projects.linkVocab).not.toHaveBeenCalled();
    await view.step(() => rowOf(view.container, 'Mine').click());
    expect(client.projects.linkVocab).toHaveBeenCalledWith('p1', 'v1');
    await view.unmount();
  });

  it('leaves a borrowed vocabulary free to unlink, linkable or not', async () => {
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
  const twoOfMine = (linkVocab) =>
    batching({
      vocabLayers: {
        list: vi.fn(async () => [
          { id: 'v1', name: 'Alpha', project: 'pa' },
          { id: 'v3', name: 'Gamma', project: 'pa' },
          { id: 'v4', name: 'Delta', project: 'pa' },
        ]),
      },
      projects: {
        get: vi.fn(async () => thisProject([{ id: 'v4', project: 'pa' }])),
        list: vi.fn(async () => homesFor()),
        linkVocab: vi.fn(linkVocab),
        unlinkVocab: vi.fn(async () => {}),
      },
      query: vi.fn(async () => ({ results: [] })),
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
  it('locks again once a vocabulary they may not link is unlinked', async () => {
    const view = await mount(makeClient({ linked: ['v2'] }));
    await view.step(() => rowOf(view.container, 'Theirs').click());
    await view.step(() => byText(document.body, '[role=alertdialog] button', 'Unlink').click());
    expect(boxOf(view.container, 'Theirs').checked).toBe(false);
    expect(boxOf(view.container, 'Theirs').disabled).toBe(true);
    await view.unmount();
  });
});

// A vocabulary of this project is linked for good: core refuses to unlink it
// from its own project. Every other row says which project it comes from, by
// name where the user can read that project.
describe('Project settings, Vocabularies, own and borrowed', () => {
  const OWN = { id: 'v0', name: 'Home lexicon', project: 'p1' };

  it('shows this project’s own vocabulary ticked and locked, and sends nothing for it', async () => {
    const client = makeClient({ own: [OWN] });
    const view = await mount(client);
    const box = boxOf(view.container, 'Home lexicon');
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(rowOf(view.container, 'Home lexicon').textContent).toContain('Belongs to this project.');
    expect(rowOf(view.container, 'Home lexicon').querySelector('button')).toBeNull();
    await view.step(() => rowOf(view.container, 'Home lexicon').click());
    expect(document.body.querySelector('[role=alertdialog]')).toBeNull();
    expect(client.projects.unlinkVocab).not.toHaveBeenCalled();
    expect(client.projects.linkVocab).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('names the project a borrowed vocabulary comes from, or says another project', async () => {
    const view = await mount(makeClient({ linked: ['v1', 'v2'] }));
    expect(rowOf(view.container, 'Mine').textContent).toContain('From “Field notes”.');
    expect(rowOf(view.container, 'Theirs').textContent).toContain('From another project.');
    expect(rowOf(view.container, 'Mine').textContent).not.toContain('Belongs to this project.');
    await view.unmount();
  });

  it('offers a borrowed vocabulary the Unlink control', async () => {
    const view = await mount(makeClient({ linked: ['v1'] }));
    expect(rowOf(view.container, 'Mine').querySelector('button[title=Unlink]')).not.toBeNull();
    await view.unmount();
  });

  it('links to a new vocabulary of this project', async () => {
    const view = await mount(makeClient());
    const a = byText(view.container, 'a', 'New vocabulary');
    expect(a.getAttribute('href')).toBe('/vocabularies/new?project=p1');
    await view.unmount();
  });
});

// Two vocabularies may share a name. Each row shows its entry count, which is
// what tells them apart (a sense is not an entry).
describe('Project settings, Vocabularies, entry counts', () => {
  it('shows each vocabulary its entry count beside its name', async () => {
    const client = {
      vocabLayers: {
        list: vi.fn(async () => [
          { id: 'v1', name: 'Lexicon', project: 'pa' },
          { id: 'v2', name: 'Lexicon', project: 'pa' },
        ]),
      },
      projects: {
        get: vi.fn(async () => thisProject([])),
        list: vi.fn(async () => homesFor()),
      },
      // Every entry counts, senses included, as on the vocabulary's page.
      query: vi.fn(async () => ({
        results: [
          ['v1', 1],
          ['v2', 1207],
        ],
      })),
    };
    const view = await mount(client);
    const rows = all(view.container, 'tbody tr').map((r) => r.textContent);
    expect(rows).toEqual([
      'Lexicon1 entryFrom “Field notes”.',
      'Lexicon1,207 entriesFrom “Field notes”.',
    ]);
    await view.unmount();
  });
});

// An unlink removes every link the project has into the vocabulary, and the
// confirm names how many.
describe('Project settings, Vocabularies, the unlink confirm', () => {
  const linkQuery = (q) => q.where.some((c) => c[0] === 'link');
  const counted = (answer) => {
    const client = makeClient({ linked: ['v1'] });
    client.query = vi.fn(async (q) => (linkQuery(q) ? answer(q) : { results: [] }));
    return client;
  };
  const dialogText = () => document.body.querySelector('[role=alertdialog]')?.textContent ?? '';

  it('names the number of links in this project', async () => {
    const client = counted(async () => ({ results: [[1204]] }));
    const view = await mount(client);
    await view.step(() => rowOf(view.container, 'Mine').click());
    expect(dialogText()).toContain('This project has 1,204 links to its entries.');
    const q = client.query.mock.calls.map((c) => c[0]).find(linkQuery);
    expect(q.scope).toEqual({ projectIds: ['p1'] });
    expect(q.where).toContainEqual(['vocab', '?v', { layer: 'v1' }]);
    await view.unmount();
  });

  it('waits for the count before Unlink can be pressed', async () => {
    let settle;
    const client = counted(() => new Promise((resolve) => (settle = resolve)));
    const view = await mount(client);
    await view.step(() => rowOf(view.container, 'Mine').click());
    expect(dialogText()).toContain('Counting links');
    expect(byText(document.body, '[role=alertdialog] button', 'Unlink').disabled).toBe(true);
    await view.step(async () => settle({ results: [[0]] }));
    expect(dialogText()).toContain('This project has no links to its entries.');
    expect(byText(document.body, '[role=alertdialog] button', 'Unlink').disabled).toBe(false);
    await view.unmount();
  });

  // SEAM-4: unlinking is any project maintainer's, linking again only for
  // someone with a role in the vocabulary's project, so the confirm says so
  // first.
  it('says the user cannot link again a vocabulary of a project they hold no role in', async () => {
    const client = makeClient({ linked: ['v1', 'v2'] });
    client.query = vi.fn(async (q) => (linkQuery(q) ? { results: [[4]] } : { results: [] }));
    const view = await mount(client);
    await view.step(() => rowOf(view.container, 'Theirs').click());
    expect(dialogText()).toContain('You cannot link it again.');
    expect(dialogText()).toContain('This project has 4 links to its entries.');
    await view.step(() => byText(document.body, '[role=alertdialog] button', 'Cancel').click());
    await view.step(() => rowOf(view.container, 'Mine').click());
    expect(dialogText()).toContain('This project has 4 links to its entries.');
    expect(dialogText()).not.toContain('You cannot link it again.');
    await view.unmount();
  });

  it('says nothing of linking again to an admin', async () => {
    auth = { user: { id: 'admin@x.org', isAdmin: true } };
    const view = await mount(counted(async () => ({ results: [[0]] })));
    await view.step(() => rowOf(view.container, 'Mine').click());
    expect(dialogText()).not.toContain('You cannot link it again.');
    await view.unmount();
  });

  it('says when the count could not be read, and still unlinks', async () => {
    const client = counted(async () => {
      throw new Error('down');
    });
    const view = await mount(client);
    await view.step(() => rowOf(view.container, 'Mine').click());
    expect(dialogText()).toContain('The number of links could not be read.');
    await view.step(() => byText(document.body, '[role=alertdialog] button', 'Unlink').click());
    expect(client.projects.unlinkVocab).toHaveBeenCalledWith('p1', 'v1');
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
    expect(view.container.textContent).toMatch(/Failed to load or save the vocabularies/);
    expect(notifyError).not.toHaveBeenCalled();
    await view.unmount();
  });
});

// The links shown are the page's project's, and a link sent reads the page's
// project again, so the other settings sections show it.
describe("Project settings, Vocabularies, the page's project", () => {
  it('shows the links the page holds', async () => {
    const client = makeClient({ linked: ['v2'] });
    const project = { id: 'p1', vocabs: [{ id: 'v1' }] };
    const view = await renderComponent(
      <MemoryRouter>
        <VocabularySettings project={project} projectId="p1" client={client} />
      </MemoryRouter>,
    );
    expect(boxOf(view.container, 'Mine').checked).toBe(true);
    expect(boxOf(view.container, 'Theirs').checked).toBe(false);
    expect(client.projects.get).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('reads the page again after a link or an unlink, and not after a refusal', async () => {
    const onProjectUpdate = vi.fn(async () => {});
    const client = makeClient({ linked: ['v2'] });
    const view = await mount(client, onProjectUpdate);
    await view.step(() => rowOf(view.container, 'Mine').click());
    expect(client.projects.linkVocab).toHaveBeenCalledWith('p1', 'v1');
    expect(onProjectUpdate).toHaveBeenCalledTimes(1);
    await view.step(() => rowOf(view.container, 'Theirs').click());
    await view.step(() => byText(document.body, '[role=alertdialog] button', 'Unlink').click());
    expect(client.projects.unlinkVocab).toHaveBeenCalledWith('p1', 'v2');
    expect(onProjectUpdate).toHaveBeenCalledTimes(2);
    await view.unmount();

    const refusing = makeClient({
      link: async () => {
        throw refused();
      },
    });
    const update = vi.fn(async () => {});
    const again = await mount(refusing, update);
    await again.step(() => rowOf(again.container, 'Mine').click());
    expect(update).not.toHaveBeenCalled();
    await again.unmount();
  });
});

// Ruling Q1: a morpheme goes by its entry's type and stores none while
// linked, so when the unlink takes the project's links into the vocabulary,
// each morpheme they leave keeps its entry's type, in the unlink's batch.
describe('Project settings, Vocabularies, an unlink keeps the morph types', () => {
  it('writes the entry type onto each morpheme the unlink leaves, in the same batch', async () => {
    const client = makeClient({ linked: ['v1'] });
    client.vocabLayers.get = vi.fn(async () => ({
      items: [
        { id: 'e-s', form: 's', metadata: { morphType: 'suffix' } },
        { id: 'e-s1', form: 's', metadata: { parent: 'e-s', senseOrder: 1 } },
        { id: 'e-cat', form: 'cat', metadata: {} },
      ],
    }));
    client.projects.get = vi.fn(async (id) => ({
      id,
      vocabs: [{ id: 'v1' }],
      writers: ['me@x.org'],
    }));
    client.query = vi.fn(async (q) =>
      q.return?.group?.[0] === '?d'
        ? { results: [['doc-1', 1]] }
        : q.where.some((c) => c[0] === 'link-token')
          ? {
              results: [
                ['e-s', 'm-1', 'ml', 'morpheme', 1],
                ['e-s1', 'm-2', 'ml', 'morpheme', 1],
                ['e-s', 'w-1', 'wl', 'word', 1],
                ['e-cat', 'm-3', 'ml', 'morpheme', 1],
              ],
            }
          : { results: [[4]] },
    );
    const view = await mount(client);
    await view.step(() => rowOf(view.container, 'Mine').click());
    await view.step(() => byText(document.body, '[role=alertdialog] button', 'Unlink').click());
    expect(client.batched).toHaveBeenCalledTimes(1);
    expect(client.tokens.bulkUpdate).toHaveBeenCalledWith([
      { id: 'm-1', metadata: [{ op: 'set', path: ['morphType'], value: 'suffix' }] },
      { id: 'm-2', metadata: [{ op: 'set', path: ['morphType'], value: 'suffix' }] },
    ]);
    expect(client.projects.unlinkVocab).toHaveBeenCalledWith('p1', 'v1');
    const q = client.query.mock.calls.map((c) => c[0]).find((x) => x.limit);
    expect(q.scope).toEqual({ projectIds: ['p1'] });
    await view.unmount();
  });
});

// REV-FX-VOCAB-2: an unlink whose kept types reach a held document is refused
// whole (423), and says so plainly, not with the server's ids.
describe('Project settings, Vocabularies, an unlink while a linked document is held', () => {
  it('says a linked document is in use', async () => {
    const client = makeClient({ linked: ['v1'] });
    client.vocabLayers.get = vi.fn(async () => ({
      items: [{ id: 'e-s', form: 's', metadata: { morphType: 'suffix' } }],
    }));
    client.projects.get = vi.fn(async (id) => ({
      id,
      vocabs: [{ id: 'v1' }],
      writers: ['me@x.org'],
    }));
    client.query = vi.fn(async (q) =>
      q.return?.group?.[0] === '?d'
        ? { results: [['doc-1', 1]] }
        : q.where.some((c) => c[0] === 'link-token')
          ? { results: [['e-s', 'm-1', 'ml', 'morpheme', 1]] }
          : { results: [[1]] },
    );
    const said = 'Document 01a04095-38c4-74d1-8450-a7d6a0267af7 is locked by svc@x.org';
    client.batched = vi.fn(async () => {
      throw Object.assign(new Error(`HTTP 423 ${said}`), {
        status: 423,
        responseData: { error: said },
      });
    });
    const view = await mount(client);
    await view.step(() => rowOf(view.container, 'Mine').click());
    await view.step(() => byText(document.body, '[role=alertdialog] button', 'Unlink').click());
    await view.step(() => new Promise((r) => setTimeout(r, 0)));
    expect(notifyError).toHaveBeenCalledWith(
      'A document linked to it is in use. Try again when it is free.',
      'Vocabularies not updated',
    );
    expect(boxOf(view.container, 'Mine').checked).toBe(true);
    await view.unmount();
  });
});

// History and Activity name a link or unlink by the vocabulary's name, not
// its id ("Remove vocab 01a1… from project …" is what core writes).
describe('Project settings, Vocabularies, the History label', () => {
  it('labels a link and an unlink with the vocabulary name', async () => {
    const client = makeClient({ linked: ['v2'] });
    const seen = [];
    client.projects.linkVocab = vi.fn(async () => seen.push(['link', client.labels.at(-1)]));
    client.projects.unlinkVocab = vi.fn(async () => seen.push(['unlink', client.labels.at(-1)]));
    const view = await mount(client);
    await view.step(() => rowOf(view.container, 'Mine').click());
    await view.step(() => rowOf(view.container, 'Theirs').click());
    await view.step(() => byText(document.body, '[role=alertdialog] button', 'Unlink').click());
    expect(seen).toEqual([
      ['link', 'Link vocabulary “Mine”'],
      ['unlink', 'Unlink vocabulary “Theirs”'],
    ]);
    await view.unmount();
  });
});
