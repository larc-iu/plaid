import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { renderComponent, texts } from '@ui/test/renderComponent.jsx';

// The Gloss lines form shows each line's source as the canvas and the export
// read it: the stored mapping, never a layer guessed from its name. After an
// archive import the stored mapping still names the old layers' ids, and the
// form says those layers are gone rather than showing no source.

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
  it('says a line whose layer is gone has lost it, and picks no layer by name', async () => {
    const r = await renderComponent(
      <MemoryRouter initialEntries={['/projects/p1']}>
        <Routes>
          <Route path="/projects/:projectId" element={<UmrSettings />} />
        </Routes>
      </MemoryRouter>,
    );
    await r.step(async () => {});
    expect(texts(r.container, 'button[aria-label="Source"]')).toEqual([
      'Morphemes',
      // Two gone layers read apart in the select.
      'Layer no longer in the project (1)',
      'Layer no longer in the project (2)',
    ]);
    await r.unmount();
  });

  it('offers Save only once a line is changed', async () => {
    const r = await renderComponent(
      <MemoryRouter initialEntries={['/projects/p1']}>
        <Routes>
          <Route path="/projects/:projectId" element={<UmrSettings />} />
        </Routes>
      </MemoryRouter>,
    );
    await r.step(async () => {});
    const save = () =>
      [...r.container.querySelectorAll('button')].find((b) => b.textContent === 'Save');
    expect(save().disabled).toBe(true);
    await r.step(() => r.container.querySelector('button[aria-label="Move down"]').click());
    expect(save().disabled).toBe(false);
    await r.unmount();
  });
});
