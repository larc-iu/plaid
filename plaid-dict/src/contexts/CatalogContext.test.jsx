import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// The entry count reaches a vocabulary through the projects that link it. One
// that no project links has no row in the answer, and the home page said
// "0 entries" for a dictionary with seven.

const auth = vi.hoisted(() => ({ current: null }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth.current }));
const { CatalogProvider, useCatalog } = await import('./CatalogContext.jsx');

describe('the catalog entry counts', () => {
  it('counts only the vocabularies the query answered for', async () => {
    const client = {
      vocabLayers: { list: async () => [{ id: 'linked' }, { id: 'unlinked' }] },
      query: async () => ({ results: [['linked', 12]] }),
    };
    auth.current = { client, logout: () => {} };
    let seen = null;
    const Probe = () => {
      seen = useCatalog().itemCounts;
      return null;
    };
    const view = await renderComponent(
      <CatalogProvider>
        <Probe />
      </CatalogProvider>,
    );
    await view.step(() => new Promise((r) => setTimeout(r, 0)));
    expect(seen).toEqual({ linked: 12 });
    expect('unlinked' in seen).toBe(false);
    await view.unmount();
  });
});
