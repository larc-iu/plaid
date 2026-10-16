import { describe, it, expect, vi } from 'vitest';
import { finishImport } from './importFinish.js';

// REV3-WIRE-1: an import stopped part way and ended with "Use the project as
// it is" has written its tagsets and each field's reference to one, but never
// reached its own last step. Finishing it puts the lists in force first.

const vs = { type: 'value-set', values: ['PL'], delimiters: '.', parts: 'all' };
const project = () => ({
  id: 'p',
  config: {
    igt: {
      tagsets: { Leipzig: { mode: 'closed', delimiters: '.', values: [{ value: 'PL' }] } },
      import: { kind: 'Plaid IGT archive' },
    },
  },
  textLayers: [
    {
      id: 'tl',
      config: { plaid: { role: 'baseline' } },
      tokenLayers: [
        {
          id: 'm',
          name: 'Morphemes',
          config: { plaid: { role: 'morpheme' } },
          constraints: { igt: [{ type: 'coextensive' }, { type: 'single-link' }] },
          spanLayers: [
            {
              id: 'mg',
              name: 'Morph Gloss',
              config: { igt: { scope: 'Morpheme', tagset: 'Leipzig' } },
              constraints: { igt: [{ type: 'single-span' }] },
            },
          ],
        },
      ],
    },
  ],
});

const stub = (refused) => {
  const calls = [];
  const client = {
    calls,
    projects: {
      get: async () => project(),
      deleteConfig: async (...a) => calls.push(['deleteConfig', ...a]),
    },
    spanLayers: {
      refusedValues: async () => refused,
      checkConstraints: async () => ({ violations: [], violationCount: 0 }),
      setConstraints: async (id, _ns, list) => calls.push(['setConstraints', id, list]),
    },
    withOperation: async (_m, fn) => fn(),
    batched: async (fn) => fn(client),
  };
  return client;
};

describe('finishImport', () => {
  it('puts the closed list in force, then clears the record', async () => {
    const client = stub({ count: 0, valueCount: 0, values: [] });
    expect(await finishImport(client, 'p')).toEqual({ cleared: true, warnings: [] });
    expect(client.calls).toEqual([
      ['setConstraints', 'mg', [{ type: 'single-span' }, vs]],
      ['deleteConfig', 'p', 'igt', 'import'],
    ]);
  });

  it('names a list the stored values break, and clears the record', async () => {
    const client = stub({
      count: 1,
      valueCount: 1,
      values: [{ value: 'QQ', parts: ['QQ'], count: 1 }],
    });
    const out = await finishImport(client, 'p');
    expect(out).toEqual({
      cleared: true,
      warnings: [
        '“Leipzig” is not in force on Morph Gloss: 1 annotation not in the list, QQ (1). Change these values, then choose Put in force under Validation.',
      ],
    });
    expect(client.calls).toEqual([['deleteConfig', 'p', 'igt', 'import']]);
  });

  it('clears the record when the rules could not be declared', async () => {
    const client = stub(null);
    client.spanLayers.refusedValues = async () => {
      throw new Error('down');
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await finishImport(client, 'p');
    spy.mockRestore();
    expect(out).toEqual({ cleared: true, warnings: ['The annotation rules were not set.'] });
  });
});
