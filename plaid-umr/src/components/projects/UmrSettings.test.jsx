import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { renderComponent, texts } from '@ui/test/renderComponent.jsx';

// The Gloss lines form shows each line's source as the canvas and the export
// read it. After an archive import or a project copy the stored mapping
// still names the old layers' ids, and the form showed those lines with no
// source.

const project = {
  id: 'p1',
  name: 'P',
  config: {
    umr: {
      ilg: [
        { header: 'morphemes', lang: null, source: 'morphemes' },
        { header: 'morpheme-gloss', lang: 'eng', source: 'layer:old-gloss' },
        { header: 'sentence-gloss', lang: 'eng', source: 'layer:old-translation' },
      ],
    },
  },
};
const layerInfo = {
  morphemeTokenLayer: { id: 'm', name: 'Morphemes' },
  glossLayers: [
    { layer: { id: 'new-gloss', name: 'Gloss' }, scope: 'morpheme', lang: 'eng' },
    { layer: { id: 'new-translation', name: 'Translation' }, scope: 'sentence', lang: 'eng' },
  ],
};
vi.mock('@ui/hooks/useManagedProject.js', () => ({
  useManagedProject: () => ({ project, fetchProject: async () => {} }),
}));
vi.mock('../../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ getClient: () => ({}) }),
}));
vi.mock('../../utils/umrLayerUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getUmrLayerInfo: () => layerInfo,
}));

const { UmrSettings } = await import('./UmrSettings.jsx');

describe('UmrSettings', () => {
  it('shows a line whose layer has a new id with the layer the canvas draws', async () => {
    const r = await renderComponent(
      <MemoryRouter initialEntries={['/projects/p1']}>
        <Routes>
          <Route path="/projects/:projectId" element={<UmrSettings />} />
        </Routes>
      </MemoryRouter>,
    );
    await r.step(async () => {});
    expect(texts(r.container, 'button[aria-label="Source"]')).toEqual([
      'Morphemes (Morphemes)',
      'Gloss (morpheme)',
      'Translation (sentence)',
    ]);
    await r.unmount();
  });
});
