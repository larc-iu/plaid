// The built-in link rule's copy options save in the same batch as the
// service defaults. A change made while that Save was on the wire was marked
// saved when the Save landed, though what was sent was the options from
// before it, so it was never stored and leaving asked nothing
// (REV-W-SETTINGS2 O2).
import { describe, it, expect, vi } from 'vitest';
import { TASKS } from '@larc-iu/plaid-client';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { ServicesSettings } from './ServicesSettings.jsx';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const project = {
  id: 'p1',
  config: {
    igt: { serviceDefaults: { [TASKS.LINK_VOCAB]: { service: { builtin: 'precedent' } } } },
  },
};

const makeClient = () => {
  let release = () => {};
  const client = {
    sent: [],
    hold: () => new Promise((r) => (release = r)),
    release: () => release(),
    projects: { get: async () => structuredClone(project) },
    messages: { discoverServices: async () => [], discardService: async () => {} },
  };
  client.held = null;
  client.batched = async (fn) => {
    const queued = [];
    await fn({ projects: { setConfig: (...args) => queued.push(args) } });
    if (client.held) await client.held;
    client.sent.push(...queued);
  };
  return client;
};

const box = (id) => document.getElementById(id);
const button = (label) =>
  all(document.body, 'button').find((b) => b.textContent.trim() === label) ?? null;
const settle = async (view) => {
  for (let i = 0; i < 4; i++)
    await view.step(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
};

describe('a copy option changed while the Save is on the wire', () => {
  it('stays unsaved when the Save lands, and the next Save sends it', async () => {
    const client = makeClient();
    const view = await renderComponent(<ServicesSettings projectId="p1" client={client} />);
    await settle(view);
    await view.step(() => box('auto-analysis-copy-links').click());
    client.held = client.hold();
    await view.step(() => button('Save defaults').click());
    await view.step(() => box('auto-analysis-copy-fields').click());
    client.release();
    await settle(view);

    const autoAnalysis = client.sent.filter(([, , key]) => key === 'autoAnalysis');
    expect(autoAnalysis).toHaveLength(1);
    expect(autoAnalysis[0][3]).toMatchObject({ copyLinks: false, copyFields: true });
    expect(button('Save defaults').disabled).toBe(false);

    client.held = null;
    await view.step(() => button('Save defaults').click());
    await settle(view);
    const again = client.sent.filter(([, , key]) => key === 'autoAnalysis');
    expect(again).toHaveLength(2);
    expect(again[1][3]).toMatchObject({ copyLinks: false, copyFields: false });
    expect(again[1][5]).toEqual({ expected: again[0][3] });
    expect(button('Save defaults').disabled).toBe(true);
    await view.unmount();
  });
});
