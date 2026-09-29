// A default changed while a Save is on the wire was marked saved when that
// Save landed, though the Save sent the draft from before the change, so the
// change was never stored and Save stayed disabled (REV-W-FINAL, as igt's
// ServicesSettings in 5d19befd).
import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all, byText } from '../../test/renderComponent.jsx';
import { ServiceDefaultsSettings } from './ServiceDefaultsSettings.jsx';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const SPOTS = [
  {
    key: 'analyze',
    label: 'Analyze',
    description: 'Glosses words.',
    builtins: [
      { name: 'builtin-a', label: 'Built in A' },
      { name: 'builtin-b', label: 'Built in B' },
    ],
  },
];

// Each Save's batch waits until `release()` is called.
const makeClient = () => {
  let release = () => {};
  const client = {
    projects: {
      get: async () => ({ id: 'p1', config: {} }),
      setConfig: vi.fn(async () => {}),
    },
    messages: { discoverServices: async () => [], discardService: vi.fn(async () => {}) },
  };
  client.batched = vi.fn(async (fn) => {
    const queued = [];
    await fn({ projects: { setConfig: (...args) => queued.push(args) } });
    await new Promise((r) => {
      release = r;
    });
    for (const args of queued) await client.projects.setConfig(...args);
  });
  return { client, release: () => release() };
};

const radio = (container, name) =>
  all(container, 'input[type="radio"]').find((r) => r.id.endsWith(name));
const saveButton = (container) =>
  byText(container, 'button', 'Save defaults') ?? byText(container, 'button', 'Saving');

describe('ServiceDefaultsSettings, a change made while a Save is out', () => {
  it('stays unsaved when the Save lands, and the next Save sends it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, release } = makeClient();
    const { container, step, unmount } = await renderComponent(
      <ServiceDefaultsSettings projectId="p1" spots={SPOTS} client={client} />,
    );

    await step(() => radio(container, 'builtin-a').click());
    await step(() => saveButton(container).click());
    // The Save is out. The user picks the other built-in meanwhile.
    await step(() => radio(container, 'builtin-b').click());
    await step(async () => {
      release();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(client.projects.setConfig).toHaveBeenCalledTimes(1);
    expect(client.projects.setConfig.mock.calls[0][3].analyze.service).toEqual({
      builtin: 'builtin-a',
    });
    // B is still unsaved: Save can be pressed, and it sends B.
    expect(saveButton(container).disabled).toBe(false);
    await step(() => saveButton(container).click());
    await step(async () => {
      release();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(client.projects.setConfig).toHaveBeenCalledTimes(2);
    expect(client.projects.setConfig.mock.calls[1][3].analyze.service).toEqual({
      builtin: 'builtin-b',
    });
    // The second Save expects what the first stored.
    expect(client.projects.setConfig.mock.calls[1][5]).toEqual({
      expected: { analyze: { service: { builtin: 'builtin-a' }, params: {} } },
    });
    await unmount();
  });

  it('is marked saved when the draft did not change during the Save', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, release } = makeClient();
    const { container, step, unmount } = await renderComponent(
      <ServiceDefaultsSettings projectId="p1" spots={SPOTS} client={client} />,
    );
    await step(() => radio(container, 'builtin-a').click());
    await step(() => saveButton(container).click());
    await step(async () => {
      release();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(saveButton(container).disabled).toBe(true);
    await unmount();
  });
});
