import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// The page acts on what it shows, never on a box edited since:
// - H3-6-1: a preview stayed live after the box changed, and Apply wrote the
//   OLD rule, then re-previewed the NEW text.
// - H3-6-4: the preview re-run after an apply ticked again the sentences the
//   maintainer had unticked.
// - H3-6-5: Count by counted the pattern now in the box, not the search shown.
// - H3-6-6: the results' page was not in the URL, so Back from a hit landed
//   on page 1.

const query = vi.hoisted(() => ({ fn: null }));
const client = vi.hoisted(() => ({
  projects: {
    get: async () => ({ id: 'p1', name: 'P' }),
    listDocuments: async () => [{ id: 'd1', name: 'Doc' }],
  },
  query: (...args) => query.fn(...args),
  server: { limits: async () => ({}) },
}));
vi.mock('@ui/contexts/useAuth.js', () => ({
  useAuth: () => ({ getClient: () => client, user: { id: 'u1' } }),
}));
vi.mock('../projects/ProjectTabs.jsx', () => ({ ProjectTabs: () => null }));
vi.mock('./QuickSearch.jsx', () => ({ QuickSearch: () => null }));
vi.mock('./GrewHelp.jsx', () => ({ GrewHelp: () => null }));
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
const runner = vi.hoisted(() => ({ plan: null, apply: null }));
vi.mock('../../grew/rewrite/runner.js', () => ({
  planRewrite: (...args) => runner.plan(...args),
  applyRewrite: (...args) => runner.apply(...args),
  applySummary: (out) => (out.failed ? 'Stopped.' : 'Changed.'),
}));
const notes = vi.hoisted(() => []);
vi.mock('../../utils/feedback.jsx', async (orig) => ({
  ...(await orig()),
  notifySuccess: (m) => notes.push(['ok', m]),
  notifyError: (m, t) => notes.push(['error', t]),
}));
// The preview as plain controls: its rows, which are ticked, and Apply.
vi.mock('./RewritePreview.jsx', () => ({
  RewritePreview: ({ rows, selected, onSelect, onApply }) => (
    <div data-preview>
      <span data-rows>{rows.map((r) => r.key).join(',')}</span>
      <span data-ticked>
        {rows
          .filter((r) => selected.has(r.key))
          .map((r) => r.key)
          .join(',')}
      </span>
      <button
        data-untick
        onClick={() => onSelect(new Set([...selected].filter((k) => k !== 'd1:b')))}
      />
      <button data-apply onClick={onApply} />
    </div>
  ),
}));
vi.mock('./CountBy.jsx', () => ({
  CountBy: ({ onCount }) => (
    <button data-count onClick={() => onCount({ node: 'X', field: 'upos' })} />
  ),
}));

const { SearchPage } = await import('./SearchPage.jsx');

const seen = { search: '' };
const Probe = () => {
  seen.search = useLocation().search;
  return null;
};

const mount = (entry = '/projects/p1/search') =>
  renderComponent(
    <MemoryRouter initialEntries={[entry]}>
      <Probe />
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
const box = (view) => view.container.querySelector('#grew-query');
const button = (view, label) =>
  [...view.container.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
const type = (view, text) => view.step(() => typeInto(box(view), text));
const press = (view, label) => view.step(() => button(view, label).click());
const click = (view, sel) => view.step(() => view.container.querySelector(sel).click());
const text = (view, sel) => view.container.querySelector(sel)?.textContent;

const PRON = 'pattern { X [upos=DET] } commands { X.upos = PRON }';
const NUM = 'pattern { X [upos=DET] } commands { X.upos = NUM }';
const ROWS = ['a', 'b', 'c'].map((id) => ({ docId: 'd1', id, changes: [] }));

beforeEach(() => {
  notes.length = 0;
  runner.plan = vi.fn(async () => ({ rows: ROWS, docs: {}, documentsVisited: 1 }));
  runner.apply = vi.fn(async () => ({ failed: null }));
});

const previewed = async () => {
  const view = await mount();
  await type(view, PRON);
  await press(view, 'Preview changes');
  expect(text(view, '[data-ticked]')).toBe('d1:a,d1:b,d1:c');
  return view;
};

describe('a rewrite preview', () => {});

describe('the search results', () => {
  const HITS = Array.from({ length: 30 }, (_, i) => ({
    docId: 'd1',
    sentenceId: `s${i}`,
    text: `Sentence ${i + 1}.`,
    highlights: [],
  }));

  it('keeps its page in the URL, and a new request opens on page 1', async () => {
    compiled.fn = () => ({ query: {}, warnings: [], nodes: [], edges: [] });
    query.fn = async () => ({ results: HITS, count: 30 });
    const q = encodeURIComponent('pattern { X [upos=VERB] }');
    const view = await mount(`/projects/p1/search?q=${q}&page=2`);
    await view.step(async () => {});
    await view.step(async () => {});
    expect(view.container.textContent).toContain('Sentence 26.');
    expect(view.container.textContent).not.toContain('Sentence 1.');
    expect(new URLSearchParams(seen.search).get('page')).toBe('2');
    await type(view, 'pattern { X [upos=NOUN] }');
    await press(view, 'Search');
    expect(new URLSearchParams(seen.search).get('page')).toBe(null);
    expect(view.container.textContent).toContain('Sentence 1.');
    await view.unmount();
  });
});
