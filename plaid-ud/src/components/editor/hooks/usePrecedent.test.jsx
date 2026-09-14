import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { usePrecedent } from './usePrecedent.js';

// The cache holds the PROMISE of an answer, not the answer, and what that buys
// is only visible in the sequence: two cells asking the same question at the
// same moment make ONE request, and the second waits for the first rather than
// starting another. A cache of RESULTS gives both of them the right counts in
// the end, so nothing that reads what came back can tell the two apart.

const layerInfo = {
  morphemeTokenLayer: { id: 'morph' },
  formLayer: { id: 'form' },
  lemmaLayer: { id: 'lemma' },
  xposLayer: { id: 'xpos' },
  featuresLayer: { id: 'feats' },
};

// The hook's one function, as the last render left it. A property rather than
// a variable, so the assignment is not a reassignment during render.
const hook = {};
const api = (...args) => hook.lookup(...args);
const Probe = ({ client, documentId }) => {
  hook.lookup = usePrecedent({ client, projectId: 'p1', layerInfo, documentId });
  return null;
};

// One deferred query per call, resolved by hand. `lemma` asks TWO of them (a
// word's form is a Form span or the token's own text), which is why the counts
// below are per-query and not per-question.
const deferredClient = () => {
  const settle = [];
  return {
    settle,
    query: vi.fn(() => new Promise((resolve) => settle.push(resolve))),
  };
};

describe('the precedent cache', () => {
  it('asks once when two cells ask at the same moment', async () => {
    const client = deferredClient();
    const view = await renderComponent(<Probe client={client} documentId="d1" />);

    let first, second;
    await view.step(() => {
      first = api('lemma', 'dog');
    });
    const asked = client.query.mock.calls.length;
    expect(asked).toBe(2);

    // The second cell asks while the first request is still out.
    await view.step(() => {
      second = api('lemma', 'dog');
    });
    expect(client.query.mock.calls.length).toBe(asked);

    await view.step(async () => {
      client.settle.forEach((resolve) => resolve({ results: [['ADP', 3]] }));
      await Promise.all([first, second]);
    });
    // And both of them get the same answer, from the one request.
    expect(await first).toEqual(await second);
    await view.unmount();
  });

  it('asks again after a failure, having kept nothing', async () => {
    const client = {
      query: vi.fn(() => Promise.reject(new Error('down'))),
    };
    const view = await renderComponent(<Probe client={client} documentId="d1" />);

    await view.step(async () => {
      expect(await api('xpos', 'dog')).toEqual([]);
    });
    const asked = client.query.mock.calls.length;

    await view.step(async () => {
      await api('xpos', 'dog');
    });
    expect(client.query.mock.calls.length).toBe(asked * 2);
    await view.unmount();
  });

  it('forgets what it knows when the document changes', async () => {
    const client = { query: vi.fn(() => Promise.resolve({ results: [] })) };
    const view = await renderComponent(<Probe client={client} documentId="d1" />);

    await view.step(async () => {
      await api('xpos', 'dog');
    });
    const asked = client.query.mock.calls.length;

    await view.step(async () => {
      await api('xpos', 'dog');
    });
    expect(client.query.mock.calls.length).toBe(asked);

    await view.rerender(<Probe client={client} documentId="d2" />);
    await view.step(async () => {
      await api('xpos', 'dog');
    });
    expect(client.query.mock.calls.length).toBe(asked * 2);
    await view.unmount();
  });
});
