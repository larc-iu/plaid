import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// Admin > Vocabularies: each vocabulary's project, and every project that
// uses it, its own project first. A vocabulary always has a project now.

vi.mock('@/utils/feedback', () => ({ notifyError: vi.fn(), humanizeError: (e) => String(e) }));

const { AdminVocabularies } = await import('./AdminVocabularies.jsx');

const mount = async (vocabs, projects) => {
  const client = {
    vocabLayers: { list: async () => vocabs },
    projects: { list: async () => projects },
  };
  const view = await renderComponent(
    <MemoryRouter>
      <AdminVocabularies client={client} />
    </MemoryRouter>,
  );
  for (let i = 0; i < 3; i++) await view.step(async () => {});
  return view;
};
const headers = () => all(document.body, 'thead th').map((th) => th.textContent);
const row = (name) =>
  all(document.body, 'tbody tr')
    .find((tr) => tr.querySelector('td').textContent === name)
    .querySelectorAll('td');

describe('Admin vocabularies', () => {
  it('names the project of each, then the projects that use it, its own first', async () => {
    const view = await mount(
      [
        { id: 'v1', name: 'Lexicon', project: 'B' },
        { id: 'v2', name: 'Roots', project: 'GONE' },
      ],
      [
        { id: 'A', name: 'Arapaho', vocabs: [{ id: 'v1' }] },
        { id: 'B', name: 'Blackfoot', vocabs: [{ id: 'v1' }] },
      ],
    );
    expect(headers()).toEqual(['Name', 'Project', 'Used by']);
    const [, project, usedBy] = row('Lexicon');
    expect(project.textContent).toBe('Blackfoot');
    expect(project.querySelector('a').getAttribute('href')).toBe('/projects/B');
    expect(all(usedBy, 'a').map((a) => a.textContent)).toEqual(['Blackfoot', 'Arapaho']);
    // A project the list does not hold is named by its id.
    expect(row('Roots')[1].textContent).toBe('GONE');
    expect(document.body.textContent).not.toContain('No project');
    expect(document.body.textContent).not.toContain('Maintainers');
    await view.unmount();
  });
});
