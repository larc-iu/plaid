import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { CldfOptions } from './CldfOptions.jsx';

const LAYERS = {
  orthographies: [],
  sentFields: [],
  wordFields: [],
  morphFields: [],
  fieldLangs: {},
  documentMetadata: [],
};

// The notice for a project with no language identity links to the settings
// section that sets it, by its own address: old settings addresses are not
// redirected.
describe('CldfOptions', () => {
  it('links a project without languages to its General settings', async () => {
    const view = await renderComponent(
      <MemoryRouter>
        <CldfOptions
          options={{}}
          layers={LAYERS}
          languages={null}
          projectId="p1"
          onChange={() => {}}
        />
      </MemoryRouter>,
    );
    const link = [...view.container.querySelectorAll('a')].find((a) =>
      a.textContent.includes('Set the languages in Settings'),
    );
    expect(link?.getAttribute('href')).toBe('/projects/p1/general');
    await view.unmount();
  });
});
