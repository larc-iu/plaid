import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// A settings page opened before another maintainer added a field does not list
// it. Saving any change on that page used to delete the field, with every
// annotation in it, and to write back the page's old tagset and language for
// fields someone else had changed since (V6-1). A save writes only what the
// user changed on this page.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  humanizeError: (e) => String(e),
}));

const { FieldsSettings } = await import('./FieldsSettings.jsx');
const { fieldChange } = await import('./fieldChange.js');
const { notifyError } = await import('@/utils/feedback');

const role = (r) => ({ plaid: { role: r } });
const layer = (id, name, igt = {}) => ({ id, name, config: { igt: { scope: 'Word', ...igt } } });
const project = (wordSpanLayers) => ({
  id: 'p1',
  config: {},
  textLayers: [
    {
      id: 'text',
      config: role('baseline'),
      tokenLayers: [
        { id: 'sent', config: role('sentence'), spanLayers: [] },
        { id: 'word', config: role('word'), spanLayers: wordSpanLayers },
        { id: 'morph', config: role('morpheme'), spanLayers: [] },
      ],
    },
  ],
});

// What the page loaded, and what the server holds by the time it saves:
// another maintainer added Remark and pointed POS at the Leipzig tagset.
const loaded = () => project([layer('gloss', 'Gloss', { lang: 'en' }), layer('pos', 'POS')]);
const server = () =>
  project([
    layer('gloss', 'Gloss', { lang: 'en' }),
    layer('pos', 'POS', { tagset: 'Leipzig' }),
    layer('remark', 'Remark'),
  ]);

const fakeClient = () => {
  const writes = [];
  const bundle = (sink) => ({
    tokenLayers: { setConfig: (...a) => sink(['tokenLayers.setConfig', ...a]) },
    spanLayers: {
      setConfig: (...a) => sink(['spanLayers.setConfig', ...a]),
      deleteConfig: (...a) => sink(['spanLayers.deleteConfig', ...a]),
      delete: (...a) => sink(['spanLayers.delete', ...a]),
    },
  });
  const client = {
    writes,
    projects: { get: async () => server() },
    ...bundle((w) => writes.push(w)),
    batched: async (fn) => {
      fn(bundle((w) => writes.push(w)));
      return [];
    },
    query: async () => ({ results: [[0]] }),
  };
  client.spanLayers.create = async (...a) => {
    writes.push(['spanLayers.create', ...a]);
    return { id: 'new' };
  };
  return client;
};

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const typeInto = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const mount = async (client) => {
  const view = await renderComponent(
    <FieldsSettings project={loaded()} projectId="p1" client={client} onProjectUpdate={vi.fn()} />,
  );
  await view.step(async () => {});
  return view;
};

afterEach(() => vi.clearAllMocks());

describe('Settings > Fields on a page opened before another maintainer saved', () => {
  it('changing a language writes that language and nothing else', async () => {
    const client = fakeClient();
    const { step, unmount } = await mount(client);
    const box = document.querySelector('input[aria-label="Language of Gloss"]');
    await step(() => typeInto(box, 'fr'));
    await step(async () => {
      box.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      box.dispatchEvent(new FocusEvent('blur'));
      await settle();
    });
    expect(client.writes).toEqual([
      ['spanLayers.setConfig', 'gloss', 'igt', 'lang', 'fr', undefined, { expected: 'en' }],
    ]);
    await unmount();
  });

  it('removing a field deletes that field only', async () => {
    const client = fakeClient();
    const { container, step, unmount } = await mount(client);
    const row = all(container, 'tbody tr').find((tr) => tr.textContent.includes('POS'));
    const trash = all(row, 'button').find((b) => b.title === 'Remove');
    await step(async () => {
      trash.click();
      await settle();
    });
    const confirm = all(document.body, 'button').find((b) => b.textContent.trim() === 'Delete');
    await step(async () => {
      confirm.click();
      await settle();
    });
    expect(client.writes).toEqual([['spanLayers.delete', 'pos']]);
    await unmount();
  });
});

describe('Settings > Fields when the same value changed elsewhere', () => {
  it('refuses a language change over one another maintainer made, and reads the project again', async () => {
    const client = fakeClient();
    const onProjectUpdate = vi.fn(async () => {});
    client.projects.get = async () => {
      const p = server();
      p.textLayers[0].tokenLayers[1].spanLayers[0].config.igt.lang = 'de';
      return p;
    };
    const view = await renderComponent(
      <FieldsSettings
        project={loaded()}
        projectId="p1"
        client={client}
        onProjectUpdate={onProjectUpdate}
      />,
    );
    await view.step(async () => {});
    const box = document.querySelector('input[aria-label="Language of Gloss"]');
    await view.step(() => typeInto(box, 'fr'));
    await view.step(async () => {
      box.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      box.dispatchEvent(new FocusEvent('blur'));
      await settle();
    });
    expect(client.writes).toEqual([]);
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(onProjectUpdate).toHaveBeenCalled();
    await view.unmount();
  });
});

describe('fieldChange', () => {
  const f = (name, extra = {}) => ({ name, scope: 'Word', tagset: null, lang: null, ...extra });
  const ignored = {
    mode: 'punctuation',
    unicodePunctuationExceptions: [],
    explicitIgnoredTokens: [],
  };
  const previous = { fields: [f('Gloss'), f('POS')], ignoredTokens: ignored };

  it('names the added, the removed and the changed, and nothing the user left alone', () => {
    const c = fieldChange({
      fields: [f('Gloss', { lang: 'fr' }), f('Note', { lang: 'nl' })],
      ignoredTokens: ignored,
      previous,
    });
    expect(c.added.map((x) => x.name)).toEqual(['Note']);
    expect(c.removed.map((x) => x.name)).toEqual(['POS']);
    expect(c.lang.map((x) => x.name)).toEqual(['Gloss', 'Note']);
    expect(c.tagset.map((x) => x.name)).toEqual(['Note']);
    expect(c.ignoredTokens).toBe(false);
  });

  it('sees a change to the ignored tokens', () => {
    const c = fieldChange({
      fields: previous.fields,
      ignoredTokens: { ...ignored, unicodePunctuationExceptions: ['-'] },
      previous,
    });
    expect(c.ignoredTokens).toBe(true);
    expect(c.added.length + c.removed.length + c.lang.length + c.tagset.length).toBe(0);
  });
});
