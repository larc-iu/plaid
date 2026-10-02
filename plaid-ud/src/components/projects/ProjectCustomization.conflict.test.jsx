import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// A Save refused because another maintainer saved since (409) read the project
// again and reseeded the whole tab, so every unsaved change was lost for the
// one cell that conflicted (H24-SETTINGS-3). The tab keeps every change whose
// setting is still what it loaded, takes the latest for the settings changed
// elsewhere, and names those.

const managed = vi.hoisted(() => ({ current: null }));
vi.mock('@ui/hooks/useManagedProject.js', () => ({ useManagedProject: () => managed.current }));
const client = vi.hoisted(() => ({ current: null }));
vi.mock('../../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ getClient: () => client.current }),
}));
vi.mock('../../utils/feedback.jsx', () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }));

const layer = (id, ud) => ({ id, config: { ud } });
const info = vi.hoisted(() => ({ current: null }));
vi.mock('../../utils/udLayerUtils.js', async (orig) => ({
  ...(await orig()),
  getUdLayerInfo: () => info.current,
}));

const { ProjectCustomization } = await import('./ProjectCustomization.jsx');
const { notifyError } = await import('../../utils/feedback.jsx');

const infoWith = (uposColors) => ({
  isConfigured: true,
  uposLayer: layer('upos', { vocab: ['NOUN', 'VERB'], colors: uposColors }),
  xposLayer: layer('xpos', {}),
  featuresLayer: layer('feats', {}),
  relationLayer: layer('deprel', { vocab: ['nsubj'] }),
  vocab: { upos: ['NOUN', 'VERB'], xpos: [], deprel: ['nsubj'], featureInventory: { list: [] } },
  colors: { upos: uposColors, deprel: {} },
  modes: {},
  descriptions: { upos: {}, xpos: {}, deprel: {}, feats: {} },
});

const el = () => (
  <MemoryRouter>
    <ProjectCustomization />
  </MemoryRouter>
);

let view;
let batches;

beforeEach(() => {
  vi.clearAllMocks();
  info.current = infoWith({ NOUN: '#112233' });
  batches = [];
  managed.current = {
    project: { id: 'p1', name: 'P', config: {} },
    loading: false,
    // The real hook sets a freshly read project, a new object, and returns it.
    fetchProject: vi.fn(async () => {
      const project = { id: 'p1', name: 'P', config: {} };
      managed.current = { ...managed.current, project };
      await view.rerender(el());
      return project;
    }),
    canConfigure: true,
  };
  // The first Save meets another maintainer's save of the UPOS colors.
  client.current = {
    batched: async (fn) => {
      const ops = [];
      const rec = (bundle) => ({
        setConfig: (id, ns, key, value, audit, options) =>
          ops.push({ cell: `${bundle}:${id}/${key}`, value, options }),
        setConstraints: (id) => ops.push({ cell: `${bundle}:${id}/constraints` }),
      });
      await fn({
        spanLayers: rec('span'),
        relationLayers: rec('rel'),
        projects: rec('proj'),
        tokenLayers: rec('tok'),
      });
      batches.push(ops);
      if (batches.length === 1) {
        info.current = infoWith({ NOUN: '#445566' });
        throw Object.assign(new Error('changed'), { status: 409 });
      }
      return [];
    },
  };
});

const sw = (id) => view.container.querySelector(`#${id}`);
const closed = () =>
  ['upos-closed', 'xpos-closed', 'deprel-closed'].map(
    (id) => sw(id).getAttribute('aria-checked') === 'true',
  );
const hex = (tag) => view.container.querySelector(`input[aria-label="${tag} hex"]`);
const typeInto = (input, text) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const save = () =>
  view.step(async () => {
    [...view.container.querySelectorAll('button')]
      .find((b) => b.textContent.trim() === 'Save')
      .click();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });

describe('UD settings Save refused by a save elsewhere', () => {
  it('keeps every other change, shows the latest of what changed, and names it', async () => {
    view = await renderComponent(el());
    for (const id of ['upos-closed', 'xpos-closed', 'deprel-closed']) {
      await view.step(() => sw(id).click());
    }
    await view.step(() => typeInto(hex('NOUN'), '#abcdef'));
    expect(closed()).toEqual([true, true, true]);

    await save();

    // The three lists stay closed, the colors show the other maintainer's.
    expect(closed()).toEqual([true, true, true]);
    expect(hex('NOUN').value).toBe('#445566');
    expect(notifyError).toHaveBeenCalledTimes(1);
    const [message, title] = notifyError.mock.calls[0];
    expect(title).toBe('UD settings not saved');
    expect(message).toMatch(/UPOS colors/);
    expect(message).not.toMatch(/UPOS tags|XPOS|Dependency/);
    expect(message).toMatch(/Save again/);

    // Save again writes the kept changes, each expecting what is stored now.
    await save();
    expect(batches[1].map((o) => o.cell).filter((c) => !c.endsWith('/constraints'))).toEqual([
      'span:xpos/vocabMode',
      'rel:deprel/vocabMode',
      'span:upos/vocabMode',
    ]);
    await view.unmount();
  });

  it('takes the latest without naming it when nothing on the tab had changed there', async () => {
    view = await renderComponent(el());
    await view.step(() => sw('xpos-closed').click());
    await save();
    expect(closed()).toEqual([false, true, false]);
    expect(hex('NOUN').value).toBe('#445566');
    const [message, title] = notifyError.mock.calls[0];
    expect(title).toBe('UD settings not saved');
    expect(message).not.toMatch(/UPOS colors/);
    await view.unmount();
  });
});
