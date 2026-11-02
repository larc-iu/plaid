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
      audit: async () => [
        {
          id: 'g1',
          time: '2026-10-29T02:48:00Z',
          endTime: MADE,
          ops: [{ id: 'op7', time: MADE, endTime: MADE, description: 'Create vocab items' }],
        },
      ],
      auditPage: async (id, opts) => {
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
