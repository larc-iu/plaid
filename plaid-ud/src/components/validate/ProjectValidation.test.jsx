import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { readFeatureInventory } from '../../utils/udVocab.js';

// Add on the Validation tab writes the list with the off-list values after
// it, expecting the list as read, with the layer's rules in the same batch,
// and once more against what another save left when that one is refused. The
// feature inventory is written on its own.

const managed = vi.hoisted(() => ({ current: null }));
vi.mock('@ui/hooks/useManagedProject.js', () => ({ useManagedProject: () => managed.current }));
const client = vi.hoisted(() => ({ current: null }));
vi.mock('../../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ getClient: () => client.current }),
}));
vi.mock('../../utils/feedback.jsx', () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }));
vi.mock('../projects/ProjectTabs.jsx', () => ({ ProjectTabs: () => null }));

const info = vi.hoisted(() => ({ current: null }));
vi.mock('../../utils/udLayerUtils.js', async (orig) => ({
  ...(await orig()),
  getUdLayerInfo: () => info.current,
}));

const { ProjectValidation } = await import('./ProjectValidation.jsx');

const layer = (id, ud) => ({ id, config: { ud } });
const INVENTORY = [{ key: 'Number', values: ['Sing'] }];
const infoWith = (upos) => ({
  isConfigured: true,
  sentenceLayer: { id: 'sent' },
  uposLayer: layer('upos', { vocab: upos }),
  featuresLayer: layer('feats', { inventory: INVENTORY }),
  vocab: {
    upos,
    xpos: [],
    deprel: [],
    featureInventory: readFeatureInventory({ ud: { inventory: INVENTORY } }),
  },
  modes: {},
});

const COUNTS = { upos: [['X', 2]], feats: [['Number=Plur', 3]] };

let view;
let batches;
let reload;
const realLocation = window.location;

beforeEach(() => {
  info.current = infoWith(['NOUN', 'VERB']);
  batches = [];
  managed.current = {
    project: { id: 'p1', name: 'P', config: {} },
    projectId: 'p1',
    loading: false,
    canConfigure: true,
  };
  reload = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...realLocation, reload },
  });
  client.current = {
    query: vi.fn(async (q) => {
      const text = JSON.stringify(q);
      return { results: text.includes('"feats"') ? COUNTS.feats : COUNTS.upos };
    }),
    projects: { get: vi.fn(async () => ({ id: 'p1', name: 'P', config: {} })) },
    spanLayers: { setConfig: vi.fn(async () => {}) },
    batched: async (fn) => {
      const ops = [];
      const rec = (bundle) => ({
        setConfig: (id, ns, key, value, audit, options) =>
          ops.push({ cell: `${bundle}:${id}/${ns}.${key}`, value, audit, options }),
        setConstraints: (id) => ops.push({ cell: `${bundle}:${id}/constraints` }),
        repairConstraints: (id) => ops.push({ cell: `${bundle}:${id}/repair` }),
      });
      await fn({
        spanLayers: rec('span'),
        relationLayers: rec('rel'),
        projects: rec('proj'),
        tokenLayers: rec('tok'),
      });
      batches.push(ops);
      if (batches.length === 1) {
        // Another maintainer's save lands first.
        info.current = infoWith(['NOUN', 'VERB', 'ADJ']);
        throw Object.assign(new Error('changed'), { status: 409 });
      }
      return [];
    },
  };
});

afterEach(async () => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  if (view) await view.unmount();
  view = null;
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const addButtons = () =>
  [...view.container.querySelectorAll('button')].filter((b) =>
    b.textContent.trim().startsWith('Add '),
  );

describe('UD Validation, Add', () => {
  it('writes the list with the values added, expecting it, and redoes it once after a 409', async () => {
    view = await renderComponent(
      <MemoryRouter>
        <ProjectValidation />
      </MemoryRouter>,
    );
    await view.step(settle);
    const [uposAdd] = addButtons();
    await view.step(async () => {
      uposAdd.click();
      await settle();
    });
    const cells = (ops) => ops.filter((o) => !o.cell.endsWith('/constraints'));
    expect(batches.map(cells)).toEqual([
      [
        {
          cell: 'span:upos/ud.vocab',
          value: ['NOUN', 'VERB', 'X'],
          audit: undefined,
          options: { expected: ['NOUN', 'VERB'] },
        },
      ],
      [
        {
          cell: 'span:upos/ud.vocab',
          value: ['NOUN', 'VERB', 'ADJ', 'X'],
          audit: undefined,
          options: { expected: ['NOUN', 'VERB', 'ADJ'] },
        },
      ],
    ]);
    expect(client.current.projects.get).toHaveBeenCalledWith('p1');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('writes the feature inventory on its own, expecting what is stored', async () => {
    view = await renderComponent(
      <MemoryRouter>
        <ProjectValidation />
      </MemoryRouter>,
    );
    await view.step(settle);
    const featsAdd = addButtons().at(-1);
    await view.step(async () => {
      featsAdd.click();
      await settle();
    });
    expect(batches).toEqual([]);
    expect(client.current.spanLayers.setConfig.mock.calls).toEqual([
      [
        'feats',
        'ud',
        'inventory',
        [{ key: 'Number', values: ['Sing', 'Plur'] }],
        undefined,
        { expected: INVENTORY },
      ],
    ]);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
