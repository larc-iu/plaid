import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

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
vi.mock('./VocabularyMaintainers', () => ({ VocabularyMaintainers: () => null }));
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
      vocabLayers: {
        get: async () => ({ id: 'A', name: 'Ayvale lexicon', config: {}, maintainers: ['u'] }),
        setConfig: write('setConfig'),
        update: write('update'),
      },
      projects: { list: async () => [] },
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

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
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
  it('keeps a tagset rename that landed when the fields that name it are refused', async () => {
    // The server holds tagset "cases", which the field "case" names. The
    // rename lands and the fields' repoint is refused. The editor must not
    // roll back to "cases", which the server no longer holds, and what it is
    // shown afterwards must be the server's.
    const server = {
      id: 'A',
      name: 'Ayvale lexicon',
      maintainers: ['u'],
      config: {
        igt: {
          fields: [{ name: 'case', type: 'text', tagset: 'cases' }],
          tagsets: { cases: { mode: 'closed', tags: [{ value: 'NOM' }] } },
        },
      },
    };
    const client = {
      vocabLayers: {
        get: async () => structuredClone(server),
        setConfig: async (_id, _ns, key, value) => {
          if (key === 'fields') throw new Error('refused');
          server.config.igt[key] = value;
        },
        update: async () => {},
      },
      projects: { list: async () => [] },
    };
    const view = await mount(client, '/vocabularies/A?tab=settings');
    const next = { case: server.config.igt.tagsets.cases };
    let threw = false;
    await view.step(async () => {
      try {
        await tagsetsManager.props.onSaveChanges(next, { renamed: { from: 'cases', to: 'case' } });
      } catch {
        threw = true;
      }
      await settle();
    });
    expect(threw).toBe(false);
    expect(Object.keys(tagsetsManager.props.tagsets)).toEqual(['case']);

    // A later change to the server's tagsets reaches the editor.
    server.config.igt.tagsets = { case: next.case, moods: { mode: 'closed', tags: [] } };
    await view.step(async () => {
      tagsetsManager.props.onSaveChanges(server.config.igt.tagsets);
      await settle();
    });
    expect(Object.keys(tagsetsManager.props.tagsets).sort()).toEqual(['case', 'moods']);
    await view.unmount();
  });

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
      await settle();
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
      await settle();
    });
    expect(calls).toEqual(['setConfig']);
    await view.step(async () => {
      held.resolve();
      await settle();
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
      await settle();
    });
    await view.step(async () => {
      refused.reject(new Error('refused'));
      await settle();
    });
    // The read failed and waits its turn to be tried again.
    expect(reads).toBe(1);
    expect(asks()).toBe(true);
    await view.step(async () => {
      await new Promise((r) => setTimeout(r, 1100));
      await settle();
    });
    expect(reads).toBe(2);
    expect(asks()).toBe(false);
    expect(document.body.textContent).toContain('Ayvale lexicon');
    expect(document.body.textContent).not.toContain('Beeworth lexicon');
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
      await settle();
    });
    await view.step(async () => {
      refused.reject(new Error('refused'));
      await settle();
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
      await settle();
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
      maintainers: ['u'],
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
      vocabLayers: {
        get: async (_id, withItems) => ({
          ...structuredClone(server),
          ...(withItems ? { items } : {}),
        }),
        setConfig: async () => {},
        update: async () => {},
      },
      projects: { list: async () => [] },
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
      maintainers: ['u'],
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
      projects: { list: async () => [] },
    };
    return { server, client, sent };
  };

  it('expects the fields it read, and then the ones it wrote', async () => {
    const { server, client, sent } = casServer();
    const view = await mount(client, '/vocabularies/A?tab=settings');
    const read = structuredClone(server.config.igt.fields);
    await view.step(async () => {
      firstInlineSwitch().click();
      await settle();
    });
    const first = structuredClone(server.config.igt.fields);
    await view.step(async () => {
      firstInlineSwitch().click();
      await settle();
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
      await settle();
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
      await settle();
    });
    expect(threw).toBe(true);
    expect(Object.keys(server.config.igt.tagsets).sort()).toEqual(['cases', 'moods']);
    expect(Object.keys(tagsetsManager.props.tagsets).sort()).toEqual(['cases', 'moods']);
    await view.unmount();
  });
});
