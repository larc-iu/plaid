import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// Save on this tab wrote all sixteen settings from the tab's copy, so a tab
// opened before another maintainer saved put every one of their changes back
// (V6 H6-2). It writes only what changed on the tab, in one batch, each write
// expecting the value the tab was loaded with, and reads the project again
// when the server refuses it.

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

const fakeClient = ({ refuse = false } = {}) => {
  const ops = [];
  const setConfig = (bundle) => (id, ns, key, value, audit, options) =>
    ops.push({ bundle, id, ns, key, value, options });
  const bundles = {
    spanLayers: { setConfig: setConfig('spanLayers') },
    relationLayers: { setConfig: setConfig('relationLayers') },
    projects: { setConfig: setConfig('projects') },
  };
  return {
    ops,
    batched: async (fn) => {
      await fn(bundles);
      if (refuse) throw Object.assign(new Error('HTTP 409 changed'), { status: 409 });
      return [];
    },
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  const upos = layer('upos', { vocab: ['NOUN', 'VERB'], colors: { NOUN: '#112233' } });
  info.current = {
    isConfigured: true,
    uposLayer: upos,
    xposLayer: layer('xpos', {}),
    featuresLayer: layer('feats', {}),
    relationLayer: layer('deprel', { vocab: ['nsubj'] }),
    vocab: {
      upos: ['NOUN', 'VERB'],
      xpos: [],
      deprel: ['nsubj'],
      featureInventory: { list: [] },
    },
    colors: { upos: { NOUN: '#112233' }, deprel: {} },
    modes: {},
    descriptions: { upos: {}, xpos: {}, deprel: {}, feats: {} },
  };
  managed.current = {
    project: { id: 'p1', name: 'P', config: {} },
    loading: false,
    fetchProject: vi.fn(async () => {}),
    canConfigure: true,
  };
});

const button = (root, text) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);

const closeUposAndSave = async (view) => {
  await view.step(() => view.container.querySelector('#upos-closed').click());
  await view.step(async () => {
    button(view.container, 'Save').click();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });
};

const mount = () =>
  renderComponent(
    <MemoryRouter>
      <ProjectCustomization />
    </MemoryRouter>,
  );

describe('UD settings Save', () => {
  it('writes only the setting changed on the tab, expecting what the tab loaded', async () => {
    client.current = fakeClient();
    const view = await mount();
    await closeUposAndSave(view);
    expect(client.current.ops).toEqual([
      {
        bundle: 'spanLayers',
        id: 'upos',
        ns: 'ud',
        key: 'vocabMode',
        value: 'closed',
        options: { expected: undefined },
      },
    ]);
    expect(managed.current.fetchProject).toHaveBeenCalled();
    await view.unmount();
  });

  it('reads the project again when another save came in between', async () => {
    client.current = fakeClient({ refuse: true });
    const view = await mount();
    await closeUposAndSave(view);
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(managed.current.fetchProject).toHaveBeenCalled();
    await view.unmount();
  });
});
