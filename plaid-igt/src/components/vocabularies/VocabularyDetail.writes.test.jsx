import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { settle } from '@/domain/test-helpers.js';

// The vocabulary's schema writes and its name take their turn in one queue,
// closing the tab asks while they are on their way, and the vocabulary's own
// tabs ask before an entry typed on the Entries tab is lost.

// The Entries tab stands in as a screen holding a typed entry.
vi.mock('./VocabularyItems', async () => {
  const { useUnsavedDraft } = await import('@ui/hooks/useUnsavedDraft.js');
  return {
    VocabularyItems: () => {
      useUnsavedDraft('The entry you have typed');
      return null;
    },
  };
});
vi.mock('./VocabularyBorrowers', () => ({ VocabularyBorrowers: () => null }));
vi.mock('./VocabularyCommentsTab', () => ({ VocabularyCommentsTab: () => null }));
// The tagsets editor stands in as its last props, so a test can save through
// it and read what it is shown.
const tagsetsManager = vi.hoisted(() => ({ props: null }));
vi.mock('@/components/projects/settings/TagsetsManager.jsx', () => ({
  TagsetsManager: (props) => {
    tagsetsManager.props = props;
    return null;
  },
}));
vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  humanizeError: (e) => String(e),
}));
const confirm = vi.hoisted(() => vi.fn(async () => false));
vi.mock('@ui/components/shared/ConfirmProvider', () => ({ useConfirm: () => confirm }));
vi.mock('@ui/domain/CommentStore', () => ({
  CommentStore: class {
    load() {
      return Promise.resolve();
    }
  },
}));
vi.mock('@ui/domain/useCommentStore', () => ({ useCommentStore: () => 0 }));

const auth = vi.hoisted(() => ({
  client: null,
  user: { id: 'u', isAdmin: true },
  logout: vi.fn(),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));

const { VocabularyDetail } = await import('./VocabularyDetail.jsx');
const feedback = await import('@/utils/feedback');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// A server holding vocabulary A. `holds` is a list of deferreds the next
// writes wait on, in order.
const stub = () => {
  const calls = [];
  const holds = [];
  const write = (kind) => async () => {
    calls.push(kind);
    const hold = holds.shift();
    if (hold) await hold.promise;
  };
  return {
    calls,
    holds,
    client: {
      withOperation: (_label, fn) => fn(),
      vocabLayers: {
        get: async () => ({ id: 'A', name: 'Ayvale lexicon', config: {}, project: 'P' }),
        setConfig: write('setConfig'),
        update: write('update'),
      },
      projects: {
        list: async () => [],
        get: async (id) => ({ id, name: 'Pear', maintainers: ['u'] }),
      },
    },
  };
};

const mount = async (client, at) => {
  auth.client = client;
  const view = await renderComponent(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/vocabularies/:vocabularyId" element={<VocabularyDetail />} />
      </Routes>
    </MemoryRouter>,
  );
  await view.step(async () => {});
  await view.step(async () => {});
  return view;
};
const asks = () => {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};
const setValue = (el, value) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const button = (name) => all(document.body, 'button').find((b) => b.textContent.trim() === name);
const firstInlineSwitch = () => document.querySelector('button[role="switch"]');
const nameInput = () => document.querySelector('input[placeholder="Enter vocabulary name"]');

describe('the vocabulary screen', () => {
  it('asks before the tab closes while a schema write is on its way', async () => {
    const { client, holds } = stub();
    const held = deferred();
    holds.push(held);
    const view = await mount(client, '/vocabularies/A?tab=settings');
    expect(asks()).toBe(false);
    await view.step(() => firstInlineSwitch().click());
    expect(asks()).toBe(true);
    await view.step(async () => {
      held.resolve();
      await settle(5);
    });
    expect(asks()).toBe(false);
    await view.unmount();
  });

  it('sends a rename after the schema write made before it, not beside it', async () => {
    const { client, calls, holds } = stub();
    const held = deferred();
    holds.push(held);
    const view = await mount(client, '/vocabularies/A?tab=settings');
    await view.step(() => firstInlineSwitch().click());
    await view.step(() => setValue(nameInput(), 'Beeworth lexicon'));
    await view.step(async () => {
      button('Save').click();
      await settle(5);
    });
    expect(calls).toEqual(['setConfig']);
    await view.step(async () => {
      held.resolve();
      await settle(5);
    });
    expect(calls).toEqual(['setConfig', 'update']);
    await view.unmount();
  });

  it('reads the vocabulary again after a refused rename until the read lands', async () => {
    const { client, holds } = stub();
    const refused = deferred();
    holds.push(refused);
    const view = await mount(client, '/vocabularies/A?tab=settings');
    const get = client.vocabLayers.get;
    let reads = 0;
    client.vocabLayers.get = async (...args) => {
      reads += 1;
      if (reads === 1) throw new TypeError('Failed to fetch');
      return get(...args);
    };
    await view.step(() => setValue(nameInput(), 'Beeworth lexicon'));
    await view.step(async () => {
      button('Save').click();
      await settle(5);
    });
    await view.step(async () => {
      refused.reject(new Error('refused'));
      await settle(5);
    });
    // The read failed and waits its turn to be tried again.
    expect(reads).toBe(1);
    expect(asks()).toBe(true);
    await view.step(async () => {
      await new Promise((r) => setTimeout(r, 1100));
      await settle(5);
    });
    expect(reads).toBe(2);
    // Nothing is on its way now, and the refused name is still in the box,
    // typed and not saved, so leaving still asks.
    expect(nameInput().value).toBe('Beeworth lexicon');
    expect(asks()).toBe(true);
    expect(document.body.textContent).toContain('Ayvale lexicon');
    expect(document.body.textContent).not.toContain('Beeworth lexicon');
    await view.unmount();
  });

  // REV4 J3: the settings writes go under operation keys and are sent again,
  // under them, until they are answered, like every other write.
  it('sends a rename and a fields write whose answers were lost again, under their keys, until they land', async () => {
    const { client, calls } = stub();
    const ops = [];
    client.keySeed = () => ({ seed: `seed${ops.length}` });
    client.withOperation = async (label, fn, opts) => {
      ops.push([label, opts]);
      return fn();
    };
    const lostOnce = (kind, method) => {
      let failed = false;
      return async () => {
        calls.push(kind);
        if (failed) return;
        failed = true;
        throw Object.assign(new Error('Network error: fetch failed'), { status: 0, method });
      };
    };
    client.vocabLayers.setConfig = lostOnce('setConfig', 'PUT');
    client.vocabLayers.update = lostOnce('update', 'PATCH');
    feedback.notifyError.mockClear();
    const view = await mount(client, '/vocabularies/A?tab=settings');
    await view.step(() => firstInlineSwitch().click());
    await view.step(() => setValue(nameInput(), 'Beeworth lexicon'));
    await view.step(async () => {
      button('Save').click();
      await settle(5);
    });
    expect(asks()).toBe(true);
    await view.step(async () => {
      await new Promise((r) => setTimeout(r, 2300));
      await settle(5);
    });
    expect(calls).toEqual(['setConfig', 'setConfig', 'update', 'update']);
    expect(feedback.notifyError).not.toHaveBeenCalled();
    expect(ops[0][1]).toBe(ops[1][1]);
    expect(ops[2][1]).toBe(ops[3][1]);
    expect(ops[0][1]).not.toBe(ops[2][1]);
    expect(asks()).toBe(false);
    await view.unmount();
  });

  it('sends a schema write queued behind a refused one', async () => {
    const { client, calls, holds } = stub();
    const refused = deferred();
    holds.push(refused);
    feedback.notifyError.mockClear();
    const view = await mount(client, '/vocabularies/A?tab=settings');
    await view.step(() => firstInlineSwitch().click());
    await view.step(() => setValue(nameInput(), 'Beeworth lexicon'));
    await view.step(async () => {
      button('Save').click();
      await settle(5);
    });
    await view.step(async () => {
      refused.reject(new Error('refused'));
      await settle(5);
    });
    expect(calls).toEqual(['setConfig', 'update']);
    expect(feedback.notifyError).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('asks before its own tabs take an entry that is typed and not saved', async () => {
    const { client } = stub();
    confirm.mockClear();
    const view = await mount(client, '/vocabularies/A');
    const settings = all(document.body, '[role="tab"]').find((t) =>
      t.textContent.includes('Settings'),
    );
    await view.step(async () => {
      settings.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      await settle(5);
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    // Refused: the Entries tab stays.
    expect(settings.getAttribute('data-state')).toBe('inactive');
    await view.unmount();
  });
});

describe('the values a vocabulary tagset seed reads', () => {
  it("read each entry's values as its morph type gives, a sense taking its headword's", async () => {
    const server = {
      id: 'A',
      name: 'Ayvale lexicon',
      project: 'P',
      config: {
        igt: {
          fields: { gloss: { tagset: 'Gloss' } },
          tagsets: { Gloss: { mode: 'suggest', delimiters: '.:', values: [] } },
        },
      },
    };
    const items = [
      { id: 'ti', form: 'ti', metadata: { morphType: 'suffix', gloss: 'sbj:3.pfv' } },
      { id: 'te', form: 'te', metadata: { parent: 'ti', gloss: 'sbj:3.pfv' } },
      { id: 'sa', form: 'sa', metadata: { morphType: 'stem', gloss: 'sbj:3.pfv' } },
    ];
    const client = {
      withOperation: (_label, fn) => fn(),
      vocabLayers: {
        get: async (_id, withItems) => ({
          ...structuredClone(server),
          ...(withItems ? { items } : {}),
        }),
        setConfig: async () => {},
        update: async () => {},
      },
      projects: {
        list: async () => [],
        get: async (id) => ({ id, name: 'Pear', maintainers: ['u'] }),
      },
    };
    const view = await mount(client, '/vocabularies/A?tab=settings');
    let rows;
    await view.step(async () => {
      rows = await tagsetsManager.props.onLoadAttested('Gloss');
    });
    expect(rows).toEqual([
      ['sbj:3.pfv', 2, { bound: true, beside: [] }],
      ['sbj:3.pfv', 1, undefined],
    ]);
    await view.unmount();
  });
});

// The vocabulary's fields and tagsets are written whole, each expecting what
// this page last read or wrote (config compare-and-set, D6). A page opened
// before another maintainer saved is refused rather than writing over that
// save, and the refusal's re-read shows what is stored.
describe('the vocabulary schema written from a stale page', () => {
  const casServer = () => {
    const server = {
      id: 'A',
      name: 'Ayvale lexicon',
      project: 'P',
      config: {
        igt: {
          fields: { gloss: { inline: true }, pos: { inline: true } },
          tagsets: { cases: { mode: 'closed', values: [{ value: 'NOM' }] } },
        },
      },
    };
    const sent = [];
    const canonical = (v) =>
      JSON.stringify(v ?? null, (_k, x) =>
        x && typeof x === 'object' && !Array.isArray(x)
          ? Object.fromEntries(
              Object.keys(x)
                .sort()
                .map((k) => [k, x[k]]),
            )
          : x,
      );
    const client = {
      withOperation: (_label, fn) => fn(),
      vocabLayers: {
        get: async () => structuredClone(server),
        setConfig: async (_id, _ns, key, value, _msg, options) => {
          sent.push([key, options]);
          // A write that names no expected value is not checked.
          const checked = !!options && 'expected' in options;
          if (checked && canonical(options.expected) !== canonical(server.config.igt[key])) {
            throw Object.assign(new Error('HTTP 409'), { status: 409, method: 'PUT' });
          }
          server.config.igt[key] = structuredClone(value);
        },
        update: async () => {},
      },
      projects: {
        list: async () => [],
        get: async (id) => ({ id, name: 'Pear', maintainers: ['u'] }),
      },
    };
    // A batch is all or nothing, as core's.
    let batches = 0;
    client.batched = async (fn) => {
      batches += 1;
      const queued = [];
      const record =
        (method) =>
        (...args) =>
          queued.push([method, args]);
      fn({ vocabLayers: { setConfig: record('setConfig'), deleteConfig: record('deleteConfig') } });
      const before = structuredClone(server.config.igt);
      try {
        for (const [method, [id, ns, key, ...rest]] of queued) {
          if (method === 'setConfig') {
            await client.vocabLayers.setConfig(id, ns, key, ...rest);
          } else {
            const options = rest[1];
            sent.push([key, options]);
            if (canonical(options.expected) !== canonical(server.config.igt[key])) {
              throw Object.assign(new Error('HTTP 409'), { status: 409 });
            }
            delete server.config.igt[key];
          }
        }
      } catch (error) {
        server.config.igt = before;
        throw error;
      }
    };
    return { server, client, sent, batches: () => batches };
  };

  // REV7-WIRE-1: a rename and the fields that name it are one batch, as on
  // the project's Tagsets screen.
  it('renames a tagset and repoints the fields that name it in one batch', async () => {
    const { server, client, batches } = casServer();
    server.config.igt.fields.gloss.tagset = 'cases';
    const view = await mount(client, '/vocabularies/A?tab=settings');
    const next = { case: server.config.igt.tagsets.cases };
    await view.step(async () => {
      await tagsetsManager.props.onSaveChanges(next, { renamed: { from: 'cases', to: 'case' } });
      await settle(5);
    });
    expect(batches()).toBe(1);
    expect(Object.keys(server.config.igt.tagsets)).toEqual(['case']);
    expect(server.config.igt.fields.gloss.tagset).toBe('case');
    await view.unmount();
  });

  it("keeps the Status tagset's stored order when another tagset is added (HUNT-igt R1)", async () => {
    const { server, client } = casServer();
    server.config.igt.tagsets.Status = {
      mode: 'closed',
      ordered: true,
      values: [{ value: 'draft' }, { value: 'reviewed' }, { value: 'published' }],
    };
    const view = await mount(client, '/vocabularies/A?tab=settings');
    const next = {
      ...tagsetsManager.props.tagsets,
      moods: { mode: 'suggest', delimiters: '', values: [] },
    };
    await view.step(async () => {
      await tagsetsManager.props.onSaveChanges(next);
      await settle(5);
    });
    expect(server.config.igt.tagsets.Status.ordered).toBe(true);
    expect(Object.keys(server.config.igt.tagsets).sort()).toEqual(['Status', 'cases', 'moods']);
    await view.unmount();
  });

  it('writes neither the rename nor the repoint when the fields changed since the page read them', async () => {
    const { server, client } = casServer();
    server.config.igt.fields.gloss.tagset = 'cases';
    feedback.notifyError.mockClear();
    const view = await mount(client, '/vocabularies/A?tab=settings');
    server.config.igt.fields = { ...server.config.igt.fields, remark: { inline: true } };
    let threw = false;
    await view.step(async () => {
      try {
        await tagsetsManager.props.onSaveChanges(
          { case: server.config.igt.tagsets.cases },
          { renamed: { from: 'cases', to: 'case' } },
        );
      } catch {
        threw = true;
      }
      await settle(5);
    });
    expect(threw).toBe(true);
    expect(Object.keys(server.config.igt.tagsets)).toEqual(['cases']);
    expect(server.config.igt.fields.gloss.tagset).toBe('cases');
    expect(feedback.notifyError).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('a tagsets save the tagsets moved under says so', async () => {
    const { server, client } = casServer();
    feedback.notifyError.mockClear();
    const view = await mount(client, '/vocabularies/A?tab=settings');
    server.config.igt.tagsets = { renamed: server.config.igt.tagsets.cases };
    await view.step(async () => {
      try {
        await tagsetsManager.props.onSaveChanges({});
      } catch {
        // the editor rolls back
      }
      await settle(5);
    });
    expect(feedback.notifyError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Tagsets changed elsewhere. Reload and redo your change.',
      }),
      'Failed to save the tagsets',
    );
    expect(Object.keys(server.config.igt.tagsets)).toEqual(['renamed']);
    await view.unmount();
  });

  it('expects the fields it read, and then the ones it wrote', async () => {
    const { server, client, sent } = casServer();
    const view = await mount(client, '/vocabularies/A?tab=settings');
    const read = structuredClone(server.config.igt.fields);
    await view.step(async () => {
      firstInlineSwitch().click();
      await settle(5);
    });
    const first = structuredClone(server.config.igt.fields);
    await view.step(async () => {
      firstInlineSwitch().click();
      await settle(5);
    });
    expect(sent.map(([key, o]) => [key, o.expected])).toEqual([
      ['fields', read],
      ['fields', first],
    ]);
    await view.unmount();
  });

  it('is refused over another maintainer’s save, and then shows it', async () => {
    const { server, client } = casServer();
    feedback.notifyError.mockClear();
    const view = await mount(client, '/vocabularies/A?tab=settings');
    // Someone else adds a field after this page read the vocabulary.
    server.config.igt.fields = { ...server.config.igt.fields, remark: { inline: true } };
    const theirs = structuredClone(server.config.igt.fields);
    await view.step(async () => {
      firstInlineSwitch().click();
      await settle(5);
    });
    expect(server.config.igt.fields).toEqual(theirs);
    expect(feedback.notifyError).toHaveBeenCalledWith(
      expect.objectContaining({ status: 409 }),
      'Failed to save the fields',
    );
    expect(document.body.textContent).toContain('Remark');
    await view.unmount();
  });

  it('refuses a tagsets save over another maintainer’s, and the editor learns it', async () => {
    const { server, client } = casServer();
    const view = await mount(client, '/vocabularies/A?tab=settings');
    server.config.igt.tagsets = {
      ...server.config.igt.tagsets,
      moods: { mode: 'open', values: [] },
    };
    let threw = false;
    await view.step(async () => {
      try {
        await tagsetsManager.props.onSaveChanges({ cases: server.config.igt.tagsets.cases });
      } catch {
        threw = true;
      }
      await settle(5);
    });
    expect(threw).toBe(true);
    expect(Object.keys(server.config.igt.tagsets).sort()).toEqual(['cases', 'moods']);
    expect(Object.keys(tagsetsManager.props.tagsets).sort()).toEqual(['cases', 'moods']);
    await view.unmount();
  });
});

describe('a vocabulary name typed and not saved', () => {
  it('asks before the page is left, and stops asking once it is saved', async () => {
    const { client } = stub();
    const view = await mount(client, '/vocabularies/A?tab=settings');
    expect(asks()).toBe(false);
    await view.step(() => setValue(nameInput(), 'Ayvale dictionary'));
    expect(asks()).toBe(true);
    await view.step(async () => {
      button('Save').click();
      await settle();
    });
    expect(asks()).toBe(false);
    await view.unmount();
  });
});

// Ruling Q1: deleting a vocabulary deletes every link into it, and each
// morpheme they leave keeps the type its entry gave it, in the delete's batch.
describe('deleting the vocabulary', () => {
  it('writes the entry types onto the morphemes its links leave, in the same batch', async () => {
    const { client } = stub();
    const sent = [];
    const get = client.vocabLayers.get;
    client.vocabLayers.get = async (id, withItems) => ({
      ...(await get(id)),
      ...(withItems
        ? {
            items: [
              { id: 'e-s', form: 's', metadata: { morphType: 'suffix' } },
              { id: 'e-cat', form: 'cat', metadata: {} },
            ],
          }
        : {}),
    });
    client.query = async (q) =>
      q.return?.group?.[0] === '?d'
        ? { results: [['doc-1', 1]] }
        : q.where.some((c) => c[0] === 'link-token')
          ? {
              results: [
                ['e-s', 'm-1', 'ml', 'morpheme', 1],
                ['e-cat', 'm-2', 'ml', 'morpheme', 1],
              ],
            }
          : { results: [] };
    client.tokenLayers = { get: async () => ({ project: 'p1' }) };
    // Its own project, and the one its morphemes are in.
    client.projects.get = async (id) =>
      id === 'P' ? { id, name: 'Pear', maintainers: ['u'] } : { id: 'p1', writers: ['u'] };
    client.vocabLayers.delete = async () => ({ links: 2 });
    client.batched = async (fn) => {
      const ops = [];
      await fn({
        tokens: { bulkUpdate: (rows) => ops.push(['tokens.bulkUpdate', rows]) },
        vocabLayers: { delete: (id) => ops.push(['vocabLayers.delete', id]) },
      });
      sent.push(ops);
    };
    const view = await mount(client, '/vocabularies/A?tab=settings');
    await view.step(() => button('Delete vocabulary').click());
    await view.step(() =>
      setValue(document.getElementById('vocabulary-delete-confirm'), 'Ayvale lexicon'),
    );
    const confirm = all(document.body, '[role="dialog"] button').find(
      (b) => b.textContent.trim() === 'Delete vocabulary',
    );
    await view.step(async () => {
      confirm.click();
      await settle(5);
    });
    expect(sent).toEqual([
      [
        [
          'tokens.bulkUpdate',
          [{ id: 'm-1', metadata: [{ op: 'set', path: ['morphType'], value: 'suffix' }] }],
        ],
        ['vocabLayers.delete', 'A'],
      ],
    ]);
    await view.unmount();
  });
});

// Core refuses to delete a vocabulary while another project uses it, for
// everyone (ruling 11.2). The dialog asks core first (a dry run) and says what
// the delete removes, or that it is refused.
describe('the delete question', () => {
  const refusal = (n) =>
    Object.assign(new Error(`HTTP 409 ${n} other projects use this vocabulary.`), {
      status: 409,
      responseData: { error: `${n} other projects use this vocabulary.`, 'other-projects': n },
    });
  const dialogText = () => document.querySelector('[role="dialog"]')?.textContent ?? '';
  const dialogButton = (name) =>
    all(document.body, '[role="dialog"] button').find((b) => b.textContent.trim() === name);

  it('counts the links that go, before the typed name', async () => {
    const { client } = stub();
    const asked = [];
    client.vocabLayers.delete = async (...a) => {
      asked.push(a);
      return { links: 14 };
    };
    const view = await mount(client, '/vocabularies/A?tab=settings');
    await view.step(async () => {
      button('Delete vocabulary').click();
      await settle(5);
    });
    expect(asked).toEqual([['A', undefined, { dryRun: true }]]);
    expect(dialogText()).toContain(
      'Deletes “Ayvale lexicon” with all its entries and their links. This cannot be undone.Its entries are linked to 14 words/morphemes. Those links will be removed.',
    );
    expect(dialogText()).not.toContain('use this vocabulary');
    expect(document.getElementById('vocabulary-delete-confirm')).not.toBeNull();
    await view.unmount();
  });

  it('leaves the links out when there are none', async () => {
    const { client } = stub();
    client.vocabLayers.delete = async () => ({ links: 0 });
    const view = await mount(client, '/vocabularies/A?tab=settings');
    await view.step(async () => {
      button('Delete vocabulary').click();
      await settle(5);
    });
    expect(dialogText()).toContain('This cannot be undone.');
    expect(dialogText()).not.toContain('linked to');
    expect(dialogButton('Delete vocabulary')).toBeDefined();
    await view.unmount();
  });

  it('says the delete is refused up front while other projects use it', async () => {
    const { client } = stub();
    client.vocabLayers.delete = async () => {
      throw refusal(3);
    };
    const view = await mount(client, '/vocabularies/A?tab=settings');
    await view.step(async () => {
      button('Delete vocabulary').click();
      await settle(5);
    });
    expect(dialogText()).toContain(
      '3 other projects use this vocabulary. It can be deleted once they unlink it.',
    );
    expect(document.getElementById('vocabulary-delete-confirm')).toBeNull();
    expect(dialogButton('Delete vocabulary')).toBeUndefined();
    await view.unmount();
  });

  it('turns to the refusal when core refuses the delete itself', async () => {
    const { client } = stub();
    client.vocabLayers.delete = async () => ({ links: 0 });
    client.vocabLayers.get = async (id, withItems) => ({
      id: 'A',
      name: 'Ayvale lexicon',
      config: {},
      project: 'P',
      ...(withItems ? { items: [] } : {}),
    });
    client.projects.get = async (id) => ({ id, name: 'Pear', maintainers: ['u'] });
    client.query = async () => ({ results: [] });
    client.batched = async () => {
      throw refusal(1);
    };
    feedback.notifyError.mockClear();
    const view = await mount(client, '/vocabularies/A?tab=settings');
    await view.step(async () => {
      button('Delete vocabulary').click();
      await settle(5);
    });
    expect(dialogText()).toContain('This cannot be undone.');
    await view.step(() =>
      setValue(document.getElementById('vocabulary-delete-confirm'), 'Ayvale lexicon'),
    );
    await view.step(async () => {
      dialogButton('Delete vocabulary').click();
      await settle(5);
    });
    expect(dialogText()).toContain(
      '1 other project uses this vocabulary. It can be deleted once that project unlinks it.',
    );
    expect(feedback.notifyError).toHaveBeenCalledWith(
      '1 other project uses this vocabulary.',
      'Failed to delete the vocabulary',
    );
    await view.unmount();
  });
});
