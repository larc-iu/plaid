import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// H1 S5: with nothing to list, the page names no other app.

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'student@x.com' } }) }));
vi.mock('@/contexts/CatalogContext', () => ({
  useCatalog: () => ({ vocabularies: [], itemCounts: {}, loading: false, error: '' }),
}));
vi.mock('@/hooks/useDocumentTitle', () => ({ useDocumentTitle: () => {} }));
const { Home } = await import('./Home.jsx');

describe('the landing page with no dictionaries', () => {
  it('says so and names no other app', async () => {
    const view = await renderComponent(
      <MemoryRouter>
        <Home />
      </MemoryRouter>,
    );
    expect(view.container.textContent).toContain('No dictionaries.');
    expect(view.container.textContent).not.toMatch(/IGT/);
    await view.unmount();
  });
});
