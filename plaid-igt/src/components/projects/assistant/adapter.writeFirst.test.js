import { describe, it, expect, vi } from 'vitest';
import { IGT_ASSISTANT } from './adapter.js';

// An approved tagset plan (writeFirst) puts the rules in force after its
// settings write. A field whose rules the plan changes takes them inside the
// plan's own operation, so the audit row carries the plan's ref. A field the
// plan does not touch (drifted for another reason) is healed apart, under the
// heal's own operation, and no annotation is changed either way.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
}));

const leipzig = (values) => ({
  type: 'value-set',
  values,
  delimiters: '.',
  parts: 'all',
});

const serverProject = () => ({
  id: 'p-1',
  config: {
    igt: {
      tagsets: {
        Leipzig: { mode: 'closed', delimiters: '.', values: [{ value: 'PL' }, { value: 'NOM' }] },
        POS: { mode: 'closed', delimiters: '', values: [{ value: 'N' }] },
      },
    },
  },
  textLayers: [
    {
      id: 'tl',
      config: { plaid: { role: 'baseline' } },
      tokenLayers: [
        {
          id: 'wl',
          config: { plaid: { role: 'word' } },
          constraints: { igt: [{ type: 'single-link' }] },
          spanLayers: [
            // Out of force before the plan (one span a token only): the plan's
            // change to Leipzig is what puts the list on it.
            {
              id: 'sl-mg',
              name: 'Morph Gloss',
              config: { igt: { scope: 'Word', tagset: 'Leipzig' } },
              constraints: { igt: [{ type: 'single-span' }] },
            },
            // Holds an older POS list: drift the plan has nothing to do with.
            {
              id: 'sl-pos',
              name: 'POS',
              config: { igt: { scope: 'Word', tagset: 'POS' } },
              constraints: {
                igt: [{ type: 'single-span' }, { ...leipzig(['X']), delimiters: '' }],
              },
            },
          ],
        },
      ],
    },
  ],
});

const makeClient = () => {
  const server = serverProject();
  const layer = (id) => server.textLayers[0].tokenLayers[0].spanLayers.find((s) => s.id === id);
  const stack = [];
  const log = [];
  const op = () => (stack.length ? { label: stack[0][0], ...stack[0][1] } : null);
  const client = {
    log,
    projects: {
      get: async () => structuredClone(server),
      setConfig: async (_id, ns, key, value) => {
        log.push(['setConfig', key, op()]);
        server.config[ns][key] = value;
      },
    },
    spanLayers: {
      setConstraints: async (id, ns, list) => {
        log.push(['setConstraints', id, op()]);
        layer(id).constraints = { [ns]: list };
      },
      refusedValues: async () => ({ count: 0, valueCount: 0, values: [] }),
      checkConstraints: async () => ({ violations: [], violationCount: 0 }),
      repairConstraints: async () => {
        log.push(['repairConstraints']);
        return { repaired: [] };
      },
      get: async (id) => structuredClone(layer(id)),
    },
    // A nested operation joins the one open, as the real client's does.
    withOperation: async (label, fn, opts = {}) => {
      stack.push([label, opts]);
      try {
        return await fn(() => {});
      } finally {
        stack.pop();
      }
    },
    async batched(fn) {
      const ops = [];
      const queue = (bundle) =>
        new Proxy(
          {},
          {
            get:
              (_, method) =>
              (...args) =>
                ops.push(() => client[bundle][method](...args)),
          },
        );
      fn({ projects: queue('projects'), spanLayers: queue('spanLayers') });
      for (const o of ops) await o();
      return [];
    },
  };
  return { client, layer };
};

describe('an approved tagset plan puts the rules in force', () => {
  it("in the plan's operation for the fields it changes, apart for the rest", async () => {
    const { client, layer } = makeClient();
    const before = { mode: 'closed', delimiters: '.', values: [{ value: 'PL' }, { value: 'NOM' }] };
    const plan = {
      ops: [
        {
          kind: 'set_tagset',
          owner: 'project',
          was: 'Leipzig',
          name: 'Leipzig',
          before,
          after: { ...before, values: [...before.values, { value: 'ERG' }] },
        },
      ],
    };
    const operation = {
      message: 'Assistant: add ERG',
      kind: 'assistant-plan',
      ref: 'conv:c/plan:p/service:s',
    };
    const wrote = await IGT_ASSISTANT.writeFirst({ client, projectId: 'p-1', plan, operation });
    expect(wrote).toBe(true);
    const planOp = { label: 'Assistant: add ERG', kind: 'assistant-plan', ref: operation.ref };
    expect(client.log).toEqual([
      ['setConfig', 'tagsets', planOp],
      ['setConstraints', 'sl-mg', planOp],
      ['setConstraints', 'sl-pos', { label: 'Set up layer rules', kind: 'repair' }],
    ]);
    expect(layer('sl-mg').constraints.igt).toEqual([
      { type: 'single-span' },
      leipzig(['PL', 'NOM', 'ERG']),
    ]);
  });
});
