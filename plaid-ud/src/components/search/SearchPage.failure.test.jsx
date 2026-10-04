import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// H35-CORE polish: a search that failed ("Illegal repetition") showed its
// error above the previous search's results, as if they were its own.

const query = vi.hoisted(() => ({ fn: null }));
const client = vi.hoisted(() => ({
  projects: {
    get: async () => ({ id: 'p1', name: 'P' }),
    listDocuments: async () => [{ id: 'd1', name: 'Doc' }],
  },
  query: (...args) => query.fn(...args),
}));
vi.mock('../../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ getClient: () => client, user: { id: 'u1' } }),
}));
vi.mock('../projects/ProjectTabs.jsx', () => ({ ProjectTabs: () => null }));
vi.mock('./QuickSearch.jsx', () => ({ QuickSearch: () => null }));
vi.mock('./GrewHelp.jsx', () => ({ GrewHelp: () => null }));
vi.mock('./CountBy.jsx', () => ({ CountBy: () => null }));
vi.mock('../../utils/udLayerUtils.js', async (orig) => ({
  ...(await orig()),
  getUdLayerInfo: () => ({
    isConfigured: true,
    sentenceTokenLayer: { id: 's' },
    morphemeTokenLayer: { id: 'm' },
  }),
}));
vi.mock('./grewToHighlight.js', () => ({
  groupResults: (results) => results,
}));
const compiled = vi.hoisted(() => ({ fn: null }));
vi.mock('../../grew/index.js', async (orig) => ({
  ...(await orig()),
  parseAndCompile: (...args) => compiled.fn(...args),
}));

const { SearchPage } = await import('./SearchPage.jsx');
const { GrewParseError } = await import('../../grew/errors.js');

const HIT = { docId: 'd1', sentenceId: 's1', text: 'The dog barked.', highlights: [] };

const mount = () =>
  renderComponent(
    <MemoryRouter initialEntries={['/projects/p1/search']}>
      <Routes>
        <Route path="/projects/:projectId/search" element={<SearchPage />} />
      </Routes>
    </MemoryRouter>,
  );

const typeInto = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const search = async (view, text) => {
  await view.step(() => typeInto(view.container.querySelector('#grew-query'), text));
  const button = [...view.container.querySelectorAll('button')].find(
    (b) => b.textContent.trim() === 'Search',
  );
  await view.step(() => button.click());
};

const searchedOnce = async () => {
  compiled.fn = () => ({ query: {}, warnings: ['A warning.'], nodes: [], edges: [] });
  query.fn = async () => ({ results: [HIT], count: 1 });
  const view = await mount();
  await search(view, 'pattern { X [upos=NOUN] }');
  expect(view.container.textContent).toContain('The dog barked.');
  expect(view.container.textContent).toContain('1 matching sentence');
  expect(view.container.textContent).toContain('A warning.');
  return view;
};

describe('a failed search', () => {
  it('clears the previous results when the server refuses it', async () => {
    const view = await searchedOnce();
    query.fn = async () => {
      throw Object.assign(new Error('Illegal repetition'), { status: 400 });
    };
    await search(view, 'pattern { X [form=re"{"] }');
    expect(view.container.textContent).toContain('Failed to search');
    expect(view.container.textContent).not.toContain('The dog barked.');
    expect(view.container.textContent).not.toContain('matching sentence');
    expect(view.container.textContent).not.toContain('A warning.');
    await view.unmount();
  });

  it('clears the previous results when the pattern cannot be read', async () => {
    const view = await searchedOnce();
    compiled.fn = () => {
      throw new GrewParseError('Expected "}"', 1, 12);
    };
    await search(view, 'pattern { X');
    expect(view.container.textContent).toContain('Syntax error');
    expect(view.container.textContent).not.toContain('The dog barked.');
    await view.unmount();
  });
});
