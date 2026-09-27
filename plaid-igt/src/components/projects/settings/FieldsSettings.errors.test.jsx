import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { notifySuccess, notifyError } from '@/utils/feedback';

// A refused save in Settings > Fields said the field was added, then replaced the
// whole section with a dead "refresh the page" panel. A save shows at once,
// is put back when refused, says why, and leaves every control in place.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  humanizeError: (e) => String(e),
}));

const { FieldsSettings } = await import('./FieldsSettings.jsx');

const role = (r) => ({ plaid: { role: r } });
const project = () => ({
  id: 'p1',
  config: {},
  textLayers: [
    {
      id: 'text',
      config: role('baseline'),
      tokenLayers: [
        { id: 'sent', config: role('sentence'), spanLayers: [] },
        {
          id: 'word',
          config: role('word'),
          spanLayers: [{ id: 'gloss', name: 'Gloss', config: { igt: { scope: 'Word' } } }],
        },
        { id: 'morph', config: role('morpheme'), spanLayers: [] },
      ],
    },
  ],
});

// A client whose writes are recorded, on the wire or in a batch.
const fakeClient = ({ refuseCreate = false } = {}) => {
  const calls = [];
  const bundles = (sink) => ({
    tokenLayers: { setConfig: (...a) => sink('tokenLayers.setConfig', a) },
    spanLayers: {
      setConfig: (...a) => sink('spanLayers.setConfig', a),
      deleteConfig: (...a) => sink('spanLayers.deleteConfig', a),
      delete: (...a) => sink('spanLayers.delete', a),
    },
  });
  const wire = async (kind, args) => calls.push([kind, ...args]);
  const client = {
    calls,
    projects: { get: async () => project() },
    ...bundles(wire),
    batched: async (fn) => {
      const ops = [];
      fn(bundles((kind, args) => ops.push([kind, ...args])));
      calls.push(['batch', ops.map(([k]) => k)]);
      return [];
    },
  };
  client.spanLayers.create = async (...a) => {
    calls.push(['spanLayers.create', ...a]);
    if (refuseCreate) throw Object.assign(new Error('HTTP 500 boom'), { status: 500 });
    return { id: 'new-layer' };
  };
  client.spanLayers.shift = async () => {
    throw Object.assign(new Error('HTTP 403 no'), { status: 403 });
  };
  return client;
};

const typeInto = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const mount = async (client, onProjectUpdate = vi.fn(async () => {})) => {
  const view = await renderComponent(
    <FieldsSettings
      project={project()}
      projectId="p1"
      client={client}
      onProjectUpdate={onProjectUpdate}
    />,
  );
  await view.step(async () => {});
  return { ...view, onProjectUpdate };
};
const nameBox = () => document.querySelector('input[placeholder="Enter field name"]');
const addButton = () =>
  all(document.body, 'button').find((b) => b.textContent.trim() === 'Add field');
const rowNames = (c) => all(c, 'tbody tr').map((tr) => tr.textContent);

afterEach(() => vi.clearAllMocks());

describe('Settings > Fields when a save is refused', () => {
  it('keeps the section, puts the table and the typed name back, and reads the project again', async () => {
    const client = fakeClient({ refuseCreate: true });
    const { container, step, unmount, onProjectUpdate } = await mount(client);
    await step(() => typeInto(nameBox(), 'Note2'));
    await step(async () => {
      addButton().click();
      await settle();
    });
    expect(container.textContent).not.toContain('refresh the page');
    expect(nameBox()).toBeTruthy();
    expect(nameBox().value).toBe('Note2');
    expect(rowNames(container).some((t) => t.includes('Note2'))).toBe(false);
    expect(notifySuccess).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(onProjectUpdate).toHaveBeenCalled();
    // Nothing after the refused create went out.
    expect(client.calls.map(([k]) => k)).toEqual(['spanLayers.create']);
    await unmount();
  });

  it('says the field was added only once the save has landed, and sends the rest as one batch', async () => {
    const client = fakeClient();
    const { container, step, unmount } = await mount(client);
    await step(() => typeInto(nameBox(), 'Note2'));
    await step(async () => {
      addButton().click();
      await settle();
    });
    expect(notifySuccess).toHaveBeenCalledTimes(1);
    expect(rowNames(container).some((t) => t.includes('Note2'))).toBe(true);
    expect(client.calls.map(([k]) => k)).toEqual([
      'spanLayers.create',
      'spanLayers.setConfig',
      'batch',
    ]);
    await unmount();
  });

  it('puts a refused move back and keeps the section', async () => {
    const client = fakeClient();
    client.projects.get = async () => project();
    const p = project();
    p.textLayers[0].tokenLayers[1].spanLayers.push({
      id: 'pos',
      name: 'POS',
      config: { igt: { scope: 'Word' } },
    });
    const view = await renderComponent(
      <FieldsSettings project={p} projectId="p1" client={client} onProjectUpdate={vi.fn()} />,
    );
    await view.step(async () => {});
    const before = rowNames(view.container);
    const down = all(view.container, 'button').find((b) => /down/i.test(b.title || ''));
    expect(down).toBeTruthy();
    await view.step(async () => {
      down.click();
      await settle();
    });
    expect(rowNames(view.container)).toEqual(before);
    expect(view.container.textContent).not.toContain('refresh the page');
    expect(notifyError).toHaveBeenCalledTimes(1);
    await view.unmount();
  });
});

// A save reads the layers that exist and creates the missing ones. Two saves
// at once both saw the first new field missing, and both created it.
describe('Settings > Fields with a save still on its way', () => {
  it('a second field added meanwhile waits for the first save, so no field is made twice', async () => {
    const server = project();
    const word = server.textLayers[0].tokenLayers[1];
    let release;
    const held = new Promise((r) => (release = r));
    const client = fakeClient();
    client.projects.get = async () => structuredClone(server);
    client.spanLayers.create = async (parent, name) => {
      client.calls.push(['spanLayers.create', parent, name]);
      if (name === 'Note2') await held;
      const layer = { id: `layer-${name}`, name, config: { igt: { scope: 'Word' } } };
      word.spanLayers.push(layer);
      return layer;
    };
    const { step, unmount } = await mount(client);
    await step(() => typeInto(nameBox(), 'Note2'));
    await step(async () => {
      addButton().click();
      await settle();
    });
    await step(() => typeInto(nameBox(), 'Note3'));
    await step(async () => {
      addButton().click();
      await settle();
    });
    await step(async () => {
      release();
      await settle();
    });
    const made = client.calls.filter(([k]) => k === 'spanLayers.create').map((c) => c[2]);
    expect(made).toEqual(['Note2', 'Note3']);
    await unmount();
  });
});
