import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// The entry form's saves: each shows at once and is sent in its turn. What the
// list shows afterwards must be what the server holds, a new entry's form must
// survive its server id arriving, and a save sends only the keys it changed.

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
  useAssistantAvailable: () => false,
}));
// The assistant's "applied" callback is the screen's refetch after an import.
const subject = vi.hoisted(() => ({ current: null }));
vi.mock('@ui/components/assistant/subject.js', () => ({
  useAskAssistant: () => null,
  useAssistantSubject: (s) => {
    subject.current = s;
  },
}));
vi.mock('@ui/components/assistant/useDock.js', () => ({ useWideEnoughToDock: () => false }));

const auth = vi.hoisted(() => ({ client: null, user: { id: 'u', isAdmin: true } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));

const { VocabularyItems } = await import('./VocabularyItems.jsx');
const { WriteQueue } = await import('@ui/domain/WriteQueue.js');
const { hasUnsavedDraft } = await import('@ui/hooks/useUnsavedDraft.js');

const FIELDS = [{ name: 'gloss', type: 'text' }];

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// A server holding `items`. `holds` is a list of deferreds the next writes
// wait on, in order.
const stub = (items) => {
  const calls = [];
  const holds = [];
  const write =
    (kind, fn) =>
    async (...args) => {
      calls.push([kind, ...args]);
      const hold = holds.shift();
      if (hold) await hold.promise;
      return fn(...args);
    };
  return {
    calls,
    holds,
    client: {
      withOperation: (_label, fn) => fn(),
      query: async () => ({ results: [] }),
      vocabLayers: {
        get: async () => ({ id: 'v1', name: 'Lexicon', config: {}, items: structuredClone(items) }),
      },
      projects: { list: async () => [] },
      vocabItems: {
        create: write('create', () => ({ id: 'server-1' })),
        update: write('update', () => ({})),
        bulkUpdate: write('bulkUpdate', () => ({})),
        patchMetadata: write('patchMetadata', () => ({})),
        setMetadata: write('setMetadata', () => ({})),
        deleteMetadata: write('deleteMetadata', () => ({})),
        delete: write('delete', () => ({})),
      },
    },
  };
};

const mount = async (client, at) => {
  auth.client = client;
  const view = await renderComponent(
    <MemoryRouter initialEntries={[at]}>
      <VocabularyItems
        vocabularyId="v1"
        vocabulary={{ id: 'v1' }}
        client={client}
        fields={FIELDS}
        writes={new WriteQueue()}
      />
    </MemoryRouter>,
  );
  await view.step(async () => {});
  await view.step(async () => {});
  return view;
};

const setValue = (el, value) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const formInput = () => document.querySelector('input[id$="-form"]');
const glossInput = () => document.querySelector('input[id$="-field-0"]');
const button = (name) => all(document.body, 'button').find((b) => b.textContent.trim() === name);
// A row is a link whose text runs the form, the gloss and the use count
// together, so a form is found as one of its parts.
const parts = (a) => [...a.querySelectorAll('*')].map((n) => n.textContent.trim());
const link = (form) => all(document.body, 'a').find((a) => parts(a).includes(form));
const listed = () =>
  [...new Set(all(document.body, 'a').flatMap(parts))]
    .filter((t) => /^(uno|dos)(-EDIT)?$/.test(t))
    .sort();

describe('the entry form', () => {
  it('does not send a save queued behind one that was refused', async () => {
    const { client, calls, holds } = stub([
      { id: 'a', form: 'uno' },
      { id: 'b', form: 'dos' },
    ]);
    const refused = deferred();
    holds.push(refused);
    const view = await mount(client, '/vocabularies/v1?item=a');

    await view.step(() => setValue(formInput(), 'uno-EDIT'));
    await view.step(() => button('Save').click());
    await view.step(() => link('dos').click());
    expect(formInput().value).toBe('dos');
    await view.step(() => setValue(formInput(), 'dos-EDIT'));
    await view.step(() => button('Save').click());
    expect(listed()).toEqual(['dos-EDIT', 'uno-EDIT']);

    await view.step(async () => {
      refused.reject(new Error('refused'));
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls.filter(([kind]) => kind !== 'create')).toHaveLength(1);
    expect(listed()).toEqual(['dos', 'uno']);
    await view.unmount();
  });

  it("keeps what is typed into a new entry when the server's id arrives", async () => {
    const { client, holds } = stub([{ id: 'a', form: 'uno' }]);
    const create = deferred();
    holds.push(create);
    const view = await mount(client, '/vocabularies/v1?item=new');

    await view.step(() => setValue(formInput(), 'nuevo'));
    await view.step(() => button('Create').click());
    await view.step(() => setValue(glossInput(), 'new word'));
    await view.step(async () => {
      create.resolve();
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
    expect(link('nuevo').getAttribute('href')).toContain('item=server-1');
    expect(formInput().value).toBe('nuevo');
    expect(glossInput().value).toBe('new word');
    await view.unmount();
  });

  it('sends only the keys a save changed', async () => {
    const { client, calls } = stub([
      { id: 'a', form: 'uno', metadata: { gloss: 'one', note: 'kept' } },
    ]);
    const view = await mount(client, '/vocabularies/v1?item=a');
    await view.step(() => setValue(glossInput(), 'ONE'));
    await view.step(async () => {
      button('Save').click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls).toEqual([
      ['bulkUpdate', [{ id: 'a', metadata: [{ op: 'set', path: ['gloss'], value: 'ONE' }] }]],
    ]);
    await view.unmount();
  });

  it('saves an entry whose older roleset the rule would refuse, when the roleset is untouched', async () => {
    // "look after-01" was accepted before rolesets were checked. The band
    // that could mend it is not even on screen here (no UMR project links
    // this vocabulary), so it must not lock the rest of the entry.
    const { client, calls } = stub([
      { id: 'a', form: 'uno', metadata: { gloss: 'one', umr: { roleset: 'look after-01' } } },
    ]);
    const view = await mount(client, '/vocabularies/v1?item=a');
    await view.step(() => setValue(glossInput(), 'ONE'));
    await view.step(async () => {
      button('Save').click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls).toEqual([
      ['bulkUpdate', [{ id: 'a', metadata: [{ op: 'set', path: ['gloss'], value: 'ONE' }] }]],
    ]);
    await view.unmount();
  });

  it('asks before the tab closes while a save is on its way, after the screen is left too', async () => {
    const { client, holds } = stub([{ id: 'a', form: 'uno' }]);
    const held = deferred();
    holds.push(held);
    const asks = () => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const view = await mount(client, '/vocabularies/v1?item=a');
    expect(asks()).toBe(false);
    await view.step(() => setValue(formInput(), 'uno-EDIT'));
    await view.step(() => button('Save').click());
    expect(asks()).toBe(true);
    await view.unmount();
    expect(asks()).toBe(true);

    held.resolve();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(asks()).toBe(false);
  });

  it('reads the entries again after an import only once the saves queued before it have landed', async () => {
    const { client, calls, holds } = stub([{ id: 'a', form: 'uno' }]);
    // A server that applies the save once it lands.
    const server = [{ id: 'a', form: 'uno' }];
    const gets = [];
    client.vocabLayers.get = async () => {
      gets.push(calls.length);
      return { id: 'v1', name: 'Lexicon', config: {}, items: structuredClone(server) };
    };
    const held = deferred();
    holds.push(held);
    const view = await mount(client, '/vocabularies/v1?item=a');
    const loads = gets.length;

    await view.step(() => setValue(formInput(), 'uno-EDIT'));
    await view.step(() => button('Save').click());
    await view.step(async () => {
      subject.current.onApplied();
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
    // Nothing is read while the save is still on its way.
    expect(gets.length).toBe(loads);
    expect(listed()).toEqual(['uno-EDIT']);

    await view.step(async () => {
      server[0].form = 'uno-EDIT';
      held.resolve();
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
    expect(gets.length).toBe(loads + 1);
    expect(listed()).toEqual(['uno-EDIT']);
    await view.unmount();
  });

  it('asks before an entry with unsaved edits is left, whichever way out', async () => {
    const { client } = stub([{ id: 'a', form: 'uno' }]);
    const view = await mount(client, '/vocabularies/v1?item=a');
    expect(hasUnsavedDraft()).toBeNull();
    await view.step(() => setValue(formInput(), 'uno-EDIT'));
    expect(hasUnsavedDraft()).toBe('The entry you have typed');
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    await view.step(() => button('Save').click());
    expect(hasUnsavedDraft()).toBeNull();
    await view.unmount();
  });
});
