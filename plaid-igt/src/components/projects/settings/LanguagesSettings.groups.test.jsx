import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { LanguagesSettings } from './LanguagesSettings.jsx';

// The object and meta language boxes have the same fields, so each box is a
// group named by its title, and a screen reader says which "Name" it is in.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  humanizeError: (e) => String(e),
}));

describe('LanguagesSettings', () => {
  it('names each language box after its title', async () => {
    const project = { id: 'p-1', textLayers: [], config: { igt: {} } };
    const view = await renderComponent(
      <MemoryRouter>
        <LanguagesSettings project={project} projectId="p-1" client={{}} />
      </MemoryRouter>,
    );
    const groups = [...view.container.querySelectorAll('[role=group]')].map((g) => ({
      name: document.getElementById(g.getAttribute('aria-labelledby'))?.textContent.trim(),
      inputs: g.querySelectorAll('input').length,
    }));
    expect(groups.map((g) => g.name)).toEqual(['Object language', 'Meta language']);
    for (const g of groups) expect(g.inputs).toBeGreaterThan(0);
    await view.unmount();
  });
});
