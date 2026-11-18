import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { renderComponent } from '@ui/test/renderComponent.jsx';

vi.mock('@/utils/feedback', () => ({ notifyError: vi.fn() }));

const { useVocabHistory } = await import('./useVocabHistory.js');

// P1-4: an entry's History lists each change with only the operations that
// wrote that entry, so an import's change ended where the entry was made, and
// picking it showed the vocabulary partway through the import (3,000 of 4,907
// entries). The vocabulary is read as of the end of the whole change.
const MADE = '2026-10-29T02:49:04Z';
const DONE = '2026-10-29T02:51:30Z';

const fakeClient = () => {
  const reads = [];
  const pages = [];
  return {
    reads,
    pages,
    vocabLayers: {
      auditPage: async (id, opts) => {
        if (!opts.entryId) {
          return {
            entries: [
              {
                id: 'g1',
                time: '2026-10-29T02:48:00Z',
                endTime: MADE,
                ops: [{ id: 'op7', time: MADE, endTime: MADE, description: 'Create vocab items' }],
              },
            ],
          };
        }
        pages.push([id, opts]);
        return { entries: [{ id: 'g1', time: '2026-10-29T02:48:00Z', endTime: DONE }] };
      },
      get: async (id, withItems, asOf) => {
        reads.push(asOf);
        return { id, items: [] };
      },
    },
  };
};

const mount = async (client) => {
  let api = null;
  const Probe = () => {
    api = useVocabHistory({ client, vocabularyId: 'V' });
    return null;
  };
  const view = await renderComponent(<Probe />);
  return { view, api: () => api };
};

// SCL4-5: the rail read every action of every change, so one Bulk Edit of
// 5,000 entries made every open of the rail ship all 5,000.
describe('the rail', () => {
  it('reads each change with its first 100 actions, and the next 100 when asked', async () => {
    const ops = (from, n) =>
      Array.from({ length: n }, (_, i) => ({ id: `op${from + i}`, time: `t${from + i}` }));
    const asked = [];
    const client = {
      vocabLayers: {
        auditPage: async (id, opts) => {
          asked.push(opts);
          if (opts.entryId) return { entries: [{ id: 'big', ops: ops(99, 101) }] };
          return { entries: [{ id: 'big', opCount: 5000, ops: ops(0, opts.opsLimit ?? 5000) }] };
        },
      },
    };
    const { view, api } = await mount(client);
    await act(async () => api().openHistory());
    await act(async () => {});
    expect(asked[0]).toMatchObject({ opsLimit: 100 });
    expect(api().entries[0].ops).toHaveLength(100);
    await act(async () => api().loadMoreOps('big'));
    expect(asked[1]).toMatchObject({ entryId: 'big', startTime: 't99', opsLimit: 101 });
    expect(api().entries[0].ops).toHaveLength(200);
    await view.unmount();
  });
});

describe("an entry's History", () => {
  it('shows the vocabulary after the whole change, not where the entry was written', async () => {
    const client = fakeClient();
    const { view, api } = await mount(client);
    await act(async () => api().openHistory('item-1'));
    await act(async () => {});
    await act(async () => api().select({ id: 'g1', time: MADE, label: 'Import FLEx project' }));
    expect(client.pages).toEqual([['V', { entryId: 'g1', opsLimit: 1 }]]);
    expect(client.reads).toEqual([DONE]);
    expect(api().past.time).toBe(DONE);
    await view.unmount();
  });

  it('shows the state after one operation when that is what was picked', async () => {
    const client = fakeClient();
    const { view, api } = await mount(client);
    await act(async () => api().openHistory('item-1'));
    await act(async () => {});
    await act(async () => api().select({ id: 'op7', time: MADE, label: 'Create vocab items' }));
    expect(client.pages).toEqual([]);
    expect(client.reads).toEqual([MADE]);
    await view.unmount();
  });

  it("reads the whole vocabulary's rail as it is", async () => {
    const client = fakeClient();
    const { view, api } = await mount(client);
    await act(async () => api().openHistory());
    await act(async () => {});
    await act(async () => api().select({ id: 'g1', time: MADE, label: 'Import FLEx project' }));
    expect(client.pages).toEqual([]);
    expect(client.reads).toEqual([MADE]);
    await view.unmount();
  });
});
