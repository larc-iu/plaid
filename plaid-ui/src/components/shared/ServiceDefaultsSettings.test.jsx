import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderComponent, all, byText } from '../../test/renderComponent.jsx';
import { ServiceDefaultsSettings } from './ServiceDefaultsSettings.jsx';

const { toast } = vi.hoisted(() => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock('sonner', () => ({ toast }));

const SPOTS = [
  { key: 'tokenize', label: 'Tokenize', description: 'Splits text.', builtins: [] },
  {
    key: 'analyze',
    label: 'Analyze',
    description: 'Glosses words.',
    builtins: [{ name: 'builtin-a', label: 'Built in' }],
  },
];

const SERVICE = {
  serviceId: 's1',
  serviceName: 'Punkt',
  online: false,
  lastSeenAt: '2026-09-01T00:00:00Z',
  extras: { tasks: ['tokenize'] },
};

const STRAY = {
  serviceId: 's2',
  serviceName: 'Something else',
  online: true,
  extras: { tasks: ['translate'] },
};

// `batched` hands the page a batch whose writes are the client's own
// setConfig, sent when the batch is: each Save is one request.
const makeClient = (over = {}) => {
  const client = {
    projects: {
      get: async () => ({ id: 'p1', config: {} }),
      setConfig: vi.fn(async () => {}),
    },
    messages: {
      discoverServices: async () => [SERVICE, STRAY],
      discardService: vi.fn(async () => {}),
    },
    ...over,
  };
  client.batched = vi.fn(async (fn) => {
    const queued = [];
    await fn({ projects: { setConfig: (...args) => queued.push(args) } });
    for (const args of queued) await client.projects.setConfig(...args);
  });
  return client;
};

const mount = (props = {}) => {
  const client = props.client || makeClient();
  return renderComponent(
    <ServiceDefaultsSettings projectId="p1" spots={SPOTS} {...props} client={client} />,
  ).then((view) => ({ ...view, client }));
};

const radios = (container) => all(container, 'input[type="radio"]');

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('ServiceDefaultsSettings', () => {
  it('offers one card per spot, and says when a spot has nothing at all', async () => {
    const { container, unmount } = await mount();
    expect(container.textContent).toContain('Tokenize');
    expect(container.textContent).toContain('Analyze');
    // Tokenize has Punkt; Analyze has only a built-in, so neither card is empty.
    expect(container.textContent).not.toContain('has connected to this project. Start one');
    await unmount();
  });

  it('says when a service was last seen, and offers to forget it', async () => {
    const { container, unmount } = await mount();
    expect(container.textContent).toContain('offline');
    expect(container.textContent).toContain('last seen');
    expect(container.querySelector('button[aria-label="Forget Punkt"]')).not.toBe(null);
    await unmount();
  });

  it('lists a service no spot claims, so it can still be forgotten', async () => {
    const { container, unmount } = await mount();
    expect(container.textContent).toContain('Other services');
    expect(container.textContent).toContain('Something else');
    await unmount();
  });

  it('writes the chosen default under the app’s own config namespace', async () => {
    const { container, client, step, unmount } = await mount();

    const punkt = radios(container).find((r) => r.id.includes('s1'));
    await step(() => punkt.click());
    await step(async () => {
      byText(container, 'button', 'Save defaults').click();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(client.projects.setConfig).toHaveBeenCalledWith(
      'p1',
      'igt', // the test run configures the package as plaid-igt
      'serviceDefaults',
      expect.objectContaining({ tokenize: expect.anything() }),
      undefined,
      // What the page read: nothing stored yet.
      { expected: undefined },
    );
    expect(toast.success).toHaveBeenCalled();
    await unmount();
  });

  // A page opened before another maintainer saved wrote its whole copy over
  // that save, and a return to the tab threw an unsaved choice away (V6).
  it('keeps an unsaved choice when the tab comes back', async () => {
    const { container, step, unmount } = await mount();
    const punkt = radios(container).find((r) => r.id.includes('s1'));
    await step(() => punkt.click());
    expect(punkt.checked).toBe(true);
    await step(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(radios(container).find((r) => r.id.includes('s1')).checked).toBe(true);
    expect(byText(container, 'button', 'Save defaults').disabled).toBe(false);
    await unmount();
  });

  it('reads the settings again when someone else saved them since', async () => {
    const stored = { analyze: { builtin: 'builtin-a' } };
    const get = vi.fn(async () => ({ id: 'p1', config: { igt: { serviceDefaults: stored } } }));
    const setConfig = vi.fn(async () => {
      throw Object.assign(new Error('HTTP 409 changed'), { status: 409 });
    });
    const client = makeClient({
      projects: { get, setConfig },
    });
    const { container, step, unmount } = await mount({ client });
    const punkt = radios(container).find((r) => r.id.includes('s1'));
    await step(() => punkt.click());
    await step(async () => {
      byText(container, 'button', 'Save defaults').click();
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
    expect(setConfig.mock.calls[0][5]).toEqual({ expected: stored });
    expect(toast.error).toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(2);
    await unmount();
  });

  it('does not write the defaults when only the second key changed', async () => {
    const saveExtra = vi.fn();
    const { container, client, step, unmount } = await mount({ saveExtra, extraDirty: true });
    await step(async () => {
      byText(container, 'button', 'Save defaults').click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(client.projects.setConfig).not.toHaveBeenCalled();
    expect(saveExtra).toHaveBeenCalledWith(expect.anything(), { id: 'p1', config: {} });
    await unmount();
  });

  it('saves the app’s own second key in the same Save', async () => {
    const saveExtra = vi.fn();
    const onExtraSaved = vi.fn();
    const { container, step, unmount } = await mount({
      saveExtra,
      onExtraSaved,
      extraDirty: true,
    });

    await step(async () => {
      byText(container, 'button', 'Save defaults').click();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(saveExtra).toHaveBeenCalled();
    expect(onExtraSaved).toHaveBeenCalled();
    await unmount();
  });

  // Two writes, the defaults and the app's key: a refusal of the second said
  // the Save failed though the first had landed. One batch lands both or
  // neither.
  it('sends the defaults and the app’s own key as one request, and keeps both unsaved when it is refused', async () => {
    const client = makeClient();
    const sent = [];
    client.batched = vi.fn(async (fn) => {
      const queued = [];
      await fn({ projects: { setConfig: (...args) => queued.push(args) } });
      sent.push(queued.map((args) => args[2]));
      throw Object.assign(new Error('HTTP 409 changed'), { status: 409 });
    });
    const onExtraSaved = vi.fn();
    const saveExtra = (b) => b.projects.setConfig('p1', 'igt', 'autoAnalysis', { on: 1 });
    const { container, step, unmount } = await mount({
      client,
      saveExtra,
      onExtraSaved,
      extraDirty: true,
    });
    const punkt = radios(container).find((r) => r.id.includes('s1'));
    await step(() => punkt.click());
    await step(async () => {
      byText(container, 'button', 'Save defaults').click();
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
    expect(sent).toEqual([['serviceDefaults', 'autoAnalysis']]);
    expect(client.projects.setConfig).not.toHaveBeenCalled();
    expect(onExtraSaved).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
    await unmount();
  });

  it('offers nothing to change to a reader', async () => {
    const { container, unmount } = await mount({ canManage: false });
    expect(container.textContent).toContain('Read-only');
    expect(radios(container).every((r) => r.disabled)).toBe(true);
    expect(byText(container, 'button', 'Save defaults')).toBe(null);
    expect(container.querySelector('button[aria-label="Forget Punkt"]')).toBe(null);
    await unmount();
  });

  it('forgets a service and reads the registry again', async () => {
    const { container, client, step, unmount } = await mount();

    await step(async () => {
      container.querySelector('button[aria-label="Forget Punkt"]').click();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(client.messages.discardService).toHaveBeenCalledWith('p1', 's1');
    await unmount();
  });

  it('describes a failed read rather than showing an empty registry', async () => {
    const client = makeClient({
      projects: {
        get: async () => {
          throw Object.assign(new Error('HTTP 503 at http://localhost:8085/api/v1'), {
            status: 503,
          });
        },
        setConfig: vi.fn(),
      },
    });
    const { unmount } = await mount({ client });

    expect(toast.error).toHaveBeenCalledWith('Failed to load the services', {
      description: 'Failed to reach the server. Check your connection and try again.',
    });
    await unmount();
  });
});
