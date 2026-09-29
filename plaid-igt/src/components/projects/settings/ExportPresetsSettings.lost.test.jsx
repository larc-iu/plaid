import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { sameConfig } from '@ui/domain/configCells.js';

// Create a preset, and the answer never comes: the preset may or may not
// have been stored, and the user presses Create again. The second write is
// refused (the list changed, by the first one), made again over the list as
// stored, and used to add a second preset of the same name beside the first.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  humanizeError: (e) => String(e),
}));

const { ExportPresetsSettings } = await import('./ExportPresetsSettings.jsx');

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
  const client = {
    lose: 0,
    projects: {
      get: async () => structuredClone(server),
      setConfig: async (_id, ns, key, value, _audit, options) => {
        const stored = server.config[ns]?.[key];
        if (options && !sameConfig(options.expected, stored)) {
          throw Object.assign(new Error('HTTP 409 changed'), { status: 409 });
        }
        server.config[ns] = { ...server.config[ns], [key]: structuredClone(value) };
        if (client.lose > 0) {
          client.lose--;
          throw Object.assign(new Error('HTTP 502'), { status: 502 });
        }
      },
    },
  };
  return { server, client };
};

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const button = (text) => all(document.body, 'button').find((b) => b.textContent.trim() === text);

describe('Export presets, Create after an answer that never came', () => {
  it('stores one preset, not two', async () => {
    const { server, client } = makeServer();
    const view = await renderComponent(
      <MemoryRouter>
        <ExportPresetsSettings projectId="p1" client={client} />
      </MemoryRouter>,
    );
    await view.step(settle);
    await view.step(async () => {
      button('New preset').click();
      await settle();
    });
    client.lose = 1;
    await view.step(async () => {
      button('Create').click();
      await settle();
    });
    expect(server.config.igt.export.presets).toHaveLength(1);
    await view.step(async () => {
      button('Create').click();
      await settle();
    });
    expect(server.config.igt.export.presets).toHaveLength(1);
    await view.unmount();
  });
});
