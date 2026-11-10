import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { discoverExportLayers } from '@/export/exportLayers';
import { newPreset } from '@/export/presets';

// Activity names each preset write by what it did to which preset. The bare
// config write read "Set editor config igt/export".

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  humanizeError: (e) => String(e),
}));
vi.mock('@/components/export/ExportRunner.jsx', () => ({ ExportRunner: () => null }));

const { ExportPresetsSettings } = await import('./ExportPresetsSettings.jsx');
const { ExportPresetEditor } = await import('./ExportPresetEditor.jsx');

const role = (r) => ({ plaid: { role: r } });
const makeServer = () => {
  const server = {
    id: 'p1',
    config: {},
    textLayers: [
      {
        id: 'text',
        name: 'Baseline',
        config: role('baseline'),
        tokenLayers: [
          { id: 'sent', name: 'Sentences', config: role('sentence'), spanLayers: [] },
          { id: 'word', name: 'Words', config: role('word'), spanLayers: [] },
        ],
      },
    ],
  };
  const preset = newPreset('elan', discoverExportLayers(server), 'Course');
  server.config.igt = { export: { presets: [preset] } };
  const labels = [];
  const client = {
    projects: {
      get: async () => structuredClone(server),
      setConfig: async (_id, ns, key, value, auditMessage) => {
        labels.push(auditMessage);
        server.config[ns] = { ...server.config[ns], [key]: structuredClone(value) };
      },
    },
  };
  return { server, client, preset, labels };
};

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const button = (text) => all(document.body, 'button').find((b) => b.textContent.trim() === text);
const click = (view, el) =>
  view.step(async () => {
    el.click();
    await settle();
  });

describe('Export preset writes in Activity', () => {
  it('names the preset a create and a delete wrote', async () => {
    const { client, labels } = makeServer();
    const view = await renderComponent(
      <MemoryRouter>
        <ExportPresetsSettings projectId="p1" client={client} />
      </MemoryRouter>,
    );
    await view.step(settle);
    await click(view, button('New preset'));
    await click(view, button('Create'));
    expect(labels).toHaveLength(1);
    expect(labels[0]).toBe('Create export preset “Plain text”');

    await click(
      view,
      all(document.body, 'button').find((b) => b.getAttribute('aria-label') === 'Delete Course'),
    );
    await click(view, button('Delete'));
    expect(labels[1]).toBe('Delete export preset “Course”');
    await view.unmount();
  });

  it('names the preset an edit saved', async () => {
    const { client, preset, labels } = makeServer();
    const view = await renderComponent(
      <MemoryRouter>
        <ExportPresetEditor projectId="p1" client={client} presetId={preset.id} />
      </MemoryRouter>,
    );
    await view.step(settle);
    const name = document.getElementById('preset-name');
    await view.step(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(name, 'Course notes');
      name.dispatchEvent(new Event('input', { bubbles: true }));
      await settle();
    });
    await click(view, button('Save'));
    expect(labels).toEqual(['Edit export preset “Course notes”']);
    await view.unmount();
  });
});
