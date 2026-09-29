import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// What Merge says, and what it does when an entry went meanwhile
// (REV-F-BULK defects 4 and 8). Two entries spelled alike are told apart by
// their numbers, drawn as subscripts (dog₂ → dog₁). The preview and the toast
// count the same thing, links, and the toast says how many of the links it
// moved are in projects this person cannot open. A merge refused because an
// entry is gone reads the entries again.

const feedback = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
  humanizeError: (e) => `said: ${e.message}`,
}));
vi.mock('@/utils/feedback', () => feedback);
const auth = { user: { id: 'u1' } };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
const { MergePanel } = await import('./MergePanel.jsx');

const ITEMS = [
  { id: 'd1', form: 'dog' },
  { id: 'd2', form: 'dog' },
  { id: 'c1', form: 'cat' },
];

const makeClient = ({ merged, refuse = null } = {}) => {
  const client = {
    items: ITEMS,
    reads: 0,
    vocabLayers: {
      get: async (id, withItems) => {
        if (withItems) client.reads += 1;
        return {
          id,
          name: 'Lexicon',
          maintainers: ['u1'],
          timeModified: null,
          config: {},
          ...(withItems ? { items: client.items } : {}),
        };
      },
    },
    // One link on dog₂ this person can see, in one document.
    query: async () => ({ results: [['doc1', 'l1', 1]] }),
    withOperation: async (_label, fn) => fn(),
    batched: async (fn) => {
      const ops = [];
      await fn({
        vocabItems: {
          bulkUpdate: (u) => ops.push(['bulkUpdate', u]),
          merge: (s, l) => ops.push(['merge', s, l]),
        },
      });
      if (refuse) throw refuse;
      return ops.map(([kind]) => ({ status: 200, body: kind === 'merge' ? merged : {} }));
    },
  };
  return client;
};

const mount = async (client) => {
  const view = await renderComponent(
    <MemoryRouter>
      <MergePanel project={{ id: 'p1', vocabs: [{ id: 'v1', name: 'Lexicon' }] }} client={client} />
    </MemoryRouter>,
  );
  for (let i = 0; i < 4; i++) await view.step(async () => {});
  return view;
};
const settle = async (view) => {
  for (let i = 0; i < 6; i++)
    await view.step(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
};
const button = (label) =>
  all(document.body, 'button').find((b) => b.textContent.trim() === label) ?? null;

// Rows are sorted by form: cat, dog, dog. Tick the two dogs, d1 first (the
// survivor), then preview.
const previewDogs = async (view) => {
  const boxes = all(document.body, 'input[type="checkbox"]');
  await view.step(() => boxes[1].click());
  await view.step(() => boxes[2].click());
  await view.step(() => button('Preview').click());
  await settle(view);
};
const apply = async (view) => {
  await view.step(() => button('Apply 1 change').click());
  await settle(view);
  await view.step(() => button('Apply').click());
  await settle(view);
};

describe('Merge', () => {
  it('names entries spelled alike by their subscript number, and counts links', async () => {
    const client = makeClient({ merged: { moved: 1, duplicates: 0, removed: ['d2'] } });
    const view = await mount(client);
    await previewDogs(view);
    const line = all(document.body, 'span').find((s) => s.textContent.includes('will follow.'));
    expect(line).toBeTruthy();
    expect(all(line, 'sub').map((s) => s.textContent)).toEqual(['2', '1']);
    expect(line.textContent).toBe('dog2 → dog1: 1 link in 1 document will follow.');
    await view.unmount();
  });

  it('says how many of the links it moved are in projects this person cannot open', async () => {
    feedback.notifySuccess.mockClear();
    const client = makeClient({ merged: { moved: 3, duplicates: 0, removed: ['d2'] } });
    const view = await mount(client);
    await previewDogs(view);
    await apply(view);
    expect(feedback.notifySuccess).toHaveBeenCalledWith(
      '1 entry merged. 3 links moved to “dog 1”, 2 of them in projects you cannot open.',
      'Merged',
    );
    await view.unmount();
  });

  it('says nothing of other projects when every link moved was seen', async () => {
    feedback.notifySuccess.mockClear();
    const client = makeClient({ merged: { moved: 1, duplicates: 0, removed: ['d2'] } });
    const view = await mount(client);
    await previewDogs(view);
    await apply(view);
    expect(feedback.notifySuccess).toHaveBeenCalledWith(
      '1 entry merged. 1 link moved to “dog 1”.',
      'Merged',
    );
    await view.unmount();
  });

  it('reads the entries again when the survivor went meanwhile', async () => {
    feedback.notifyError.mockClear();
    const gone = Object.assign(new Error('HTTP 403'), {
      status: 403,
      method: 'POST',
      responseData: { error: 'User u1 lacks maintainer access to vocab layer' },
    });
    const client = makeClient({ refuse: gone });
    const view = await mount(client);
    await previewDogs(view);
    client.items = ITEMS.filter((it) => it.id !== 'd1');
    const readsBefore = client.reads;
    await apply(view);
    expect(feedback.notifyError).toHaveBeenCalledWith('said: HTTP 403', 'Failed to apply');
    // Read at Apply, then once more after the refusal.
    expect(client.reads).toBe(readsBefore + 2);
    expect(all(document.body, 'input[type="checkbox"]')).toHaveLength(2);
    expect(button('Apply 1 change')).toBeNull();
    // dog₂ stays ticked, and no survivor is chosen.
    expect(all(document.body, 'input[type="radio"]').some((r) => r.checked)).toBe(false);
    await view.unmount();
  });
});
