import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { discoverExportLayers } from '@/export/exportLayers';
import { newPreset } from '@/export/presets';

// The preset editor offers "Include vocabularies as TSV files" for every
// format whose export adds them (runExport's vocabularyTsvs), and a saved
// preset keeps the switch. ELAN adds them and the editor used to leave the
// switch out, so an ELAN preset could never ask for them.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  humanizeError: (e) => String(e),
}));
vi.mock('@/components/export/ExportRunner.jsx', () => ({ ExportRunner: () => null }));

const { ExportPresetEditor } = await import('./ExportPresetEditor.jsx');

const role = (r) => ({ plaid: { role: r } });
const makeServer = (format) => {
  const server = {
    id: 'p1',
    config: {},
    vocabs: [{ id: 'v1', name: 'Lexicon' }],
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
  const preset = newPreset(format, discoverExportLayers(server), 'Mine');
  server.config.igt = { export: { presets: [preset] } };
  const client = {
    projects: {
      get: async () => structuredClone(server),
      setConfig: async (_id, ns, key, value) => {
        server.config[ns] = { ...server.config[ns], [key]: structuredClone(value) };
      },
    },
  };
  return { server, client, preset };
};

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const button = (text) => all(document.body, 'button').find((b) => b.textContent.trim() === text);
const tsvSwitch = () =>
  all(document.body, 'label')
    .find((l) => l.textContent.includes('Include vocabularies as TSV files'))
    ?.querySelector('[role="switch"]');

describe('Export preset editor, the vocabulary TSV switch', () => {
  for (const format of ['plaintext', 'elan']) {
    it(`is offered for ${format} and saved with the preset`, async () => {
      const { server, client, preset } = makeServer(format);
      const view = await renderComponent(
        <MemoryRouter>
          <ExportPresetEditor projectId="p1" client={client} presetId={preset.id} />
        </MemoryRouter>,
      );
      await view.step(settle);
      expect(tsvSwitch()).toBeTruthy();
      await view.step(async () => {
        tsvSwitch().click();
        await settle();
      });
      await view.step(async () => {
        button('Save').click();
        await settle();
      });
      expect(server.config.igt.export.presets[0].includeVocabularies).toBe(true);
      await view.unmount();
    });
  }

  for (const format of ['flextext', 'cldf', 'latex', 'plaid-igt-json']) {
    it(`is not offered for ${format}, whose export does not add them`, async () => {
      const { client, preset } = makeServer(format);
      const view = await renderComponent(
        <MemoryRouter>
          <ExportPresetEditor projectId="p1" client={client} presetId={preset.id} />
        </MemoryRouter>,
      );
      await view.step(settle);
      expect(button('Save')).toBeTruthy();
      expect(tsvSwitch()).toBeFalsy();
      await view.unmount();
    });
  }
});
