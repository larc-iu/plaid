// Auto-analyze's copy step runs whichever method links to the lexicon, so
// what it copies is set whatever the Auto-link vocabulary default is. The
// options were drawn only under "Follow precedent and unique matches", and a
// new project, with no default, showed none of them (GUIDE-IGT-2).
import { describe, it, expect, vi } from 'vitest';
import { TASKS } from '@larc-iu/plaid-client';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { ServicesSettings } from './ServicesSettings.jsx';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const makeClient = (config) => {
  const client = {
    sent: [],
    projects: { get: async () => ({ id: 'p1', config }) },
    messages: { discoverServices: async () => [], discardService: async () => {} },
  };
  client.batched = async (fn) => {
    const queued = [];
    await fn({ projects: { setConfig: (...args) => queued.push(args) } });
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

describe('the copy step options on Services', () => {
  it('are shown on a project with no Auto-link default, and save', async () => {
    const client = makeClient({});
    const view = await renderComponent(<ServicesSettings projectId="p1" client={client} />);
    await settle(view);
    expect(document.body.textContent).toContain('Copy previous analyses');
    expect(box('auto-analysis-copy')).not.toBeNull();
    expect(box('auto-analysis-copy-seg')).not.toBeNull();
    await view.step(() => box('auto-analysis-copy-fields').click());
    await view.step(() => button('Save defaults').click());
    await settle(view);
    const sent = client.sent.filter(([, , key]) => key === 'autoAnalysis');
    expect(sent).toHaveLength(1);
    expect(sent[0][3]).toMatchObject({ copyAnalyses: true, copyFields: false });
    await view.unmount();
  });

  it('stay where they are when the built-in link rule is the default', async () => {
    const client = makeClient({
      igt: { serviceDefaults: { [TASKS.LINK_VOCAB]: { service: { builtin: 'precedent' } } } },
    });
    const view = await renderComponent(<ServicesSettings projectId="p1" client={client} />);
    await settle(view);
    expect(all(document.body, '#auto-analysis-copy')).toHaveLength(1);
    await view.step(() => box('svc-default-link-vocab-none')?.click());
    expect(all(document.body, '#auto-analysis-copy')).toHaveLength(1);
    await view.unmount();
  });
});
