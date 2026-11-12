import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// The vocabulary list groups the vocabularies by the project each belongs to
// (SPEC 5.4): a heading per project the person can read, by name, then
// "Other projects" for those whose project they cannot read.

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
  isPermissionError: () => false,
}));
const auth = vi.hoisted(() => ({ client: null, logout: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));

const { VocabularyList } = await import('./VocabularyList.jsx');

const vocab = (id, name, project) => ({ id, name, project, config: {}, timeModified: null });

const mount = async (vocabularies, projects) => {
  auth.client = {
    vocabLayers: { list: async () => vocabularies },
    projects: { list: async () => projects },
    query: async () => ({ results: [] }),
  };
  const view = await renderComponent(
    <MemoryRouter>
      <VocabularyList />
    </MemoryRouter>,
  );
  for (let i = 0; i < 4; i++) await view.step(async () => {});
  return view;
};
// Each group: its heading, then the vocabularies under it.
const groups = () =>
  all(document.body, 'section').map((s) => [
    s.querySelector('h3').textContent,
    all(s, 'tbody tr').map((tr) => tr.querySelector('td').textContent),
  ]);

describe('the vocabulary list', () => {
  it('groups by project, by name, the projects the person cannot read last', async () => {
    const view = await mount(
      [
        vocab('v1', 'Roots', 'Z'),
        vocab('v2', 'Lexicon', 'Z'),
        vocab('v3', 'Loans', 'A'),
        vocab('v4', 'Their lexicon', 'HIDDEN'),
        vocab('v5', 'Other words', 'HIDDEN-2'),
      ],
      [
        { id: 'Z', name: 'Zapotec' },
        { id: 'A', name: 'Arapaho' },
      ],
    );
    expect(groups()).toEqual([
      ['Arapaho', ['Loans']],
      ['Zapotec', ['Lexicon', 'Roots']],
      ['Other projects', ['Other words', 'Their lexicon']],
    ]);
    const heading = all(document.body, 'h3 a').find((a) => a.textContent === 'Arapaho');
    expect(heading.getAttribute('href')).toBe('/projects/A');
    const row = all(document.body, 'tbody a').find((a) => a.textContent === 'Loans');
    expect(row.getAttribute('href')).toBe('/vocabularies/v3');
    const add = all(document.body, 'a').find((a) => a.textContent.includes('New vocabulary'));
    expect(add.getAttribute('href')).toBe('/vocabularies/new');
    await view.unmount();
  });

  it('has no Other projects group when every project can be read', async () => {
    const view = await mount([vocab('v1', 'Lexicon', 'A')], [{ id: 'A', name: 'Arapaho' }]);
    expect(groups()).toEqual([['Arapaho', ['Lexicon']]]);
    await view.unmount();
  });
});
