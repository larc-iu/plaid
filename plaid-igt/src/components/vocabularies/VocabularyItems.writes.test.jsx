import { afterEach, describe, it, expect, vi } from 'vitest';
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
const feedback = await import('@/utils/feedback');

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

// A server holding `items`, which a create or a form change that lands
// updates. `holds` is a list of deferreds the next writes wait on, in order.
const stub = (initial) => {
  const items = structuredClone(initial);
  const calls = [];
  const holds = [];
  const setForms = (updates) => {
    for (const u of updates || []) {
      const it = items.find((i) => i.id === u.id);
      if (it && 'form' in u) it.form = u.form;
    }
    return {};
  };
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
      withOperation: (_label, fn) => fn(() => {}),
      // A batch's writes go out as the client's own here.
      batched(fn) {
        return fn(this);
      },
      query: async () => ({ results: [] }),
      vocabLayers: {
        get: async () => ({ id: 'v1', name: 'Lexicon', config: {}, items: structuredClone(items) }),
      },
      projects: { list: async () => [] },
      vocabItems: {
        create: write('create', (_layer, form, metadata) => {
          items.push({ id: 'server-1', form, metadata: metadata ?? {} });
          return { id: 'server-1' };
        }),
        update: write('update', () => ({})),
        bulkCreate: write('bulkCreate', (specs) => ({ ids: specs.map((_, i) => `bulk-${i}`) })),
        bulkUpdate: write('bulkUpdate', setForms),
        patchMetadata: write('patchMetadata', () => ({})),
        setMetadata: write('setMetadata', () => ({})),
        deleteMetadata: write('deleteMetadata', () => ({})),
        delete: write('delete', () => ({})),
      },
    },
  };
};

const mount = async (client, at, writes = new WriteQueue()) => {
  auth.client = client;
  const view = await renderComponent(
    <MemoryRouter initialEntries={[at]}>
      <VocabularyItems
        vocabularyId="v1"
        vocabulary={{ id: 'v1' }}
        client={client}
        fields={FIELDS}
        writes={writes}
      />
    </MemoryRouter>,
  );
  // The entries are read in two steps: the vocabulary's time, then the entries
  // (vocabCache.js).
  await view.step(async () => {});
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
  it('sends a save queued behind one that was refused, and reads the entries again once it lands', async () => {
    const { client, calls, holds } = stub([
      { id: 'a', form: 'uno' },
      { id: 'b', form: 'dos' },
    ]);
    const refused = deferred();
    holds.push(refused);
    const view = await mount(client, '/vocabularies/v1?item=a');
    const get = vi.spyOn(client.vocabLayers, 'get');

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
    const updates = calls.filter(([kind]) => kind === 'bulkUpdate');
    expect(updates).toHaveLength(2);
    expect(updates[1][1]).toEqual([{ id: 'b', form: 'dos-EDIT' }]);
    // The refusal's read, then the one that shows the save sent behind it,
    // each the vocabulary's time and then its entries.
    expect(get.mock.calls.filter((args) => args[1] === true)).toHaveLength(2);
    expect(feedback.notifyError).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('says nothing when a save or a delete lands', async () => {
    const { client, calls } = stub([{ id: 'a', form: 'uno' }]);
    const view = await mount(client, '/vocabularies/v1?item=a');
    await view.step(() => setValue(glossInput(), 'one'));
    await view.step(async () => {
      button('Save').click();
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
    await view.step(() => button('Delete').click());
    await view.step(async () => {
      button('Delete entry').click();
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls.map(([kind]) => kind)).toEqual(['bulkUpdate', 'delete']);
    expect(feedback.notifySuccess).not.toHaveBeenCalled();
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

  it('saves on Enter in any one-line field and on Ctrl+Enter, and only when something changed', async () => {
    const { client, calls } = stub([{ id: 'a', form: 'uno', metadata: { gloss: 'one' } }]);
    const view = await mount(client, '/vocabularies/v1?item=a');
    const press = (el, init = {}) =>
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }),
      );
    const sent = () => calls.filter(([kind]) => kind === 'bulkUpdate').length;
    await view.step(() => press(glossInput()));
    expect(sent()).toBe(0);
    await view.step(() => setValue(glossInput(), 'ONE'));
    await view.step(() => press(glossInput(), { shiftKey: true }));
    expect(sent()).toBe(0);
    await view.step(async () => {
      press(glossInput());
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(sent()).toBe(1);
    await view.step(() => setValue(glossInput(), 'ONE!'));
    await view.step(async () => {
      press(glossInput(), { ctrlKey: true });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(sent()).toBe(2);
    await view.step(() => setValue(formInput(), 'uno2'));
    await view.step(async () => {
      press(formInput());
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(sent()).toBe(3);
    await view.unmount();
  });

  it('puts the caret in the Form field after Save, which greys out', async () => {
    const { client } = stub([{ id: 'a', form: 'uno' }]);
    const view = await mount(client, '/vocabularies/v1?item=a');
    await view.step(() => setValue(glossInput(), 'one'));
    await view.step(async () => {
      button('Save').focus();
      button('Save').click();
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(button('Save').disabled).toBe(true);
    expect(document.activeElement).toBe(formInput());
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

  it('refuses to save while an argument row of the roleset band names no ARG or repeats one', async () => {
    // Saved as it stood, the row would keep the argument as it was read and
    // say nothing of the name typed over it.
    const { client, calls } = stub([
      {
        id: 'a',
        form: 'uno',
        metadata: {
          gloss: 'one',
          umr: { roleset: 'uno-01', args: { ARG0: 'giver', ARG1: 'gift' } },
        },
      },
    ]);
    // A project set up for UMR links the vocabulary, so the band shows.
    client.projects.list = async () => [
      {
        id: 'p1',
        vocabs: [{ id: 'v1' }],
        textLayers: [{ tokenLayers: [{ config: { umr: { nodes: true } } }] }],
      },
    ];
    const view = await mount(client, '/vocabularies/v1?item=a');
    const argName = (n) => document.querySelector(`input[aria-label="Argument ${n} name"]`);
    expect(argName(2).value).toBe('ARG1');

    await view.step(() => setValue(glossInput(), 'ONE'));
    await view.step(() => setValue(argName(2), 'ARG0'));
    expect(document.body.textContent).toContain('ARG0 is named twice.');
    expect(button('Save').disabled).toBe(true);
    // Enter in the form box saves too, and is refused the same way.
    await view.step(() =>
      formInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    expect(feedback.notifyError).toHaveBeenCalledWith('ARG0 is named twice.', 'Not saved');
    expect(calls).toEqual([]);

    // A name typed over with nothing else changed still counts as typed, and
    // Cancel takes the row back to the entry's.
    await view.step(() => setValue(glossInput(), 'one'));
    await view.step(() => setValue(argName(2), 'ARG'));
    expect(hasUnsavedDraft()).toBeTruthy();
    await view.step(() => button('Cancel').click());
    expect(argName(2).value).toBe('ARG1');
    expect(hasUnsavedDraft()).toBeFalsy();

    await view.step(() => setValue(argName(2), 'ARG2'));
    expect(button('Save').disabled).toBe(false);
    await view.step(async () => {
      button('Save').click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls.length).toBe(1);
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
    // Only the reads of the entries count, not the vocabulary's time.
    client.vocabLayers.get = async (_id, withItems) => {
      if (withItems) gets.push(calls.length);
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

  it('creates a new sense with nothing typed, and does not call it unsaved', async () => {
    // Add sense seeds the form with its headword's form. That sense can be
    // created as it stands, to be filled in later, and leaving it loses
    // nothing, so no way out asks.
    const { client, calls } = stub([{ id: 'a', form: 'uno' }]);
    const view = await mount(client, '/vocabularies/v1?item=a');
    await view.step(() =>
      all(document.body, 'a')
        .find((a) => a.textContent.trim() === 'Add sense')
        .click(),
    );
    expect(formInput().value).toBe('uno');
    expect(hasUnsavedDraft()).toBeNull();
    expect(button('Create').disabled).toBe(false);
    await view.step(async () => {
      button('Create').click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls.map(([kind]) => kind)).toEqual(['create']);
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

// Bulk Add and Replace plan against the entries as shown, which can hold a
// save still on its way. Their writes take their turn behind it, and read the
// entries again then. A Replace of a value the server does not hold (a save
// it refused, someone else's change) is skipped, and a Bulk Add whose plan
// would now write something else goes back to its review.
describe('Bulk Add and Replace', () => {
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const kinds = (calls) => calls.map(([kind]) => kind);
  const replaceEdit = async (view) => {
    await view.step(() => button('Replace').click());
    await view.step(() => setValue(document.getElementById('vocab-replace-find'), 'EDIT'));
    await view.step(() => setValue(document.getElementById('vocab-replace-with'), 'X'));
    await view.step(async () => {
      button('Replace 1 value').click();
      await settle();
    });
  };
  const bulkAdd = async (view, label = 'Add 2') => {
    await view.step(() => button('Bulk Add').click());
    await view.step(() => setValue(document.querySelector('textarea'), 'dos\ttwo\ntres\tthree'));
    await view.step(() => button('Next: columns').click());
    await view.step(() => button('Next: review').click());
    await view.step(async () => {
      button(label).click();
      await settle();
    });
  };
  let mounted = null;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
  });
  const saving = async () => {
    const stubbed = stub([{ id: 'a', form: 'uno' }]);
    const held = deferred();
    stubbed.holds.push(held);
    const view = await mount(stubbed.client, '/vocabularies/v1?item=a');
    mounted = view;
    await view.step(() => setValue(formInput(), 'uno-EDIT'));
    await view.step(() => button('Save').click());
    return { ...stubbed, held, view };
  };

  // A study reads the audit log: a Bulk Add is an import of a table, and a
  // Replace a bulk edit.
  it('records a Bulk Add as an import and a Replace as a bulk edit', async () => {
    const stubbed = stub([{ id: 'a', form: 'uno-EDIT' }]);
    const opts = [];
    stubbed.client.withOperation = (_label, fn, o) => {
      opts.push(o);
      return fn(() => {});
    };
    const view = await mount(stubbed.client, '/vocabularies/v1');
    mounted = view;
    await replaceEdit(view);
    await bulkAdd(view);
    expect(opts.map(({ kind, ref }) => ({ kind, ref }))).toEqual([
      { kind: 'bulk-edit', ref: 'action:vocab-replace' },
      { kind: 'import', ref: 'format:table' },
    ]);
  });

  it('sends a Replace behind a save still on its way', async () => {
    const { calls, held, view } = await saving();
    await replaceEdit(view);
    expect(kinds(calls)).toEqual(['bulkUpdate']);
    await view.step(async () => {
      held.resolve();
      await settle();
    });
    expect(kinds(calls)).toEqual(['bulkUpdate', 'bulkUpdate']);
    expect(calls[1][1]).toEqual([{ id: 'a', form: 'uno-X' }]);
  });

  it('skips a Replace of a value whose save was refused, and says so', async () => {
    const { calls, held, view } = await saving();
    await replaceEdit(view);
    await view.step(async () => {
      held.reject(new Error('refused'));
      await settle();
    });
    expect(kinds(calls)).toEqual(['bulkUpdate']);
    expect(feedback.notifyWarning).toHaveBeenCalledWith(
      'Skipped 1 value changed since the preview.',
      'Nothing replaced',
    );
  });

  it('skips a Replace of a value someone else changed since the preview', async () => {
    const stubbed = stub([
      { id: 'a', form: 'uno-EDIT' },
      { id: 'b', form: 'dos-EDIT' },
    ]);
    const view = await mount(stubbed.client, '/vocabularies/v1');
    mounted = view;
    await view.step(() => button('Replace').click());
    await view.step(() => setValue(document.getElementById('vocab-replace-find'), 'EDIT'));
    await view.step(() => setValue(document.getElementById('vocab-replace-with'), 'X'));
    // Another maintainer renames b after this preview was drawn.
    const read = stubbed.client.vocabLayers.get;
    stubbed.client.vocabLayers.get = async (...args) => {
      const v = await read(...args);
      return { ...v, items: v.items.map((i) => (i.id === 'b' ? { ...i, form: 'dos-NEW' } : i)) };
    };
    await view.step(async () => {
      button('Replace 2 values').click();
      await settle();
    });
    expect(stubbed.calls).toEqual([['bulkUpdate', [{ id: 'a', form: 'uno-X' }]]]);
    expect(feedback.notifySuccess).toHaveBeenCalledWith(
      '1 value replaced in Form. Skipped 1 value changed since the preview.',
      'Replaced',
    );
  });

  it('writes nothing of a Bulk Add whose entries changed since the review, and reviews it again', async () => {
    const stubbed = stub([{ id: 'a', form: 'uno' }]);
    const view = await mount(stubbed.client, '/vocabularies/v1');
    mounted = view;
    const read = stubbed.client.vocabLayers.get;
    let added = false;
    stubbed.client.vocabLayers.get = async (...args) => {
      const v = await read(...args);
      return added ? { ...v, items: [...v.items, { id: 'd', form: 'dos', metadata: {} }] } : v;
    };
    await view.step(() => button('Bulk Add').click());
    await view.step(() => setValue(document.querySelector('textarea'), 'dos\ttwo\ntres\tthree'));
    await view.step(() => button('Next: columns').click());
    await view.step(() => button('Next: review').click());
    // Someone else adds "dos" after the review was drawn: the row for it now
    // fills that entry in rather than adding a second one.
    added = true;
    await view.step(async () => {
      button('Add 2').click();
      await settle();
    });
    expect(kinds(stubbed.calls)).toEqual([]);
    expect(document.body.textContent).toContain('Entries changed since this review.');
    expect(button('Add 1 · update 1')).toBeTruthy();
  });

  it('sends a Bulk Add behind a save still on its way', async () => {
    const { calls, held, view } = await saving();
    await bulkAdd(view);
    expect(kinds(calls)).toEqual(['bulkUpdate']);
    await view.step(async () => {
      held.resolve();
      await settle();
    });
    expect(kinds(calls)).toEqual(['bulkUpdate', 'bulkCreate']);
  });

  // An entry whose create is still on its way is shown under a pending id, and
  // a run planned against it must name the server's id when it is sent.
  const creating = async (form) => {
    const stubbed = stub([{ id: 'a', form: 'uno' }]);
    const held = deferred();
    stubbed.holds.push(held);
    const view = await mount(stubbed.client, '/vocabularies/v1?item=new');
    mounted = view;
    await view.step(() => setValue(formInput(), form));
    await view.step(() => button('Create').click());
    return { ...stubbed, held, view };
  };

  it("sends a Replace over an entry still being made under the server's id", async () => {
    const { calls, held, view } = await creating('dos-EDIT');
    await replaceEdit(view);
    await view.step(async () => {
      held.resolve();
      await settle();
    });
    expect(kinds(calls)).toEqual(['create', 'bulkUpdate']);
    expect(calls[1][1]).toEqual([{ id: 'server-1', form: 'dos-X' }]);
  });

  it("sends a Bulk Add update of an entry still being made under the server's id", async () => {
    const { calls, held, view } = await creating('dos');
    await bulkAdd(view, 'Add 1 · update 1');
    await view.step(async () => {
      held.resolve();
      await settle();
    });
    const update = calls.find(([kind]) => kind === 'bulkUpdate');
    expect(update).toBeTruthy();
    expect(update[1].map((u) => u.id)).toEqual(['server-1']);
  });

  it('sends a Bulk Add planned over a save that was refused', async () => {
    const { calls, held, view } = await saving();
    await bulkAdd(view);
    await view.step(async () => {
      held.reject(new Error('refused'));
      await settle();
    });
    expect(kinds(calls)).toEqual(['bulkUpdate', 'bulkCreate']);
  });
});

// A refusal says so and reads the entries again. It must not take what is
// typed into the entry open NOW, which need not be the one it was about, and a
// refused new entry goes back to a form that can be sent again.
describe('a refused entry write', () => {
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  let mounted = null;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    vi.clearAllMocks();
  });

  it('leaves the gloss being typed into another entry alone', async () => {
    const { client, holds } = stub([
      { id: 'a', form: 'uno' },
      { id: 'b', form: 'dos' },
    ]);
    const refused = deferred();
    holds.push(refused);
    const view = (mounted = await mount(client, '/vocabularies/v1?item=a'));
    await view.step(() => setValue(glossInput(), 'one'));
    await view.step(() => button('Save').click());
    await view.step(() => link('dos').click());
    await view.step(() => setValue(glossInput(), 'two, not saved'));
    await view.step(async () => {
      refused.reject(new Error('refused'));
      await settle();
    });
    expect(formInput().value).toBe('dos');
    expect(glossInput().value).toBe('two, not saved');
    expect(feedback.notifySuccess).not.toHaveBeenCalled();
    expect(feedback.notifyError).toHaveBeenCalledTimes(1);
  });

  it('puts a refused new entry back in the new-entry form, ready to send again', async () => {
    const { client, calls, holds } = stub([{ id: 'a', form: 'uno' }]);
    const refused = deferred();
    holds.push(refused);
    const view = (mounted = await mount(client, '/vocabularies/v1?item=new'));
    await view.step(() => setValue(formInput(), 'nuevo'));
    await view.step(() => setValue(glossInput(), 'new'));
    await view.step(() => button('Create').click());
    await view.step(async () => {
      refused.reject(new Error('refused'));
      await settle();
    });
    expect(feedback.notifySuccess).not.toHaveBeenCalled();
    expect(formInput().value).toBe('nuevo');
    expect(glossInput().value).toBe('new');
    expect(button('Create').disabled).toBe(false);
    expect(hasUnsavedDraft()).toBe('The entry you have typed');
    await view.step(async () => {
      button('Create').click();
      await settle();
    });
    expect(calls.map(([kind]) => kind)).toEqual(['create', 'create']);
    // A create that lands says nothing: the list already shows it.
    expect(feedback.notifySuccess).not.toHaveBeenCalled();
  });

  // REV4 J2, J4: homonyms are ordinary in a lexicon, so each Create is an
  // entry of its own under an id of its own. The queue sends a create whose
  // answer was lost again until it is answered, so no press is left unsure.
  it('sends each Create under an id of its own, the same entry typed twice included', async () => {
    const { client, calls, holds } = stub([{ id: 'a', form: 'uno' }]);
    const options = [];
    client.withOperation = (_label, fn, opts) => {
      options.push(opts);
      return fn(() => {});
    };
    const first = deferred();
    holds.push(first);
    const view = (mounted = await mount(client, '/vocabularies/v1?item=new'));
    await view.step(() => setValue(formInput(), 'nuevo'));
    await view.step(() => button('Create').click());
    await view.step(() =>
      all(document.body, 'a')
        .find((a) => a.textContent.trim() === 'New')
        .click(),
    );
    await view.step(() => setValue(formInput(), 'nuevo'));
    await view.step(async () => {
      button('Create').click();
      await settle();
    });
    const idOf = (call) => call.at(-1)?.id;
    expect(calls.map(([kind]) => kind)).toEqual(['create']);
    await view.step(async () => {
      first.resolve();
      await settle();
    });
    expect(calls.map(([kind]) => kind)).toEqual(['create', 'create']);
    expect(idOf(calls[1])).not.toBe(idOf(calls[0]));
    expect([...options[1].minted]).toEqual([idOf(calls[1])]);
  });

  it('sends a refused new entry again under a new id', async () => {
    const { client, calls, holds } = stub([{ id: 'a', form: 'uno' }]);
    const refused = deferred();
    holds.push(refused);
    const view = (mounted = await mount(client, '/vocabularies/v1?item=new'));
    await view.step(() => setValue(formInput(), 'nuevo'));
    await view.step(() => button('Create').click());
    await view.step(async () => {
      refused.reject(new Error('refused'));
      await settle();
    });
    await view.step(async () => {
      button('Create').click();
      await settle();
    });
    const idOf = (call) => call.at(-1)?.id;
    expect(calls.map(([kind]) => kind)).toEqual(['create', 'create']);
    expect(idOf(calls[1])).not.toBe(idOf(calls[0]));
  });

  it('sends a new entry under a fresh id once the form was closed and opened again', async () => {
    const { client, calls, holds } = stub([{ id: 'a', form: 'uno' }]);
    const refused = deferred();
    holds.push(refused);
    const view = (mounted = await mount(client, '/vocabularies/v1?item=new'));
    await view.step(() => setValue(formInput(), 'nuevo'));
    await view.step(() => button('Create').click());
    await view.step(async () => {
      refused.reject(new Error('refused'));
      await settle();
    });
    await view.step(() => button('Cancel').click());
    await view.step(() =>
      all(document.body, 'a')
        .find((a) => a.textContent.trim() === 'New')
        .click(),
    );
    await view.step(() => setValue(formInput(), 'nuevo'));
    await view.step(async () => {
      button('Create').click();
      await settle();
    });
    const idOf = (call) => call.at(-1)?.id;
    expect(calls.map(([kind]) => kind)).toEqual(['create', 'create']);
    expect(idOf(calls[1])).not.toBe(idOf(calls[0]));
  });

  it('sends a create whose answer was lost again, under the same id, until it is answered', async () => {
    const { client, calls, holds } = stub([{ id: 'a', form: 'uno' }]);
    const lost = deferred();
    holds.push(lost);
    const writes = new WriteQueue({ retryDelay: () => 0 });
    const view = (mounted = await mount(client, '/vocabularies/v1?item=new', writes));
    await view.step(() => setValue(formInput(), 'seis'));
    await view.step(() => button('Create').click());
    await view.step(async () => {
      lost.reject(
        Object.assign(new Error('Request timed out at http://x/api/v1/vocab-items'), {
          status: 0,
          method: 'POST',
        }),
      );
      await settle();
    });
    expect(calls.map(([kind]) => kind)).toEqual(['create', 'create']);
    const idOf = (call) => call.at(-1)?.id;
    expect(idOf(calls[0])).toMatch(/^[0-9a-f-]{36}$/);
    expect(idOf(calls[1])).toBe(idOf(calls[0]));
    expect(button('Create')).toBeUndefined();
    expect(feedback.notifyError).not.toHaveBeenCalled();
  });

  it('reads the entries again until the read lands, and asks before the tab closes until then', async () => {
    const { client, holds } = stub([{ id: 'a', form: 'uno' }]);
    const refused = deferred();
    holds.push(refused);
    const writes = new WriteQueue({ retryDelay: () => 0 });
    const view = (mounted = await mount(client, '/vocabularies/v1?item=a', writes));
    const get = client.vocabLayers.get;
    let reads = 0;
    const offline = deferred();
    client.vocabLayers.get = async (...args) => {
      if (!args[1]) return get(...args);
      reads += 1;
      if (reads === 1) throw new TypeError('Failed to fetch');
      if (reads === 2) await offline.promise;
      return get(...args);
    };
    await view.step(() => setValue(formInput(), 'uno-EDIT'));
    await view.step(() => button('Save').click());
    expect(listed()).toEqual(['uno-EDIT']);
    await view.step(async () => {
      refused.reject(new Error('refused'));
      await settle();
    });
    // The first read failed, the second is on the wire: still saving.
    expect(reads).toBe(2);
    expect(writes.isSaving).toBe(true);
    expect(listed()).toEqual(['uno-EDIT']);
    await view.step(async () => {
      offline.resolve();
      await settle();
    });
    expect(writes.isSaving).toBe(false);
    expect(listed()).toEqual(['uno']);
  });
});

// The usage query names this vocabulary in the projects that link it, and
// with none it is refused. Nothing is asked, and nothing is shown.
describe('usage counts', () => {
  const usageQueries = (client) =>
    client.query.mock.calls.filter(([q]) => q.return?.group?.includes('?tl.config.plaid.role'));
  it('are not asked for a vocabulary no project links', async () => {
    const { client } = stub([{ id: 'a', form: 'uno' }]);
    client.query = vi.fn(async () => ({ results: [] }));
    const view = await mount(client, '/vocabularies/v1?item=a');
    expect(usageQueries(client)).toHaveLength(0);
    expect(feedback.notifyWarning).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('are asked when a project links it', async () => {
    const { client } = stub([{ id: 'a', form: 'uno' }]);
    client.projects.list = async () => [{ id: 'p1', vocabs: [{ id: 'v1' }] }];
    client.query = vi.fn(async () => ({ results: [['a', 'word', 3]] }));
    const view = await mount(client, '/vocabularies/v1?item=a');
    expect(usageQueries(client)).toHaveLength(1);
    // The shorthand, which counts a word once per entry however many of the
    // entry's links name it (perf-entry-link-counts, ruled a: today's counts).
    const [[query]] = usageQueries(client);
    expect(query.where).toContainEqual(['vocab-link', '?t', '?v']);
    expect(query.where.some((c) => c[0] === 'link' || c[0] === 'link-token')).toBe(false);
    await view.unmount();
  });

  // The open entry's usage examples ask the same kind of query, refused alike.
  const concordanceQueries = (client) =>
    client.query.mock.calls.filter(
      ([q]) =>
        q.where?.some((c) => c[0] === 'vocab-link') &&
        !q.return?.group?.includes('?tl.config.plaid.role'),
    );
  it('usage examples are not asked for a vocabulary no project links', async () => {
    const { client } = stub([{ id: 'a', form: 'uno' }]);
    client.query = vi.fn(async () => ({ results: [] }));
    const view = await mount(client, '/vocabularies/v1?item=a');
    expect(concordanceQueries(client)).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Failed to load the usage examples.');
    await view.unmount();
  });

  it('usage examples are asked when a project links it', async () => {
    const { client } = stub([{ id: 'a', form: 'uno' }]);
    client.projects.list = async () => [{ id: 'p1', vocabs: [{ id: 'v1' }] }];
    client.query = vi.fn(async () => ({ results: [] }));
    const view = await mount(client, '/vocabularies/v1?item=a');
    expect(concordanceQueries(client).length).toBeGreaterThan(0);
    await view.unmount();
  });
});
